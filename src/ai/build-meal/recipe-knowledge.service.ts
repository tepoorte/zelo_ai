import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import {
  familyFacets,
  inferBuildMealFamily,
  relatedFamilyScore,
  shouldTransferIngredientToFamily,
} from "./recipe-family.service.js";
import type {
  BuildMealIngredientTraining,
  BuildMealRecipeCandidate,
  BuildMealRecipeTraining,
  BuildMealTrainingSeed,
  BuildMealUnknownRecipeContext,
  BuildMealUnknownRecipeDraft,
} from "./types.js";

type ConceptEntry = {
  key: string;
  terms: string[];
  ingredient: BuildMealIngredientTraining;
};

type FamilyEntry = {
  key: string;
  terms: string[];
  baseRecipe: BuildMealRecipeTraining;
};

type FamilyMatch = FamilyEntry & {
  matchKind: "direct" | "related";
  targetFamily: string;
  score: number;
};

const LEADING_ARTICLES = new Set([
  "un",
  "une",
  "des",
  "du",
  "de",
  "la",
  "le",
  "les",
  "l",
  "d",
]);

const REQUEST_MODIFIER_CONCEPT_ALIASES: Array<{
  terms: string[];
  conceptKeys: string[];
}> = [
  { terms: ["lorraine"], conceptKeys: ["lardons", "lardon"] },
  { terms: ["hawai", "hawaien", "hawaienne", "hawaiien", "hawaiienne"], conceptKeys: ["ananas"] },
  { terms: ["forestiere", "forestier"], conceptKeys: ["champignons", "champignon"] },
  { terms: ["bolognaise", "bolognese"], conceptKeys: ["viande_hachee", "boeuf_hache", "sauce_tomate", "sauce_tomates"] },
];

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => normalizeText(value || "")).filter(Boolean))];
}

export function makeBuildMealKey(label: string): string {
  const normalized = normalizeText(label)
    .replace(/\b(?:un|une|des|du|de la|de l|le|la|les)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    normalized
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "recette"
  );
}

export function makeBuildMealIngredientKey(label: string, fallbackIndex = 0): string {
  const key = makeBuildMealKey(label);
  return key || `ingredient_${fallbackIndex + 1}`;
}

function stripRequestPattern(text: string, training: BuildMealTrainingSeed): string {
  let value = normalizeText(text);
  const patterns = [...(training.requestPatterns || [])]
    .map((pattern) => normalizeText(pattern))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const pattern of patterns) {
    if (value.startsWith(pattern)) {
      value = value.slice(pattern.length).trim();
      break;
    }
  }

  value = value
    .replace(/\bpour\s+\d+\b/g, " ")
    .replace(/\b\d+\s*(?:personnes?|pers|personne)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = value.split(" ").filter(Boolean);
  while (tokens.length && LEADING_ARTICLES.has(tokens[0])) {
    tokens.shift();
  }

  return tokens.join(" ").trim() || normalizeText(text);
}

function recipeFamily(recipe: BuildMealRecipeTraining): string {
  if (recipe.family) return normalizeText(recipe.family);
  return inferBuildMealFamily({
    label: recipe.label,
    ingredients: recipe.ingredients,
  }).family;
}

function conceptKeyForIngredient(ingredient: BuildMealIngredientTraining): string {
  return normalizeText(
    ingredient.conceptKey ||
      ingredient.label ||
      ingredient.preferredProductName ||
      ingredient.key
  );
}

function conceptTerms(ingredient: BuildMealIngredientTraining): string[] {
  return uniqueStrings([
    ingredient.conceptKey,
    ingredient.label,
    ingredient.preferredProductName,
    ...(ingredient.synonyms || []),
    ...(ingredient.fallbackSearchTerms || []),
  ]);
}

function recipeModifierText(recipe: BuildMealRecipeTraining): string {
  const familyTokens = new Set(tokenizeForMatch(recipeFamily(recipe)));
  return tokenizeForMatch(recipe.label)
    .filter((token) => !familyTokens.has(token))
    .join(" ");
}

function isRecipeModifierIngredient(
  recipe: BuildMealRecipeTraining,
  ingredient: BuildMealIngredientTraining
): boolean {
  const modifierText = recipeModifierText(recipe);
  if (!modifierText) return false;
  return conceptTerms(ingredient).some((term) => hasTermInText(modifierText, term));
}

function familyTerms(recipe: BuildMealRecipeTraining): string[] {
  const family = recipeFamily(recipe);
  return uniqueStrings([
    family,
    recipe.label,
    ...(recipe.aliases || []),
  ]);
}

function hasTermInText(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (normalizedText.includes(normalizedTerm)) return true;

  const textTokens = new Set(tokenizeForMatch(normalizedText));
  const termTokens = tokenizeForMatch(normalizedTerm);
  return termTokens.length > 0 && termTokens.every((token) => textTokens.has(token));
}

function aliasedConceptKeysForText(normalizedText: string): Set<string> {
  const keys = new Set<string>();
  for (const item of REQUEST_MODIFIER_CONCEPT_ALIASES) {
    if (item.terms.some((term) => hasTermInText(normalizedText, term))) {
      for (const conceptKey of item.conceptKeys) {
        keys.add(makeBuildMealKey(conceptKey));
      }
    }
  }
  return keys;
}

function cloneIngredient(
  ingredient: BuildMealIngredientTraining,
  keySuffix?: string
): BuildMealIngredientTraining {
  const cloned = JSON.parse(JSON.stringify(ingredient)) as BuildMealIngredientTraining;
  if (keySuffix) {
    cloned.key = `${cloned.key}_${keySuffix}`.replace(/_+/g, "_").slice(0, 80);
  }
  return cloned;
}

function buildConceptIndex(training: BuildMealTrainingSeed): ConceptEntry[] {
  const byKey = new Map<string, ConceptEntry>();

  for (const recipe of training.meals || []) {
    for (const ingredient of recipe.ingredients || []) {
      if (!ingredient.preferredProductId && !ingredient.preferredProductName) continue;

      const key = conceptKeyForIngredient(ingredient);
      if (!key) continue;

      const current = byKey.get(key);
      const candidate: ConceptEntry = {
        key,
        terms: conceptTerms(ingredient),
        ingredient,
      };

      if (!current || Boolean(ingredient.preferredProductId) && !current.ingredient.preferredProductId) {
        byKey.set(key, candidate);
      }
    }
  }

  return [...byKey.values()];
}

function buildFamilyIndex(training: BuildMealTrainingSeed): FamilyEntry[] {
  const byFamily = new Map<string, FamilyEntry>();

  for (const recipe of training.meals || []) {
    const family = recipeFamily(recipe);
    if (!family) continue;

    const current = byFamily.get(family);
    const candidate: FamilyEntry = {
      key: family,
      terms: familyTerms(recipe),
      baseRecipe: recipe,
    };

    if (!current) {
      byFamily.set(family, candidate);
      continue;
    }

    if (recipe.baseRecipe && !current.baseRecipe.baseRecipe) {
      byFamily.set(family, candidate);
      continue;
    }

    const currentIngredientCount = current.baseRecipe.ingredients?.length || 0;
    const candidateIngredientCount = recipe.ingredients?.length || 0;
    if (!current.baseRecipe.baseRecipe && candidateIngredientCount < currentIngredientCount) {
      byFamily.set(family, candidate);
    }
  }

  return [...byFamily.values()];
}

function findBestFamily(
  normalizedLabel: string,
  training: BuildMealTrainingSeed,
  targetFamily?: string
): FamilyMatch | null {
  const families = buildFamilyIndex(training);
  const directMatches = families
    .map((family) => ({
      family,
      score: family.terms.reduce(
        (best, term) => Math.max(best, hasTermInText(normalizedLabel, term) ? normalizeText(term).length : 0),
        0
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (directMatches[0]) {
    return {
      ...directMatches[0].family,
      matchKind: "direct",
      targetFamily: targetFamily || directMatches[0].family.key,
      score: directMatches[0].score,
    };
  }

  const normalizedTargetFamily = normalizeText(targetFamily || "");
  if (!normalizedTargetFamily) return null;

  const exactFamily = families.find((family) => family.key === normalizedTargetFamily);
  if (exactFamily) {
    return {
      ...exactFamily,
      matchKind: "direct",
      targetFamily: normalizedTargetFamily,
      score: 100,
    };
  }

  const relatedMatches = families
    .map((family) => ({
      family,
      score: relatedFamilyScore(normalizedTargetFamily, family.key),
    }))
    .filter((item) => item.score >= 0.45)
    .sort((left, right) => right.score - left.score);

  if (!relatedMatches[0]) return null;

  return {
    ...relatedMatches[0].family,
    matchKind: "related",
    targetFamily: normalizedTargetFamily,
    score: relatedMatches[0].score,
  };
}

function findExplicitConcepts(
  normalizedLabel: string,
  training: BuildMealTrainingSeed,
  baseRecipe?: BuildMealRecipeTraining
): BuildMealIngredientTraining[] {
  const baseConcepts = new Set(
    (baseRecipe?.ingredients || []).map((ingredient) => conceptKeyForIngredient(ingredient))
  );
  const aliasedConceptKeys = aliasedConceptKeysForText(normalizedLabel);

  return buildConceptIndex(training)
    .filter((concept) => !baseConcepts.has(concept.key))
    .filter((concept) =>
      concept.terms.some((term) => hasTermInText(normalizedLabel, term)) ||
      aliasedConceptKeys.has(makeBuildMealKey(concept.key))
    )
    .map((concept, index) => {
      const ingredient = cloneIngredient(concept.ingredient, `mod_${index + 1}`);
      ingredient.role = ingredient.role === "base" ? "garniture" : ingredient.role;
      ingredient.slot = ingredient.slot || "modifier";
      return ingredient;
    });
}

export function buildUnknownRecipeContext(input: {
  userText: string;
  normalizedText: string;
  servings: number;
  training: BuildMealTrainingSeed;
  candidates: BuildMealRecipeCandidate[];
}): BuildMealUnknownRecipeContext {
  const suggestedLabel = stripRequestPattern(input.userText, input.training);
  const normalizedLabel = normalizeText(suggestedLabel);
  const familyInference = inferBuildMealFamily({
    label: suggestedLabel,
    sourceText: input.userText,
    existingRecipes: input.training.meals,
  });
  const family = findBestFamily(normalizedLabel, input.training, familyInference.family);
  let draft: BuildMealUnknownRecipeDraft | undefined;

  if (family) {
    const ingredientsByConcept = new Map<string, BuildMealIngredientTraining>();

    for (const ingredient of family.baseRecipe.ingredients || []) {
      if (isRecipeModifierIngredient(family.baseRecipe, ingredient)) {
        continue;
      }
      if (
        family.matchKind === "related" &&
        !shouldTransferIngredientToFamily(ingredient, family.targetFamily)
      ) {
        continue;
      }
      ingredientsByConcept.set(conceptKeyForIngredient(ingredient), cloneIngredient(ingredient));
    }

    for (const ingredient of findExplicitConcepts(normalizedLabel, input.training, family.baseRecipe)) {
      ingredientsByConcept.set(conceptKeyForIngredient(ingredient), ingredient);
    }

    const ingredients = [...ingredientsByConcept.values()];
    if (ingredients.length) {
      draft = {
        status: "suggested",
        family: family.targetFamily || family.key,
        baseMealKey: family.baseRecipe.key,
        baseMealLabel: family.baseRecipe.label,
        confidence:
          family.matchKind === "related" ? Math.min(0.7, 0.48 + family.score * 0.28) :
          ingredients.length > (family.baseRecipe.ingredients?.length || 0) ? 0.82 : 0.68,
        ingredients,
      };
    }
  }

  return {
    text: input.userText,
    normalizedText: input.normalizedText,
    suggestedMealKey: makeBuildMealKey(suggestedLabel),
    suggestedLabel,
    suggestedFamily: familyInference.family,
    familySource: familyInference.source,
    familyConfidence: familyInference.confidence,
    familyReasons: familyInference.reasons,
    servings: input.servings,
    candidates: input.candidates,
    draft,
  };
}
