import { parseFrenchNumber } from "../../domain/french-numbers.js";
import { normalizeText } from "../../domain/normalizer.js";
import type {
  DiscoverBudgetSignal,
  DiscoverMlModel,
  DiscoverNeedScore,
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverSemanticFrame,
  DiscoverSemanticPolarity,
  DiscoverSemanticRoleIntent,
} from "./types.js";

type BuildSemanticFrameInput = {
  query: string;
  needs: DiscoverNeedScore[];
  budget: DiscoverBudgetSignal;
  profiles: DiscoverProductProfile[];
  hints?: {
    roleHints?: DiscoverProductRole[];
    focusTerms?: string[];
    constraints?: string[];
  };
  model?: DiscoverMlModel;
};

const CONVERSATIONAL_NOISE = new Set([
  "alors",
  "bonjour",
  "bonsoir",
  "salut",
  "hello",
  "coucou",
  "comment",
  "ca",
  "va",
  "du",
  "coup",
  "moi",
  "stp",
  "svp",
  "merci",
]);

const REQUEST_WORDS = new Set([
  "propose",
  "proposes",
  "proposer",
  "idee",
  "idees",
  "suggestion",
  "suggestions",
  "conseille",
  "conseilles",
  "voudrais",
  "veux",
  "besoin",
]);

const ROLE_EXPANSIONS: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>> = {
  protein: ["protein", "meat", "fish", "egg", "cheese"],
  meat: ["meat", "protein"],
  fish: ["fish", "protein"],
  egg: ["egg", "protein"],
  cheese: ["cheese", "dairy", "protein"],
  dairy: ["dairy"],
  fruit: ["fruit"],
  vegetable: ["vegetable"],
  drink: ["drink"],
  cleaning: ["cleaning"],
  hygiene: ["hygiene"],
  starch: ["starch", "grain"],
};

const CONCEPT_ROLE_PRIORS: Record<string, DiscoverProductRole[]> = {
  healthy: ["vegetable", "fruit", "grain", "starch"],
  balanced: ["vegetable", "fruit", "starch", "grain", "egg", "dairy"],
  light: ["vegetable", "fruit", "starch"],
  nutrition_support: ["fruit", "vegetable"],
  picnic: ["bread", "cheese", "fruit", "drink", "snack"],
  aperitif: ["aperitif", "cheese", "bread", "drink", "snack"],
  hosting: ["aperitif", "cheese", "bread", "drink"],
  sharing: ["aperitif", "cheese", "bread", "drink", "snack"],
  kids: ["fruit", "dairy", "grain", "bread"],
  breakfast: ["breakfast", "grain", "dairy", "fruit", "bread"],
  dinner: ["protein", "starch", "vegetable"],
  quick: ["prepared_meal", "bread", "dairy", "starch"],
  vegetarian: ["vegetable", "starch", "grain", "egg", "cheese", "dairy"],
};

const ROLE_ALIASES: Partial<Record<DiscoverProductRole, string[]>> = {
  aperitif: ["apero", "aperitif", "grignoter", "partager"],
  bread: ["pain", "baguette", "toast"],
  breakfast: ["petit dejeuner", "dejeuner", "matin"],
  cheese: ["fromage", "gruyere", "mozzarella", "raclette", "crottin"],
  cleaning: ["menage", "nettoyage", "lessive", "nettoyant", "maison"],
  dairy: ["lait", "yaourt", "yogourt", "yoghourt", "brebis"],
  dessert: ["dessert", "gateau", "sorbet", "glace", "chocolat"],
  drink: ["boire", "boir", "boisson", "jus", "kefir", "sirop", "the", "cafe"],
  egg: ["oeuf", "oeufs"],
  fish: ["poisson", "perche", "brochet", "fera"],
  fruit: ["fruit", "fruits", "pomme", "pommes", "poire", "poires", "banane", "bananes", "fraise"],
  grain: ["cereale", "cereales", "muesli", "farine"],
  hygiene: ["hygiene", "savon", "shampoing", "dentifrice"],
  meat: ["viande", "boeuf", "poulet", "porc", "lard", "jambon", "saucisse", "salami"],
  oil: ["huile", "vinaigre"],
  prepared_meal: ["plat prepare", "menu", "pizza", "pret"],
  protein: ["proteine", "proteines", "proteineux", "proteinee"],
  snack: ["gouter", "snack", "chips", "noix"],
  starch: ["riz", "pates", "pomme de terre", "patate", "feculent"],
  sweet: ["sucre", "sucree", "chocolat", "miel", "bonbon"],
  vegetable: ["legume", "legumes", "salade", "tomate", "carotte", "poireau", "poireaux"],
};

const STRICT_DOMAIN_ROLES = new Set<DiscoverProductRole>([
  "fruit",
  "vegetable",
  "drink",
  "dessert",
  "cleaning",
  "hygiene",
  "gift",
]);

function scoreClamp(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function addScore(bucket: Map<string, number>, key: string, score: number): void {
  bucket.set(key, Math.max(bucket.get(key) ?? 0, scoreClamp(score)));
}

function normalizedIncludes(text: string, phrase: string): boolean {
  return text.includes(normalizeText(phrase));
}

export function cleanDiscoverQuery(query: string): string {
  const tokens = normalizeText(query)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !CONVERSATIONAL_NOISE.has(token));

  const firstRequest = tokens.findIndex((token) => REQUEST_WORDS.has(token));
  const usefulTokens = firstRequest > 0 ? tokens.slice(firstRequest) : tokens;
  return usefulTokens.join(" ").replace(/\s+/g, " ").trim() || normalizeText(query);
}

function extractRequestCount(cleaned: string): number | undefined {
  const match = cleaned.match(/\b(\d+|un|une|deux|trois|quatre|cinq)\s+(?:idee|idees|proposition|propositions|option|options)\b/);
  const parsed = parseFrenchNumber(match?.[1]);
  if (!parsed || parsed < 1) return undefined;
  return Math.min(5, Math.round(parsed));
}

function roleAliasesFromModel(model?: DiscoverMlModel): Partial<Record<DiscoverProductRole, string[]>> {
  return {
    ...ROLE_ALIASES,
    ...(model?.focusPolicy?.roleAliasIndex ?? {}),
  };
}

function detectMentionedRoles(text: string, model?: DiscoverMlModel): DiscoverProductRole[] {
  const aliases = roleAliasesFromModel(model);
  let roles: DiscoverProductRole[] = [];

  for (const [role, terms] of Object.entries(aliases)) {
    if ((terms ?? []).some((term) => normalizedIncludes(text, term))) {
      roles.push(role as DiscoverProductRole);
    }
  }

  roles = [...new Set(roles)];

  if (/\bpommes?\b/.test(text) && !/\bpomme\s+de\s+terre\b|\bpatate\b|\bpdt\b/.test(text)) {
    roles = roles.filter((role) => !["vegetable", "starch"].includes(String(role)));
  }
  if (/\bpomme\s+de\s+terre\b|\bpatate\b|\bpdt\b/.test(text)) {
    roles = roles.filter((role) => role !== "fruit");
  }
  if (/\b(jus|sirop|biere|vin|cidre|cafe|the|boir|boire|boisson|boissons)\b/.test(text)) {
    roles = roles.filter((role) => role !== "fruit");
  }
  if (/\balcool\b/.test(text) && !/\b(jus|sirop|biere|vin|cidre|cafe|the|boir|boire|boisson|boissons|kefir)\b/.test(text)) {
    roles = roles.filter((role) => role !== "drink");
  }

  return roles;
}

function expandRoles(roles: Iterable<DiscoverProductRole>): DiscoverProductRole[] {
  const output = new Set<DiscoverProductRole>();
  for (const role of roles) {
    for (const expanded of ROLE_EXPANSIONS[role] ?? [role]) output.add(expanded);
  }
  return [...output];
}

function expandConstraintRoles(roles: Iterable<DiscoverProductRole>, scope: string): DiscoverProductRole[] {
  const output = new Set<DiscoverProductRole>();
  const normalizedScope = normalizeText(scope);

  for (const role of roles) {
    if (role === "protein" && /\bproteine|proteines|proteineux|proteinee\b/.test(normalizedScope)) {
      for (const expanded of ROLE_EXPANSIONS.protein ?? ["protein"]) output.add(expanded);
      continue;
    }
    if (role === "protein") continue;
    output.add(role);
  }

  return [...output];
}

function addRoleIntent(
  bucket: Map<string, DiscoverSemanticRoleIntent>,
  role: DiscoverProductRole,
  polarity: DiscoverSemanticPolarity,
  score: number,
  source: string
): void {
  const key = `${role}:${polarity}`;
  const existing = bucket.get(key);
  if (!existing || score > existing.score) {
    bucket.set(key, { role, polarity, score: scoreClamp(score), source });
  }
}

function extractRoleIntents(
  cleaned: string,
  hints: BuildSemanticFrameInput["hints"],
  model?: DiscoverMlModel
): DiscoverSemanticRoleIntent[] {
  const intents = new Map<string, DiscoverSemanticRoleIntent>();
  const mentionedRoles = detectMentionedRoles(cleaned, model);
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const connectors = new Set(["a", "au", "aux", "de", "des", "du", "d", "la", "le", "les", "l"]);
  const hardStops = new Set(["et", "ou", "mais", "puis", "avec", "pour"]);

  for (const role of hints?.roleHints ?? []) {
    addRoleIntent(
      intents,
      role,
      STRICT_DOMAIN_ROLES.has(role) ? "strict" : "prefer",
      STRICT_DOMAIN_ROLES.has(role) ? 0.72 : 0.58,
      "planner_hint"
    );
  }

  for (const role of mentionedRoles) {
    addRoleIntent(
      intents,
      role,
      STRICT_DOMAIN_ROLES.has(role) ? "strict" : "prefer",
      STRICT_DOMAIN_ROLES.has(role) ? 0.76 : 0.64,
      "role_alias"
    );
  }

  for (let index = 0; index < tokens.length; index += 1) {
    let polarity: Extract<DiscoverSemanticPolarity, "avoid" | "limit"> | null = null;
    let start = index + 1;
    const token = tokens[index];
    const next = tokens[index + 1];

    if (token === "san" && next === "s") {
      polarity = "avoid";
      start = index + 2;
    } else if (token === "san") {
      polarity = "avoid";
    } else if (token === "sans" && next === "trop") {
      polarity = "limit";
      start = index + 2;
    } else if (["sans", "sauf", "eviter", "evite", "evites", "aucun", "aucune"].includes(token)) {
      polarity = "avoid";
    } else if (token === "pas" && (next === "de" || next === "d")) {
      polarity = "avoid";
      start = index + 2;
    } else if (token === "pas" && next === "trop") {
      polarity = "limit";
      start = index + 2;
    } else if (token === "moins" && next === "de") {
      polarity = "limit";
      start = index + 2;
    } else if (["limiter", "limite", "limites"].includes(token)) {
      polarity = "limit";
    }

    if (!polarity) continue;

    const collected: string[] = [];
    for (let cursor = start; cursor < tokens.length && collected.length < 5; cursor += 1) {
      const candidate = tokens[cursor];
      if (hardStops.has(candidate) && collected.length > 0) break;
      if (connectors.has(candidate)) continue;
      collected.push(candidate);
    }

    const scope = collected.join(" ");
    let scopedRoles = detectMentionedRoles(scope, model);
    if (/\balcool\b/.test(scope)) {
      scopedRoles = scopedRoles.filter((role) => role !== "drink");
    }
    if (!scopedRoles.length) continue;

    for (const role of expandConstraintRoles(scopedRoles, scope)) {
      addRoleIntent(intents, role, polarity, polarity === "avoid" ? 0.9 : 0.86, `${polarity}_scope`);
    }
  }

  for (const rawConstraint of hints?.constraints ?? []) {
    for (const role of expandConstraintRoles(detectMentionedRoles(rawConstraint, model), rawConstraint)) {
      addRoleIntent(intents, role, "avoid", 0.82, "constraint_hint");
    }
  }

  return [...intents.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 16);
}

function conceptsFromQuery(cleaned: string, needs: DiscoverNeedScore[]): Map<string, number> {
  const concepts = new Map<string, number>();
  for (const need of needs) addScore(concepts, need.label, Math.min(0.88, need.score));

  if (/\b(sain|sante|mieux|equilibre|bonnes?\s+habitudes)\b/.test(cleaned)) addScore(concepts, "healthy", 0.82);
  if (/\b(leger|legere|pas\s+lourd|pas\s+lourde|digeste)\b/.test(cleaned)) addScore(concepts, "light", 0.8);
  if (/\b(vitamine|vitamines|carence|absence|manque|nutrition)\b/.test(cleaned)) addScore(concepts, "nutrition_support", 0.76);
  if (/\b(pique\s*nique|picnic|randonnee|randonee|balade|excursion)\b/.test(cleaned)) {
    addScore(concepts, "picnic", 0.84);
    addScore(concepts, "sharing", 0.62);
  }
  if (/\b(apero|aperitif)\b/.test(cleaned)) addScore(concepts, "aperitif", 0.88);
  if (/\b(recois|recevoir|amis|invite|invites|partager|table)\b/.test(cleaned)) {
    addScore(concepts, "hosting", 0.78);
    addScore(concepts, "sharing", 0.72);
  }
  if (/\b(enfant|enfants|ecole|gouter)\b/.test(cleaned)) addScore(concepts, "kids", 0.82);
  if (/\b(ce\s+soir|soir|souper|diner|repas)\b/.test(cleaned)) addScore(concepts, "dinner", 0.68);
  if (/\b(rapide|vite|facile|simple|express)\b/.test(cleaned)) addScore(concepts, "quick", 0.75);
  if (/\b(local|coin|region|gland)\b/.test(cleaned)) addScore(concepts, "local", 0.72);

  return concepts;
}

function domainScores(
  cleaned: string,
  roleIntents: DiscoverSemanticRoleIntent[],
  profiles: DiscoverProductProfile[]
): DiscoverSemanticFrame["domains"] {
  const scores = new Map<string, number>();
  const roleSet = new Set(roleIntents.filter((intent) => intent.polarity === "prefer" || intent.polarity === "strict").map((intent) => intent.role));

  if (roleSet.has("cleaning") || normalizedIncludes(cleaned, "menage") || normalizedIncludes(cleaned, "maison")) addScore(scores, "cleaning", 0.9);
  if (roleSet.has("hygiene")) addScore(scores, "hygiene", 0.88);
  if (roleSet.has("drink")) addScore(scores, "drink", 0.86);
  if ([...roleSet].some((role) => ["fruit", "vegetable", "starch", "meat", "fish", "egg", "cheese", "dairy", "bread", "grain"].includes(role))) {
    addScore(scores, "food", 0.9);
  }
  if (!scores.size && profiles.some((profile) => profile.isFood)) addScore(scores, "food", 0.62);

  return [...scores.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
}

function addConceptRolePriors(
  roleIntents: Map<string, DiscoverSemanticRoleIntent>,
  concepts: Map<string, number>
): void {
  for (const [concept, score] of concepts.entries()) {
    for (const role of CONCEPT_ROLE_PRIORS[concept] ?? []) {
      addRoleIntent(roleIntents, role, "prefer", score * 0.56, `concept:${concept}`);
    }
  }
}

function hasMissingSpecificNutritionTarget(cleaned: string): boolean {
  return /\b(vitamine|vitamines|carence|absence|manque)\b/.test(cleaned) &&
    !/\b(vitamine\s+[abcdekm]\d*|b12|fer|calcium|magnesium|zinc|omega)\b/.test(cleaned);
}

export function buildSemanticDiscoveryFrame(input: BuildSemanticFrameInput): DiscoverSemanticFrame {
  const cleanedQuery = cleanDiscoverQuery(input.query);
  const concepts = conceptsFromQuery(cleanedQuery, input.needs);
  const explicitlyMentionedRoles = new Set(detectMentionedRoles(cleanedQuery, input.model));
  if (explicitlyMentionedRoles.has("drink")) {
    concepts.delete("dinner");
    concepts.delete("balanced");
    addScore(concepts, "drink", 0.9);
  }
  if (explicitlyMentionedRoles.has("cleaning") || explicitlyMentionedRoles.has("hygiene")) {
    concepts.delete("dinner");
    concepts.delete("balanced");
    concepts.delete("healthy");
  }
  if (
    concepts.has("nutrition_support") &&
    !/\b(repas|ce\s+soir|soir|souper|diner|dejeuner|midi|plat|menu)\b/.test(cleanedQuery)
  ) {
    concepts.delete("dinner");
    addScore(concepts, "healthy", 0.72);
  }
  const roleIntentMap = new Map<string, DiscoverSemanticRoleIntent>();
  for (const intent of extractRoleIntents(cleanedQuery, input.hints, input.model)) {
    addRoleIntent(roleIntentMap, intent.role, intent.polarity, intent.score, intent.source ?? "semantic");
  }
  addConceptRolePriors(roleIntentMap, concepts);

  for (const intent of [...roleIntentMap.values()]) {
    if (intent.polarity !== "avoid" && intent.polarity !== "limit") continue;
    roleIntentMap.delete(`${intent.role}:prefer`);
    roleIntentMap.delete(`${intent.role}:complement`);
    roleIntentMap.delete(`${intent.role}:strict`);
  }

  const roleIntents = [...roleIntentMap.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 18);
  const domains = domainScores(cleanedQuery, roleIntents, input.profiles);
  const requestCount = extractRequestCount(cleanedQuery);
  const uncertainties: DiscoverSemanticFrame["uncertainties"] = [];

  if (hasMissingSpecificNutritionTarget(cleanedQuery)) {
    uncertainties.push({ kind: "missing_specific_target", target: "vitamin", score: 0.78 });
    uncertainties.push({ kind: "health_sensitive", target: "nutrition", score: 0.64 });
  }
  if (!concepts.size && !roleIntents.length) uncertainties.push({ kind: "low_confidence", score: 0.62 });

  const constraints: DiscoverSemanticFrame["constraints"] = roleIntents
    .filter((intent) => intent.polarity === "avoid" || intent.polarity === "limit" || intent.polarity === "strict")
    .map((intent) => ({
      kind: intent.polarity === "avoid" ? "avoid_role" as const : intent.polarity === "limit" ? "limit_role" as const : "strict_domain" as const,
      target: intent.role,
      score: intent.score,
      source: intent.source,
    }));

  if (input.budget.kind !== "none") {
    constraints.push({
      kind: "budget",
      target: input.budget.kind,
      score: input.budget.confidence,
      source: input.budget.source,
    });
  }

  const confidenceSignals = [
    ...[...concepts.values()],
    ...roleIntents.map((intent) => intent.score),
    ...domains.map((domain) => domain.score),
  ];
  const confidence = scoreClamp(confidenceSignals.reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(5, confidenceSignals.length)));
  const responseMode = uncertainties.some((uncertainty) => uncertainty.kind === "missing_specific_target")
    ? "safe_general_with_clarification"
    : confidence < 0.28
      ? "clarify"
      : "direct";

  return {
    schemaVersion: 1,
    originalQuery: input.query,
    cleanedQuery,
    ...(requestCount ? { requestCount } : {}),
    domains,
    concepts: [...concepts.entries()]
      .map(([name, score]) => ({ name, score: scoreClamp(score) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 10),
    roleIntents,
    constraints,
    uncertainties,
    responseMode,
    confidence,
  };
}

export function frameRoles(
  frame: DiscoverSemanticFrame,
  polarity: DiscoverSemanticPolarity
): Set<DiscoverProductRole> {
  return new Set(
    frame.roleIntents
      .filter((intent) => intent.polarity === polarity)
      .map((intent) => intent.role)
  );
}

export function frameHasConcept(frame: DiscoverSemanticFrame, concept: string): boolean {
  return frame.concepts.some((entry) => entry.name === concept && entry.score >= 0.45);
}
