import assert from "node:assert/strict";
import { shouldAskForProductOptions } from "../src/ai/services/cart.service.js";
import {
  resolveOptionsFromText,
  userChoseNoOptions,
} from "../src/ai/services/product-options.service.js";

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

console.log("pending-options tests passed");
