import assert from "node:assert/strict";

import { clearPending } from "../src/ai/pending.js";
import {
  tryHandleRecurringOrders,
  type RecurringOrdersDeps,
} from "../src/ai/services/recurring-orders.service.js";
import type { CustomerRecurringOrder } from "../src/swissdata/recurring-orders.js";
import type { Product } from "../src/swissdata/products.js";
import { computeBasketQty } from "../src/ai/services/cart-quantity.service.js";

const products: Record<string, Product> = {
  pain: { id: "p-pain", name: "Pain Balance" },
  lait: { id: "p-lait", name: "Lait Bio" },
  oeufs: { id: "p-oeufs", name: "Oeuf Bio à la pièce" },
  lard: {
    id: "p-lard",
    name: "A. Lard de Begnins",
    size: "100g",
    priceType: "per-weight",
    refWeight: 100,
    refWeightUnit: "g",
  },
  pizza: {
    id: "p-pizza",
    name: "Pizza Marguerite",
    optionsIds: ["opt-pizza"],
    availableOptions: [{ id: "opt-pizza", name: "Option pizza" }],
  },
};

function baseOrders(): CustomerRecurringOrder[] {
  return [
    {
      id: "rec-mardi",
      name: "AI TEST - Commande récurrente mardi",
      customerId: "customer-samuel",
      daysOfWeek: [2],
      deliveryTime: "08:00",
      nextDates: ["07-07-2026 08:00"],
      products: [
        { productId: "p-lait", name: "Lait Bio", quantity: 2 },
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 6 },
      ],
    },
    {
      id: "rec-jeudi",
      name: "AI TEST - Commande récurrente jeudi",
      customerId: "customer-samuel",
      daysOfWeek: [4],
      deliveryTime: "09:00",
      nextDates: ["09-07-2026 09:00"],
      products: [
        { productId: "p-pain", name: "Pain Balance", quantity: 1 },
        { productId: "p-lait", name: "Lait Bio", quantity: 1 },
      ],
    },
    {
      id: "rec-vendredi",
      name: "AI TEST - Commande récurrente vendredi",
      customerId: "customer-samuel",
      daysOfWeek: [5],
      deliveryTime: "10:00",
      nextDates: ["10-07-2026 10:00"],
      products: [
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 4 },
      ],
    },
  ];
}

function makeDeps() {
  let orders = baseOrders();
  const updates: Array<{ id: string; products: Array<{ productId: string; quantity: number }> }> = [];

  const deps: RecurringOrdersDeps = {
    listCustomerRecurringOrders: async () => orders,
    updateCustomerRecurringProducts: async (_userRef, id, nextProducts) => {
      updates.push({ id, products: nextProducts });
      orders = orders.map((order) => {
        if (order.id !== id) return order;
        return {
          ...order,
          products: nextProducts.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            name: Object.values(products).find((product) => product.id === line.productId)?.name ?? line.productId,
          })),
        };
      });
      const updated = orders.find((order) => order.id === id);
      assert(updated);
      return updated;
    },
    extractAddItemsFromText: async (_userRef, text) => {
      const normalized = text.toLowerCase();
      const items = [];
      if (normalized.includes("pain")) items.push({ query: "pain", qty: 1 });
      if (normalized.includes("lait")) items.push({ query: "lait", qty: 1 });
      if (normalized.includes("lard")) items.push({ query: "A. Lard de Begnins", qty: 2, unit: "kg", productId: "p-lard" });
      if (normalized.includes("pizza")) items.push({ query: "Pizza Marguerite", qty: 1, unit: "piece", productId: "p-pizza" });
      if (normalized.includes("oeuf") || normalized.includes("œuf")) items.push({ query: "oeufs", qty: 2 });
      return {
        intent: "ADD_ITEMS",
        actions: [{ type: "add_to_cart", items }],
      };
    },
    fetchFullProduct: async (_userRef, productId) =>
      Object.values(products).find((product) => product.id === productId) ?? null,
    resolveProduct: async (_userRef, rawItem) => {
      const normalized = rawItem.toLowerCase();
      if (normalized.includes("pain")) return products.pain;
      if (normalized.includes("lait")) return products.lait;
      if (normalized.includes("lard")) return products.lard;
      if (normalized.includes("pizza")) return products.pizza;
      if (normalized.includes("oeuf") || normalized.includes("œuf")) return products.oeufs;
      return null;
    },
    computeBasketQty,
  };

  return { deps, updates };
}

function assertIncludes(haystack: string, needle: string): void {
  assert(
    haystack.includes(needle),
    `Expected message to include ${JSON.stringify(needle)}.\nMessage:\n${haystack}`
  );
}

async function testShowRecurringOrders(): Promise<void> {
  const userRef = "test:recurring:show";
  clearPending(userRef);
  const { deps } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "montre mes commandes récurrentes",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Commande récurrente du mardi");
  assertIncludes(response.message, "Commande récurrente du jeudi");
  assertIncludes(response.message, "Commande récurrente du vendredi");
  assert(!response.message.includes("AI TEST"), "technical fixture prefix must not be shown to customers");
  assertIncludes(response.message, "Lait Bio");
}

async function testAmbiguousAddRequiresChoiceThenOkConfirmation(): Promise<void> {
  const userRef = "test:recurring:choice";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const first = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(first);
  assertIncludes(first.message, "Laquelle veux-tu modifier");
  assert.equal(updates.length, 0);

  const second = await tryHandleRecurringOrders(userRef, "mardi", undefined, deps);
  assert(second);
  assertIncludes(second.message, "Changements proposés");
  assertIncludes(second.message, "Ajout");
  assertIncludes(second.message, "écris « ok »");
  assert.equal(updates.length, 0);

  const ok = await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert(ok);
  assertIncludes(ok.message, "Commande récurrente mise à jour");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-pain" && line.quantity === 1));
}

async function testRemoveFromExplicitDay(): Promise<void> {
  const userRef = "test:recurring:remove";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "retire le lait de ma commande récurrente du jeudi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Retrait");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-jeudi");
  assert(!updates[0].products.some((line) => line.productId === "p-lait"));
}

async function testRecurringAddUsesFullProductForWeightUnits(): Promise<void> {
  const userRef = "test:recurring:weight";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute 2kg de lard du begnin à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Ajout : 20 × A. Lard de Begnins");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-lard" && line.quantity === 20));
}

async function testRecurringMultiAddSkipsOptionsLikeCartAdd(): Promise<void> {
  const userRef = "test:recurring:multi-options";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute 2kg de lard du begnin et une pizza marguerita à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Ajout : 20 × A. Lard de Begnins");
  assertIncludes(response.message, "Ajout : 1 × Pizza Marguerite");
  assert(!response.message.includes("options nécessaires"), "multi-item recurring add should mirror cart add and not block all items on options");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-lard" && line.quantity === 20));
  assert(updates[0].products.some((line) => line.productId === "p-pizza" && line.quantity === 1));
}

async function testAmbiguousRemoveDoesNotWrite(): Promise<void> {
  const userRef = "test:recurring:ambiguous-remove";
  clearPending(userRef);
  const { deps, updates } = makeDeps();
  const originalList = deps.listCustomerRecurringOrders;
  deps.listCustomerRecurringOrders = async (...args) => {
    const orders = await originalList(...args);
    return orders.map((order) =>
      order.id === "rec-mardi"
        ? {
            ...order,
            products: [
              { productId: "p-pain", name: "Pain Balance", quantity: 1 },
              { productId: "p-pain-choc", name: "Pain au chocolat", quantity: 1 },
            ],
          }
        : order
    );
  };

  const response = await tryHandleRecurringOrders(
    userRef,
    "retire le pain de ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "plusieurs produits possibles");
  assertIncludes(response.message, "Pain Balance");
  assertIncludes(response.message, "Pain au chocolat");
  assert.equal(updates.length, 0);
}

async function testNoKeywordReturnsNullWithoutHint(): Promise<void> {
  const userRef = "test:recurring:no-keyword";
  clearPending(userRef);
  const { deps } = makeDeps();

  const response = await tryHandleRecurringOrders(userRef, "ajoute du pain", undefined, deps);
  assert.equal(response, null);
}

async function main(): Promise<void> {
  await testShowRecurringOrders();
  await testAmbiguousAddRequiresChoiceThenOkConfirmation();
  await testRemoveFromExplicitDay();
  await testRecurringAddUsesFullProductForWeightUnits();
  await testRecurringMultiAddSkipsOptionsLikeCartAdd();
  await testAmbiguousRemoveDoesNotWrite();
  await testNoKeywordReturnsNullWithoutHint();
  console.log("[recurring-orders.test] all checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
