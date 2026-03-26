/*import { ensureCatalogIndexV2 } from "./catalog-index.v2.js";
import { retrieveMealCandidatesV2 } from "./meal-candidate-retriever.v2.js";
import {
  decideCandidateConfidenceV2,
  rerankMealCandidatesV2,
} from "./meal-reranker.v2.js";
import type {
  IngredientMatchResultV2,
  MealIngredientV2,
  MealMatchSummaryV2,
} from "./meal-types.v2.js";

function buildMissingReason(ingredient: MealIngredientV2): string {
  if (ingredient.isCore) {
    return `Missing core ingredient: ${ingredient.label}`;
  }
  return `Missing optional ingredient: ${ingredient.label}`;
}

export async function matchIngredientToCatalogV2(
  userRef: string,
  ingredient: MealIngredientV2
): Promise<IngredientMatchResultV2> {
  const docs = await ensureCatalogIndexV2(userRef);

  const retrieved = await retrieveMealCandidatesV2(ingredient, docs, 20);
  const reranked = rerankMealCandidatesV2(ingredient, retrieved, 10);
  const confidence = decideCandidateConfidenceV2(ingredient, reranked);

  const accepted =
    confidence === "EXACT" || confidence === "GOOD"
      ? reranked[0]
      : confidence === "WEAK" && !ingredient.isCore
      ? reranked[0]
      : undefined;

  const result: IngredientMatchResultV2 = {
    ingredient,
    candidates: reranked,
    accepted,
    confidence,
    missingReason: accepted ? undefined : buildMissingReason(ingredient),
  };

  const best = reranked[0];
  console.log("[MEAL_MATCH_V2]", {
    ingredient: ingredient.label,
    role: ingredient.role,
    isCore: ingredient.isCore,
    confidence,
    chosen: best?.product?.name,
    score: best?.score,
    lexical: best?.lexicalScore,
    semantic: best?.semanticScore,
    category: best?.categoryScore,
    penalty: best?.penaltyScore,
    reasons: best?.reasons,
  });

  return result;
}

export async function matchMealIngredientsV2(
  userRef: string,
  ingredients: MealIngredientV2[],
  meal: string,
  servings: number
): Promise<MealMatchSummaryV2> {
  const matches: IngredientMatchResultV2[] = [];

  for (const ingredient of ingredients) {
    const match = await matchIngredientToCatalogV2(userRef, ingredient);
    matches.push(match);
  }

  return {
    meal,
    servings,
    matches,
    accepted: matches.filter((m) => !!m.accepted),
    missing: matches.filter((m) => !m.accepted),
  };
}*/