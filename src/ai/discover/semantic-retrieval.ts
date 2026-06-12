import { createHash } from "node:crypto";
import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import type {
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverSemanticFrame,
  DiscoverSemanticRoleIntent,
} from "./types.js";

export type SemanticRankedProduct = {
  profile: DiscoverProductProfile;
  score: number;
  baseScore: number;
  semanticScore: number;
  semanticReasons: string[];
  semanticPenalties: string[];
};

type ProductEntry = {
  profile: DiscoverProductProfile;
  score: number;
};

const ROLE_FAMILIES: Partial<Record<DiscoverProductRole, DiscoverProductRole[]>> = {
  protein: ["protein", "meat", "fish", "egg", "cheese"],
  meat: ["meat", "protein"],
  fish: ["fish", "protein"],
  egg: ["egg", "protein", "breakfast"],
  cheese: ["cheese", "dairy", "protein", "aperitif"],
  dairy: ["dairy"],
  fruit: ["fruit"],
  vegetable: ["vegetable"],
  drink: ["drink"],
  cleaning: ["cleaning"],
  hygiene: ["hygiene"],
  starch: ["starch", "grain"],
  grain: ["grain", "starch"],
  bread: ["bread", "bakery"],
};

const CONCEPT_ROLE_BOOSTS: Record<string, DiscoverProductRole[]> = {
  healthy: ["vegetable", "fruit", "grain", "starch", "dairy"],
  balanced: ["vegetable", "fruit", "starch", "grain", "egg", "dairy"],
  light: ["vegetable", "fruit", "starch", "grain"],
  nutrition_support: ["fruit", "vegetable"],
  picnic: ["bread", "cheese", "fruit", "drink", "snack"],
  aperitif: ["aperitif", "cheese", "bread", "drink", "snack"],
  hosting: ["aperitif", "cheese", "bread", "drink", "snack"],
  sharing: ["aperitif", "cheese", "bread", "drink", "snack"],
  kids: ["fruit", "dairy", "grain", "bread"],
  breakfast: ["breakfast", "grain", "dairy", "fruit", "bread"],
  dinner: ["protein", "starch", "vegetable", "fish", "meat", "egg"],
  quick: ["prepared_meal", "bread", "dairy", "starch", "grain"],
  vegetarian: ["vegetable", "starch", "grain", "egg", "cheese", "dairy"],
  local: ["cheese", "bread", "vegetable", "fruit", "meat", "fish"],
};

const CONCEPT_ROLE_PENALTIES: Record<string, DiscoverProductRole[]> = {
  healthy: ["sweet", "prepared_meal", "menu", "meat"],
  light: ["meat", "prepared_meal", "menu", "sweet"],
  nutrition_support: ["sweet", "prepared_meal", "menu", "cleaning", "hygiene"],
  picnic: ["cleaning", "hygiene", "sauce", "oil"],
  breakfast: ["meat", "fish", "prepared_meal", "menu", "oil", "sauce"],
  kids: ["alcohol", "cleaning", "hygiene"],
  vegetarian: ["meat", "fish"],
};

function hasAnyRole(profile: DiscoverProductProfile, roles: Iterable<DiscoverProductRole>): boolean {
  for (const role of roles) {
    if (profile.roles.has(role)) return true;
    for (const related of ROLE_FAMILIES[role] ?? []) {
      if (profile.roles.has(related)) return true;
    }
  }
  return false;
}

function hasForbiddenRole(profile: DiscoverProductProfile, role: DiscoverProductRole): boolean {
  if (profile.roles.has(role)) return true;
  if (role === "protein") return hasAnyRole(profile, ["meat", "fish", "egg", "cheese"]);
  if (role === "starch") return profile.roles.has("grain");
  if (role === "bread") return profile.roles.has("bakery");
  return false;
}

function domainPenalty(profile: DiscoverProductProfile, frame: DiscoverSemanticFrame): number {
  const topDomain = frame.domains[0];
  if (!topDomain || topDomain.score < 0.78) return 0;

  if (topDomain.name === "drink") return profile.roles.has("drink") ? 12 : -90;
  if (topDomain.name === "cleaning") return hasAnyRole(profile, ["cleaning", "hygiene"]) ? 12 : -95;
  if (topDomain.name === "hygiene") return profile.roles.has("hygiene") ? 12 : -95;
  if (topDomain.name === "food") return profile.isFood ? 2 : -80;
  return 0;
}

function roleSignal(
  profile: DiscoverProductProfile,
  intent: DiscoverSemanticRoleIntent,
  reasons: string[],
  penalties: string[]
): number {
  const matches = intent.polarity === "avoid" || intent.polarity === "limit"
    ? hasForbiddenRole(profile, intent.role)
    : hasAnyRole(profile, [intent.role]);

  if (intent.polarity === "strict") {
    if (matches) {
      reasons.push(`strict:${intent.role}`);
      return 22 * intent.score;
    }
    penalties.push(`missing_strict:${intent.role}`);
    return -120 * intent.score;
  }

  if (intent.polarity === "avoid") {
    if (!matches) return 0;
    penalties.push(`avoid:${intent.role}`);
    return -120 * intent.score;
  }

  if (intent.polarity === "limit") {
    if (!matches) return 0;
    penalties.push(`limit:${intent.role}`);
    return -28 * intent.score;
  }

  if (matches) {
    reasons.push(`${intent.polarity}:${intent.role}`);
    return (intent.polarity === "complement" ? 7 : 12) * intent.score;
  }

  return 0;
}

function hashedEmbedding(text: string, dim = 128): number[] {
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

export function productSemanticText(profile: DiscoverProductProfile): string {
  return normalizeText([
    profile.product.name,
    profile.categoryNames.join(" "),
    profile.product.tags?.join(" ") ?? "",
    profile.metadataText,
    [...profile.roles].join(" "),
    [...profile.labels].join(" "),
    profile.isFood ? "food catalogue" : "non food catalogue",
    profile.hasOptions ? "options disponibles" : "",
  ].join(" "));
}

function semanticSimilarity(query: string, profile: DiscoverProductProfile): number {
  return cosine(hashedEmbedding(query), hashedEmbedding(productSemanticText(profile)));
}

function singular(value: string): string {
  return value.endsWith("s") && value.length > 4 ? value.slice(0, -1) : value;
}

function lexicalProductBoost(query: string, profile: DiscoverProductProfile): number {
  const queryTokens = tokenizeForMatch(query).filter((token) => token.length >= 4);
  const productTokens = tokenizeForMatch(profile.product.name).filter((token) => token.length >= 4);
  const productTokenSet = new Set(productTokens);
  const productSingulars = new Set(productTokens.map(singular));
  let boost = 0;

  for (const token of queryTokens) {
    if (productTokenSet.has(token) || productSingulars.has(singular(token))) {
      boost += 120;
    }
  }

  return Math.min(180, boost);
}

function conceptSignal(
  profile: DiscoverProductProfile,
  frame: DiscoverSemanticFrame,
  reasons: string[],
  penalties: string[]
): number {
  let score = 0;

  for (const concept of frame.concepts) {
    const boostedRoles = CONCEPT_ROLE_BOOSTS[concept.name] ?? [];
    const penaltyRoles = CONCEPT_ROLE_PENALTIES[concept.name] ?? [];

    if (hasAnyRole(profile, boostedRoles)) {
      reasons.push(`concept:${concept.name}`);
      score += 8 * concept.score;
    }
    if (hasAnyRole(profile, penaltyRoles)) {
      penalties.push(`concept_penalty:${concept.name}`);
      score -= 12 * concept.score;
    }
  }

  return score;
}

export function rankSemanticProducts(
  entries: ProductEntry[],
  frame: DiscoverSemanticFrame
): SemanticRankedProduct[] {
  const query = frame.cleanedQuery || frame.originalQuery;

  return entries
    .map((entry) => {
      const reasons: string[] = [];
      const penalties: string[] = [];
      let semanticAdjustment = 0;

      const domain = domainPenalty(entry.profile, frame);
      semanticAdjustment += domain;
      if (domain > 0) reasons.push(`domain:${frame.domains[0]?.name ?? "match"}`);
      if (domain < -40) penalties.push(`domain:${frame.domains[0]?.name ?? "drift"}`);

      for (const intent of frame.roleIntents) {
        semanticAdjustment += roleSignal(entry.profile, intent, reasons, penalties);
      }

      semanticAdjustment += conceptSignal(entry.profile, frame, reasons, penalties);

      const embedding = semanticSimilarity(query, entry.profile);
      semanticAdjustment += embedding * 6;
      if (embedding >= 0.24) reasons.push("semantic_similarity");

      const lexicalBoost = lexicalProductBoost(query, entry.profile);
      semanticAdjustment += lexicalBoost;
      if (lexicalBoost > 0) reasons.push("direct_lexical_match");

      if (frame.responseMode === "safe_general_with_clarification" && hasAnyRole(entry.profile, ["fruit", "vegetable"])) {
        semanticAdjustment += 6;
        reasons.push("safe_general_nutrition");
      }

      const semanticScore = entry.score + semanticAdjustment;
      return {
        ...entry,
        baseScore: entry.score,
        score: semanticScore,
        semanticScore,
        semanticReasons: [...new Set(reasons)].slice(0, 8),
        semanticPenalties: [...new Set(penalties)].slice(0, 8),
      };
    })
    .sort((left, right) => right.score - left.score);
}
