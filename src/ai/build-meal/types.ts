export type BuildMealUnit = "piece" | "g" | "kg" | "litre" | "litres";

export type BuildMealRole =
  | "base"
  | "principal"
  | "garniture"
  | "condiment"
  | "sauce"
  | "side"
  | "other";

export type BuildMealScaling = "fixed" | "linear";

export type BuildMealRecipeDraftStatus = "none" | "suggested";

export type BuildMealFamilySource =
  | "provided"
  | "name_rule"
  | "ingredient_rule"
  | "existing_family"
  | "generic";

export type BuildMealIngredientTraining = {
  key: string;
  label: string;
  qty: number;
  unit: BuildMealUnit;
  role: BuildMealRole;
  optional: boolean;
  isCore: boolean;
  scaling?: BuildMealScaling;
  conceptKey?: string;
  slot?: string;
  synonyms?: string[];
  requiresTokenMatch?: boolean;
  categoryNames?: string[];
  preferredProductId?: string;
  preferredProductName?: string;
  fallbackSearchTerms?: string[];
  bannedProductIds?: string[];
  bannedProductNames?: string[];
};

export type BuildMealRecipeTraining = {
  key: string;
  label: string;
  aliases: string[];
  examples?: string[];
  family?: string;
  familySource?: BuildMealFamilySource;
  familyConfidence?: number;
  familyReasons?: string[];
  baseRecipe?: boolean;
  source?: "seed" | "user";
  userRef?: string | null;
  createdFromText?: string;
  defaultServings: number;
  ingredients: BuildMealIngredientTraining[];
};

export type BuildMealTrainingSeed = {
  version: number;
  requestPatterns: string[];
  servingsWords: Record<string, number>;
  meals: BuildMealRecipeTraining[];
};

export type BuildMealFeedbackAction = "prefer_product" | "ban_product";

export type BuildMealFeedbackEvent = {
  id: string;
  createdAt: string;
  mealKey: string;
  ingredientKey: string;
  action: BuildMealFeedbackAction;
  productId?: string;
  productName?: string;
  userRef?: string | null;
  note?: string;
};

export type BuildMealFeedbackLedger = {
  version: number;
  updatedAt: string;
  events: BuildMealFeedbackEvent[];
};

export type BuildMealRecipeCandidate = {
  mealKey: string;
  mealLabel: string;
  matchedText: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  source: "alias" | "example" | "generated" | "learned";
};

export type BuildMealLearnedExample = {
  mealKey: string;
  text: string;
  normalizedText: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  userRefs?: string[];
};

export type BuildMealLearnedExamplesStore = {
  version: number;
  updatedAt: string;
  items: BuildMealLearnedExample[];
};

export type BuildMealUnknownRecipeRecord = {
  normalizedText: string;
  sampleText: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  userRefs?: string[];
  topCandidates?: BuildMealRecipeCandidate[];
};

export type BuildMealUnknownRecipeInbox = {
  version: number;
  updatedAt: string;
  items: BuildMealUnknownRecipeRecord[];
};

export type BuildMealUserRecipesStore = {
  version: number;
  updatedAt: string;
  recipes: BuildMealRecipeTraining[];
};

export type BuildMealUnknownRecipeDraft = {
  status: BuildMealRecipeDraftStatus;
  family?: string;
  baseMealKey?: string;
  baseMealLabel?: string;
  confidence: number;
  ingredients: BuildMealIngredientTraining[];
};

export type BuildMealUnknownRecipeContext = {
  text: string;
  normalizedText: string;
  suggestedMealKey: string;
  suggestedLabel: string;
  suggestedFamily?: string;
  familySource?: BuildMealFamilySource;
  familyConfidence?: number;
  familyReasons?: string[];
  servings: number;
  candidates: BuildMealRecipeCandidate[];
  draft?: BuildMealUnknownRecipeDraft;
};

export type BuildMealDetectedRequest = {
  normalizedText: string;
  servings: number;
  matchedAlias: string;
  recipe: BuildMealRecipeTraining;
  confidence: number;
  strategy: "lexical" | "semantic" | "hybrid";
  candidates: BuildMealRecipeCandidate[];
};

export type BuildMealResolvedIngredient = {
  ingredient: BuildMealIngredientTraining;
  requestedQty: number;
  productId: string;
  productName: string;
};

export type BuildMealMissingIngredient = {
  ingredientKey?: string;
  ingredient: string;
  optional: boolean;
  reason?: string;
};

export type BuildMealFeedbackIngredientContext = {
  key: string;
  label: string;
  qty: number;
  unit: BuildMealUnit;
  role: BuildMealRole;
  optional: boolean;
  isCore: boolean;
  preferredProductId?: string;
  preferredProductName?: string;
  resolvedProductId?: string;
  resolvedProductName?: string;
  missing: boolean;
};

export type BuildMealFeedbackContext = {
  mealKey: string;
  mealLabel: string;
  servings: number;
  ingredients: BuildMealFeedbackIngredientContext[];
};

export type BuildMealResult = {
  ok: boolean;
  meal: string;
  mealKey?: string;
  servings: number;
  added: Array<{
    ingredientKey: string;
    ingredient: string;
    productId: string;
    productName: string;
    qty: number;
    confidence: string;
  }>;
  missing: BuildMealMissingIngredient[];
  resolvedItems: Array<{
    ingredientKey: string;
    ingredient: string;
    productId: string;
    productName: string;
    qty: number;
  }>;
  feedbackContext?: BuildMealFeedbackContext;
  unknownRecipe?: BuildMealUnknownRecipeContext;
  message: string;
};
