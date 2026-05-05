import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeText } from "../../domain/normalizer.js";
import { fetchFullProduct, type Product } from "../../swissdata/products.js";
import { CATEGORY_NAME_BY_ID, EXCLUDED_CATEGORY_IDS } from "../food-taxonomy.js";
import {
  makeBuildMealIngredientKey,
  makeBuildMealKey,
} from "./recipe-knowledge.service.js";
import { inferBuildMealFamily } from "./recipe-family.service.js";
import type {
  BuildMealFeedbackAction,
  BuildMealFeedbackEvent,
  BuildMealFeedbackLedger,
  BuildMealIngredientTraining,
  BuildMealRecipeTraining,
  BuildMealTrainingSeed,
  BuildMealUnit,
  BuildMealUserRecipesStore,
} from "./types.js";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const PUBLIC_DIR = path.join(process.cwd(), "public", "predictor");
const SEED_FILE = path.join(PUBLIC_DIR, "build-meal-training.json");
const LEDGER_FILE = path.join(CACHE_DIR, "build-meal-feedback-ledger.json");
const RUNTIME_FILE = path.join(CACHE_DIR, "build-meal-training.runtime.json");
const USER_RECIPES_FILE = path.join(CACHE_DIR, "build-meal-user-recipes.json");

function runtimeFileForUser(userRef?: string | null): string {
  if (!userRef) return RUNTIME_FILE;
  const safeUserRef = String(userRef)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 80);
  return path.join(CACHE_DIR, `build-meal-training.runtime.${safeUserRef || "anonymous"}.json`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureCacheDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function loadSeedTraining(): Promise<BuildMealTrainingSeed> {
  const training = await readJsonFile<BuildMealTrainingSeed | null>(SEED_FILE, null);
  if (!training?.meals?.length) {
    throw new Error("Build meal seed training introuvable ou invalide.");
  }
  return training;
}

async function loadLedger(): Promise<BuildMealFeedbackLedger> {
  return await readJsonFile<BuildMealFeedbackLedger>(LEDGER_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    events: [],
  });
}

async function loadUserRecipesStore(): Promise<BuildMealUserRecipesStore> {
  return await readJsonFile<BuildMealUserRecipesStore>(USER_RECIPES_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    recipes: [],
  });
}

function findRecipeOrNull(
  training: BuildMealTrainingSeed,
  mealKey: string
): BuildMealRecipeTraining | null {
  return training.meals.find((item) => item.key === mealKey) || null;
}

function findRecipe(training: BuildMealTrainingSeed, mealKey: string): BuildMealRecipeTraining {
  const recipe = findRecipeOrNull(training, mealKey);
  if (!recipe) {
    throw new Error(`Unknown meal key: ${mealKey}`);
  }
  return recipe;
}

function findIngredientOrNull(
  recipe: BuildMealRecipeTraining,
  ingredientKey: string
): BuildMealIngredientTraining | null {
  return recipe.ingredients.find((item) => item.key === ingredientKey) || null;
}

function findIngredient(recipe: BuildMealRecipeTraining, ingredientKey: string): BuildMealIngredientTraining {
  const ingredient = findIngredientOrNull(recipe, ingredientKey);
  if (!ingredient) {
    throw new Error(`Unknown ingredient key: ${recipe.key}/${ingredientKey}`);
  }
  return ingredient;
}

function applyFeedbackEvent(
  training: BuildMealTrainingSeed,
  event: BuildMealFeedbackEvent
): void {
  const recipe = findRecipeOrNull(training, event.mealKey);
  if (!recipe) return;

  const ingredient = findIngredientOrNull(recipe, event.ingredientKey);
  if (!ingredient) return;

  if (event.action === "prefer_product") {
    if (event.productId) {
      ingredient.preferredProductId = event.productId;
    }
    if (event.productName) {
      ingredient.preferredProductName = event.productName;
    }
    return;
  }

  if (event.action === "ban_product") {
    if (event.productId) {
      const bannedIds = new Set(ingredient.bannedProductIds || []);
      bannedIds.add(event.productId);
      ingredient.bannedProductIds = [...bannedIds];
    }
    if (event.productName) {
      const bannedNames = new Set(ingredient.bannedProductNames || []);
      bannedNames.add(event.productName);
      ingredient.bannedProductNames = [...bannedNames];
    }
  }
}

function mergeTraining(
  baseTraining: BuildMealTrainingSeed,
  userRecipes: BuildMealUserRecipesStore,
  ledger: BuildMealFeedbackLedger,
  userRef?: string | null
): BuildMealTrainingSeed {
  const merged = deepClone(baseTraining);

  const mealsByKey = new Map<string, BuildMealRecipeTraining>();
  for (const meal of merged.meals || []) {
    mealsByKey.set(meal.key, meal);
  }

  for (const recipe of userRecipes.recipes || []) {
    const isGlobalRecipe = !recipe.userRef;
    const isMatchingUserRecipe = !!userRef && recipe.userRef === userRef;
    if (!isGlobalRecipe && !isMatchingUserRecipe) continue;
    mealsByKey.set(recipe.key, deepClone(recipe));
  }

  merged.meals = [...mealsByKey.values()];

  for (const event of ledger.events) {
    const isGlobalEvent = !event.userRef;
    const isMatchingUserEvent = !!userRef && event.userRef === userRef;
    if (!isGlobalEvent && !isMatchingUserEvent) {
      continue;
    }
    applyFeedbackEvent(merged, event);
  }
  return merged;
}

export async function rebuildBuildMealTrainingRuntime(
  userRef?: string | null
): Promise<BuildMealTrainingSeed> {
  const seed = await loadSeedTraining();
  const userRecipes = await loadUserRecipesStore();
  const ledger = await loadLedger();
  const runtime = mergeTraining(seed, userRecipes, ledger, userRef);
  await writeJsonFile(runtimeFileForUser(userRef), runtime);
  return runtime;
}

export async function getBuildMealTrainingRuntime(
  userRef?: string | null
): Promise<BuildMealTrainingSeed> {
  return await rebuildBuildMealTrainingRuntime(userRef);
}

export async function recordBuildMealFeedback(input: {
  mealKey: string;
  ingredientKey: string;
  action: BuildMealFeedbackAction;
  productId?: string;
  productName?: string;
  userRef?: string;
  note?: string;
}): Promise<{ event: BuildMealFeedbackEvent; training: BuildMealTrainingSeed }> {
  const training = await getBuildMealTrainingRuntime(input.userRef ?? null);
  findIngredient(findRecipe(training, input.mealKey), input.ingredientKey);

  if (input.action !== "prefer_product" && input.action !== "ban_product") {
    throw new Error("Invalid build meal feedback action");
  }
  if (!input.productId && !input.productName) {
    throw new Error("Missing productId or productName");
  }

  const ledger = await loadLedger();
  const event: BuildMealFeedbackEvent = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    mealKey: input.mealKey,
    ingredientKey: input.ingredientKey,
    action: input.action,
    productId: input.productId,
    productName: input.productName,
    userRef: input.userRef ?? null,
    note: input.note,
  };

  ledger.events.push(event);
  ledger.updatedAt = event.createdAt;
  await writeJsonFile(LEDGER_FILE, ledger);

  const targetUserRef = input.userRef ?? null;
  const runtime = targetUserRef
    ? await rebuildBuildMealTrainingRuntime(targetUserRef)
    : await rebuildBuildMealTrainingRuntime();
  return { event, training: runtime };
}

function validUnit(value: unknown): BuildMealUnit {
  const unit = String(value || "piece");
  return unit === "g" || unit === "kg" || unit === "litre" || unit === "litres"
    ? unit
    : "piece";
}

function productCategoryNames(product: Product): string[] {
  const categoryIds = Array.isArray(product.categories) ? product.categories.map(String) : [];
  const excluded = categoryIds.some((categoryId) =>
    EXCLUDED_CATEGORY_IDS.includes(categoryId as never)
  );
  if (excluded) {
    throw new Error(`Produit exclu du build_meal: ${product.name}`);
  }

  return [...new Set(
    categoryIds
      .map((categoryId) => CATEGORY_NAME_BY_ID[categoryId])
      .filter(Boolean)
  )];
}

function uniqueAliases(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export async function getBuildMealUserRecipes(
  userRef?: string | null
): Promise<BuildMealUserRecipesStore> {
  const store = await loadUserRecipesStore();
  return {
    ...store,
    recipes: (store.recipes || []).filter((recipe) => {
      const isGlobalRecipe = !recipe.userRef;
      const isMatchingUserRecipe = !!userRef && recipe.userRef === userRef;
      return isGlobalRecipe || isMatchingUserRecipe;
    }),
  };
}

export async function createBuildMealUserRecipe(input: {
  userRef?: string | null;
  key?: string;
  label: string;
  aliases?: string[];
  examples?: string[];
  sourceText?: string;
  defaultServings?: number;
  family?: string;
  baseRecipe?: boolean;
  ingredients: Array<{
    key?: string;
    label?: string;
    qty?: number;
    unit?: string;
    role?: string;
    optional?: boolean;
    isCore?: boolean;
    scaling?: "fixed" | "linear";
    conceptKey?: string;
    slot?: string;
    synonyms?: string[];
    categoryNames?: string[];
    productId: string;
    productName?: string;
    fallbackSearchTerms?: string[];
  }>;
}): Promise<{ recipe: BuildMealRecipeTraining; training: BuildMealTrainingSeed }> {
  const userRef = input.userRef ? String(input.userRef) : null;
  const label = String(input.label || "").trim();
  if (!label) throw new Error("Missing recipe label");
  if (!Array.isArray(input.ingredients) || !input.ingredients.length) {
    throw new Error("Une recette build_meal doit contenir au moins un produit catalogue.");
  }

  const usedIngredientKeys = new Set<string>();
  const ingredients: BuildMealIngredientTraining[] = [];
  const catalogUserRef = userRef || "local-dev";

  for (let index = 0; index < input.ingredients.length; index += 1) {
    const raw = input.ingredients[index];
    const productId = String(raw?.productId || "").trim();
    if (!productId) throw new Error("Missing productId for recipe ingredient");

    const product = await fetchFullProduct(catalogUserRef, productId);
    if (!product) throw new Error(`Produit catalogue introuvable: ${productId}`);

    const ingredientLabel = String(raw.label || raw.productName || product.name || "").trim();
    let ingredientKey = raw.key
      ? makeBuildMealIngredientKey(raw.key, index)
      : makeBuildMealIngredientKey(ingredientLabel, index);
    while (usedIngredientKeys.has(ingredientKey)) {
      ingredientKey = `${ingredientKey}_${index + 1}`.slice(0, 80);
    }
    usedIngredientKeys.add(ingredientKey);

    const qty = Number(raw.qty ?? 1);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const categoryNames = Array.isArray(raw.categoryNames) && raw.categoryNames.length
      ? raw.categoryNames.map(String).filter(Boolean)
      : productCategoryNames(product);

    ingredients.push({
      key: ingredientKey,
      label: ingredientLabel,
      qty: safeQty,
      unit: validUnit(raw.unit),
      role: (raw.role as BuildMealIngredientTraining["role"]) || (index === 0 ? "base" : "principal"),
      optional: Boolean(raw.optional),
      isCore: raw.isCore !== false,
      scaling: raw.scaling || "fixed",
      conceptKey: raw.conceptKey ? makeBuildMealKey(raw.conceptKey) : makeBuildMealKey(ingredientLabel),
      slot: raw.slot || (index === 0 ? "base" : "modifier"),
      synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.map(String).filter(Boolean) : undefined,
      categoryNames,
      preferredProductId: String(product.id),
      preferredProductName: product.name,
      fallbackSearchTerms: uniqueAliases([
        ingredientLabel,
        product.name,
        ...(raw.fallbackSearchTerms || []),
      ]),
    });
  }

  const store = await loadUserRecipesStore();
  const seed = await loadSeedTraining();
  const existingRecipes = [
    ...(seed.meals || []),
    ...(store.recipes || []).filter((recipe) => {
      const isGlobalRecipe = !recipe.userRef;
      const isMatchingUserRecipe = !!userRef && recipe.userRef === userRef;
      return isGlobalRecipe || isMatchingUserRecipe;
    }),
  ];
  const familyInference = inferBuildMealFamily({
    label,
    sourceText: input.sourceText,
    requestedFamily: input.family,
    ingredients,
    existingRecipes,
  });

  const recipe: BuildMealRecipeTraining = {
    key: input.key ? makeBuildMealKey(input.key) : makeBuildMealKey(label),
    label,
    aliases: uniqueAliases([
      label,
      normalizeText(label),
      ...(input.aliases || []),
      ...(input.sourceText ? [input.sourceText] : []),
    ]),
    examples: uniqueAliases([
      ...(input.examples || []),
      ...(input.sourceText ? [input.sourceText] : []),
    ]),
    family: familyInference.family,
    familySource: familyInference.source,
    familyConfidence: familyInference.confidence,
    familyReasons: familyInference.reasons,
    baseRecipe: Boolean(input.baseRecipe),
    source: "user",
    userRef,
    createdFromText: input.sourceText,
    defaultServings:
      input.defaultServings != null && Number.isFinite(Number(input.defaultServings)) && Number(input.defaultServings) > 0
        ? Number(input.defaultServings)
        : 2,
    ingredients,
  };

  const now = new Date().toISOString();
  store.recipes = (store.recipes || []).filter((item) =>
    !(item.key === recipe.key && (item.userRef || null) === userRef)
  );
  store.recipes.push(recipe);
  store.updatedAt = now;
  await writeJsonFile(USER_RECIPES_FILE, store);

  const training = await rebuildBuildMealTrainingRuntime(userRef);
  return { recipe, training };
}
