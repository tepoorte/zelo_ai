/*import {
  cosineSimilarity,
  embedQueryV2,
} from "./catalog-index.v2.js";
import type {
    CandidateSourceV2,
  MealIngredientV2,
  ProductIndexDocV2,
  RankedCandidateV2,
} from "./meal-types.v2.js";

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function safeIncludes(text: string, term: string): boolean {
  return text.includes(term.toLowerCase().trim());
}

function lexicalOverlapScore(ingredient: MealIngredientV2, doc: ProductIndexDocV2): number {
  const hints = ingredient.matchingHints || {};
  const terms = uniq([
    ingredient.label,
    ingredient.canonicalLabel,
    ...(hints.synonyms || []),
    ...(hints.broaderTerms || []),
    ...(hints.narrowerTerms || []),
  ])
    .map(t => t.toLowerCase().trim())
    .filter(Boolean);

  if (!terms.length) return 0;

  let score = 0;

  for (const term of terms) {
    if (safeIncludes(doc.normalizedName, term)) score += 1.0;
    else if (safeIncludes(doc.searchableText, term)) score += 0.5;
  }

  return score / terms.length;
}

function categoryHintScore(ingredient: MealIngredientV2, doc: ProductIndexDocV2): number {
  const hints = ingredient.matchingHints || {};
  let score = 0;

  const preferredIds = hints.preferredCategoryIds || [];
  const preferredNames = (hints.preferredCategoryNames || []).map(x => x.toLowerCase());

  if (preferredIds.some(id => doc.normalizedCategoryIds.includes(id))) score += 0.7;
  if (preferredNames.some(name => doc.normalizedCategoryNames.some(n => n.includes(name)))) score += 0.5;

  const forbiddenIds = hints.forbiddenCategoryIds || [];
  const forbiddenNames = (hints.forbiddenCategoryNames || []).map(x => x.toLowerCase());

  if (forbiddenIds.some(id => doc.normalizedCategoryIds.includes(id))) score -= 1.0;
  if (forbiddenNames.some(name => doc.normalizedCategoryNames.some(n => n.includes(name)))) score -= 0.8;

  return score;
}

function roleCompatScore(ingredient: MealIngredientV2, doc: ProductIndexDocV2): number {
  const role = ingredient.role;
  const f = doc.facets;

  if (role === "condiment" || role === "sauce") {
    return f.condimentness * 0.7 + f.sauceness * 0.7 - f.preparedness * 0.4;
  }

  if (role === "base") {
    return f.breadness * 0.5 + f.ingredientness * 0.6 - f.preparedness * 0.5;
  }

  if (role === "principal") {
    return f.ingredientness * 0.7 + f.meatness * 0.4 + f.cheeseness * 0.2 - f.preparedness * 0.5;
  }

  if (role === "garniture") {
    return f.ingredientness * 0.6 + f.cheeseness * 0.3 + f.sauceness * 0.2 - f.preparedness * 0.45;
  }

  return f.ingredientness * 0.5 - f.preparedness * 0.3;
}

function penaltyScore(ingredient: MealIngredientV2, doc: ProductIndexDocV2): number {
  const hints = ingredient.matchingHints || {};
  let penalty = 0;

  for (const term of (hints.avoidTerms || []).map(t => t.toLowerCase())) {
    if (safeIncludes(doc.searchableText, term)) penalty += 0.9;
  }

  if (doc.facets.containerness >= 0.8) penalty += 1.5;

  if ((hints.productForm || "unknown") === "ingredient") {
    penalty += doc.facets.preparedness * 0.9;
  }

  if ((hints.productForm || "unknown") === "condiment") {
    penalty += Math.max(0, 0.6 - doc.facets.condimentness);
  }

  return penalty;
}

function toCandidate(
  ingredient: MealIngredientV2,
  doc: ProductIndexDocV2,
  semanticScore: number,
  lexicalScore: number
): RankedCandidateV2 {
  const catScore = categoryHintScore(ingredient, doc);
  const roleScore = roleCompatScore(ingredient, doc);
  const pen = penaltyScore(ingredient, doc);

  const score =
    lexicalScore * 0.35 +
    semanticScore * 0.30 +
    catScore * 0.15 +
    roleScore * 0.20 -
    pen;

  const reasons: string[] = [];
  if (lexicalScore > 0.8) reasons.push("strong lexical match");
  if (semanticScore > 0.7) reasons.push("strong semantic match");
  if (catScore > 0.3) reasons.push("category hint match");
  if (roleScore > 0.3) reasons.push("role-compatible");
  if (pen > 0.5) reasons.push("penalized");

  return {
    product: doc.product,
    indexDoc: doc,
    score,
    lexicalScore,
    semanticScore,
    categoryScore: catScore,
    roleScore,
    penaltyScore: pen,
    source: [],
    reasons,
  };
}

export async function retrieveMealCandidatesV2(
  ingredient: MealIngredientV2,
  docs: ProductIndexDocV2[],
  topK = 20
): Promise<RankedCandidateV2[]> {
  const { queryVector, textVector } = await embedQueryV2(
    ingredient.canonicalLabel || ingredient.label,
    [
      ingredient.mealContext,
      ingredient.notes,
      ...(ingredient.matchingHints?.synonyms || []),
      ...(ingredient.matchingHints?.broaderTerms || []),
    ]
      .filter(Boolean)
      .join(" ")
  );

  const ranked = docs.map((doc) => {
    const lexicalScore = lexicalOverlapScore(ingredient, doc);

    const nameSim = cosineSimilarity(queryVector, doc.vectors?.name || []);
    const textSim = cosineSimilarity(textVector, doc.vectors?.text || []);
    const semanticScore = nameSim * 0.6 + textSim * 0.4;

    const candidate = toCandidate(ingredient, doc, semanticScore, lexicalScore);

    const source: CandidateSourceV2[] = [];

    if (lexicalScore > 0.2) source.push("lexical");
    if (semanticScore > 0.2) source.push("semantic");
    if (candidate.categoryScore !== 0) source.push("category");

    candidate.source = source.length
  ? source
  : ["fallback"];
    return candidate;
  });

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}*/