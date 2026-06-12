import type { Product } from "../../swissdata/products.js";

export const DISCOVER_NEED_LABELS = [
  "aperitif",
  "balanced",
  "breakfast",
  "budget",
  "cleaning",
  "dessert",
  "dinner",
  "discovery_open",
  "drink",
  "gift",
  "healthy",
  "hygiene",
  "kids",
  "local",
  "quick",
  "vegetarian",
  "weekly_basket",
  "zero_waste",
] as const;

export type DiscoverNeedLabel = (typeof DISCOVER_NEED_LABELS)[number] | (string & {});

export const DISCOVER_PRODUCT_ROLES = [
  "aperitif",
  "bakery",
  "basket",
  "bread",
  "breakfast",
  "cheese",
  "cleaning",
  "condiment",
  "dairy",
  "dessert",
  "drink",
  "egg",
  "fish",
  "fruit",
  "gift",
  "grain",
  "hygiene",
  "meat",
  "menu",
  "oil",
  "pantry",
  "prepared_meal",
  "protein",
  "sauce",
  "snack",
  "starch",
  "sweet",
  "vegetable",
] as const;

export type DiscoverProductRole = (typeof DISCOVER_PRODUCT_ROLES)[number] | (string & {});

export type DiscoverPlannerVocabulary = {
  needs: DiscoverNeedLabel[];
  roles: DiscoverProductRole[];
};

export type DiscoverIntentExample = {
  text: string;
  labels: DiscoverNeedLabel[];
};

export type DiscoverProductRoleExample = {
  productId?: string;
  name?: string;
  roles: DiscoverProductRole[];
  labels?: DiscoverNeedLabel[];
};

export type DiscoverRankingExample = {
  query: string;
  acceptedRoles?: DiscoverProductRole[];
  rejectedRoles?: DiscoverProductRole[];
  labels?: DiscoverNeedLabel[];
};

export type DiscoverTrainingArtifacts = {
  queryIntents: DiscoverIntentExample[];
  productRoles: DiscoverProductRoleExample[];
  rankingExamples: DiscoverRankingExample[];
  model?: DiscoverMlModel;
};

export type DiscoverMlIntentClassifier = {
  labels: DiscoverNeedLabel[];
  vocabulary: Record<string, number>;
  idf: number[];
  weights: Record<string, number[]>;
  bias: Record<string, number>;
  thresholds: Record<string, number>;
};

export type DiscoverMlRanker = {
  featureNames: string[];
  weights: number[];
  bias: number;
};

export type DiscoverMlProductProfile = {
  id: string;
  name: string;
  roles: DiscoverProductRole[];
  labels: DiscoverNeedLabel[];
  categoryIds: string[];
  categoryNames: string[];
  tokens: string[];
  isFood: boolean;
  isGenericBundle: boolean;
  hasOptions: boolean;
  rankPrior: number;
  labelPriors?: Partial<Record<DiscoverNeedLabel, number>>;
};

export type DiscoverSemanticPolarity = "prefer" | "avoid" | "limit" | "strict" | "complement";

export type DiscoverSemanticScore = {
  name: string;
  score: number;
};

export type DiscoverSemanticRoleIntent = {
  role: DiscoverProductRole;
  polarity: DiscoverSemanticPolarity;
  score: number;
  source?: string;
};

export type DiscoverSemanticConstraint = {
  kind: "avoid_role" | "limit_role" | "strict_domain" | "avoid_product" | "budget" | "other";
  target: string;
  score: number;
  source?: string;
};

export type DiscoverSemanticUncertainty = {
  kind: "missing_specific_target" | "low_confidence" | "ambiguous_domain" | "health_sensitive";
  target?: string;
  score: number;
};

export type DiscoverSemanticFrame = {
  schemaVersion: number;
  originalQuery: string;
  cleanedQuery: string;
  requestCount?: number;
  domains: DiscoverSemanticScore[];
  concepts: DiscoverSemanticScore[];
  roleIntents: DiscoverSemanticRoleIntent[];
  constraints: DiscoverSemanticConstraint[];
  uncertainties: DiscoverSemanticUncertainty[];
  responseMode: "direct" | "safe_general" | "safe_general_with_clarification" | "clarify";
  confidence: number;
};

export type DiscoverMlProposalBlueprint = {
  id: string;
  title: string;
  why: string;
  labels: DiscoverNeedLabel[];
  productIds: string[];
  rejectedProductIds: string[];
};

export type DiscoverMlResponseStyle = {
  id: string;
  labels: DiscoverNeedLabel[];
  intro: string;
  cta: string;
  lowConfidence: string;
};

export type DiscoverAnchorPolicyMode = "strict_domain" | "composable";

export type DiscoverAnchorPolicy = {
  mode: DiscoverAnchorPolicyMode;
  complementRoles?: DiscoverProductRole[];
  blockedRoles?: DiscoverProductRole[];
};

export type DiscoverBudgetKind = "none" | "economic" | "target" | "premium";

export type DiscoverBudgetSignal = {
  kind: DiscoverBudgetKind;
  confidence: number;
  targetAmountCHF?: number;
  minAmountCHF?: number;
  maxAmountCHF?: number;
  source?: string;
};

export type DiscoverBudgetPolicy = {
  schemaVersion: number;
  currencyTerms: string[];
  targetCues: string[];
  economicCues: string[];
  premiumCues: string[];
  hardNegativeCues: string[];
  toleranceRatio: number;
  toleranceMinCHF: number;
  metrics?: Record<string, unknown>;
};

export type DiscoverFocusPolicy = {
  schemaVersion: number;
  nonAnchorTerms: string[];
  roleAliasIndex: Partial<Record<DiscoverProductRole, string[]>>;
  productAliasIndex: Record<string, string[]>;
  negationTemplates: string[];
  negationTriggers: string[];
  negationConnectors: string[];
  negativeQualifierRoles: Record<string, DiscoverProductRole[]>;
  typoTolerance: {
    tokenMinSimilarity: number;
    phraseMinSimilarity: number;
    compactMinLength: number;
  };
};

export type DiscoverMlModel = {
  schemaVersion: number;
  trainedAt: string;
  trainingMode: string;
  catalog: {
    count: number;
    source: string;
    signature: string;
  };
  intentClassifier: DiscoverMlIntentClassifier;
  productRanker: DiscoverMlRanker;
  productProfiles: Record<string, DiscoverMlProductProfile>;
  labelRoleWeights: Partial<Record<DiscoverNeedLabel, Partial<Record<DiscoverProductRole, number>>>>;
  proposalBlueprints: DiscoverMlProposalBlueprint[];
  responseStyles: DiscoverMlResponseStyle[];
  genericBundleProductIds: string[];
  bundleAllowedPatterns: string[];
  plannerVocabulary?: DiscoverPlannerVocabulary;
  anchorPolicies?: Partial<Record<DiscoverProductRole, DiscoverAnchorPolicy>>;
  focusPolicy?: DiscoverFocusPolicy;
  budgetPolicy?: DiscoverBudgetPolicy;
  semanticFrameModel?: Record<string, unknown>;
  rolePolarityModel?: Record<string, unknown>;
  productSemanticProfiles?: Record<string, unknown>;
  productGraph?: Record<string, unknown>;
  productRankerV2?: Record<string, unknown>;
  compositionReranker?: Record<string, unknown>;
  semanticMetrics?: Record<string, unknown>;
  evaluationReport?: Record<string, unknown>;
  metrics: Record<string, unknown>;
};

export type DiscoverNeedScore = {
  label: DiscoverNeedLabel;
  score: number;
};

export type DiscoverProductProfile = {
  product: Product;
  roles: Set<DiscoverProductRole>;
  labels: Set<DiscoverNeedLabel>;
  categoryNames: string[];
  tokens: string[];
  metadataText: string;
  isFood: boolean;
  isGenericBundle: boolean;
  hasOptions: boolean;
  rankPrior: number;
  labelPriors: Map<DiscoverNeedLabel, number>;
};

export type DiscoverProposalProduct = {
  productId: string;
  name: string;
  roles: DiscoverProductRole[];
  reason: string;
  hasOptions: boolean;
  estimatedPriceCHF?: number;
  priceEstimateReliable?: boolean;
};

export type DiscoverProposal = {
  id: string;
  title: string;
  why: string;
  score: number;
  needs: DiscoverNeedLabel[];
  products: DiscoverProposalProduct[];
  estimatedTotalCHF?: number;
  budgetDistanceCHF?: number;
  budgetTargetCHF?: number;
  budgetKind?: DiscoverBudgetKind;
  budgetNote?: string;
  semanticScore?: number;
  semanticCoverage?: string[];
  semanticViolations?: string[];
};

export type DiscoverResult = {
  ok: boolean;
  query: string;
  needs: DiscoverNeedScore[];
  confidence: number;
  budget?: DiscoverBudgetSignal;
  semanticFrame?: DiscoverSemanticFrame;
  proposals: DiscoverProposal[];
  message: string;
};
