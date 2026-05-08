import assert from "node:assert/strict";
import {
  detectRecipeRequest,
  getRecipeCandidates,
} from "../src/ai/build-meal/recipe-memory.js";
import type {
  BuildMealIngredientTraining,
  BuildMealRecipeTraining,
  BuildMealTrainingSeed,
} from "../src/ai/build-meal/types.js";

const ingredient: BuildMealIngredientTraining = {
  key: "test",
  label: "test",
  qty: 1,
  unit: "piece",
  role: "principal",
  optional: false,
  isCore: true,
};

function recipe(input: {
  key: string;
  label: string;
  aliases: string[];
  family?: string;
}): BuildMealRecipeTraining {
  return {
    key: input.key,
    label: input.label,
    aliases: input.aliases,
    examples: input.aliases,
    family: input.family,
    defaultServings: 2,
    ingredients: [ingredient],
  };
}

const training: BuildMealTrainingSeed = {
  version: 999,
  requestPatterns: [
    "de quoi faire",
    "je veux de quoi faire",
    "faire un",
    "faire une",
    "faire des",
  ],
  servingsWords: {},
  meals: [
    recipe({
      key: "pizza",
      label: "pizza",
      aliases: ["pizza", "de quoi faire une pizza"],
      family: "pizza",
    }),
    recipe({
      key: "pizza_ananas",
      label: "pizza ananas",
      aliases: ["pizza ananas", "de quoi faire une pizza ananas"],
      family: "pizza",
    }),
    recipe({
      key: "dessert_ananas",
      label: "dessert ananas",
      aliases: ["dessert ananas", "de quoi faire un dessert ananas"],
      family: "dessert",
    }),
    recipe({
      key: "spaghetti_bolognese",
      label: "spaghetti bolognese",
      aliases: ["spaghetti bolognese", "bolognese"],
      family: "pasta",
    }),
  ],
};

async function expectMatch(text: string, mealKey: string): Promise<void> {
  const match = await detectRecipeRequest(text, training, 2, { force: true });
  assert.equal(match?.recipe.key, mealKey, `${text} should match ${mealKey}`);
}

async function expectNoMatch(text: string): Promise<void> {
  const match = await detectRecipeRequest(text, training, 2, { force: true });
  assert.equal(match, null, `${text} should stay unmatched`);
}

async function run(): Promise<void> {
  await expectMatch("de quoi faire une pizza ananas", "pizza_ananas");
  await expectMatch("de quoi faire un pizza ananas", "pizza_ananas");
  await expectMatch("de quoi faire un dessert ananas", "dessert_ananas");
  await expectMatch("de quoi faire un dessert à ananas", "dessert_ananas");

  await expectNoMatch("de quoi faire une pizza wurstel");
  await expectNoMatch("de quoi faire un boisson a l'ananas");

  const candidates = await getRecipeCandidates("de quoi faire un boisson a l'ananas", training);
  assert.notEqual(
    candidates[0]?.mealKey,
    "spaghetti_bolognese",
    "A poisoned learned example must not make boisson ananas retrieve spaghetti bolognese first"
  );
}

run().then(() => {
  console.log("[PASS] build-meal matching guards");
});
