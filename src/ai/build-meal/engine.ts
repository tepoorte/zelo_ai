import { addProductToBasket, getCurrentBasket } from "../../swissdata/cart.js";
import { normalizeText } from "../../domain/normalizer.js";
import { computeBasketQty } from "../services/cart-quantity.service.js";
import { resolveCatalogProduct } from "./catalog-resolver.js";
import { getBuildMealTrainingRuntime } from "./training.service.js";
import { rememberUnknownBuildMealRequest } from "./learning.service.js";
import {
  detectRecipeRequest,
  getRecipeCandidates,
  looksLikeMealRequest,
} from "./recipe-memory.js";
import { buildUnknownRecipeContext } from "./recipe-knowledge.service.js";
import type {
  BuildMealDetectedRequest,
  BuildMealFeedbackContext,
  BuildMealIngredientTraining,
  BuildMealMissingIngredient,
  BuildMealRecipeTraining,
  BuildMealResult,
  BuildMealTrainingSeed,
} from "./types.js";

function detectServings(normalizedText: string, training: BuildMealTrainingSeed): number | null {
  const numberMatch =
    normalizedText.match(/\bpour\s+(\d+)\b/) ||
    normalizedText.match(/\b(\d+)\s*(?:personnes?|pers|personne)\b/);
  if (numberMatch) {
    const value = Number(numberMatch[1]);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  for (const [word, value] of Object.entries(training.servingsWords || {})) {
    const regexes = [
      new RegExp(`\\bpour\\s+${word}\\b`, "i"),
      new RegExp(`\\b${word}\\s+(?:personnes?|pers|personne)\\b`, "i"),
    ];
    if (regexes.some((regex) => regex.test(normalizedText))) {
      return value;
    }
  }

  return null;
}

function buildUserMessage(
  meal: string,
  added: Array<{ productName: string }>,
  missing: BuildMealMissingIngredient[]
): string {
  const lines: string[] = [];

  if (added.length) {
    lines.push(`J’ai ajouté des ingrédients pour préparer « ${meal} » :`);
    lines.push("");
    for (const item of added) {
      lines.push(`• ${item.productName}`);
    }
  }

  if (missing.length) {
    if (lines.length) lines.push("");
    lines.push("Ingrédients manquants :");
    for (const item of missing) {
      lines.push(`- ${item.ingredient}`);
    }
  }

  return (
    lines.join("\n") ||
    `Je n’ai pas trouvé assez d’ingrédients fiables pour "${meal}".`
  );
}

function scaleIngredientQty(
  ingredient: BuildMealIngredientTraining,
  servings: number,
  defaultServings: number
): number {
  const scaling = ingredient.scaling || "fixed";
  if (scaling === "fixed" || defaultServings <= 0) {
    return ingredient.qty;
  }

  const scaled = (ingredient.qty * servings) / defaultServings;
  if (ingredient.unit === "piece") {
    return Math.max(1, Math.ceil(scaled));
  }
  return Math.max(ingredient.qty, scaled);
}

async function addResolvedProducts(
  userRef: string,
  recipe: BuildMealRecipeTraining,
  servings: number
): Promise<{
  added: BuildMealResult["added"];
  missing: BuildMealMissingIngredient[];
}> {
  const basket = await getCurrentBasket(userRef);
  const basketId = basket.id;
  const added: BuildMealResult["added"] = [];
  const missing: BuildMealMissingIngredient[] = [];

  for (const ingredient of recipe.ingredients) {
    const product = await resolveCatalogProduct(userRef, ingredient);
    if (!product) {
      missing.push({
        ingredientKey: ingredient.key,
        ingredient: ingredient.label,
        optional: ingredient.optional,
        reason: `Aucun produit catalogue fiable pour ${ingredient.label}`,
      });
      continue;
    }

    const requestedQty = scaleIngredientQty(
      ingredient,
      servings,
      recipe.defaultServings
    );
    const basketQty = computeBasketQty(product, requestedQty, ingredient.unit);

    await addProductToBasket(userRef, basketId, product.id, basketQty);

    added.push({
      ingredientKey: ingredient.key,
      ingredient: ingredient.label,
      productId: String(product.id),
      productName: product.name,
      qty: basketQty,
      confidence: "TRAINED",
    });
  }

  return { added, missing };
}

function buildFeedbackContext(
  recipe: BuildMealRecipeTraining,
  servings: number,
  added: BuildMealResult["added"],
  missing: BuildMealMissingIngredient[]
): BuildMealFeedbackContext {
  const addedByKey = new Map(added.map((item) => [item.ingredientKey, item]));
  const missingKeys = new Set(
    missing.map((item) => item.ingredientKey).filter(Boolean) as string[]
  );

  return {
    mealKey: recipe.key,
    mealLabel: recipe.label,
    servings,
    ingredients: recipe.ingredients.map((ingredient) => {
      const addedItem = addedByKey.get(ingredient.key);
      return {
        key: ingredient.key,
        label: ingredient.label,
        qty: ingredient.qty,
        unit: ingredient.unit,
        role: ingredient.role,
        optional: ingredient.optional,
        isCore: ingredient.isCore,
        preferredProductId: ingredient.preferredProductId,
        preferredProductName: ingredient.preferredProductName,
        resolvedProductId: addedItem?.productId,
        resolvedProductName: addedItem?.productName,
        missing: missingKeys.has(ingredient.key),
      };
    }),
  };
}

export class BuildMealEngine {
  static async detectRequest(
    userRef: string | undefined,
    userText: string,
    options?: { force?: boolean }
  ): Promise<BuildMealDetectedRequest | null> {
    const training = await getBuildMealTrainingRuntime(userRef ?? null);
    const normalizedText = normalizeText(userText);
    if (!normalizedText) return null;
    const servings = detectServings(normalizedText, training) ?? 2;
    return await detectRecipeRequest(userText, training, servings, options);
  }

  static async preview(
    userText: string,
    userRef?: string
  ): Promise<{
    matched: boolean;
    normalizedText: string;
    servings?: number;
    mealKey?: string;
    mealLabel?: string;
    matchedAlias?: string;
    confidence?: number;
    strategy?: string;
    candidates?: BuildMealDetectedRequest["candidates"];
    ingredients?: BuildMealRecipeTraining["ingredients"];
    unknownRecipe?: BuildMealResult["unknownRecipe"];
  }> {
    const training = await getBuildMealTrainingRuntime(userRef);
    const candidates = await getRecipeCandidates(userText, training);
    const detection = await this.detectRequest(userRef, userText, { force: true });
    if (!detection) {
      const normalizedText = normalizeText(userText);
      const servings = detectServings(normalizedText, training) ?? 2;
      return {
        matched: false,
        normalizedText,
        candidates,
        unknownRecipe: buildUnknownRecipeContext({
          userText,
          normalizedText,
          servings,
          training,
          candidates,
        }),
      };
    }

    return {
      matched: true,
      normalizedText: detection.normalizedText,
      servings: detection.servings,
      mealKey: detection.recipe.key,
      mealLabel: detection.recipe.label,
      matchedAlias: detection.matchedAlias,
      confidence: detection.confidence,
      strategy: detection.strategy,
      candidates: detection.candidates,
      ingredients: detection.recipe.ingredients,
    };
  }

  static async handleBuildMealFromText(
    userRef: string,
    userText: string
  ): Promise<BuildMealResult> {
    const detection = await this.detectRequest(userRef, userText, { force: true });
    if (!detection) {
      const training = await getBuildMealTrainingRuntime(userRef);
      const candidates = await getRecipeCandidates(userText, training);
      const normalizedText = normalizeText(userText);
      const servings = detectServings(normalizedText, training) ?? 2;
      const unknownRecipe = buildUnknownRecipeContext({
        userText,
        normalizedText,
        servings,
        training,
        candidates,
      });
      await rememberUnknownBuildMealRequest({
        text: userText,
        normalizedText,
        userRef,
        topCandidates: candidates,
      });

      return {
        ok: false,
        meal: userText.trim(),
        servings,
        added: [],
        missing: [],
        resolvedItems: [],
        unknownRecipe,
        message: "Je n’ai pas encore appris cette recette.",
      };
    }

    return await this.handleRecipe(userRef, detection.recipe, detection.servings);
  }

  static async tryHandleDetectedRequest(
    userRef: string,
    userText: string
  ): Promise<BuildMealResult | null> {
    const detection = await this.detectRequest(userRef, userText, { force: false });
    if (!detection) {
      const training = await getBuildMealTrainingRuntime(userRef);
      const normalizedText = normalizeText(userText);
      if (!normalizedText || !looksLikeMealRequest(normalizedText, training)) {
        return null;
      }

      const candidates = await getRecipeCandidates(userText, training);
      const servings = detectServings(normalizedText, training) ?? 2;
      const unknownRecipe = buildUnknownRecipeContext({
        userText,
        normalizedText,
        servings,
        training,
        candidates,
      });
      await rememberUnknownBuildMealRequest({
        text: userText,
        normalizedText,
        userRef,
        topCandidates: candidates,
      });

      return {
        ok: false,
        meal: userText.trim(),
        servings,
        added: [],
        missing: [],
        resolvedItems: [],
        unknownRecipe,
        message: "Je n’ai pas encore appris cette recette.",
      };
    }
    return await this.handleRecipe(userRef, detection.recipe, detection.servings);
  }

  private static async handleRecipe(
    userRef: string,
    recipe: BuildMealRecipeTraining,
    servings: number
  ): Promise<BuildMealResult> {
    const { added, missing } = await addResolvedProducts(userRef, recipe, servings);
    const resolvedItems = added.map((item) => ({
      ingredientKey: item.ingredientKey,
      ingredient: item.ingredient,
      productId: item.productId,
      productName: item.productName,
      qty: item.qty,
    }));

    const ok = added.length > 0;
    const feedbackContext = buildFeedbackContext(recipe, servings, added, missing);

    return {
      ok,
      meal: recipe.label,
      mealKey: recipe.key,
      servings,
      added,
      missing,
      resolvedItems,
      feedbackContext,
      message: buildUserMessage(recipe.label, added, missing),
    };
  }
}
