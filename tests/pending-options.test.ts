import assert from "node:assert/strict";
import {
  shouldAskForProductOptions,
  tryResolvePendingOptions,
} from "../src/ai/services/cart.service.js";
import {
  resolveOptionsFromText,
  userChoseNoOptions,
} from "../src/ai/services/product-options.service.js";
import { clearPending, getPending, setPending } from "../src/ai/pending.js";
import { BLOCKED_ASSISTANT_CATEGORY_IDS } from "../src/ai/product-eligibility.js";

const options = [
  { id: "sliced", name: "Coupé en tranches" },
  { id: "bag", name: "Sac papier" },
];

assert.equal(shouldAskForProductOptions(1), true);
assert.equal(shouldAskForProductOptions(2), false);
assert.equal(shouldAskForProductOptions(5), false);

assert.deepEqual(resolveOptionsFromText("1", options), [
  { id: "sliced", name: "Coupé en tranches" },
]);
assert.deepEqual(resolveOptionsFromText("2", options), [
  { id: "bag", name: "Sac papier" },
]);
assert.deepEqual(resolveOptionsFromText("3", options), []);

assert.equal(userChoseNoOptions("3", options), true);
assert.equal(userChoseNoOptions("aucune", options), true);
assert.equal(userChoseNoOptions("2", options), false);

const oneOption = [{ id: "sliced", name: "Coupé en tranches" }];
assert.deepEqual(resolveOptionsFromText("2", oneOption), []);
assert.equal(userChoseNoOptions("2", oneOption), true);

{
  const userRef = "test:pending-options:product-became-blocked";
  clearPending(userRef);
  setPending(userRef, {
    type: "awaiting_options",
    productId: "stale-pending-product",
    productName: "Produit devenu indisponible",
    qty: 1,
    remainingItems: [],
    availableOptions: options,
  });

  const response = await tryResolvePendingOptions(userRef, "1", {
    fetchProduct: async () => ({
      id: "stale-pending-product",
      name: "Produit devenu indisponible",
      type: "sell",
      categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
    }),
  });

  assert(response);
  assert.equal(response.message.includes("n’a pas été ajouté"), true);
  assert.equal(getPending(userRef), undefined, "A blocked stale pending choice must be cleared");
}

console.log("pending-options tests passed");
