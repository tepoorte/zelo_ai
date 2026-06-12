import { createHash } from "node:crypto";
import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import { textSimilarity, tokenSimilarity } from "../../domain/text-similarity.js";
import type { PurchaseHistory } from "../../swissdata/history.js";
import { getAllProducts, type Product } from "../../swissdata/products.js";
import { buildBudgetAwareProposal } from "./budget-composer.js";
import { extractDiscoverBudgetSignal } from "./budget-extractor.js";
import { profileCatalog } from "./catalog-profiler.js";
import { rankSemanticProposals } from "./composition-reranker.js";
import { classifyDiscoverNeeds, discoverConfidence } from "./need-classifier.js";
import { buildSemanticGraphProposals } from "./product-graph.js";
import { buildSemanticDiscoveryFrame } from "./semantic-frame.js";
import { rankSemanticProducts } from "./semantic-retrieval.js";
import { loadDiscoverTrainingArtifacts } from "./training-artifacts.js";
import type {
  DiscoverAnchorPolicy,
  DiscoverBudgetSignal,
  DiscoverFocusPolicy,
  DiscoverMlModel,
  DiscoverMlProposalBlueprint,
  DiscoverMlResponseStyle,
  DiscoverNeedLabel,
  DiscoverNeedScore,
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverProposal,
  DiscoverProposalProduct,
  DiscoverResult,
  DiscoverTrainingArtifacts,
} from "./types.js";

type BuildDiscoverOptions = {
  products?: Product[];
  history?: PurchaseHistory;
  training?: DiscoverTrainingArtifacts;
  hints?: {
    needHints?: DiscoverNeedLabel[];
    roleHints?: DiscoverProductRole[];
    focusTerms?: string[];
    constraints?: string[];
  };
};

type ScoredProduct = {
  profile: DiscoverProductProfile;
  score: number;
};

type QueryFocus = {
  terms: string[];
  roles: Set<DiscoverProductRole>;
  productIds: Set<string>;
  strictRoles: Set<DiscoverProductRole>;
  complementRoles: Set<DiscoverProductRole>;
  blockedRoles: Set<DiscoverProductRole>;
  blockedProductIds: Set<string>;
  constraintTerms: string[];
};

type QueryConstraints = {
  roles: Set<DiscoverProductRole>;
  productIds: Set<string>;
  terms: Set<string>;
};

const FALLBACK_RESPONSE_STYLE: DiscoverMlResponseStyle = {
  id: "fallback",
  labels: ["discovery_open"],
  intro: "Je peux te proposer quelques idées concrètes à partir du catalogue :",
  cta: "Si une idée te plaît, écris simplement les produits que tu veux ajouter.",
  lowConfidence:
    "Je peux t’aider à trouver une idée, mais il me manque encore un peu de contexte. Dis-moi par exemple si tu veux quelque chose de rapide, sain, végétarien, local, pour ce soir ou pour l’apéro.",
};

const MIN_CONFIDENCE = 0.24;
const NON_DISCRIMINATIVE_FOCUS_ROLES = new Set<DiscoverProductRole>([
  "bakery",
  "condiment",
  "pantry",
  "protein",
]);
const NON_BLOCKABLE_CONSTRAINT_ROLES = new Set<DiscoverProductRole>([
  "aperitif",
  "basket",
  "breakfast",
  "menu",
  "pantry",
  "protein",
  "snack",
]);
const BROAD_CONSTRAINT_ROLES = new Set<DiscoverProductRole>([
  ...NON_BLOCKABLE_CONSTRAINT_ROLES,
  "dairy",
  "dessert",
  "drink",
  "cleaning",
  "hygiene",
]);
const NON_FOOD_NEED_LABELS = new Set<DiscoverNeedLabel>(["cleaning", "gift", "hygiene"]);
const QUERY_FOCUS_STOPWORDS = new Set([
  "avec",
  "autour",
  "balle",
  "balles",
  "budget",
  "ce",
  "ces",
  "cet",
  "cette",
  "cher",
  "chere",
  "cheres",
  "chers",
  "chf",
  "chose",
  "dans",
  "des",
  "dimanche",
  "disponible",
  "donne",
  "demain",
  "faire",
  "fr",
  "franc",
  "francs",
  "franch",
  "franchs",
  "frs",
  "gourmand",
  "gourmande",
  "heure",
  "heures",
  "idee",
  "idees",
  "jour",
  "jours",
  "jeudi",
  "livraison",
  "lundi",
  "ma",
  "maison",
  "mardi",
  "mange",
  "manger",
  "manges",
  "max",
  "maximum",
  "mercredi",
  "mes",
  "mettre",
  "moi",
  "mon",
  "notre",
  "nos",
  "personne",
  "personnes",
  "premium",
  "pour",
  "produit",
  "produits",
  "proposition",
  "propose",
  "proposes",
  "quelque",
  "quoi",
  "rapide",
  "repa",
  "repas",
  "selection",
  "semaine",
  "samedi",
  "ta",
  "tes",
  "ton",
  "truc",
  "vendredi",
  "veux",
  "votre",
  "vos",
]);
const MAX_DIRECT_FOCUS_MATCHES_PER_TERM = 12;
const ANCHOR_NEED_LABEL_PRIORITY: DiscoverNeedLabel[] = [
  "cleaning",
  "hygiene",
  "vegetarian",
  "drink",
  "breakfast",
  "aperitif",
  "dinner",
  "dessert",
  "kids",
  "healthy",
  "balanced",
  "local",
  "budget",
  "weekly_basket",
  "quick",
];
const EXPLICIT_ROLE_CANDIDATES: DiscoverProductRole[] = [
  "fruit",
  "vegetable",
  "drink",
  "starch",
  "meat",
  "fish",
  "egg",
  "cheese",
];

const FALLBACK_FOCUS_POLICY: DiscoverFocusPolicy = {
  schemaVersion: 1,
  nonAnchorTerms: [...QUERY_FOCUS_STOPWORDS],
  roleAliasIndex: {},
  productAliasIndex: {},
  negationTemplates: [],
  negationTriggers: ["sans", "san", "pas", "eviter", "evite", "aucun", "aucune", "sauf"],
  negationConnectors: ["a", "au", "aux", "de", "des", "du", "d", "la", "le", "les", "l", "trop"],
  negativeQualifierRoles: {
    lourd: ["prepared_meal", "menu", "meat"],
    lourds: ["prepared_meal", "menu", "meat"],
    sucre: ["sweet"],
    sucree: ["sweet"],
  },
  typoTolerance: {
    tokenMinSimilarity: 0.78,
    phraseMinSimilarity: 0.82,
    compactMinLength: 5,
  },
};

const FALLBACK_ANCHOR_POLICIES: Partial<Record<DiscoverProductRole, DiscoverAnchorPolicy>> = {
  fruit: {
    mode: "strict_domain",
    blockedRoles: [
      "aperitif",
      "bakery",
      "bread",
      "dessert",
      "drink",
      "grain",
      "meat",
      "menu",
      "oil",
      "prepared_meal",
      "fish",
      "snack",
      "starch",
      "sweet",
      "vegetable",
      "cleaning",
      "hygiene",
    ],
  },
  vegetable: {
    mode: "strict_domain",
    blockedRoles: [
      "aperitif",
      "bakery",
      "bread",
      "dessert",
      "drink",
      "grain",
      "meat",
      "menu",
      "oil",
      "prepared_meal",
      "fish",
      "snack",
      "sweet",
      "cleaning",
      "hygiene",
    ],
  },
  drink: {
    mode: "strict_domain",
    blockedRoles: ["meat", "fish", "egg", "starch", "vegetable", "cleaning", "hygiene", "prepared_meal", "menu"],
  },
  dessert: {
    mode: "strict_domain",
    blockedRoles: ["meat", "fish", "cleaning", "hygiene"],
  },
  cleaning: {
    mode: "strict_domain",
    blockedRoles: ["meat", "fish", "fruit", "vegetable", "starch", "dairy", "drink", "dessert"],
  },
  hygiene: {
    mode: "strict_domain",
    blockedRoles: ["meat", "fish", "fruit", "vegetable", "starch", "dairy", "drink", "dessert"],
  },
  gift: {
    mode: "strict_domain",
    blockedRoles: ["cleaning", "hygiene"],
  },
  meat: {
    mode: "composable",
    complementRoles: ["starch", "grain", "vegetable", "oil", "sauce", "condiment", "bread"],
    blockedRoles: ["fish"],
  },
  fish: {
    mode: "composable",
    complementRoles: ["starch", "grain", "vegetable", "oil", "sauce", "condiment", "bread"],
    blockedRoles: ["meat"],
  },
  egg: {
    mode: "composable",
    complementRoles: ["bread", "vegetable", "starch", "grain", "cheese", "dairy"],
  },
  cheese: {
    mode: "composable",
    complementRoles: ["bread", "vegetable", "starch", "grain", "meat"],
  },
  prepared_meal: {
    mode: "composable",
    complementRoles: ["vegetable", "drink", "sauce", "condiment"],
  },
};

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function needLabels(needs: DiscoverNeedScore[]): DiscoverNeedLabel[] {
  return needs.map((need) => need.label);
}

function activeNeedLabels(needs: DiscoverNeedScore[]): DiscoverNeedLabel[] {
  const labels = needs
    .filter((need) => need.score >= 0.22)
    .map((need) => need.label);
  return labels.length ? labels : needLabels(needs);
}

function labelCompatibleWithFocus(
  label: DiscoverNeedLabel,
  focus: QueryFocus,
  model?: DiscoverMlModel
): boolean {
  if (!focus.roles.size) return true;
  return labelsRoleScore([label], focus.roles, model) > -0.5;
}

function activeNeedLabelsForFocus(
  needs: DiscoverNeedScore[],
  focus: QueryFocus,
  model?: DiscoverMlModel
): DiscoverNeedLabel[] {
  const labels = activeNeedLabels(needs).filter((label) => labelCompatibleWithFocus(label, focus, model));
  return labels.length ? labels : activeNeedLabels(needs);
}

function explicitBundleAllowed(query: string, needs: DiscoverNeedScore[], model?: DiscoverMlModel): boolean {
  const normalized = normalizeText(query);
  const patterns = model?.bundleAllowedPatterns ?? [];

  if (patterns.some((pattern) => new RegExp(pattern, "i").test(normalized))) return true;
  return needs.some((need) => ["budget", "weekly_basket", "zero_waste"].includes(need.label) && need.score >= 0.65);
}

function anchorPolicies(model?: DiscoverMlModel): Partial<Record<DiscoverProductRole, DiscoverAnchorPolicy>> {
  return {
    ...FALLBACK_ANCHOR_POLICIES,
    ...(model?.anchorPolicies ?? {}),
  };
}

function trainedFocusPolicy(model?: DiscoverMlModel): DiscoverFocusPolicy {
  const policy = model?.focusPolicy;
  if (!policy) return FALLBACK_FOCUS_POLICY;

  return {
    ...FALLBACK_FOCUS_POLICY,
    ...policy,
    nonAnchorTerms: [
      ...new Set([
        ...FALLBACK_FOCUS_POLICY.nonAnchorTerms,
        ...(policy.nonAnchorTerms ?? []),
      ].map((term) => normalizeText(term)).filter(Boolean)),
    ],
    negationTriggers: policy.negationTriggers?.length
      ? policy.negationTriggers
      : FALLBACK_FOCUS_POLICY.negationTriggers,
    negationConnectors: policy.negationConnectors?.length
      ? policy.negationConnectors
      : FALLBACK_FOCUS_POLICY.negationConnectors,
    negativeQualifierRoles: {
      ...FALLBACK_FOCUS_POLICY.negativeQualifierRoles,
      ...(policy.negativeQualifierRoles ?? {}),
    },
    typoTolerance: {
      ...FALLBACK_FOCUS_POLICY.typoTolerance,
      ...(policy.typoTolerance ?? {}),
    },
  };
}

function compactText(text: string): string {
  return normalizeText(text).replace(/\s+/g, "");
}

function focusStopwords(policy: DiscoverFocusPolicy): Set<string> {
  return new Set([
    ...QUERY_FOCUS_STOPWORDS,
    ...(policy.nonAnchorTerms ?? []),
    ...(policy.negationTriggers ?? []),
    ...(policy.negationConnectors ?? []),
  ].map((term) => normalizeText(term)).filter(Boolean));
}

function phraseSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeForMatch(left);
  const rightTokens = tokenizeForMatch(right);
  if (!leftTokens.length || !rightTokens.length) return 0;

  const forward =
    leftTokens.reduce((sum, token) => {
      const best = Math.max(...rightTokens.map((candidate) => tokenSimilarity(token, candidate)), 0);
      return sum + best;
    }, 0) / Math.max(1, leftTokens.length);
  const backward =
    rightTokens.reduce((sum, token) => {
      const best = Math.max(...leftTokens.map((candidate) => tokenSimilarity(token, candidate)), 0);
      return sum + best;
    }, 0) / Math.max(1, rightTokens.length);

  return Math.min(forward, backward);
}

function aliasMatchScore(phrase: string, alias: string, policy: DiscoverFocusPolicy): number {
  const normalizedPhrase = normalizeText(phrase);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedPhrase || !normalizedAlias) return 0;
  if (normalizedPhrase === normalizedAlias) return 1;
  if (normalizedAlias.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedAlias)) {
    return Math.min(normalizedPhrase.length, normalizedAlias.length) >= 4 ? 0.92 : 0;
  }

  const compactPhrase = compactText(normalizedPhrase);
  const compactAlias = compactText(normalizedAlias);
  const minCompactLength = policy.typoTolerance?.compactMinLength ?? 5;
  if (
    compactPhrase.length >= minCompactLength &&
    compactAlias.length >= minCompactLength &&
    (compactAlias.includes(compactPhrase) || compactPhrase.includes(compactAlias))
  ) {
    return 0.88;
  }

  return phraseSimilarity(normalizedPhrase, normalizedAlias);
}

function resolveRoleAliases(
  phrase: string,
  policy: DiscoverFocusPolicy,
  threshold = policy.typoTolerance?.phraseMinSimilarity ?? 0.82
): DiscoverProductRole[] {
  const scored: Array<{ role: DiscoverProductRole; score: number }> = [];

  for (const [role, aliases] of Object.entries(policy.roleAliasIndex ?? {})) {
    const best = Math.max(
      ...((aliases ?? []) as string[]).map((alias) => aliasMatchScore(phrase, alias, policy)),
      0
    );
    if (best >= threshold) scored.push({ role: role as DiscoverProductRole, score: best });
  }

  const maxScore = Math.max(...scored.map((item) => item.score), 0);
  return scored
    .filter((item) => item.score >= Math.max(threshold, maxScore - 0.04))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((item) => item.role);
}

function resolveProductAliases(
  phrase: string,
  policy: DiscoverFocusPolicy,
  threshold = policy.typoTolerance?.phraseMinSimilarity ?? 0.82
): string[] {
  const scored: Array<{ productId: string; score: number }> = [];

  for (const [productId, aliases] of Object.entries(policy.productAliasIndex ?? {})) {
    const best = Math.max(
      ...((aliases ?? []) as string[]).map((alias) => aliasMatchScore(phrase, alias, policy)),
      0
    );
    if (best >= threshold) scored.push({ productId, score: best });
  }

  const maxScore = Math.max(...scored.map((item) => item.score), 0);
  return scored
    .filter((item) => item.score >= Math.max(threshold, maxScore - 0.03))
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map((item) => item.productId);
}

function tokenMatchesAny(token: string, candidates: string[], policy: DiscoverFocusPolicy): boolean {
  const normalized = normalizeText(token);
  const minSimilarity = policy.typoTolerance?.tokenMinSimilarity ?? 0.78;
  return candidates.some((candidate) => {
    const expected = normalizeText(candidate);
    return normalized === expected || tokenSimilarity(normalized, expected) >= minSimilarity;
  });
}

function normalizedQueryTokens(query: string): string[] {
  return normalizeText(query).split(/\s+/).filter(Boolean);
}

function isNegationTrigger(tokens: string[], index: number, policy: DiscoverFocusPolicy): { ok: boolean; next: number } {
  const token = tokens[index] ?? "";
  if (token === "san" && tokens[index + 1] === "s") {
    return { ok: true, next: index + 2 };
  }
  if (tokenMatchesAny(token, policy.negationTriggers ?? [], policy)) {
    return { ok: true, next: index + 1 };
  }
  if (token === "n" && (tokens[index + 1] === "a" || tokens[index + 1] === "as") && tokens[index + 2] === "pas") {
    return { ok: true, next: index + 3 };
  }
  return { ok: false, next: index + 1 };
}

function constraintCandidatePhrases(
  tokens: string[],
  startIndex: number,
  policy: DiscoverFocusPolicy
): string[] {
  const connectors = new Set((policy.negationConnectors ?? []).map((term) => normalizeText(term)));
  const phrases: string[] = [];
  const collected: string[] = [];
  let index = startIndex;

  while (index < tokens.length && connectors.has(tokens[index])) index += 1;

  for (; index < tokens.length && collected.length < 5; index += 1) {
    const token = tokens[index];
    if (tokenMatchesAny(token, policy.negationTriggers ?? [], policy)) break;
    if (["et", "ou", "mais", "puis", "avec", "pour"].includes(token) && collected.length > 0) break;
    if (connectors.has(token)) continue;
    collected.push(token);
    phrases.push(collected.join(" "));
  }

  return phrases.sort((left, right) => right.length - left.length);
}

function addConstraintMatches(
  constraints: QueryConstraints,
  phrase: string,
  policy: DiscoverFocusPolicy
): void {
  const normalized = normalizeText(phrase);
  if (!normalized) return;

  constraints.terms.add(normalized);
  const resolvedProducts = resolveProductAliases(normalized, policy, 0.84);
  for (const productId of resolvedProducts) constraints.productIds.add(productId);

  const resolvedRoles = resolveRoleAliases(normalized, policy, 0.78)
    .filter((role) => !NON_BLOCKABLE_CONSTRAINT_ROLES.has(role));
  const specificRoles = resolvedRoles.filter((role) => !BROAD_CONSTRAINT_ROLES.has(role));
  const rolesToBlock = specificRoles.length ? specificRoles : (resolvedProducts.length ? [] : resolvedRoles);

  for (const role of rolesToBlock) {
    if (!NON_BLOCKABLE_CONSTRAINT_ROLES.has(role)) constraints.roles.add(role);
  }

  for (const role of EXPLICIT_ROLE_CANDIDATES) {
    if (queryMentionsRolePhrase(normalized, role) && !NON_BLOCKABLE_CONSTRAINT_ROLES.has(role)) {
      constraints.roles.add(role);
    }
  }

  for (const [qualifier, roles] of Object.entries(policy.negativeQualifierRoles ?? {})) {
    if (aliasMatchScore(normalized, qualifier, policy) >= 0.78) {
      for (const role of roles ?? []) constraints.roles.add(role);
    }
  }
}

function semanticRolesFromText(
  text: string,
  policy: DiscoverFocusPolicy,
  threshold = 0.86
): Set<DiscoverProductRole> {
  const roles = new Set<DiscoverProductRole>();
  const tokens = tokenizeForMatch(text);
  const phrases = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    for (let size = 1; size <= 3 && index + size <= tokens.length; size += 1) {
      phrases.add(tokens.slice(index, index + size).join(" "));
    }
  }

  for (const phrase of phrases) {
    for (const role of resolveRoleAliases(phrase, policy, threshold)) {
      if (!NON_DISCRIMINATIVE_FOCUS_ROLES.has(role)) roles.add(role);
    }
  }

  return new Set([...roles].filter((role) => !BROAD_CONSTRAINT_ROLES.has(role)));
}

function blueprintSemanticRoles(
  blueprint: DiscoverMlProposalBlueprint,
  model?: DiscoverMlModel
): Set<DiscoverProductRole> {
  const policy = trainedFocusPolicy(model);
  return semanticRolesFromText(`${blueprint.id} ${blueprint.title} ${blueprint.why}`, policy);
}

function blueprintCompatibleWithFocus(
  blueprint: DiscoverMlProposalBlueprint,
  products: DiscoverProposalProduct[],
  profileById: Map<string, ScoredProduct>,
  focus: QueryFocus,
  model?: DiscoverMlModel
): boolean {
  const semanticRoles = blueprintSemanticRoles(blueprint, model);
  if (!semanticRoles.size) return true;

  if ([...semanticRoles].some((role) => focus.blockedRoles.has(role))) return false;

  const hasSemanticProduct = products.some((product) => {
    const entry = profileById.get(product.productId);
    return entry ? productHasAnyRole(entry.profile, semanticRoles) : false;
  });

  return hasSemanticProduct;
}

function proposalHasUsefulStructure(
  products: DiscoverProposalProduct[],
  profileById: Map<string, ScoredProduct>,
  needs: DiscoverNeedScore[],
  focus: QueryFocus
): boolean {
  if (!products.length) return false;
  if (focus.strictRoles.has("fruit") || focus.strictRoles.has("drink")) return true;

  const labels = activeNeedLabels(needs);
  const wantsMealLike = labels.some((label) =>
    ["balanced", "dinner", "healthy", "quick", "vegetarian"].includes(label)
  );
  if (!wantsMealLike) return true;

  const roles = new Set<DiscoverProductRole>();
  for (const product of products) {
    const entry = profileById.get(product.productId);
    for (const role of entry?.profile.roles ?? []) roles.add(role);
  }

  const hasOnlyFruit =
    roles.has("fruit") &&
    !["bread", "cheese", "dairy", "egg", "fish", "grain", "starch", "vegetable"].some((role) =>
      roles.has(role as DiscoverProductRole)
    );
  return !hasOnlyFruit;
}

function extractQueryConstraints(query: string, policy: DiscoverFocusPolicy, hints?: BuildDiscoverOptions["hints"]): QueryConstraints {
  const constraints: QueryConstraints = {
    roles: new Set<DiscoverProductRole>(),
    productIds: new Set<string>(),
    terms: new Set<string>(),
  };

  for (const raw of hints?.constraints ?? []) {
    addConstraintMatches(constraints, raw, policy);
  }

  const tokens = normalizedQueryTokens(query);
  for (let index = 0; index < tokens.length; index += 1) {
    const trigger = isNegationTrigger(tokens, index, policy);
    if (!trigger.ok) continue;

    for (const phrase of constraintCandidatePhrases(tokens, trigger.next, policy)) {
      addConstraintMatches(constraints, phrase, policy);
    }
  }

  return constraints;
}

function policyForRole(
  role: DiscoverProductRole,
  model?: DiscoverMlModel
): DiscoverAnchorPolicy | undefined {
  return anchorPolicies(model)[role];
}

function addPolicyRoles(
  role: DiscoverProductRole,
  policy: DiscoverAnchorPolicy | undefined,
  focus: QueryFocus
): void {
  if (!policy) return;

  if (policy.mode === "strict_domain") {
    focus.strictRoles.add(role);
  }

  for (const complement of policy.complementRoles ?? []) {
    focus.complementRoles.add(complement);
  }

  for (const blocked of policy.blockedRoles ?? []) {
    focus.blockedRoles.add(blocked);
  }
}

function labelRoleWeight(
  model: DiscoverMlModel | undefined,
  label: DiscoverNeedLabel,
  role: DiscoverProductRole
): number {
  return Number(model?.labelRoleWeights?.[label]?.[role] ?? 0);
}

function labelsRoleScore(
  labels: DiscoverNeedLabel[],
  roles: Set<DiscoverProductRole>,
  model?: DiscoverMlModel
): number {
  let score = 0;
  for (const label of labels) {
    for (const role of roles) {
      score += labelRoleWeight(model, label, role);
    }
  }
  return score;
}

function needRoleScore(
  needs: DiscoverNeedScore[],
  roles: Set<DiscoverProductRole>,
  model?: DiscoverMlModel
): number {
  let score = 0;
  for (const need of needs) {
    for (const role of roles) {
      score += labelRoleWeight(model, need.label, role) * need.score;
    }
  }
  return score;
}

function roleMatchCount(
  labels: DiscoverNeedLabel[],
  roles: Set<DiscoverProductRole>,
  model?: DiscoverMlModel
): number {
  let count = 0;
  for (const label of labels) {
    for (const role of roles) {
      if (labelRoleWeight(model, label, role) > 0.15) count += 1;
    }
  }
  return count;
}

function labelScore(labels: DiscoverNeedLabel[], needs: DiscoverNeedScore[]): number {
  return labels.reduce(
    (sum, label) => sum + (needs.find((need) => need.label === label)?.score ?? 0),
    0
  );
}

function labelAffinity(labels: DiscoverNeedLabel[], needs: DiscoverNeedScore[]): number {
  return labelScore(labels, needs) / Math.max(1, labels.length);
}

function acceptsNonFood(needs: DiscoverNeedScore[]): boolean {
  return needs.some((need) => NON_FOOD_NEED_LABELS.has(need.label) && need.score >= 0.35);
}

function activeNonFoodNeedLabels(needs: DiscoverNeedScore[]): Set<DiscoverNeedLabel> {
  return new Set(
    needs
      .filter((need) => NON_FOOD_NEED_LABELS.has(need.label) && need.score >= 0.35)
      .map((need) => need.label)
  );
}

function productMatchesNonFoodNeed(
  profile: DiscoverProductProfile,
  labels: Set<DiscoverNeedLabel>
): boolean {
  if (labels.has("cleaning") && (profile.roles.has("cleaning") || profile.roles.has("hygiene"))) return true;
  if (labels.has("hygiene") && profile.roles.has("hygiene")) return true;
  if (labels.has("gift") && profile.roles.has("gift")) return true;
  return false;
}

function labelConflictRoles(labels: DiscoverNeedLabel[]): Set<DiscoverProductRole> {
  const labelSet = new Set(labels);
  const conflicts = new Set<DiscoverProductRole>();

  const add = (roles: DiscoverProductRole[]): void => {
    for (const role of roles) conflicts.add(role);
  };

  if (labelSet.has("vegetarian")) add(["meat", "fish"]);
  if (labelSet.has("breakfast") && !labelSet.has("aperitif") && !labelSet.has("dinner")) {
    add(["meat", "fish", "prepared_meal", "menu", "sauce", "oil", "cleaning", "hygiene"]);
  }
  if (labelSet.has("kids") && !labelSet.has("dinner")) {
    add(["alcohol", "meat", "fish", "prepared_meal", "menu", "sauce", "cleaning", "hygiene"]);
  }
  if (labelSet.has("drink") && !labelSet.has("aperitif") && !labelSet.has("dinner") && !labelSet.has("balanced")) {
    add([
      "meat",
      "fish",
      "egg",
      "starch",
      "vegetable",
      "bread",
      "grain",
      "cleaning",
      "hygiene",
      "prepared_meal",
      "menu",
    ]);
  }
  if (labelSet.has("cleaning") || labelSet.has("hygiene")) {
    add(["meat", "fish", "fruit", "vegetable", "starch", "dairy", "bread", "grain", "drink", "dessert", "sweet"]);
  }

  return conflicts;
}

function productCompatibleWithLabels(
  profile: DiscoverProductProfile,
  labels: DiscoverNeedLabel[]
): boolean {
  const labelSet = new Set(labels);

  if (labelSet.has("cleaning") && !(profile.roles.has("cleaning") || profile.roles.has("hygiene"))) return false;
  if (labelSet.has("hygiene") && !profile.roles.has("hygiene")) return false;
  if (
    labelSet.has("gift") &&
    !["gift", "sweet", "dessert", "drink"].some((role) => profile.roles.has(role as DiscoverProductRole))
  ) {
    return false;
  }
  if (
    labelSet.has("drink") &&
    !labelSet.has("aperitif") &&
    !labelSet.has("dinner") &&
    !labelSet.has("balanced") &&
    !profile.roles.has("drink")
  ) {
    return false;
  }

  return ![...labelConflictRoles(labels)].some((role) => profile.roles.has(role));
}

function bestTermMatch(term: string, tokens: string[]): number {
  const uniqueTokens = [...new Set(tokens.map((token) => normalizeText(token)).filter(Boolean))];
  let best = 0;

  for (const token of uniqueTokens) {
    if (term === token) best = Math.max(best, 1);
    else if (term.length >= 5 && token.length >= 5 && token.includes(term)) {
      best = Math.max(best, 0.92);
    } else if (term.length >= 5 && token.length >= 5) {
      best = Math.max(best, tokenSimilarity(term, token));
    }
  }

  return best;
}

function productFocusEvidence(term: string, profile: DiscoverProductProfile): { direct: number; catalog: number } {
  const nameTokens = tokenizeForMatch(profile.product.name);
  const categoryTokens = profile.categoryNames.flatMap((name) => tokenizeForMatch(name));

  return {
    direct: bestTermMatch(term, nameTokens),
    catalog: bestTermMatch(term, categoryTokens),
  };
}

function queryFocusTerms(
  query: string,
  hints: BuildDiscoverOptions["hints"] | undefined,
  policy: DiscoverFocusPolicy,
  constraints: QueryConstraints
): string[] {
  const stopwords = focusStopwords(policy);
  const blockedTerms = new Set([...constraints.terms].flatMap((term) => tokenizeForMatch(term)));
  const hintedTerms = (hints?.focusTerms ?? []).flatMap((term) => tokenizeForMatch(term));
  const fallbackTerms = tokenizeForMatch(query);
  const terms = (hintedTerms.length ? hintedTerms : fallbackTerms)
    .map((term) => normalizeText(term))
    .filter((term) => term.length >= 4 && !stopwords.has(term) && !blockedTerms.has(term));

  return [...new Set(terms)].slice(0, 8);
}

function queryMentionsRolePhrase(query: string, role: DiscoverProductRole): boolean {
  const normalized = normalizeText(query);
  if (role === "starch") return /\bpomme\s+de\s+terre\b|\bpatate\b|\bpates?\b|\briz\b/.test(normalized);
  if (role === "fruit") return /\bfruits?\b|\bpommes?\b|\bpoires?\b|\bananas?\b|\bananas?\b|\bbananes?\b|\bfraises?\b|\bmangues?\b/.test(normalized);
  if (role === "vegetable") return /\blegumes?\b|\bsalades?\b|\bcarottes?\b|\btomates?\b|\bcourgettes?\b|\basperges?\b|\bchoux?\b|\bpoireaux?\b|\bbettes?\b/.test(normalized);
  if (role === "drink") return /\b(jus|sirop|biere|vin|cidre|cafe|the|boir|boire|boissons?)\b/.test(normalized);
  if (role === "meat") return /\b(viande|boeuf|poulet|porc|dinde|lard|jambon|saucisse|salami)\b/.test(normalized);
  if (role === "fish") return /\b(poisson|poissons|perche|perches|brochet|fera)\b/.test(normalized);
  if (role === "egg") return /\boeufs?\b/.test(normalized);
  if (role === "cheese") return /\b(fromage|fromages|gruyere|mozzarella|raclette|crottin)\b/.test(normalized);
  return false;
}

function directMatchCompatibleWithHints(
  profile: DiscoverProductProfile,
  roleHints: DiscoverProductRole[],
): boolean {
  if (!roleHints.length) return true;
  return roleHints.some((role) => profile.roles.has(role));
}

function mergeNeedHints(
  needs: DiscoverNeedScore[],
  hints?: DiscoverNeedLabel[]
): DiscoverNeedScore[] {
  const scoreByLabel = new Map<DiscoverNeedLabel, number>();
  for (const need of needs) scoreByLabel.set(need.label, need.score);

  for (const hint of hints ?? []) {
    scoreByLabel.set(hint, Math.max(scoreByLabel.get(hint) ?? 0, 0.86));
  }

  return [...scoreByLabel.entries()]
    .map(([label, score]) => ({ label, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function adjustNeedsForBudgetSignal(
  needs: DiscoverNeedScore[],
  budget: DiscoverBudgetSignal
): DiscoverNeedScore[] {
  const scoreByLabel = new Map<DiscoverNeedLabel, number>();
  for (const need of needs) scoreByLabel.set(need.label, need.score);

  if (budget.kind === "target") {
    scoreByLabel.set("budget", Math.max(scoreByLabel.get("budget") ?? 0, 0.76));
  } else if (budget.kind === "economic") {
    scoreByLabel.set("budget", Math.max(scoreByLabel.get("budget") ?? 0, 0.82));
  } else if (budget.kind === "premium") {
    scoreByLabel.delete("budget");
    scoreByLabel.delete("weekly_basket");
    scoreByLabel.set("discovery_open", Math.max(scoreByLabel.get("discovery_open") ?? 0, 0.58));
  }

  return [...scoreByLabel.entries()]
    .map(([label, score]) => ({ label, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function analyzeQueryFocus(
  query: string,
  profiles: DiscoverProductProfile[],
  hints?: BuildDiscoverOptions["hints"],
  model?: DiscoverMlModel
): QueryFocus {
  const policy = trainedFocusPolicy(model);
  const constraints = extractQueryConstraints(query, policy, hints);
  const roleHints = [...new Set((hints?.roleHints ?? []).map((role) => String(role).trim()).filter(Boolean))] as DiscoverProductRole[];
  const terms = queryFocusTerms(query, hints, policy, constraints);
  const directRoleScores = new Map<DiscoverProductRole, number>();
  const catalogRoleScores = new Map<DiscoverProductRole, number>();
  const directProductIds = new Set<string>();
  const directMatchedTerms = new Set<string>();
  const catalogMatchedTerms = new Set<string>();
  const directThreshold = Math.min(policy.typoTolerance?.tokenMinSimilarity ?? 0.78, 0.74);
  const profileById = new Map(profiles.map((profile) => [String(profile.product.id), profile]));

  const addRoleScore = (
    scores: Map<DiscoverProductRole, number>,
    role: DiscoverProductRole,
    weight: number
  ): void => {
    if (NON_DISCRIMINATIVE_FOCUS_ROLES.has(role)) return;
    scores.set(role, (scores.get(role) ?? 0) + weight);
  };

  for (const term of terms) {
    for (const role of resolveRoleAliases(term, policy, 0.78)) {
      addRoleScore(directRoleScores, role, 5);
      directMatchedTerms.add(term);
    }
    for (const productId of resolveProductAliases(term, policy, 0.84)) {
      const profile = profileById.get(productId);
      if (!profile) continue;
      directProductIds.add(productId);
      directMatchedTerms.add(term);
      for (const role of profile.roles) addRoleScore(directRoleScores, role, 4);
    }

    const directMatches: Array<{ profile: DiscoverProductProfile; match: number }> = [];
    const catalogMatches: Array<{ profile: DiscoverProductProfile; match: number }> = [];

    for (const profile of profiles) {
      const evidence = productFocusEvidence(term, profile);

      if (evidence.direct >= directThreshold) {
        directMatches.push({ profile, match: evidence.direct });
      } else if (evidence.catalog >= 0.9) {
        catalogMatches.push({ profile, match: evidence.catalog });
      }
    }

      if (directMatches.length > 0 && directMatches.length <= MAX_DIRECT_FOCUS_MATCHES_PER_TERM) {
      directMatchedTerms.add(term);
      for (const { profile, match } of directMatches) {
        if (directMatchCompatibleWithHints(profile, roleHints)) {
          directProductIds.add(String(profile.product.id));
        }
        for (const role of profile.roles) addRoleScore(directRoleScores, role, match * 3);
      }
      continue;
    }

    if (!directMatches.length && catalogMatches.length > 0) {
      catalogMatchedTerms.add(term);
      for (const { profile, match } of catalogMatches) {
        for (const role of profile.roles) addRoleScore(catalogRoleScores, role, match * 1.6);
      }
    }
  }

  const roleScores = directRoleScores.size ? directRoleScores : catalogRoleScores;
  const matchedTerms = directRoleScores.size ? directMatchedTerms : catalogMatchedTerms;
  const maxScore = Math.max(...roleScores.values(), 0);
  const roles = new Set<DiscoverProductRole>();
  for (const [role, score] of roleScores.entries()) {
    if (score >= Math.max(1.2, maxScore * 0.85)) roles.add(role);
  }

  for (const role of roleHints) roles.add(role);
  const constraintMentionsRole = (role: DiscoverProductRole): boolean =>
    [...constraints.terms].some((term) => queryMentionsRolePhrase(term, role));
  for (const role of EXPLICIT_ROLE_CANDIDATES) {
    if (constraintMentionsRole(role)) continue;
    if (queryMentionsRolePhrase(query, role)) roles.add(role);
  }

  if (roles.has("fruit") && roles.has("starch") && queryMentionsRolePhrase(query, "starch")) {
    roles.delete("fruit");
  }
  if (roles.has("drink") && roles.has("fruit") && queryMentionsRolePhrase(query, "drink")) {
    roles.delete("fruit");
  }

  const focus: QueryFocus = {
    terms: [...matchedTerms],
    roles,
    productIds: directProductIds,
    strictRoles: new Set<DiscoverProductRole>(),
    complementRoles: new Set<DiscoverProductRole>(),
    blockedRoles: new Set<DiscoverProductRole>(constraints.roles),
    blockedProductIds: new Set<string>(constraints.productIds),
    constraintTerms: [...constraints.terms],
  };

  for (const role of roles) addPolicyRoles(role, policyForRole(role, model), focus);
  for (const role of roles) focus.blockedRoles.delete(role);

  return focus;
}

function productHasAnyRole(profile: DiscoverProductProfile, roles: Set<DiscoverProductRole>): boolean {
  return [...roles].some((role) => profile.roles.has(role));
}

function productHasBlockedRole(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  return productHasAnyRole(profile, focus.blockedRoles);
}

function productMatchesConstraintTerm(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  for (const term of focus.constraintTerms) {
    const normalized = normalizeText(term);
    if (normalized.length < 4) continue;

    const tokens = tokenizeForMatch(normalized);
    if (tokens.length <= 1 && productFocusEvidence(normalized, profile).direct >= 0.92) {
      return true;
    }

    if (tokens.length > 1 && phraseSimilarity(normalized, profile.product.name) >= 0.86) {
      return true;
    }
  }

  return false;
}

function productIsBlocked(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  return (
    focus.blockedProductIds.has(String(profile.product.id)) ||
    productHasBlockedRole(profile, focus) ||
    productMatchesConstraintTerm(profile, focus)
  );
}

function productMatchesAnchor(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  if (!focus.roles.size && !focus.productIds.size) return true;
  if (focus.productIds.has(String(profile.product.id))) return true;
  return productHasAnyRole(profile, focus.roles);
}

function productAllowedByFocus(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  if (productIsBlocked(profile, focus)) return false;
  if (!focus.roles.size && !focus.productIds.size) return true;
  if (focus.strictRoles.size) {
    const matchesStrictDomain =
      focus.productIds.has(String(profile.product.id)) ||
      productHasAnyRole(profile, focus.strictRoles) ||
      productHasAnyRole(profile, focus.roles);
    return matchesStrictDomain;
  }
  if (productMatchesAnchor(profile, focus)) return true;
  if (focus.complementRoles.size && productHasAnyRole(profile, focus.complementRoles)) {
    return true;
  }
  return false;
}

function productMatchesFocus(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  return productAllowedByFocus(profile, focus);
}

function productMatchesDirectFocus(profile: DiscoverProductProfile, focus: QueryFocus): boolean {
  return focus.productIds.has(String(profile.product.id)) && productAllowedByFocus(profile, focus);
}

function productRankFeatures(
  query: string,
  profile: DiscoverProductProfile,
  needs: DiscoverNeedScore[],
  model: DiscoverMlModel | undefined,
  focus: QueryFocus
): Record<string, number> {
  const labels = activeNeedLabelsForFocus(needs, focus, model);
  const queryTokens = tokenizeForMatch(query);
  const queryTokenSet = new Set(queryTokens);
  const productTokenSet = new Set(profile.tokens);
  const overlap = queryTokens.filter((token) => productTokenSet.has(token)).length;
  const bundleAllowed = explicitBundleAllowed(query, needs, model);
  const positiveRoleScore = Math.max(0, needRoleScore(needs, profile.roles, model));
  const negativeRoleScore = Math.min(0, needRoleScore(needs, profile.roles, model));
  const labelCompatible = productCompatibleWithLabels(profile, labels);
  const hasFocus = focus.roles.size > 0 || focus.productIds.size > 0;
  const anchorMatch = hasFocus && productMatchesAnchor(profile, focus);
  const anchorAllowed = !hasFocus || productAllowedByFocus(profile, focus);

  return {
    role_match: roleMatchCount(labels, profile.roles, model),
    weighted_role_match: positiveRoleScore + negativeRoleScore,
    positive_role_score: positiveRoleScore,
    negative_role_score: negativeRoleScore,
    label_match: needs.reduce((sum, need) => sum + (profile.labels.has(need.label) ? need.score : 0), 0),
    label_compatible: labelCompatible ? 1 : 0,
    label_conflict: labelCompatible ? 0 : 1,
    embedding_similarity: localEmbeddingSimilarity(query, profile),
    query_name_similarity: textSimilarity(query, profile.product.name),
    query_token_overlap: overlap / Math.max(1, queryTokenSet.size),
    is_food: profile.isFood ? 1 : 0,
    is_generic_bundle: profile.isGenericBundle ? 1 : 0,
    bundle_allowed: bundleAllowed ? 1 : 0,
    generic_blocked: profile.isGenericBundle && !bundleAllowed ? 1 : 0,
    has_options: profile.hasOptions ? 1 : 0,
    category_count: Math.min(1, profile.categoryNames.length / 8),
    multi_category: profile.categoryNames.length > 3 ? 1 : 0,
    local: profile.labels.has("local") ? 1 : 0,
    healthy: profile.labels.has("healthy") ? 1 : 0,
    need_confidence: Math.max(...needs.map((need) => need.score), 0),
    rank_prior: profile.rankPrior,
    focus_match: productMatchesFocus(profile, focus) ? 1 : 0,
    anchor_match: anchorMatch ? 1 : 0,
    anchor_allowed: anchorAllowed ? 1 : 0,
    anchor_blocked: hasFocus && !anchorAllowed ? 1 : 0,
  };
}

function productScore(
  profile: DiscoverProductProfile,
  query: string,
  needs: DiscoverNeedScore[],
  history: PurchaseHistory,
  model: DiscoverMlModel | undefined,
  focus: QueryFocus
): number {
  const bundleAllowed = explicitBundleAllowed(query, needs, model);
  if (profile.isGenericBundle && !bundleAllowed) return -100;
  if (!profile.isFood && !acceptsNonFood(needs)) return -80;
  if (!productAllowedByFocus(profile, focus)) return -90;
  const labels = activeNeedLabelsForFocus(needs, focus, model);
  if (!productCompatibleWithLabels(profile, labels)) return -85;

  let score = 0;
  const nonFoodNeedLabels = activeNonFoodNeedLabels(needs);
  if (nonFoodNeedLabels.size) {
    if (productMatchesNonFoodNeed(profile, nonFoodNeedLabels)) score += 12;
    else if (profile.isFood) score -= 8;
    else score -= 2;
  }
  score += needRoleScore(needs, profile.roles, model) * 4;
  score += needs.reduce((sum, need) => sum + (profile.labels.has(need.label) ? need.score * 2 : 0), 0);
  score += needs.reduce((sum, need) => sum + (profile.labelPriors.get(need.label) ?? 0) * need.score * 3, 0);
  if (focus.roles.size || focus.productIds.size) {
    if (productMatchesDirectFocus(profile, focus)) score += 14;
    else if (productMatchesAnchor(profile, focus)) score += 8;
    else score += 2;
  }
  score += profile.rankPrior;

  const historyQty = Number(history[String(profile.product.id)] ?? 0);
  if (historyQty > 0) score += Math.min(1.2, Math.log1p(historyQty) / 2);

  if (model?.productRanker?.featureNames?.length) {
    const features = productRankFeatures(query, profile, needs, model, focus);
    let raw = model.productRanker.bias ?? 0;
    for (let index = 0; index < model.productRanker.featureNames.length; index += 1) {
      const name = model.productRanker.featureNames[index];
      raw += (features[name] ?? 0) * (model.productRanker.weights[index] ?? 0);
    }
    score += sigmoid(raw) * 10;
  }

  return score;
}

function hashedEmbedding(text: string, dim = 96): number[] {
  const vector = new Array(dim).fill(0);
  for (const token of tokenizeForMatch(text)) {
    const digest = createHash("sha1").update(token).digest();
    const index = digest.readUInt32BE(0) % dim;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function localEmbeddingSimilarity(query: string, profile: DiscoverProductProfile): number {
  const productText = `${profile.product.name} ${profile.tokens.join(" ")}`;
  return cosine(hashedEmbedding(query), hashedEmbedding(productText));
}

function proposalProduct(profile: DiscoverProductProfile, labels: DiscoverNeedLabel[], model?: DiscoverMlModel): DiscoverProposalProduct {
  const roleReason = [...profile.roles]
    .sort((left, right) => labelRoleWeight(model, labels[0], right) - labelRoleWeight(model, labels[0], left))[0];

  return {
    productId: String(profile.product.id),
    name: profile.product.name,
    roles: [...profile.roles].slice(0, 5),
    reason: roleReason ? `rôle catalogue : ${roleReason}` : "produit du catalogue",
    hasOptions: profile.hasOptions,
  };
}

function blueprintLabelActive(
  blueprint: DiscoverMlProposalBlueprint,
  needs: DiscoverNeedScore[],
  isOpenQuery: boolean,
  anchorLabel?: DiscoverNeedLabel
): boolean {
  if (isOpenQuery) return true;
  if (anchorLabel && !blueprint.labels.includes(anchorLabel)) return false;
  return labelAffinity(blueprint.labels, needs) >= 0.35;
}

function productCompatibleWithBlueprint(
  profile: DiscoverProductProfile,
  blueprint: DiscoverMlProposalBlueprint,
  model?: DiscoverMlModel
): boolean {
  if (blueprint.productIds.includes(String(profile.product.id))) return true;
  if (blueprint.rejectedProductIds.includes(String(profile.product.id))) return false;
  if (!productCompatibleWithLabels(profile, blueprint.labels)) return false;

  const roleScore = labelsRoleScore(blueprint.labels, profile.roles, model);
  if (roleScore <= 0.12) return false;
  return profile.isFood || blueprint.labels.some((label) => ["cleaning", "hygiene", "gift"].includes(label));
}

function buildProposalFromBlueprint(
  blueprint: DiscoverMlProposalBlueprint,
  scoredProducts: ScoredProduct[],
  needs: DiscoverNeedScore[],
  model: DiscoverMlModel | undefined,
  usedGlobalIds: Set<string>,
  maxProducts: number,
  focus: QueryFocus
): DiscoverProposal | null {
  const profileById = new Map(scoredProducts.map((entry) => [String(entry.profile.product.id), entry]));
  const usedIds = new Set<string>();
  const usedNames: string[] = [];
  const products: DiscoverProposalProduct[] = [];
  const knownBlueprintIds = blueprint.productIds.filter((productId) => profileById.has(String(productId)));
  let selectedBlueprintProducts = 0;

  const pushProduct = (entry: ScoredProduct, fromBlueprint = false): void => {
    const id = String(entry.profile.product.id);
    if (usedIds.has(id) || usedGlobalIds.has(id)) return;
    if (blueprint.rejectedProductIds.includes(id)) return;
    if (!productAllowedByFocus(entry.profile, focus)) return;
    if (usedNames.some((name) => textSimilarity(name, entry.profile.product.name) >= 0.74)) return;
    usedIds.add(id);
    usedNames.push(entry.profile.product.name);
    products.push(proposalProduct(entry.profile, blueprint.labels, model));
    if (fromBlueprint) selectedBlueprintProducts += 1;
  };

  for (const productId of blueprint.productIds) {
    const entry = profileById.get(String(productId));
    if (!entry || entry.score <= -10) continue;
    pushProduct(entry, true);
    if (products.length >= maxProducts) break;
  }

  const canCompleteFromModel = knownBlueprintIds.length === 0 || selectedBlueprintProducts === 0;

  if (products.length < Math.min(2, maxProducts) && canCompleteFromModel) {
    for (const entry of scoredProducts) {
      if (!productCompatibleWithBlueprint(entry.profile, blueprint, model)) continue;
      if (entry.score <= -70) continue;
      if (!productAllowedByFocus(entry.profile, focus)) continue;
      pushProduct(entry);
      if (products.length >= maxProducts) break;
    }
  }

  if (focus.roles.size) {
    const hasFocusedBlueprintProduct = products.some((product) => {
      const entry = profileById.get(product.productId);
      return entry ? productMatchesAnchor(entry.profile, focus) : false;
    });
    if (!hasFocusedBlueprintProduct) return null;
  }

  if (knownBlueprintIds.length > 0 && selectedBlueprintProducts === 0) return null;
  if (!products.length) return null;
  if (!blueprintCompatibleWithFocus(blueprint, products, profileById, focus, model)) return null;
  if (!proposalHasUsefulStructure(products, profileById, needs, focus)) return null;
  const acceptsSingleProduct = blueprint.labels.some((label) => ["cleaning", "hygiene", "gift"].includes(label));
  const minProducts = acceptsSingleProduct || products.some((product) => profileById.get(product.productId)?.profile.isGenericBundle)
    ? 1
    : Math.min(2, maxProducts);
  if (products.length < minProducts) return null;

  const productScores = products.reduce(
    (sum, product) => sum + (profileById.get(product.productId)?.score ?? 0),
    0
  );

  return {
    id: blueprint.id,
    title: blueprint.title,
    why: blueprint.why,
    needs: blueprint.labels,
    score: labelAffinity(blueprint.labels, needs) * 8 + productScores,
    products,
  };
}

function buildDynamicFocusedProposal(
  query: string,
  scoredProducts: ScoredProduct[],
  needs: DiscoverNeedScore[],
  model: DiscoverMlModel | undefined,
  usedGlobalIds: Set<string>,
  maxProducts: number,
  focus: QueryFocus
): DiscoverProposal | null {
  if (!focus.roles.size) return null;

  const usedIds = new Set<string>();
  const usedNames: string[] = [];
  const products: DiscoverProposalProduct[] = [];
  const labels = activeNeedLabelsForFocus(needs, focus, model);

  const pushProduct = (entry: ScoredProduct): void => {
    const id = String(entry.profile.product.id);
    if (usedIds.has(id) || usedGlobalIds.has(id)) return;
    if (!productAllowedByFocus(entry.profile, focus)) return;
    if (usedNames.some((name) => textSimilarity(name, entry.profile.product.name) >= 0.74)) return;
    usedIds.add(id);
    usedNames.push(entry.profile.product.name);
    products.push(proposalProduct(entry.profile, labels, model));
  };

  const focusedCandidates = scoredProducts.filter(
    (entry) => entry.score > 0 && productMatchesAnchor(entry.profile, focus) && productAllowedByFocus(entry.profile, focus)
  );
  const directCandidate = focusedCandidates.find((entry) => productMatchesDirectFocus(entry.profile, focus));
  const firstCandidate = directCandidate ?? focusedCandidates[0];
  if (firstCandidate) pushProduct(firstCandidate);

  if (!products.length) return null;

  for (const entry of scoredProducts) {
    if (entry.score <= -70) continue;
    if (entry.profile.isGenericBundle && !explicitBundleAllowed(query, needs, model)) continue;
    if (!productAllowedByFocus(entry.profile, focus)) continue;
    pushProduct(entry);
    if (products.length >= maxProducts) break;
  }

  const acceptsSingleProduct = acceptsNonFood(needs);
  const minProducts = acceptsSingleProduct || focus.strictRoles.size || focus.productIds.size ? 1 : Math.min(2, maxProducts);
  if (products.length < minProducts) return null;
  const profileById = new Map(scoredProducts.map((entry) => [String(entry.profile.product.id), entry]));
  if (!proposalHasUsefulStructure(products, profileById, needs, focus)) return null;

  return {
    id: "demande_adaptee",
    title: focus.terms.length ? `Idée avec ${focus.terms.slice(0, 2).join(" / ")}` : "Idée adaptée",
    why: "sélection adaptée aux termes précis de ta demande et limitée au catalogue",
    needs: labels,
    score: products.reduce((sum, product) => {
      const entry = scoredProducts.find((candidate) => String(candidate.profile.product.id) === product.productId);
      return sum + (entry?.score ?? 0);
    }, 0) + 20,
    products,
  };
}

function buildDynamicCatalogProposal(
  query: string,
  scoredProducts: ScoredProduct[],
  needs: DiscoverNeedScore[],
  model: DiscoverMlModel | undefined,
  usedGlobalIds: Set<string>,
  maxProducts: number,
  index: number
): DiscoverProposal | null {
  const labels = activeNeedLabels(needs);
  const usedIds = new Set<string>();
  const usedNames: string[] = [];
  const products: DiscoverProposalProduct[] = [];

  const pushProduct = (entry: ScoredProduct): void => {
    const id = String(entry.profile.product.id);
    if (usedIds.has(id) || usedGlobalIds.has(id)) return;
    if (entry.profile.isGenericBundle && !explicitBundleAllowed(query, needs, model)) return;
    if (usedNames.some((name) => textSimilarity(name, entry.profile.product.name) >= 0.74)) return;
    usedIds.add(id);
    usedNames.push(entry.profile.product.name);
    products.push(proposalProduct(entry.profile, labels, model));
  };

  for (const entry of scoredProducts) {
    if (entry.score <= -70) continue;
    pushProduct(entry);
    if (products.length >= maxProducts) break;
  }

  if (products.length < Math.min(2, maxProducts)) return null;

  return {
    id: `idee_catalogue_${index}`,
    title: "Autre idée catalogue",
    why: "sélection générée depuis les produits les mieux classés du catalogue",
    needs: labels,
    score: products.reduce((sum, product) => {
      const entry = scoredProducts.find((candidate) => String(candidate.profile.product.id) === product.productId);
      return sum + (entry?.score ?? 0);
    }, 0) - index,
    products,
  };
}

function buildSafetyCatalogProposal(
  query: string,
  scoredProducts: ScoredProduct[],
  needs: DiscoverNeedScore[],
  model: DiscoverMlModel | undefined,
  maxProducts: number,
  focus: QueryFocus
): DiscoverProposal | null {
  const labels = activeNeedLabels(needs);
  const products: DiscoverProposalProduct[] = [];
  const usedIds = new Set<string>();
  const usedNames: string[] = [];

  for (const entry of scoredProducts) {
    const id = String(entry.profile.product.id);
    if (usedIds.has(id)) continue;
    if (entry.score <= -80) continue;
    if (entry.profile.isGenericBundle && !explicitBundleAllowed(query, needs, model)) continue;
    if (!entry.profile.isFood && !acceptsNonFood(needs)) continue;
    if (!productAllowedByFocus(entry.profile, focus)) continue;
    if (usedNames.some((name) => textSimilarity(name, entry.profile.product.name) >= 0.74)) continue;
    usedIds.add(id);
    usedNames.push(entry.profile.product.name);
    products.push(proposalProduct(entry.profile, labels, model));
    if (products.length >= maxProducts) break;
  }

  const acceptsSingleProduct = acceptsNonFood(needs);
  const minProducts = acceptsSingleProduct || focus.strictRoles.size || focus.productIds.size ? 1 : Math.min(2, maxProducts);
  if (products.length < minProducts) return null;
  const profileById = new Map(scoredProducts.map((entry) => [String(entry.profile.product.id), entry]));
  if (!proposalHasUsefulStructure(products, profileById, needs, focus)) return null;

  return {
    id: "idee_catalogue_secours",
    title: "Idée catalogue",
    why: "sélection de secours depuis les produits cohérents du catalogue",
    needs: labels,
    score: products.reduce((sum, product) => {
      const entry = scoredProducts.find((candidate) => String(candidate.profile.product.id) === product.productId);
      return sum + (entry?.score ?? 0);
    }, 0),
    products,
  };
}

function fallbackBlueprints(model?: DiscoverMlModel): DiscoverMlProposalBlueprint[] {
  return model?.proposalBlueprints?.length
    ? model.proposalBlueprints
    : [
        {
          id: "catalogue",
          title: "Idée catalogue",
          why: "sélection basée sur les produits disponibles",
          labels: ["discovery_open"],
          productIds: [],
          rejectedProductIds: [],
        },
      ];
}

function blueprintAllowedBySemanticContext(
  blueprint: DiscoverMlProposalBlueprint,
  concepts: Set<string>
): boolean {
  const labels = new Set(blueprint.labels);

  if (concepts.has("picnic")) return false;
  if (concepts.has("aperitif")) {
    return labels.has("aperitif") || labels.has("drink") || labels.has("local");
  }
  if (concepts.has("nutrition_support")) {
    return labels.has("healthy") || labels.has("balanced") || labels.has("vegetarian");
  }

  return true;
}

function chooseResponseStyle(needs: DiscoverNeedScore[], model?: DiscoverMlModel): DiscoverMlResponseStyle {
  const styles = model?.responseStyles ?? [];
  const activeLabels = new Set(needs.map((need) => need.label));
  for (const need of needs) {
    const candidates = styles.filter((style) => style.labels.includes(need.label));
    const found = need.label === "weekly_basket" && !activeLabels.has("budget")
      ? candidates.find((style) => !style.labels.includes("budget"))
      : candidates[0];
    if (found) return found;
  }
  return styles[0] ?? FALLBACK_RESPONSE_STYLE;
}

function proposalLimit(needs: DiscoverNeedScore[]): number {
  const labels = needLabels(needs);
  if (labels.includes("discovery_open") || labels.includes("weekly_basket")) return 5;
  return 3;
}

function productLimit(needs: DiscoverNeedScore[]): number {
  const labels = needLabels(needs);
  if (labels.includes("weekly_basket")) return 4;
  return 3;
}

function proposalRoleSet(proposal: DiscoverProposal): Set<DiscoverProductRole> {
  return new Set(
    proposal.products
      .flatMap((product) => product.roles)
      .filter((role) => !NON_DISCRIMINATIVE_FOCUS_ROLES.has(role))
  );
}

function intersectionSize<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function diversityScore(
  proposal: DiscoverProposal,
  selected: DiscoverProposal[],
  isDiversitySensitive: boolean
): number {
  if (!selected.length || !isDiversitySensitive) return proposal.score;

  const labels = new Set(proposal.needs.filter((label) => label !== "discovery_open"));
  const roles = proposalRoleSet(proposal);
  const productIds = new Set(proposal.products.map((product) => product.productId));
  let adjusted = proposal.score;

  for (const existing of selected) {
    const existingLabels = new Set(existing.needs.filter((label) => label !== "discovery_open"));
    const existingRoles = proposalRoleSet(existing);
    const existingProductIds = new Set(existing.products.map((product) => product.productId));
    const labelOverlap = intersectionSize(labels, existingLabels);
    const roleOverlap = intersectionSize(roles, existingRoles);
    const productOverlap = intersectionSize(productIds, existingProductIds);

    adjusted -= productOverlap * 80;
    adjusted -= labelOverlap * 16;
    adjusted -= roleOverlap * 4;
  }

  return adjusted;
}

function rankDiverseProposals(
  proposals: DiscoverProposal[],
  limit: number,
  isDiversitySensitive: boolean
): DiscoverProposal[] {
  const selected: DiscoverProposal[] = [];
  const remaining = [...proposals].sort((left, right) => right.score - left.score);

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const score = diversityScore(remaining[index], selected, isDiversitySensitive);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function anchorNeedLabel(needs: DiscoverNeedScore[]): DiscoverNeedLabel | undefined {
  const active = new Map(
    needs
      .filter((need) => need.label !== "discovery_open" && need.score >= 0.55)
      .map((need) => [need.label, need.score])
  );
  for (const label of ANCHOR_NEED_LABEL_PRIORITY) {
    if (active.has(label)) return label;
  }
  return needs.find((need) => need.label !== "discovery_open" && need.score >= 0.55)?.label;
}

function hasSpecificMealCue(query: string): boolean {
  return /\b(ce soir|soir|soiree|souper|diner|dinner|midi|repas|plat|menu)\b/.test(normalizeText(query));
}

function formatDiscoverMessage(result: Omit<DiscoverResult, "message">, style: DiscoverMlResponseStyle): string {
  if (!result.proposals.length) {
    return style.lowConfidence || FALLBACK_RESPONSE_STYLE.lowConfidence;
  }

  const hasBudgetTarget = result.budget?.kind === "target";
  const lines = [
    hasBudgetTarget
      ? "Avec le budget indiqué, je peux te proposer :"
      : style.intro || FALLBACK_RESPONSE_STYLE.intro,
    "",
  ];

  if (result.semanticFrame?.responseMode === "safe_general_with_clarification") {
    lines.push(
      "Je te propose une base générale, sans promesse médicale. Si tu veux cibler un besoin précis, dis-moi lequel.",
      ""
    );
  }

  result.proposals.forEach((proposal) => {
    lines.push(proposal.title);
    for (const product of proposal.products) {
      const price = product.estimatedPriceCHF != null
        ? ` (~${product.estimatedPriceCHF.toFixed(2)} CHF)`
        : "";
      lines.push(`• ${product.name}${price}`);
    }
    if (proposal.estimatedTotalCHF != null) {
      lines.push(`Total estimé : env. ${proposal.estimatedTotalCHF.toFixed(2)} CHF`);
    }
    lines.push(`Pourquoi : ${proposal.why}.`);
    if (proposal.budgetNote) lines.push(`Budget : ${proposal.budgetNote}.`);
    lines.push("");
  });

  lines.push(style.cta || FALLBACK_RESPONSE_STYLE.cta);
  return lines.join("\n").trim();
}

export async function buildDiscoverMealIdeas(
  userRef: string,
  query: string,
  options: BuildDiscoverOptions = {}
): Promise<DiscoverResult> {
  const training = options.training ?? await loadDiscoverTrainingArtifacts();
  const products = options.products ?? await getAllProducts(userRef);
  const history: PurchaseHistory = {};
  const model = training.model;
  const budget = extractDiscoverBudgetSignal(query, model?.budgetPolicy);
  const needs = adjustNeedsForBudgetSignal(
    mergeNeedHints(classifyDiscoverNeeds(query, training), options.hints?.needHints),
    budget
  );
  const rawConfidence = discoverConfidence(needs);
  const confidence = budget.kind === "target" ? Math.max(rawConfidence, 0.72) : rawConfidence;
  let style = chooseResponseStyle(needs, model);
  const profiles = profileCatalog(products, training);
  const semanticFrame = buildSemanticDiscoveryFrame({
    query,
    needs,
    budget,
    profiles,
    hints: options.hints,
    model,
  });

  if (!model || confidence < MIN_CONFIDENCE) {
    const resultWithoutMessage = {
      ok: true,
      query,
      needs,
      confidence,
      budget,
      semanticFrame,
      proposals: [],
    };

    return {
      ...resultWithoutMessage,
      message: formatDiscoverMessage(resultWithoutMessage, style),
    };
  }

  const focus = analyzeQueryFocus(query, profiles, options.hints, model);
  if (process.env.DEBUG_DISCOVER_MEALS === "1") {
    console.log("[DISCOVER_FOCUS]", {
      query,
      semanticFrame,
      terms: focus.terms,
      roles: [...focus.roles],
      strictRoles: [...focus.strictRoles],
      complementRoles: [...focus.complementRoles],
      blockedRoles: [...focus.blockedRoles],
      blockedProductIds: [...focus.blockedProductIds],
      constraintTerms: focus.constraintTerms,
      productIds: [...focus.productIds],
    });
  }
  const baseScoredProducts = profiles
    .map((profile) => ({
      profile,
      score: productScore(profile, query, needs, history, model, focus),
    }))
    .sort((left, right) => right.score - left.score);
  const scoredProducts = rankSemanticProducts(baseScoredProducts, semanticFrame);

  const openNeed = needs.find((need) => need.label === "discovery_open");
  const topNeedScore = Math.max(...needs.map((need) => need.score), 0);
  const hasVeryStrongSpecificNeed = needs.some(
    (need) => need.label !== "discovery_open" && need.score >= 0.72
  );
  const isOpenQuery = Boolean(
    openNeed &&
    openNeed.score >= 0.65 &&
    (!hasVeryStrongSpecificNeed || openNeed.score >= topNeedScore - (hasSpecificMealCue(query) ? 0.08 : 0.18))
  );
  if (isOpenQuery && openNeed) {
    style = chooseResponseStyle(
      [
        { label: "discovery_open", score: openNeed.score },
        ...needs.filter((need) => need.label !== "discovery_open"),
      ],
      model
    );
  }
  const anchorLabel = anchorNeedLabel(needs);
  const globallyUsedIds = new Set<string>();
  const proposals: DiscoverProposal[] = [];
  const semanticConceptNames = new Set(
    semanticFrame.concepts
      .filter((concept) => concept.score >= 0.45)
      .map((concept) => concept.name)
  );
  const specificSemanticRequest = ["picnic", "aperitif", "nutrition_support"].some((concept) =>
    semanticConceptNames.has(concept)
  );
  const specificSemanticProposalLimit = semanticConceptNames.has("picnic")
    ? 1
    : semanticConceptNames.has("aperitif")
      ? 2
      : 3;
  const maxProposals = semanticFrame.requestCount
    ? Math.max(1, Math.min(5, semanticFrame.requestCount))
    : specificSemanticRequest
      ? Math.min(specificSemanticProposalLimit, proposalLimit(needs))
    : proposalLimit(needs);
  const maxCandidateProposals = Math.max(maxProposals, maxProposals * 3);
  const maxProducts = productLimit(needs);

  const budgetProposal = buildBudgetAwareProposal({
    signal: budget,
    entries: scoredProducts.map((entry) => ({
      ...entry,
      allowed: productAllowedByFocus(entry.profile, focus),
      anchor: productMatchesAnchor(entry.profile, focus),
      directFocus: productMatchesDirectFocus(entry.profile, focus),
    })),
    labels: activeNeedLabelsForFocus(needs, focus, model),
    focusTerms: focus.terms,
    policy: model?.budgetPolicy,
  });

  if (budgetProposal) {
    proposals.push(budgetProposal);
    for (const product of budgetProposal.products) globallyUsedIds.add(product.productId);
  }

  const semanticProposals = buildSemanticGraphProposals({
    frame: semanticFrame,
    scoredProducts,
    needs,
    maxProducts,
    maxProposals: Math.min(maxCandidateProposals, semanticFrame.requestCount ?? maxProposals),
    usedProductIds: globallyUsedIds,
  });
  for (const proposal of semanticProposals) {
    if (proposals.some((existing) => existing.id === proposal.id)) continue;
    proposals.push(proposal);
    for (const product of proposal.products) globallyUsedIds.add(product.productId);
    if (proposals.length >= maxCandidateProposals) break;
  }

  const blueprintCandidates = fallbackBlueprints(model)
    .filter((blueprint) => blueprintLabelActive(blueprint, needs, isOpenQuery, anchorLabel))
    .filter((blueprint) => blueprintAllowedBySemanticContext(blueprint, semanticConceptNames))
    .sort((left, right) => {
      const leftScore = labelAffinity(left.labels, needs);
      const rightScore = labelAffinity(right.labels, needs);
      return rightScore - leftScore;
    });

  for (const blueprint of blueprintCandidates) {
    const proposal = buildProposalFromBlueprint(
      blueprint,
      scoredProducts,
      needs,
      model,
      globallyUsedIds,
      maxProducts,
      focus
    );
    if (!proposal) continue;
    proposals.push(proposal);
    for (const product of proposal.products) globallyUsedIds.add(product.productId);
    if (proposals.length >= maxCandidateProposals) break;
  }

  const proposalsAlreadyMatchFocus = proposals.some((proposal) =>
    proposal.products.some((product) => {
      const entry = scoredProducts.find((candidate) => String(candidate.profile.product.id) === product.productId);
      return entry ? productMatchesAnchor(entry.profile, focus) : false;
    })
  );

  if ((focus.roles.size || focus.productIds.size) && !proposalsAlreadyMatchFocus && proposals.length < maxProposals) {
    const focusedProposal = buildDynamicFocusedProposal(
      query,
      scoredProducts,
      needs,
      model,
      globallyUsedIds,
      maxProducts,
      focus
    );
    if (focusedProposal && !proposals.some((proposal) => proposal.id === focusedProposal.id)) {
      proposals.unshift(focusedProposal);
      for (const product of focusedProposal.products) globallyUsedIds.add(product.productId);
    }
  }

  const minimumProposals = isOpenQuery ? Math.min(3, maxProposals) : 1;
  while (!focus.roles.size && !focus.productIds.size && proposals.length < minimumProposals) {
    const proposal = buildDynamicCatalogProposal(
      query,
      scoredProducts,
      needs,
      model,
      globallyUsedIds,
      maxProducts,
      proposals.length + 1
    );
    if (!proposal) break;
    proposals.push(proposal);
    for (const product of proposal.products) globallyUsedIds.add(product.productId);
  }

  if (!proposals.length) {
    const proposal = buildSafetyCatalogProposal(
      query,
      scoredProducts,
      needs,
      model,
      maxProducts,
      focus
    );
    if (proposal) proposals.push(proposal);
  }

  const diversitySensitive = isOpenQuery || needs.some((need) => ["weekly_basket", "balanced", "healthy"].includes(need.label));
  const semanticallyRanked = rankSemanticProposals(proposals, semanticFrame);
  const ranked = rankDiverseProposals(semanticallyRanked, maxProposals, diversitySensitive);

  const resultWithoutMessage = {
    ok: true,
    query,
    needs,
    confidence,
    budget,
    semanticFrame,
    proposals: ranked,
  };

  return {
    ...resultWithoutMessage,
    message: formatDiscoverMessage(resultWithoutMessage, style),
  };
}
