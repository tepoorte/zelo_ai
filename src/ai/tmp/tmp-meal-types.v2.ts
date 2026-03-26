export type MealRoleV2 =
  | "base"
  | "principal"
  | "garniture"
  | "condiment"
  | "sauce"
  | "side"
  | "other";

export type ProductFormV2 =
  | "ingredient"
  | "prepared"
  | "condiment"
  | "base"
  | "unknown";

export type MatchConfidenceV2 = "EXACT" | "GOOD" | "WEAK" | "NONE";

export type MealMatchingHintsV2 = {
  synonyms?: string[];
  broaderTerms?: string[];
  narrowerTerms?: string[];
  avoidTerms?: string[];
  preferredCategoryIds?: string[];
  forbiddenCategoryIds?: string[];
  preferredCategoryNames?: string[];
  forbiddenCategoryNames?: string[];
  productForm?: ProductFormV2;
};

export type MealIngredientV2 = {
  label: string;
  canonicalLabel: string;
  qty: number;
  unit?: string;
  role: MealRoleV2;
  optional: boolean;
  isCore: boolean;
  mealContext?: string;
  notes?: string;
  matchingHints?: MealMatchingHintsV2;
};

export type MealBuildPlanV2 = {
  meal: string;
  servings: number;
  ingredients: MealIngredientV2[];
};

export type ProductCategoryV2 = {
  id: string;
  name?: string;
};

export type ProductMetadataEntryV2 = {
  key: string;
  value: unknown;
};

export type SwissdataProductV2 = {
  id: string;
  name: string;
  shortDescription?: string;
  description?: string;
  tags?: string[];
  size?: string | null;
  unit?: string | null;
  type?: string | null;
  priceType?: string | null;
  refWeight?: number | null;
  refWeightUnit?: string | null;
  categories?: string[];
  metadata?: ProductMetadataEntryV2[];
  defaultSupplier?: {
    id?: string;
    _id?: string;
    companyName?: string;
    firstname?: string;
    lastname?: string;
  };
};

export type ProductFacetScoresV2 = {
  ingredientness: number;
  preparedness: number;
  condimentness: number;
  containerness: number;
  breadness: number;
  cheeseness: number;
  meatness: number;
  sauceness: number;
};

export type ProductIndexDocV2 = {
  id: string;
  product: SwissdataProductV2;

  normalizedName: string;
  normalizedShortDescription: string;
  normalizedDescription: string;
  normalizedTags: string[];
  normalizedCategoryIds: string[];
  normalizedCategoryNames: string[];
  searchableText: string;
  tokens: string[];

  facets: ProductFacetScoresV2;

  vectors?: {
    name?: number[];
    text?: number[];
  };
};

export type CandidateSourceV2 = "lexical" | "semantic" | "category" | "fallback";

export type RankedCandidateV2 = {
  product: SwissdataProductV2;
  indexDoc: ProductIndexDocV2;

  score: number;
  lexicalScore: number;
  semanticScore: number;
  categoryScore: number;
  roleScore: number;
  penaltyScore: number;

  source: CandidateSourceV2[];
  reasons: string[];
};

export type IngredientMatchResultV2 = {
  ingredient: MealIngredientV2;
  candidates: RankedCandidateV2[];
  accepted?: RankedCandidateV2;
  confidence: MatchConfidenceV2;
  missingReason?: string;
};

export type MealMatchSummaryV2 = {
  meal: string;
  servings: number;
  matches: IngredientMatchResultV2[];
  accepted: IngredientMatchResultV2[];
  missing: IngredientMatchResultV2[];
};