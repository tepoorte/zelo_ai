import assert from "node:assert/strict";
import {
  handleAddToCartAction,
  handleExecCartAction,
  type AddToCartEligibilityDependencies,
  type ExecCartEligibilityDependencies,
} from "../src/ai/services/cart.service.js";
import { BLOCKED_ASSISTANT_CATEGORY_IDS } from "../src/ai/product-eligibility.js";
import type { Product } from "../src/swissdata/products.js";

const basket = { id: "basket-test", products: [] as any[] };
const allowedProduct: Product = {
  id: "allowed-product",
  name: "Produit alimentaire",
  type: "sell",
  categories: ["food-category"],
};
const blockedProduct: Product = {
  id: "blocked-product",
  name: "Casque interdit",
  type: "sell",
  categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
};

function addDependencies(input: {
  catalogProduct: Product | null;
  currentProduct?: Product | null;
  resolveProduct?: Product | null;
}) {
  let addCalls = 0;
  const dependencies: AddToCartEligibilityDependencies = {
    getBasket: async () => basket,
    ensureBasket: async () => basket,
    fetchCatalogProduct: async () => input.catalogProduct,
    fetchCurrentProduct: async () =>
      input.currentProduct === undefined ? input.catalogProduct : input.currentProduct,
    resolveCatalogProduct: async () => input.resolveProduct ?? null,
    addProduct: async () => {
      addCalls += 1;
      return {};
    },
    getHistorySuggestions: async () => [],
    getCatalogProducts: async () => [
      input.catalogProduct ?? input.resolveProduct ?? allowedProduct,
      blockedProduct,
    ],
  };
  return { dependencies, addCalls: () => addCalls };
}

{
  const setup = addDependencies({ catalogProduct: blockedProduct });
  const result = await handleAddToCartAction(
    "test:blocked-direct-id",
    { items: [{ query: blockedProduct.name, qty: 1, productId: blockedProduct.id }] },
    setup.dependencies
  );
  assert.equal(result.pending, false);
  assert.equal(setup.addCalls(), 0, "A blocked direct product ID must not reach basket mutation");
}

{
  const whatsappUserRef = "wa:41790000000";
  const observedUserRefs: string[] = [];
  let addCalls = 0;
  const dependencies: AddToCartEligibilityDependencies = {
    getBasket: async (userRef) => {
      observedUserRefs.push(userRef);
      return basket;
    },
    getCatalogProducts: async (userRef) => {
      observedUserRefs.push(userRef);
      return [blockedProduct];
    },
    fetchCatalogProduct: async (userRef) => {
      observedUserRefs.push(userRef);
      return blockedProduct;
    },
    fetchCurrentProduct: async (userRef) => {
      observedUserRefs.push(userRef);
      return blockedProduct;
    },
    addProduct: async () => {
      addCalls += 1;
      return {};
    },
    ensureBasket: async () => basket,
    getHistorySuggestions: async () => [],
  };

  const result = await handleAddToCartAction(
    whatsappUserRef,
    { items: [{ query: blockedProduct.name, qty: 1, productId: blockedProduct.id }] },
    dependencies
  );

  assert.equal(result.pending, false);
  assert.equal(addCalls, 0, "A blocked WhatsApp add must not reach the cart adapter");
  assert.equal(observedUserRefs.length > 0, true);
  assert.equal(
    observedUserRefs.every((userRef) => userRef === whatsappUserRef),
    true,
    "The shared hard gate must preserve the wa: principal throughout cart resolution"
  );
}

{
  const setup = addDependencies({ catalogProduct: null, resolveProduct: blockedProduct });
  const result = await handleAddToCartAction(
    "test:blocked-direct-name",
    { items: [{ query: blockedProduct.name, qty: 1 }] },
    setup.dependencies
  );
  assert.equal(result.pending, false);
  assert.equal(setup.addCalls(), 0, "A blocked direct product name must not reach basket mutation");
}

{
  const setup = addDependencies({
    catalogProduct: allowedProduct,
    currentProduct: {
      ...allowedProduct,
      categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
    },
  });
  await handleAddToCartAction(
    "test:product-became-blocked",
    { items: [{ query: allowedProduct.name, qty: 1, productId: allowedProduct.id }] },
    setup.dependencies
  );
  assert.equal(
    setup.addCalls(),
    0,
    "A product that becomes blocked after cached resolution must fail current-record revalidation"
  );
}

{
  const setup = addDependencies({ catalogProduct: allowedProduct, currentProduct: allowedProduct });
  await handleAddToCartAction(
    "test:allowed-product",
    { items: [{ query: allowedProduct.name, qty: 1, productId: allowedProduct.id }] },
    setup.dependencies
  );
  assert.equal(setup.addCalls(), 1, "The hard gate must preserve normal food additions");
}

async function checkoutWith(
  products: any[],
  currentProduct: Product | null
): Promise<{ result: any; placeCalls: number }> {
  let placeCalls = 0;
  const dependencies: ExecCartEligibilityDependencies = {
    getBasket: async () => ({ id: "basket-checkout", products }),
    fetchCurrentProduct: async () => currentProduct,
    placeOrder: async () => {
      placeCalls += 1;
      return { id: "order-test" };
    },
  };
  const result = await handleExecCartAction("test:checkout", undefined, dependencies);
  return { result, placeCalls };
}

{
  const checkout = await checkoutWith(
    [{ productId: blockedProduct.id, name: blockedProduct.name, quantity: 1 }],
    blockedProduct
  );
  assert.equal(checkout.result.ok, false);
  assert.equal(checkout.placeCalls, 0, "A blocked basket line must prevent checkout mutation");
}

{
  const checkout = await checkoutWith(
    [{ name: "Produit sans identifiant", quantity: 1 }],
    allowedProduct
  );
  assert.equal(checkout.result.ok, false);
  assert.equal(checkout.placeCalls, 0, "An unidentified basket line must fail closed at checkout");
}

{
  const checkout = await checkoutWith(
    [{ productId: allowedProduct.id, name: allowedProduct.name, quantity: 1 }],
    allowedProduct
  );
  assert.equal(checkout.result.ok, true);
  assert.equal(checkout.placeCalls, 1, "An eligible basket must still be orderable");
}

console.log("cart-product-eligibility tests passed");
