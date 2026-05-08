import assert from "node:assert/strict";
import {
  areBuildMealFamiliesCompatible,
  inferBuildMealFamily,
} from "../src/ai/build-meal/recipe-family.service.js";

function run(): void {
  const dessertAnanas = inferBuildMealFamily({
    label: "dessert a ananas",
    sourceText: "de quoi faire un dessert a ananas",
  });

  assert.equal(
    dessertAnanas.family,
    "dessert",
    "A generic dessert request should be recognized as a dessert family before ingredients are validated"
  );
  assert.equal(
    areBuildMealFamiliesCompatible("dessert", "pizza"),
    false,
    "Dessert requests must not retrieve pizza recipes just because they share a modifier ingredient"
  );
  assert.equal(
    areBuildMealFamiliesCompatible("dessert", "dessert_gateau"),
    true,
    "Dessert subfamilies should stay compatible with generic dessert requests"
  );
  assert.equal(
    areBuildMealFamiliesCompatible("pizza", "pizza"),
    true,
    "Exact recipe families should remain compatible"
  );
}

run();
console.log("[PASS] build-meal family guards");
