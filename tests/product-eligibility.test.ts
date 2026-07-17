import assert from "node:assert/strict";
import {
  BLOCKED_ASSISTANT_CATEGORY_IDS,
  BLOCKED_ASSISTANT_PRODUCT_IDS,
  assistantProductIneligibilityReason,
  fetchCurrentAssistantEligibleProduct,
  filterAssistantEligibleProducts,
  hasBlockedAssistantProductReference,
  isAssistantProductEligible,
  rankAssistantEligibleProducts,
} from "../src/ai/product-eligibility.js";
import type { Product } from "../src/swissdata/products.js";

const ordinaryFood: Product = {
  id: "ordinary-food",
  name: "Produit alimentaire normal",
  type: "sell",
  categories: ["food-category"],
};
const referenceCatalog: Product[] = [
  ordinaryFood,
  { ...ordinaryFood, id: "allowed-pain", name: "Pain Balance" },
  { ...ordinaryFood, id: "allowed-milk", name: "Lait cru" },
  {
    id: "blocked-helmet",
    name: "Casque Lumos Ultra Noir",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
  },
  {
    id: "blocked-glasslock",
    name: "GlassLock Moyen",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[1]],
  },
  {
    id: "blocked-milk-bottle",
    name: "Bouteille de lait",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[1]],
  },
  {
    id: "blocked-credit-reference",
    name: "Crédits Zélo B 500",
    type: "digital",
    categories: [],
  },
];

assert.equal(isAssistantProductEligible(ordinaryFood), true);
assert.equal(assistantProductIneligibilityReason(null), "missing_product");
assert.equal(
  assistantProductIneligibilityReason({ id: "", type: "sell", categories: [] }),
  "missing_id"
);
assert.equal(
  assistantProductIneligibilityReason({ id: "missing-type", categories: [] }),
  "non_sell_product"
);
assert.equal(
  assistantProductIneligibilityReason({
    id: "malformed-categories",
    type: "sell",
    categories: "not-an-array" as unknown as string[],
  }),
  "invalid_categories"
);

for (const type of ["digital", "rent", "subscription"]) {
  assert.equal(
    assistantProductIneligibilityReason({ id: `non-sell-${type}`, type, categories: [] }),
    "non_sell_product",
    `${type} products must be blocked`
  );
}

for (const categoryId of BLOCKED_ASSISTANT_CATEGORY_IDS) {
  assert.equal(
    assistantProductIneligibilityReason({
      id: `blocked-category-${categoryId}`,
      type: "sell",
      categories: [categoryId],
    }),
    "blocked_category",
    `Category ${categoryId} must be blocked`
  );
}

assert.equal(
  isAssistantProductEligible({
    id: "mixed-food-blocked",
    type: "sell",
    categories: [ordinaryFood.categories![0], BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
  }),
  false,
  "One allowed category must never override a blocked category"
);

for (const productId of BLOCKED_ASSISTANT_PRODUCT_IDS) {
  assert.equal(
    assistantProductIneligibilityReason({ id: productId, type: "sell", categories: [] }),
    "blocked_product",
    `Explicit deny-list product ${productId} must stay blocked even if its type changes`
  );
}

const filtered = filterAssistantEligibleProducts([
  ordinaryFood,
  {
    id: "blocked-container",
    name: "Contenant",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[1]],
  },
  {
    id: "credit",
    name: "Crédit",
    type: "digital",
    categories: [],
  },
]);
assert.deepEqual(filtered.map((product) => product.id), [ordinaryFood.id]);

assert.equal(
  hasBlockedAssistantProductReference(
    `ajoute le produit ${BLOCKED_ASSISTANT_PRODUCT_IDS.at(-1)}`,
    [ordinaryFood]
  ),
  true
);
assert.equal(hasBlockedAssistantProductReference("ajoute un casque", referenceCatalog), true);
assert.equal(hasBlockedAssistantProductReference("ajoute des crédits Zélo", referenceCatalog), true);
assert.equal(
  hasBlockedAssistantProductReference("ajoute un glasslok moyen", referenceCatalog),
  true,
  "A typo for a blocked catalog product must not survive into allowed-only fuzzy ranking"
);
assert.equal(
  hasBlockedAssistantProductReference("ajoute une bouteil de lait", referenceCatalog),
  true,
  "A partial typo for a blocked catalog product must beat the weaker allowed milk match"
);
assert.equal(
  hasBlockedAssistantProductReference(
    "ajoute un pain en soutien aux producteurs locaux",
    referenceCatalog
  ),
  false,
  "Context words must not become global blocked-category keywords"
);
assert.equal(
  hasBlockedAssistantProductReference("ajoute une pomme locale", referenceCatalog),
  false
);

assert.deepEqual(
  rankAssistantEligibleProducts(
    "pomme",
    [
      {
        id: "blocked-perfect-match",
        name: "Pomme",
        type: "sell",
        categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
      },
      ordinaryFood,
      { ...ordinaryFood, id: "allowed-apple", name: "Pomme locale" },
    ],
    1
  ).map((product) => product.id),
  ["allowed-apple"],
  "Search must filter before limiting so an allowed candidate fills the result"
);

assert.equal(
  await fetchCurrentAssistantEligibleProduct("test", ordinaryFood.id, async () => ordinaryFood),
  ordinaryFood
);
assert.equal(
  await fetchCurrentAssistantEligibleProduct("test", "blocked-live", async () => ({
    id: "blocked-live",
    name: "Produit bloqué courant",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
  })),
  null
);
assert.equal(
  await fetchCurrentAssistantEligibleProduct("test", "read-error", async () => {
    throw new Error("simulated Swissdata read failure");
  }),
  null,
  "Current-product read errors must fail closed"
);

console.log("product-eligibility tests passed");
