/*import type {
  MealIngredientV2,
  RankedCandidateV2,
} from "./meal-types.v2.js";

function hasAny(text: string, terms: string[]): boolean {
  const t = text.toLowerCase();
  return terms.some(term => t.includes(term.toLowerCase()));
}

function exactNameBoost(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  const name = c.indexDoc.normalizedName;
  const baseTerms = [
    ingredient.label,
    ingredient.canonicalLabel,
    ...(ingredient.matchingHints?.synonyms || []),
  ]
    .map(x => x.toLowerCase().trim())
    .filter(Boolean);

  for (const term of baseTerms) {
    if (name === term) return 1.2;
    if (name.startsWith(term + " ") || name.endsWith(" " + term)) return 0.9;
    if (name.includes(term)) return 0.45;
  }

  return 0;
}

function preparedPenalty(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  const form = ingredient.matchingHints?.productForm || "unknown";
  if (form === "ingredient" || ingredient.isCore) {
    return c.indexDoc.facets.preparedness * 1.2;
  }
  return c.indexDoc.facets.preparedness * 0.4;
}

function containernessPenalty(c: RankedCandidateV2): number {
  return c.indexDoc.facets.containerness * 1.6;
}

function descriptionOnlyPenalty(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  const name = c.indexDoc.normalizedName;
  const desc = c.indexDoc.normalizedDescription;
  const terms = [
    ingredient.label,
    ingredient.canonicalLabel,
    ...(ingredient.matchingHints?.synonyms || []),
  ]
    .map(x => x.toLowerCase().trim())
    .filter(Boolean);

  const foundInName = terms.some(t => name.includes(t));
  const foundOnlyInDesc = !foundInName && terms.some(t => desc.includes(t));

  return foundOnlyInDesc ? 0.35 : 0;
}

function avoidTermsPenalty(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  const avoid = (ingredient.matchingHints?.avoidTerms || []).map(x => x.toLowerCase());
  if (!avoid.length) return 0;

  const text = c.indexDoc.searchableText;
  let p = 0;

  for (const term of avoid) {
    if (text.includes(term)) p += 0.8;
  }

  return p;
}

function categoryCoherenceBoost(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  const role = ingredient.role;
  const f = c.indexDoc.facets;

  if (role === "condiment" || role === "sauce") {
    return f.condimentness * 0.6 + f.sauceness * 0.4;
  }

  if (role === "base") {
    return f.breadness * 0.35 + f.ingredientness * 0.35;
  }

  if (role === "principal") {
    return f.meatness * 0.25 + f.cheeseness * 0.2 + f.ingredientness * 0.35;
  }

  if (role === "garniture") {
    return f.cheeseness * 0.2 + f.sauceness * 0.15 + f.ingredientness * 0.3;
  }

  return f.ingredientness * 0.25;
}

function impossibleCorePenalty(ingredient: MealIngredientV2, c: RankedCandidateV2): number {
  if (!ingredient.isCore) return 0;

  const text = c.indexDoc.searchableText;
  const strongTerms = [
    ingredient.label,
    ingredient.canonicalLabel,
    ...(ingredient.matchingHints?.synonyms || []),
  ]
    .map(x => x.toLowerCase().trim())
    .filter(Boolean);

  const hasStrongLexical = strongTerms.some(t => c.indexDoc.normalizedName.includes(t));
  if (hasStrongLexical) return 0;

  if (c.semanticScore > 0.65 && c.lexicalScore < 0.2) {
    return 0.9;
  }

  return 0;
}

export function rerankMealCandidatesV2(
  ingredient: MealIngredientV2,
  candidates: RankedCandidateV2[],
  topK = 10
): RankedCandidateV2[] {
  const reranked = candidates.map((c) => {
    const exactBoost = exactNameBoost(ingredient, c);
    const coherenceBoost = categoryCoherenceBoost(ingredient, c);

    const penalties =
      preparedPenalty(ingredient, c) +
      containernessPenalty(c) +
      descriptionOnlyPenalty(ingredient, c) +
      avoidTermsPenalty(ingredient, c) +
      impossibleCorePenalty(ingredient, c);

    const finalScore =
      c.score +
      exactBoost +
      coherenceBoost -
      penalties;

    const reasons = [...c.reasons];
    if (exactBoost > 0.8) reasons.push("exact-name-boost");
    if (coherenceBoost > 0.3) reasons.push("category-coherence");
    if (penalties > 0.8) reasons.push("strong-penalty");

    return {
      ...c,
      score: finalScore,
      penaltyScore: c.penaltyScore + penalties,
      reasons,
    };
  });

  return reranked
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function decideCandidateConfidenceV2(
  ingredient: MealIngredientV2,
  candidates: RankedCandidateV2[]
): "EXACT" | "GOOD" | "WEAK" | "NONE" {
  const best = candidates[0];
  if (!best) return "NONE";

  const name = best.indexDoc.normalizedName;
  const targetTerms = [
    ingredient.label,
    ingredient.canonicalLabel,
    ...(ingredient.matchingHints?.synonyms || []),
  ]
    .map(x => x.toLowerCase().trim())
    .filter(Boolean);

  const strongLexical = targetTerms.some(t => name.includes(t));

  if (best.score >= 1.4 && strongLexical) return "EXACT";
  if (best.score >= 0.95 && (strongLexical || best.lexicalScore >= 0.45)) return "GOOD";
  if (!ingredient.isCore && best.score >= 0.7) return "WEAK";
  if (ingredient.isCore && best.score >= 0.8 && strongLexical) return "GOOD";

  return "NONE";
}*/