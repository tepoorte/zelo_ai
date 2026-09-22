import {
  FRENCH_NUMBER_PATTERN_SOURCE,
  isFrenchNumberWord,
  parseFrenchNumber,
} from "../../domain/french-numbers.js";
import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import {
  canonicalizeQuantityUnit,
  isQuantityUnitToken,
  quantityUnitPatternSource,
} from "../../domain/quantity-units.js";
import { bestTokenSimilarity, levenshteinDistance, textSimilarity } from "../../domain/text-similarity.js";
import { getAllProducts, type Product } from "../../swissdata/products.js";
import {
  filterAssistantEligibleProducts,
  hasBlockedAssistantProductReference,
} from "../product-eligibility.js";
import { ollamaChat, safeJsonParse } from "./ollama-client.js";
import { plannerPromptAddItems } from "./planner.service.js";
import {
  applyVagueQuantityPolicyToPlan,
  type VagueQuantityCue,
} from "./vague-quantity-policy.service.js";

export type ExtractedAddItem = {
  query: string;
  qty: number;
  unit?: string;
  productId?: string;
  /** Internal parser cue, stripped before runtime execution. */
  vagueQuantityCue?: VagueQuantityCue;
};

export type ExtractedAddItemsPlan = {
  intent: "ADD_ITEMS";
  actions: [
    {
      type: "add_to_cart";
      items: ExtractedAddItem[];
    },
  ];
};

export type ExtractAddItemsOptions = {
  /** Optional catalog boundary supplied by a caller with stricter business scope. */
  catalog?: readonly Product[];
  /** Products already present in the caller's business object, used only as an ambiguity tie-breaker. */
  preferredProductIds?: readonly string[];
};

type CatalogMatch = {
  product: Product;
  score: number;
  reason: "exact" | "tokens" | "fuzzy";
};

type ParsedSegment = {
  raw: string;
  cleaned: string;
  query: string;
  qty: number;
  unit: string;
  product?: Product;
  productMatchReason?: CatalogMatch["reason"];
  position?: number;
  vagueQuantityCue?: VagueQuantityCue;
};

type TextToken = {
  raw: string;
  normalized: string;
  start: number;
  end: number;
};

type RawSegment = {
  text: string;
  start: number;
  end: number;
};

type SegmentSource = "deterministic" | "language_segmenter";

type LanguageSegmenterItem =
  | string
  | { raw?: unknown; text?: unknown; label?: unknown; query?: unknown; qty?: unknown; unit?: unknown };

type LanguageSegmenterResponse = {
  items?: LanguageSegmenterItem[];
  actions?: Array<{
    type?: unknown;
    items?: LanguageSegmenterItem[];
  }>;
};

const UNIT_PATTERN = quantityUnitPatternSource();
const NUMBER_PATTERN = `\\d+(?:[\\.,]\\d+)?|${FRENCH_NUMBER_PATTERN_SOURCE}`;

const QUERY_STOPWORDS = new Set([
  "a",
  "ai",
  "alors",
  "an",
  "apres",
  "après",
  "aussi",
  "aurais",
  "ajoute",
  "ajouter",
  "avance",
  "besion",
  "besoin",
  "bonjour",
  "bonne",
  "ca",
  "ce",
  "cette",
  "commande",
  "commander",
  "en",
  "fin",
  "de",
  "des",
  "du",
  "et",
  "j",
  "je",
  "journee",
  "journée",
  "la",
  "le",
  "les",
  "livrer",
  "met",
  "me",
  "mets",
  "merci",
  "midi",
  "mon",
  "oui",
  "panier",
  "peux",
  "pour",
  "prends",
  "puis",
  "quand",
  "quelque",
  "quelques",
  "salut",
  "si",
  "semaine",
  "stp",
  "te",
  "tu",
  "un",
  "une",
  "veux",
  "voudrais",
  "faudrait",
]);

const CATALOG_SCAN_STOPWORDS = new Set([
  ...QUERY_STOPWORDS,
  "a",
  "au",
  "aux",
  "avec",
  "dans",
  "d",
  "l",
  "notre",
  "nous",
  "votre",
  "vous",
  "y",
]);
CATALOG_SCAN_STOPWORDS.delete("panier");

const PRODUCT_TOKEN_NOISE = new Set(["ou", "vv"]);
const MIN_CATALOG_MATCH_SCORE = 145;
const MAX_CATALOG_WINDOW_TOKENS = 8;
const COMMON_CATALOG_TOKEN_LIMIT = 5;

function normalizeLoose(input: string): string {
  return normalizeText(input).replace(/\s+/g, " ").trim();
}

function normalizeInvisibleCharacters(input: string): string {
  return String(input || "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, " ");
}

function addItemsLanguageSegmenterPrompt(strict = false): string {
  if (!strict) return plannerPromptAddItems();

  return `${plannerPromptAddItems()}

IMPORTANT FINAL:
Chaque raw doit être une sous-chaîne exacte du message original.
Si les mots exacts ne sont pas dans le message, ne les écris pas.`;
}

function shouldUseLanguageSegmenter(userText: string): boolean {
  const text = normalizeInvisibleCharacters(userText);
  if (text.length >= 90) return true;
  if (/[\n\r,;:•*]/.test(text)) return true;

  const productJoiners = normalizeLoose(text).match(/\b(?:et|and|puis|ensuite|apres|après)\b/g) ?? [];
  return productJoiners.length >= 2;
}

function segmenterItems(payload: LanguageSegmenterResponse | null): LanguageSegmenterItem[] {
  if (Array.isArray(payload?.items)) return payload.items;
  const addAction = payload?.actions?.find((action) => action?.type === "add_to_cart");
  return Array.isArray(addAction?.items) ? addAction.items : [];
}

function segmenterRawValue(item: LanguageSegmenterItem): unknown {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return undefined;
  if (item.raw ?? item.text ?? item.label) {
    return item.raw ?? item.text ?? item.label;
  }

  const query = String(item.query ?? "").trim();
  if (!query) return undefined;

  const qty = Number(item.qty);
  const unit = typeof item.unit === "string" ? normalizeUnit(item.unit) : undefined;
  const hasQty = Number.isFinite(qty) && qty > 0 && qty !== 1;
  const prefix = hasQty
    ? `${qty}${unit && unit !== "piece" ? unit : ""} `
    : "";

  return `${prefix}${query}`.trim();
}

function normalizeSegmenterSegments(
  payload: LanguageSegmenterResponse | null,
  userText: string
): string[] | null {
  const items = segmenterItems(payload);
  const normalizedUserText = normalizeLoose(userText);
  const segments: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const value = segmenterRawValue(item);
    if (typeof value !== "string") continue;

    const segment = normalizeInvisibleCharacters(value)
      .replace(/^\s*(?:[-•*]\s*)+/, "")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedSegment = normalizeLoose(segment);

    if (!segment || segment.length < 2 || segment.length > 160) continue;
    if (!hasMeaningfulQuery(segment)) continue;
    if (seen.has(normalizedSegment)) continue;

    seen.add(normalizedSegment);
    segments.push(segment);
  }

  if (!segments.length) return null;

  const joined = normalizeLoose(segments.join(" "));
  const looksLikeWholeMessage =
    segments.length === 1 &&
    normalizedUserText.length > 120 &&
    joined.length > normalizedUserText.length * 0.72;
  if (looksLikeWholeMessage) return null;

  return segments;
}

function validateSegmenterSegments(userText: string, segments: string[]): string | null {
  const normalizedUserText = normalizeInvisibleCharacters(userText);

  for (const segment of segments) {
    if (!normalizedUserText.includes(segment)) {
      return `raw_not_in_original:${segment}`;
    }
  }

  return null;
}

async function extractSegmentsWithLanguageModel(userText: string): Promise<string[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ollamaChat(
        [
          { role: "system", content: addItemsLanguageSegmenterPrompt(attempt > 0) },
          { role: "user", content: normalizeInvisibleCharacters(userText) },
        ],
        0,
        {
          format: "json",
          keepAlive: "30m",
          numCtx: 4096,
          numPredict: 700,
        }
      );
      const parsed = safeJsonParse<LanguageSegmenterResponse>(raw);
      const segments = normalizeSegmenterSegments(parsed, userText);
      const invalidReason = segments?.length
        ? validateSegmenterSegments(userText, segments)
        : "empty_segments";

      console.log("[ADD_ITEMS_EXTRACTOR] LANGUAGE_SEGMENTER", JSON.stringify({
        attempt: attempt + 1,
        used: Boolean(segments?.length && !invalidReason),
        invalidReason,
        segments: segments ?? [],
      }));

      if (segments?.length && !invalidReason) {
        return segments;
      }
    } catch (error) {
      console.warn("[ADD_ITEMS_EXTRACTOR] LANGUAGE_SEGMENTER_FAILED", error instanceof Error ? error.message : error);
    }
  }

  return null;
}

function normalizeUnit(value?: string): string {
  return canonicalizeQuantityUnit(value) ?? "piece";
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  return parseFrenchNumber(value);
}

function isLikelyYearNumber(value?: string): boolean {
  if (!value || !/^\d{4}$/.test(value)) return false;
  const year = Number(value);
  return year >= 1900 && year <= 2099;
}

function productTokens(productName: string): string[] {
  return tokenizeForMatch(productName)
    .filter((token) => token.length > 1)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !isQuantityUnitToken(token));
}

function catalogProductTokens(productName: string): string[] {
  return [...new Set(productTokens(productName))]
    .filter((token) => !PRODUCT_TOKEN_NOISE.has(token));
}

function catalogTokenFrequency(productEntries: Array<{ tokens: string[] }>): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const entry of productEntries) {
    for (const token of new Set(entry.tokens)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return frequencies;
}

function meaningfulTokens(value: string): string[] {
  return tokenizeForMatch(value)
    .filter((token) => token.length > 1)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !isQuantityUnitToken(token))
    .filter((token) => !QUERY_STOPWORDS.has(token));
}

function hasMeaningfulQuery(value: string): boolean {
  return meaningfulTokens(value).length > 0;
}

function firstQuantityCueIndex(text: string): number {
  const matcher = new RegExp(
    `(?:^|\\s)(?:\\d+(?:[\\.,]\\d+)?\\s*(?:${UNIT_PATTERN})?|${FRENCH_NUMBER_PATTERN_SOURCE})\\b`,
    "gi"
  );
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    const raw = match[0].trim();
    const number = raw.match(/^\d+(?:[\.,]\d+)?/)?.[0];
    const hasUnit = Boolean(
      number && new RegExp(`^\\d+(?:[\\.,]\\d+)?\\s*(?:${UNIT_PATTERN})\\b`, "i").test(raw)
    );

    if (number && isLikelyYearNumber(number) && !hasUnit) {
      continue;
    }

    return match[0].startsWith(" ") ? match.index + 1 : match.index;
  }

  return -1;
}

function stripLeadingIntentNoise(raw: string): string {
  let text = String(raw || "").trim();

  text = text.replace(/^\s*(?:[-•*]\s*)+/, "");

  const colon = text.indexOf(":");
  if (colon >= 0) {
    const headTokenCount = tokenizeForMatch(text.slice(0, colon)).length;
    if (colon < 100 && headTokenCount <= 12) {
      text = text.slice(colon + 1).trim();
    }
  }

  const quantityCueIndex = firstQuantityCueIndex(text);
  if (quantityCueIndex > 0) {
    const beforeQuantity = text.slice(0, quantityCueIndex);
    const afterQuantity = text.slice(quantityCueIndex);
    const beforeLooksLikeIntro =
      /[\n!?]/.test(beforeQuantity) ||
      meaningfulTokens(beforeQuantity).length === 0;
    const afterStillContainsProductWords = meaningfulTokens(afterQuantity).length > 0;

    if (beforeLooksLikeIntro && afterStillContainsProductWords) {
      text = afterQuantity.trim();
    }
  }

  if (quantityCueIndex === 0) {
    text = text.slice(quantityCueIndex).trim();
  }

  text = text.replace(/^(?:et\s+)?(?:puis\s+)?(?:apres|après|ensuite|aussi)\s+/i, "");
  text = text.replace(/^(?:de|d['’]|du|des|de la|de l['’]|le|la|les|un|une|quelques?)\s+/i, "");

  return text.trim();
}

function stripTrailingNoise(raw: string): string {
  return String(raw || "")
    .replace(/(?:^|\s)(?:a|à)\s+(?:mon|ton|notre)?\s*panier\b/gi, " ")
    .replace(/(?:^|\s)(?:dans|au|pour)\s+(?:mon|ton|notre)?\s*panier\b/gi, " ")
    .replace(/\bj['’]?\s*en\s+prends\s+aussi\b.*$/i, "")
    .replace(/\bsi tu en as\b.*$/i, "")
    .replace(/\b(?:un\s+)?(?:grand(?:s|e|es)?\s+|mille\s+|beaucoup\s+)?merci\b.*$/i, "")
    .replace(/\b(?:merci|stp|svp|s['’]?il te plait|(?:bonne|belle) journ[eé]e)\b.*$/i, "")
    .replace(/\s+\bet\b$/i, "")
    .trim();
}

function normalizeSeparators(text: string): string {
  return String(text || "")
    .replace(/\r?\n+/g, ",")
    .replace(/[?!]+/g, ",")
    .replace(/^\s*[-•*]\s+/gm, ",")
    .replace(
      new RegExp(`\\s+[-•*]\\s+(?=(?:\\d|${FRENCH_NUMBER_PATTERN_SOURCE}\\b))`, "gi"),
      ","
    )
    .replace(/[;|]+/g, ",")
    .replace(/\s+(?:et\s+)?puis\s+(?:apres|après)\s+/gi, ",")
    .replace(/\s+(?:et\s+)?puis\s+/gi, ",")
    .replace(/\s+(?:puis|ensuite|après|apres|aussi)\s+/gi, ",")
    .replace(
      new RegExp(`\\s+(?:et|and)\\s+(?=(?:${NUMBER_PATTERN})\\b)`, "gi"),
      (separator, offset, source) => {
        const previousToken = String(source)
          .slice(0, offset)
          .trim()
          .split(/\s+/)
          .pop();
        return previousToken && isFrenchNumberWord(previousToken) ? separator : ",";
      }
    )
    .replace(
      /\s+(?:et|and)\s+(?=(?:du|de la|de l['’]?|des|d['’]?|le|la|les|quelques?)\b)/gi,
      ","
    );
}

function isConversationOnlySegment(raw: string): boolean {
  const text = normalizeLoose(raw);
  if (!text) return true;
  if (/^(?:bonjour|salut|coucou|hello|hey|andre|andré)$/.test(text)) return true;
  return false;
}

function tokenizeTextWithOffsets(input: string): TextToken[] {
  const tokens: TextToken[] = [];
  const matcher = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) !== null) {
    const raw = match[0] ?? "";
    const normalized = normalizeLoose(raw);
    if (!normalized) continue;
    tokens.push({
      raw,
      normalized,
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return tokens;
}

function isQuantityLikeToken(token: string): boolean {
  return (
    /^\d+(?:[\.,]\d+)?$/.test(token) ||
    new RegExp(`^\\d+(?:[\\.,]\\d+)?(?:${UNIT_PATTERN})$`, "i").test(token) ||
    isFrenchNumberWord(token) ||
    isQuantityUnitToken(token)
  );
}

function catalogScanTokens(input: string): TextToken[] {
  return tokenizeTextWithOffsets(input)
    .filter((token) => token.normalized.length > 2)
    .filter((token) => !CATALOG_SCAN_STOPWORDS.has(token.normalized))
    .filter((token) => !isQuantityLikeToken(token.normalized));
}

function catalogWindowTokens(window: TextToken[]): string[] {
  const tokens = window.map((token) => token.normalized);
  const expanded = new Set(tokens);

  for (let index = 0; index < window.length - 1; index++) {
    const current = window[index];
    const next = window[index + 1];
    if (!current || !next) continue;
    if (next.start - current.end > 2) continue;
    expanded.add(`${current.normalized}${next.normalized}`);
  }

  return [...expanded];
}

function scoreCatalogWindow(
  windowTokens: string[],
  productTokenList: string[],
  tokenFrequency?: Map<string, number>
): number {
  if (!windowTokens.length || !productTokenList.length) return 0;
  if (!hasDistinctiveProductToken(windowTokens, productTokenList, tokenFrequency)) return 0;

  const windowScores = windowTokens.map((token) => bestTokenSimilarity(token, productTokenList));
  const productScores = productTokenList.map((token) => bestTokenSimilarity(token, windowTokens));
  const matchedWindowTokens = windowScores.filter((score) => score >= 0.74).length;
  const matchedProductTokens = productScores.filter((score) => score >= 0.74).length;
  const exactWindowMatches = windowTokens.filter((token) => productTokenList.includes(token)).length;
  const exactProductMatches = productTokenList.filter((token) => windowTokens.includes(token)).length;
  const windowCoverage = matchedWindowTokens / windowTokens.length;
  const productCoverage = matchedProductTokens / productTokenList.length;
  const averageWindowScore = windowScores.reduce((sum, score) => sum + score, 0) / windowTokens.length;

  if (windowTokens.length === 1) {
    const [token] = windowTokens;
    const distinctiveTokens = distinctiveProductTokens(productTokenList, tokenFrequency);
    const distinctiveMatch = token
      ? bestTokenSimilarityMatch(token, distinctiveTokens)
      : { score: 0, candidate: undefined };
    const distinctiveScore = distinctiveMatch.score;
    const exactDistinctiveMatch = Boolean(token && distinctiveTokens.includes(token));
    const fuzzyDistinctiveMatch = Boolean(
      token &&
      token.length >= 4 &&
      distinctiveScore >= 0.74 &&
      hasCompatibleFuzzyTokenStart(token, distinctiveMatch.candidate) &&
      !isWeakSingleTokenPrefixMatch(token, distinctiveMatch.candidate)
    );

    if (
      !token ||
      (!exactDistinctiveMatch && (productTokenList.length > 3 || !fuzzyDistinctiveMatch))
    ) {
      return 0;
    }
  } else {
    const minimumMatchedWindowTokens = Math.min(2, windowTokens.length);
    const productFullyCovered =
      productCoverage >= 0.95 &&
      matchedProductTokens >= Math.min(2, productTokenList.length);
    if (matchedWindowTokens < minimumMatchedWindowTokens) return 0;
    if (windowCoverage < 0.75 && !productFullyCovered) return 0;
    if (productCoverage < 0.5 && matchedProductTokens < 2) return 0;
    if (productTokenList.length >= 5 && matchedProductTokens < 3) return 0;
    if (exactWindowMatches === 0 && averageWindowScore < 0.78 && !productFullyCovered) return 0;
  }

  const wordOrderBoost =
    windowTokens[0] &&
    productTokenList[0] &&
    bestTokenSimilarity(windowTokens[0], [productTokenList[0]]) >= 0.74
      ? 12
      : 0;

  return (
    100 +
    productCoverage * 85 +
    windowCoverage * 70 +
    averageWindowScore * 25 +
    exactWindowMatches * 8 +
    exactProductMatches * 18 +
    Math.min(windowTokens.length, productTokenList.length) * 2 +
    wordOrderBoost -
    Math.max(0, windowTokens.length - matchedWindowTokens) * 35
  );
}

function distinctiveProductTokens(
  productTokenList: string[],
  tokenFrequency?: Map<string, number>
): string[] {
  const rareDistinctive = tokenFrequency
    ? productTokenList.filter((token) => (tokenFrequency.get(token) ?? 0) <= COMMON_CATALOG_TOKEN_LIMIT)
    : productTokenList;
  return rareDistinctive.length ? rareDistinctive : productTokenList;
}

function hasDistinctiveProductToken(
  windowTokens: string[],
  productTokenList: string[],
  tokenFrequency?: Map<string, number>
): boolean {
  const distinctiveTokens = distinctiveProductTokens(productTokenList, tokenFrequency);
  return windowTokens.some((token) => bestTokenSimilarity(token, distinctiveTokens) >= 0.74);
}

function bestTokenSimilarityMatch(
  token: string,
  candidates: string[]
): { score: number; candidate?: string } {
  let best = { score: 0, candidate: undefined as string | undefined };

  for (const candidate of candidates) {
    const score = bestTokenSimilarity(token, [candidate]);
    if (score > best.score) {
      best = { score, candidate };
    }
  }

  return best;
}

function isWeakSingleTokenPrefixMatch(token: string, candidate?: string): boolean {
  if (!token || !candidate || token === candidate) return false;
  if (!candidate.startsWith(token)) return false;
  return token.length / candidate.length < 0.72;
}

function hasCompatibleFuzzyTokenStart(token: string, candidate?: string): boolean {
  if (!token || !candidate) return false;
  if (token[0] !== candidate[0]) return false;
  if (Math.min(token.length, candidate.length) < 5) return true;

  const prefixLength = Math.min(3, token.length, candidate.length);
  const tokenPrefix = token.slice(0, prefixLength);
  const candidatePrefix = candidate.slice(0, prefixLength);

  return (
    token.slice(0, 2) === candidate.slice(0, 2) ||
    levenshteinDistance(tokenPrefix, candidatePrefix) <= 1
  );
}

function tokenMatchesProductToken(token: string, productTokenList: string[]): boolean {
  const match = bestTokenSimilarityMatch(token, productTokenList);
  return (
    match.score >= 0.74 &&
    hasCompatibleFuzzyTokenStart(token, match.candidate) &&
    !isWeakSingleTokenPrefixMatch(token, match.candidate)
  );
}

function hasUnmatchedAdjacentDescriptor(
  scanTokens: TextToken[],
  startIndex: number,
  endIndex: number,
  productTokenList: string[]
): boolean {
  if (endIndex - startIndex !== 1) return false;

  const current = scanTokens[startIndex];
  if (!current) return false;

  const neighbours = [
    scanTokens[startIndex - 1],
    scanTokens[endIndex],
  ].filter((token): token is TextToken => {
    if (!token) return false;
    const gap = token.end <= current.start
      ? current.start - token.end
      : token.start - current.end;
    return gap >= 0 && gap <= 24;
  });

  return neighbours.some((token) => !tokenMatchesProductToken(token.normalized, productTokenList));
}

function parseNearbyQuantity(
  userText: string,
  start: number,
  end: number
): { qty: number; unit: string } {
  const left = userText.slice(Math.max(0, start - 48), start);
  const right = userText.slice(end, Math.min(userText.length, end + 32));

  const leftNumberWithUnit = left.match(
    new RegExp(`(?:^|[\\s,;:\\-])(?:a\\.?\\s*)?(\\d+(?:[\\.,]\\d+)?)\\s*(${UNIT_PATTERN})\\s*(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|de la\\s+|de l['’]\\s*)?$`, "i")
  );
  if (leftNumberWithUnit) {
    return {
      qty: parseNumber(leftNumberWithUnit[1]) ?? 1,
      unit: normalizeUnit(leftNumberWithUnit[2]),
    };
  }

  const leftWordWithUnit = left.match(
    new RegExp(`(?:^|[\\s,;:\\-])(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+(${UNIT_PATTERN})\\s*(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|de la\\s+|de l['’]\\s*)?$`, "i")
  );
  if (leftWordWithUnit) {
    return {
      qty: parseNumber(leftWordWithUnit[1]) ?? 1,
      unit: normalizeUnit(leftWordWithUnit[2]),
    };
  }

  const leftNumber = left.match(
    /(?:^|[\s,;:\-])(?:a\.?\s*)?(\d+(?:[\.,]\d+)?)\s*(?:de\s+|d['’]\s*|du\s+|des\s+|de la\s+|de l['’]\s*)?$/i
  );
  if (leftNumber) {
    return { qty: parseNumber(leftNumber[1]) ?? 1, unit: "piece" };
  }

  const leftWord = left.match(
    new RegExp(`(?:^|[\\s,;:\\-])(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|de la\\s+|de l['’]\\s*)?$`, "i")
  );
  if (leftWord) {
    return { qty: parseNumber(leftWord[1]) ?? 1, unit: "piece" };
  }

  const leftNumberWithFois = left.match(
    /(?:^|[\s,;:\-])(\d+(?:[\.,]\d+)?)\s+fois\s+(?:de\s+|d['’]\s*|du\s+|des\s+|la\s+|le\s+|les\s+|un\s+|une\s+)?$/i
  );
  if (leftNumberWithFois) {
    return { qty: parseNumber(leftNumberWithFois[1]) ?? 1, unit: "piece" };
  }

  const leftWordWithFois = left.match(
    new RegExp(`(?:^|[\\s,;:\\-])(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+fois\\s+(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|la\\s+|le\\s+|les\\s+|un\\s+|une\\s+)?$`, "i")
  );
  if (leftWordWithFois) {
    return { qty: parseNumber(leftWordWithFois[1]) ?? 1, unit: "piece" };
  }

  const quantityWithAdjectiveBridge = left.match(
    new RegExp(`(?:^|[\\s,;:\\-])(${NUMBER_PATTERN})\\s+(?:grand(?:s|e|es)?|petit(?:s|e|es)?|moyen(?:s|ne|nes)?|gros(?:se|ses)?|bon(?:s|ne|nes)?)\\s+$`, "i")
  );
  if (quantityWithAdjectiveBridge) {
    return { qty: parseNumber(quantityWithAdjectiveBridge[1]) ?? 1, unit: "piece" };
  }

  const rightNumberWithUnit = right.match(
    new RegExp(`^\\s*(\\d+(?:[\\.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "i")
  );
  if (rightNumberWithUnit) {
    return {
      qty: parseNumber(rightNumberWithUnit[1]) ?? 1,
      unit: normalizeUnit(rightNumberWithUnit[2]),
    };
  }

  return { qty: 1, unit: "piece" };
}

function vagueCueFromLeftContext(left: string): VagueQuantityCue | undefined {
  if (/(?:^|[\s,;:\-])des\s+(?:de\s+|d['’]\s*)?$/i.test(left)) return "des";
  if (/(?:^|[\s,;:\-])quelques?\s+(?:de\s+|d['’]\s*)?$/i.test(left)) return "quelque";
  return undefined;
}

function vagueCueFromRawText(raw: string): VagueQuantityCue | undefined {
  const text = normalizeLoose(raw);
  if (/(?:^|\s)des\s+[\p{L}\p{N}]/u.test(text)) return "des";
  if (/(?:^|\s)quelques?\s+[\p{L}\p{N}]/u.test(text)) return "quelque";
  return undefined;
}

function detectVagueQuantityCue(
  userText: string,
  item: ParsedSegment
): VagueQuantityCue | undefined {
  if (item.unit !== "piece" || item.qty !== 1) return undefined;

  const position = item.position ?? -1;
  if (position >= 0) {
    const left = userText.slice(Math.max(0, position - 48), position);
    const cue = vagueCueFromLeftContext(left);
    if (cue) return cue;
  }

  return vagueCueFromRawText(item.raw);
}

function applyVagueQuantityCue(
  userText: string,
  item: ParsedSegment
): ParsedSegment {
  const cue = detectVagueQuantityCue(userText, item);
  return cue ? { ...item, vagueQuantityCue: cue } : item;
}

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number }
): boolean {
  return left.start < right.end && right.start < left.end;
}

function extractCatalogMentions(userText: string, products: Product[]): ParsedSegment[] {
  const scanTokens = catalogScanTokens(userText);
  const productEntries = products
    .filter((product) => product?.id && product?.name)
    .map((product) => ({
      product,
      tokens: catalogProductTokens(product.name),
    }))
    .filter((entry) => entry.tokens.length > 0);
  const tokenFrequency = catalogTokenFrequency(productEntries);

  const candidates: Array<ParsedSegment & { start: number; end: number; score: number; tokenCount: number }> = [];

  for (let startIndex = 0; startIndex < scanTokens.length; startIndex++) {
    const maxEndIndex = Math.min(scanTokens.length, startIndex + MAX_CATALOG_WINDOW_TOKENS);

    for (let endIndex = startIndex + 1; endIndex <= maxEndIndex; endIndex++) {
      const window = scanTokens.slice(startIndex, endIndex);
      const windowTokens = catalogWindowTokens(window);
      const windowStart = window[0]?.start ?? 0;
      const windowEnd = window[window.length - 1]?.end ?? windowStart;

      for (const { product, tokens } of productEntries) {
        if (
          window.length === 1 &&
          scanTokens.length > 1 &&
          window[0]?.normalized &&
          !tokens.includes(window[0].normalized)
        ) {
          continue;
        }

        const score = scoreCatalogWindow(windowTokens, tokens, tokenFrequency);
        if (score < MIN_CATALOG_MATCH_SCORE) continue;
        if (hasUnmatchedAdjacentDescriptor(scanTokens, startIndex, endIndex, tokens)) continue;

        const quantity = parseNearbyQuantity(userText, windowStart, windowEnd);
        candidates.push({
          raw: userText.slice(windowStart, windowEnd),
          cleaned: userText.slice(windowStart, windowEnd),
          query: product.name,
          qty: Math.max(1, quantity.qty),
          unit: quantity.unit,
          product,
          productMatchReason: score >= 240 ? "tokens" : "fuzzy",
          position: windowStart,
          start: windowStart,
          end: windowEnd,
          score,
          tokenCount: windowTokens.length,
        });
      }
    }
  }

  const selected: Array<ParsedSegment & { start: number; end: number; score: number; tokenCount: number }> = [];
  const selectedProducts = new Set<string>();

  const candidateSelectionScore = (candidate: {
    raw: string;
    product?: Product;
    score: number;
    tokenCount: number;
  }) => {
    const rawTokens = new Set(productTokens(candidate.raw));
    const candidateProductTokens = catalogProductTokens(candidate.product?.name ?? "");
    const exactProductTokenMatches = candidateProductTokens
      .filter((token) => rawTokens.has(token)).length;

    return (
      candidate.score +
      exactProductTokenMatches * 35 +
      Math.min(candidate.tokenCount, 5) * 8
    );
  };

  for (const candidate of candidates.sort((a, b) =>
    candidateSelectionScore(b) - candidateSelectionScore(a) ||
    b.tokenCount - a.tokenCount ||
    a.start - b.start
  )) {
    const productId = candidate.product?.id;
    if (!productId || selectedProducts.has(productId)) continue;
    if (selected.some((item) => rangesOverlap(item, candidate))) continue;

    selectedProducts.add(productId);
    selected.push(candidate);
  }

  return selected
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(({ start: _start, end: _end, score: _score, tokenCount: _tokenCount, ...item }) => item);
}

function extractCatalogMentionsFromSegments(
  segments: RawSegment[],
  products: Product[]
): ParsedSegment[] {
  return segments.flatMap((segment) => {
    const mentions = extractCatalogMentions(segment.text, products);
    if (segment.start < 0) return mentions;

    return mentions.map((mention) => ({
      ...mention,
      position: mention.position == null ? segment.start : segment.start + mention.position,
    }));
  });
}

function splitRawSegments(text: string): string[] {
  return normalizeSeparators(text)
    .split(",")
    .map((part) => stripTrailingNoise(stripLeadingIntentNoise(part)))
    .map((part) => part.trim())
    .filter((part) => !isConversationOnlySegment(part))
    .filter(Boolean);
}

function normalizeJoinedProductPart(raw: string): string {
  return stripTrailingNoise(stripLeadingIntentNoise(raw)).trim();
}

function firstNormalizedToken(raw: string): string | undefined {
  return normalizeLoose(raw).split(/\s+/).find(Boolean);
}

function lastNormalizedToken(raw: string): string | undefined {
  const tokens = normalizeLoose(raw).split(/\s+/).filter(Boolean);
  return tokens.at(-1);
}

function isFrenchNumberJoiner(left: string, right: string): boolean {
  const leftToken = lastNormalizedToken(left);
  const rightToken = firstNormalizedToken(right);
  return Boolean(leftToken && rightToken && isFrenchNumberWord(leftToken) && isFrenchNumberWord(rightToken));
}

function isExactSingleCatalogAlias(raw: string, products: Product[]): boolean {
  const normalized = normalizeLoose(normalizeJoinedProductPart(raw));
  if (!normalized) return false;

  return products.some((product) =>
    catalogAliases(product).some((alias) => normalized === alias)
  );
}

function recognizedProductCount(raw: string, products: Product[]): number {
  const mentions = extractCatalogMentions(raw, products).length;
  const parsed = parseSegment(raw, products);
  return Math.max(mentions, parsed?.product ? 1 : 0);
}

function isRecognizedProductSegment(raw: string, products: Product[]): boolean {
  return Boolean(parseSegment(raw, products)?.product);
}

function splitLikelyJoinedProductSegment(
  raw: string,
  products: Product[],
  depth = 0
): string[] {
  const segment = normalizeJoinedProductPart(raw);
  if (!segment || depth > 4) return segment ? [segment] : [];
  if (!/\b(?:et|and)\b/i.test(segment)) return [segment];
  if (isExactSingleCatalogAlias(segment, products)) return [segment];

  const joinerMatcher = /\s+(?:et|and)\s+/gi;
  let match: RegExpExecArray | null;

  while ((match = joinerMatcher.exec(segment)) !== null) {
    const leftRaw = segment.slice(0, match.index);
    const rightRaw = segment.slice(match.index + match[0].length);
    if (isFrenchNumberJoiner(leftRaw, rightRaw)) continue;

    const left = normalizeJoinedProductPart(leftRaw);
    const right = normalizeJoinedProductPart(rightRaw);
    if (!left || !right) continue;

    const candidateParts = [
      ...splitLikelyJoinedProductSegment(left, products, depth + 1),
      ...splitLikelyJoinedProductSegment(right, products, depth + 1),
    ];
    if (candidateParts.length < 2) continue;
    if (!candidateParts.every((part) => isRecognizedProductSegment(part, products))) continue;

    const currentCount = recognizedProductCount(segment, products);
    if (candidateParts.length > currentCount) {
      return candidateParts;
    }
  }

  return [segment];
}

function refineJoinedProductSegments(segments: string[], products: Product[]): string[] {
  return segments.flatMap((segment) => splitLikelyJoinedProductSegment(segment, products));
}

function isSegmentBoundaryAfterDescriptor(value: string): boolean {
  return /^\s*(?:$|[,;:|.!?\n\r]|\b(?:et|and|puis|ensuite|apres|après)\b)/i.test(value);
}

function recoverTrailingDescriptorSegments(text: string, segments: string[]): string[] {
  let cursor = 0;

  return segments.map((segment) => {
    const cleanSegment = String(segment || "").trim();
    if (!cleanSegment) return cleanSegment;

    let start = text.indexOf(cleanSegment, cursor);
    if (start < 0) {
      start = text.indexOf(cleanSegment);
    }
    if (start < 0) return cleanSegment;

    const end = start + cleanSegment.length;
    if (cleanSegment.includes("(")) {
      cursor = end;
      return cleanSegment;
    }

    const tail = text.slice(end);
    const descriptorMatch = tail.match(/^\s*(\([^)]{2,100}\))/);
    if (!descriptorMatch) {
      cursor = end;
      return cleanSegment;
    }

    const afterDescriptor = text.slice(end + descriptorMatch[0].length);
    if (!isSegmentBoundaryAfterDescriptor(afterDescriptor)) {
      cursor = end;
      return cleanSegment;
    }

    const expanded = `${cleanSegment}${descriptorMatch[0]}`.trim();
    cursor = start + expanded.length;
    return expanded;
  });
}

function locateRawSegments(text: string, segments: string[]): RawSegment[] {
  let cursor = 0;

  return segments.map((segment, index) => {
    let start = text.indexOf(segment, cursor);
    if (start < 0) {
      start = text.indexOf(segment);
    }
    if (start < 0) {
      start = cursor + index;
    }

    const end = start + segment.length;
    if (end >= 0) {
      cursor = end;
    }

    return {
      text: segment,
      start,
      end,
    };
  });
}

function segmentLikelySingleCatalogItem(segment: RawSegment): boolean {
  const text = normalizeLoose(segment.text);
  if (!text || segment.start < 0 || segment.end <= segment.start) return false;
  if (text.length > 120) return false;
  if (/\b(?:et|and)\b/.test(text)) return false;
  return true;
}

function catalogMentionConflictsWithParsedSegment(
  mention: ParsedSegment,
  parsedSegment: ParsedSegment,
  segment: RawSegment
): boolean {
  if (!mention.product?.id || !parsedSegment.product?.id) return false;
  if (mention.product.id === parsedSegment.product.id) return false;
  if (!segmentLikelySingleCatalogItem(segment)) return false;

  const position = mention.position ?? -1;
  return position >= segment.start && position < segment.end;
}

function parseQuantityAndQuery(raw: string): { query: string; qty: number; unit: string } {
  let text = stripTrailingNoise(stripLeadingIntentNoise(raw)).replace(/\s+/g, " ").trim();
  let qty = 1;
  let unit = "piece";

  const catalogPrefixQty = text.match(/^A\.?\s+(\d+(?:[\.,]\d+)?)\s+(.+)$/i);
  if (catalogPrefixQty) {
    return {
      query: `A. ${catalogPrefixQty[2].trim()}`,
      qty: parseNumber(catalogPrefixQty[1]) ?? 1,
      unit,
    };
  }

  const numericPrefixWithFois = text.match(
    /^(\d+(?:[\.,]\d+)?)\s+fois\s+(?:de\s+|d['’]\s*|du\s+|des\s+|la\s+|le\s+|les\s+|un\s+|une\s+)?(.+)$/i
  );
  if (numericPrefixWithFois) {
    return {
      query: numericPrefixWithFois[2].trim(),
      qty: parseNumber(numericPrefixWithFois[1]) ?? 1,
      unit,
    };
  }

  const wordPrefixWithFois = text.match(
    new RegExp(`^(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+fois\\s+(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|la\\s+|le\\s+|les\\s+|un\\s+|une\\s+)?(.+)$`, "i")
  );
  if (wordPrefixWithFois) {
    return {
      query: wordPrefixWithFois[2].trim(),
      qty: parseNumber(wordPrefixWithFois[1]) ?? 1,
      unit,
    };
  }

  const numericPrefixWithUnit = text.match(
    new RegExp(`^(\\d+(?:[\\.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b\\s*(?:de\\s+|d['’]\\s*|du\\s+|des\\s+|la\\s+|le\\s+|les\\s+)?(.+)$`, "i")
  );
  if (numericPrefixWithUnit) {
    return {
      query: numericPrefixWithUnit[3].trim(),
      qty: parseNumber(numericPrefixWithUnit[1]) ?? 1,
      unit: normalizeUnit(numericPrefixWithUnit[2]),
    };
  }

  const wordPrefixWithUnit = text.match(
    new RegExp(`^(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+(${UNIT_PATTERN})\\b\\s*(?:de\\s+|d['’]\\s*|du\\s+|des\\s+)?(.+)$`, "i")
  );
  if (wordPrefixWithUnit) {
    return {
      query: wordPrefixWithUnit[3].trim(),
      qty: parseNumber(wordPrefixWithUnit[1]) ?? 1,
      unit: normalizeUnit(wordPrefixWithUnit[2]),
    };
  }

  const numericPrefix = text.match(/^(\d+(?:[\.,]\d+)?)\s+(?:de\s+|d['’]\s*|du\s+|des\s+)?(.+)$/i);
  if (numericPrefix) {
    return {
      query: numericPrefix[2].trim(),
      qty: parseNumber(numericPrefix[1]) ?? 1,
      unit,
    };
  }

  const wordPrefix = text.match(new RegExp(`^(${FRENCH_NUMBER_PATTERN_SOURCE})\\s+(.+)$`, "i"));
  if (wordPrefix) {
    return {
      query: wordPrefix[2].trim(),
      qty: parseNumber(wordPrefix[1]) ?? 1,
      unit,
    };
  }

  const suffixWithUnit = text.match(new RegExp(`^(.+?)\\s+(\\d+(?:[\\.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b$`, "i"));
  if (suffixWithUnit) {
    return {
      query: suffixWithUnit[1].trim(),
      qty: parseNumber(suffixWithUnit[2]) ?? 1,
      unit: normalizeUnit(suffixWithUnit[3]),
    };
  }

  text = text.replace(/^(?:de|d['’]|du|des|de la|de l['’]|le|la|les|un|une|quelques?)\s+/i, "").trim();

  return { query: text, qty, unit };
}

function catalogAliases(product: Product): string[] {
  const normalizedName = normalizeLoose(product.name || "");
  const aliases = new Set<string>();
  if (normalizedName) aliases.add(normalizedName);
  if (normalizedName.startsWith("a ")) aliases.add(normalizedName.slice(2).trim());
  return [...aliases].filter((alias) => alias.length >= 3);
}

function findCatalogMention(
  segment: string,
  products: Product[],
  preferredProductIds: ReadonlySet<string> = new Set()
): CatalogMatch | null {
  const normalizedSegment = ` ${normalizeLoose(segment)} `;
  const queryTokens = [...new Set(meaningfulTokens(segment))];
  const segmentTokens = new Set(queryTokens);
  let best: CatalogMatch | null = null;

  for (const product of products) {
    if (!product?.id || !product?.name) continue;

    for (const alias of catalogAliases(product)) {
      if (normalizedSegment.includes(` ${alias} `)) {
        const aliasTokens = [...new Set(productTokens(alias))];
        const unmatchedQueryTokens = queryTokens.filter((token) => bestTokenSimilarity(token, aliasTokens) < 0.72);
        const fullAliasCoverage = unmatchedQueryTokens.length === 0;
        const score = (fullAliasCoverage
          ? 1000 + alias.length
          : 115 +
            ((queryTokens.length - unmatchedQueryTokens.length) / Math.max(queryTokens.length, 1)) * 70 +
            textSimilarity(segment, product.name) * 10) +
          (preferredProductIds.has(String(product.id)) ? 75 : 0);
        if (!best || score > best.score) {
          best = { product, score, reason: fullAliasCoverage ? "exact" : "fuzzy" };
        }
      }
    }

    const tokens = [...new Set(productTokens(product.name))];
    if (!tokens.length || !queryTokens.length) continue;
    if (!hasDistinctiveProductToken(queryTokens, tokens)) continue;

    const exactQueryCoverage = queryTokens.filter((token) => tokens.includes(token)).length / queryTokens.length;
    const fuzzyScores = queryTokens.map((token) => bestTokenSimilarity(token, tokens));
    const fuzzyQueryCoverage = fuzzyScores.filter((score) => score >= 0.72).length / queryTokens.length;
    const averageFuzzyScore = fuzzyScores.reduce((sum, score) => sum + score, 0) / queryTokens.length;
    const wholeTextScore = textSimilarity(segment, product.name);

    const isStrongTokenMatch =
      queryTokens.length >= 2 &&
      fuzzyQueryCoverage >= 1 &&
      (exactQueryCoverage > 0 || averageFuzzyScore >= 0.82);
    const isSingleTokenExactMatch =
      queryTokens.length === 1 &&
      queryTokens[0].length >= 3 &&
      segmentTokens.has(queryTokens[0]) &&
      tokens.includes(queryTokens[0]);
    const singleTokenFuzzyMatch = queryTokens.length === 1
      ? bestTokenSimilarityMatch(queryTokens[0], tokens)
      : { score: 0, candidate: undefined };
    const isSingleTokenFuzzyMatch =
      queryTokens.length === 1 &&
      queryTokens[0].length >= 5 &&
      singleTokenFuzzyMatch.score >= 0.76 &&
      hasCompatibleFuzzyTokenStart(queryTokens[0], singleTokenFuzzyMatch.candidate) &&
      !isWeakSingleTokenPrefixMatch(queryTokens[0], singleTokenFuzzyMatch.candidate);
    const isWholeTextFuzzyMatch =
      queryTokens.length >= 2 &&
      wholeTextScore >= 0.72;

    if (!isStrongTokenMatch && !isSingleTokenExactMatch && !isSingleTokenFuzzyMatch && !isWholeTextFuzzyMatch) {
      continue;
    }

    const firstQueryToken = queryTokens[0];
    const firstProductToken = tokens[0];
    const wordOrderBoost =
      firstQueryToken && firstProductToken && bestTokenSimilarity(firstQueryToken, [firstProductToken]) >= 0.72
        ? 12
        : 0;

    const score =
      100 +
      exactQueryCoverage * 60 +
      fuzzyQueryCoverage * 30 +
      averageFuzzyScore * 10 +
      wholeTextScore * 10 -
      Math.max(0, tokens.length - queryTokens.length) * 0.25 +
      wordOrderBoost +
      (preferredProductIds.has(String(product.id)) ? 75 : 0);
    const reason = exactQueryCoverage >= 1 ? "tokens" : "fuzzy";

    if (!best || score > best.score) {
      best = { product, score, reason };
    }
  }

  return best;
}

function bestCatalogMention(
  segments: string[],
  products: Product[],
  preferredProductIds: ReadonlySet<string> = new Set()
): CatalogMatch | null {
  let best: CatalogMatch | null = null;

  for (const segment of segments) {
    const match = findCatalogMention(segment, products, preferredProductIds);
    if (!match) continue;
    if (!best || match.score > best.score) {
      best = match;
    }
  }

  return best;
}

function parseSegment(
  raw: string,
  products: Product[],
  preferredProductIds: ReadonlySet<string> = new Set()
): ParsedSegment | null {
  let cleaned = stripTrailingNoise(stripLeadingIntentNoise(raw));
  let parsed = parseQuantityAndQuery(cleaned);
  let catalogMatch = bestCatalogMention([parsed.query, cleaned], products, preferredProductIds);

  const quantityCueIndex = firstQuantityCueIndex(cleaned);
  if (quantityCueIndex > 0) {
    const tail = cleaned.slice(quantityCueIndex).trim();
    const tailParsed = parseQuantityAndQuery(tail);
    const tailMatch = bestCatalogMention([tailParsed.query, tail], products, preferredProductIds);

    if (tailMatch && (!catalogMatch || tailMatch.score > catalogMatch.score)) {
      cleaned = tail;
      parsed = tailParsed;
      catalogMatch = tailMatch;
    }
  }

  const query = catalogMatch?.product?.name ?? parsed.query;

  if (!hasMeaningfulQuery(query)) {
    return null;
  }

  return {
    raw,
    cleaned,
    query,
    qty: Math.max(1, parsed.qty),
    unit: parsed.unit || "piece",
    ...(catalogMatch ? { product: catalogMatch.product, productMatchReason: catalogMatch.reason } : {}),
  };
}

function dedupeItems(items: ParsedSegment[]): ParsedSegment[] {
  const byKey = new Map<string, ParsedSegment>();

  for (const item of items) {
    const key = item.product?.id
      ? `id:${item.product.id}`
      : `q:${normalizeLoose(item.query)}:${item.qty}:${item.unit}`;

    const existing = byKey.get(key);
    if (!existing || itemSpecificityScore(item) > itemSpecificityScore(existing)) {
      byKey.set(key, {
        ...item,
        position: Math.min(existing?.position ?? item.position ?? Number.MAX_SAFE_INTEGER, item.position ?? Number.MAX_SAFE_INTEGER),
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
}

function itemSpecificityScore(item: ParsedSegment): number {
  return (
    (item.unit !== "piece" ? 40 : 0) +
    (item.qty !== 1 ? 30 : 0) +
    (item.productMatchReason === "exact" ? 20 : item.productMatchReason === "tokens" ? 10 : 0) +
    Math.min(item.cleaned.length, 80) / 80 +
    Math.min(item.raw.length, 80) / 20
  );
}

function collapseCatalogMentionsBySingleItemSegment(
  mentions: ParsedSegment[],
  segments: RawSegment[]
): ParsedSegment[] {
  const bestMentionBySegment = new Map<number, ParsedSegment>();

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || !segmentLikelySingleCatalogItem(segment)) continue;

    const segmentMentions = mentions.filter((mention) => {
      const position = mention.position ?? -1;
      return position >= segment.start && position < segment.end;
    });
    if (segmentMentions.length <= 1) continue;

    const bestMention = segmentMentions
      .sort((a, b) => itemSpecificityScore(b) - itemSpecificityScore(a))[0];
    if (bestMention) {
      bestMentionBySegment.set(index, bestMention);
    }
  }

  if (!bestMentionBySegment.size) return mentions;

  return mentions.filter((mention) => {
    const position = mention.position ?? -1;
    const segmentIndex = segments.findIndex(
      (segment) =>
        segmentLikelySingleCatalogItem(segment) &&
        position >= segment.start &&
        position < segment.end
    );
    if (segmentIndex < 0) return true;

    const bestMention = bestMentionBySegment.get(segmentIndex);
    if (!bestMention) return true;

    return mention === bestMention;
  });
}

function shouldKeepUnknownFallback(item: ParsedSegment, segmentCount: number): boolean {
  if (item.product) return true;
  if (segmentCount <= 1) return true;
  if (item.unit !== "piece" || item.qty !== 1) return true;
  return false;
}

function buildAddItemsPlanFromSegments(
  userText: string,
  products: Product[],
  segments: string[],
  source: SegmentSource,
  referenceCatalog: Product[] = products,
  preferredProductIds: readonly string[] = []
): ExtractedAddItemsPlan {
  const normalizedUserText = normalizeInvisibleCharacters(userText);
  const alignedSegments = source === "language_segmenter"
    ? recoverTrailingDescriptorSegments(normalizedUserText, segments)
    : segments;
  const refinedSegments = refineJoinedProductSegments(alignedSegments, products);
  const locatedSegments = locateRawSegments(normalizedUserText, refinedSegments);
  const catalogMentions = extractCatalogMentionsFromSegments(locatedSegments, products);
  const preferredProductIdSet = new Set(preferredProductIds.map(String));
  const parsedFromSegments = locatedSegments
    .map((segment) => {
      const parsed = parseSegment(segment.text, products, preferredProductIdSet);
      if (parsed && !shouldKeepUnknownFallback(parsed, segments.length)) {
        return null;
      }
      if (parsed && parsed.position == null) {
        parsed.position = segment.start;
      }
      return parsed;
    });
  const filteredCatalogMentions = collapseCatalogMentionsBySingleItemSegment(
    catalogMentions.filter((mention) => {
      return !locatedSegments.some((segment, index) => {
        const parsedSegment = parsedFromSegments[index];
        return Boolean(
          parsedSegment &&
          catalogMentionConflictsWithParsedSegment(mention, parsedSegment, segment)
        );
      });
    }),
    locatedSegments
  );
  const parsedSegments = dedupeItems(
    filteredCatalogMentions.concat(parsedFromSegments
      .map((parsed, index) => {
        const segment = locatedSegments[index];
        const position = segment?.start ?? -1;
        if (
          parsed &&
          !parsed.product &&
          position >= 0 &&
          filteredCatalogMentions.some((mention) => {
            const mentionPosition = mention.position ?? -1;
            return mentionPosition >= position && mentionPosition <= (segment?.end ?? position);
          })
        ) {
          return null;
        }
        return parsed;
      })
      .filter((item): item is ParsedSegment => Boolean(item)))
  )
    .map((item) => applyVagueQuantityCue(normalizedUserText, item))
    .filter((item) =>
      !hasBlockedAssistantProductReference(`${item.raw} ${item.query}`, referenceCatalog)
    );

  console.log("[ADD_ITEMS_EXTRACTOR] CATALOG_MENTIONS", JSON.stringify(filteredCatalogMentions.map((item) => ({
    raw: item.raw,
    query: item.query,
    qty: item.qty,
    unit: item.unit,
    productId: item.product?.id,
    productName: item.product?.name,
    productMatchReason: item.productMatchReason,
    vagueQuantityCue: item.vagueQuantityCue,
  })), null, 2));
  console.log("[ADD_ITEMS_EXTRACTOR] SEGMENTS", JSON.stringify({ source, segments: refinedSegments }));
  console.log("[ADD_ITEMS_EXTRACTOR] PARSED", JSON.stringify(parsedSegments.map((item) => ({
    raw: item.raw,
    cleaned: item.cleaned,
    query: item.query,
    qty: item.qty,
    unit: item.unit,
    productId: item.product?.id,
    productName: item.product?.name,
    productMatchReason: item.productMatchReason,
    vagueQuantityCue: item.vagueQuantityCue,
  })), null, 2));

  return {
    intent: "ADD_ITEMS",
    actions: [
      {
        type: "add_to_cart",
        items: parsedSegments.map((item) => ({
          query: item.query,
          qty: item.qty,
          unit: item.unit,
          ...(item.product?.id ? { productId: item.product.id } : {}),
          ...(item.vagueQuantityCue ? { vagueQuantityCue: item.vagueQuantityCue } : {}),
        })),
      },
    ],
  };
}

export function extractAddItemsFromTextWithCatalog(
  userText: string,
  products: Product[],
  options: Pick<ExtractAddItemsOptions, "preferredProductIds"> = {}
): ExtractedAddItemsPlan {
  const normalizedUserText = normalizeInvisibleCharacters(userText);
  return buildAddItemsPlanFromSegments(
    normalizedUserText,
    filterAssistantEligibleProducts(products),
    splitRawSegments(normalizedUserText),
    "deterministic",
    products,
    options.preferredProductIds
  );
}

export function extractAddItemsFromTextWithCatalogSegments(
  userText: string,
  products: Product[],
  segments: string[],
  options: Pick<ExtractAddItemsOptions, "preferredProductIds"> = {}
): ExtractedAddItemsPlan {
  const normalizedUserText = normalizeInvisibleCharacters(userText);
  return buildAddItemsPlanFromSegments(
    normalizedUserText,
    filterAssistantEligibleProducts(products),
    segments.map((segment) => stripTrailingNoise(stripLeadingIntentNoise(segment))).filter(Boolean),
    "language_segmenter",
    products,
    options.preferredProductIds
  );
}

export async function extractAddItemsFromText(
  userRef: string,
  userText: string,
  options: ExtractAddItemsOptions = {}
): Promise<ExtractedAddItemsPlan> {
  const referenceCatalog = options.catalog
    ? [...options.catalog]
    : await getAllProducts(userRef);
  const products = filterAssistantEligibleProducts(referenceCatalog);
  console.log("[ADD_ITEMS_EXTRACTOR] START", {
    userRef,
    textPreview: userText.slice(0, 160),
    catalogCount: products.length,
  });

  const normalizedUserText = normalizeInvisibleCharacters(userText);
  const languageSegments = shouldUseLanguageSegmenter(normalizedUserText)
    ? await extractSegmentsWithLanguageModel(normalizedUserText)
    : null;

  let plan = languageSegments?.length
    ? buildAddItemsPlanFromSegments(
        normalizedUserText,
        products,
        languageSegments,
        "language_segmenter",
        referenceCatalog,
        options.preferredProductIds
      )
    : extractAddItemsFromTextWithCatalog(normalizedUserText, referenceCatalog, options);

  if (languageSegments?.length && plan.actions[0].items.length === 0) {
    console.warn("[ADD_ITEMS_EXTRACTOR] LANGUAGE_SEGMENTER_EMPTY_PLAN_FALLBACK");
    plan = extractAddItemsFromTextWithCatalog(normalizedUserText, referenceCatalog, options);
  }

  const adjustedPlan = await applyVagueQuantityPolicyToPlan(userRef, plan);

  console.log("[ADD_ITEMS_EXTRACTOR] PLAN", JSON.stringify(adjustedPlan, null, 2));
  return adjustedPlan as ExtractedAddItemsPlan;
}
