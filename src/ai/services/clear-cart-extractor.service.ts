import { parseFrenchNumber, FRENCH_NUMBER_PATTERN_SOURCE } from "../../domain/french-numbers.js";
import { bestTokenSimilarity } from "../../domain/text-similarity.js";
import { normalizeLooseText } from "./product-options.service.js";
import { basketLineName, type BasketLine } from "./cart-line-matcher.service.js";

export type ClearCartPartialOperation = "remove_all" | "decrease" | "set_exact";

export type ExtractedClearCartLine = {
  line: BasketLine;
  name: string;
  query: string;
  operation: ClearCartPartialOperation;
  quantity?: number;
  targetQuantity?: number;
  confidence: number;
};

export type ClearCartPartialExtraction = {
  items: ExtractedClearCartLine[];
  unmatchedQueries: string[];
};

type TextToken = {
  raw: string;
  normalized: string;
  start: number;
  end: number;
};

type CandidateMatch = {
  line: BasketLine;
  name: string;
  query: string;
  score: number;
  matchedTokenIndexes: number[];
};

const NUMBER_PATTERN = `\\d+(?:[\\.,]\\d+)?|${FRENCH_NUMBER_PATTERN_SOURCE}`;

const PRODUCT_TOKEN_NOISE = new Set([
  "a",
  "au",
  "aux",
  "avec",
  "bio",
  "de",
  "des",
  "du",
  "et",
  "la",
  "le",
  "les",
  "l",
  "ou",
  "par",
  "pour",
  "un",
  "une",
  "vv",
]);

const TEXT_TOKEN_NOISE = new Set([
  ...PRODUCT_TOKEN_NOISE,
  "alors",
  "attends",
  "attend",
  "bien",
  "bonjour",
  "ca",
  "ce",
  "cette",
  "dans",
  "en",
  "enfin",
  "finalement",
  "j",
  "je",
  "me",
  "merci",
  "mon",
  "ne",
  "non",
  "notre",
  "nous",
  "pas",
  "panier",
  "plus",
  "stp",
  "te",
  "tu",
  "veux",
]);

export function isExplicitClearAllRequest(userText: string): boolean {
  const text = normalizeLooseText(userText);
  if (!text) return false;

  if (/\bvide[rsz]?\b/.test(text) && /\bpanier\b/.test(text)) return true;
  if (/\bpanier\b/.test(text) && /\b(?:zero|vide)\b/.test(text)) return true;
  if (/\b(?:supprime[rsz]?|enleve[rsz]?|retire[rsz]?|efface[rsz]?)\b.*\b(?:tout|tous|toute|toutes|entierement|integralement|completement)\b/.test(text)) {
    return true;
  }
  if (/\b(?:je\s+ne\s+veux\s+plus\s+rien|je\s+veux\s+plus\s+rien|plus\s+rien|ne\s+doit\s+rien\s+contenir)\b/.test(text)) {
    return true;
  }
  if (/\b(?:remets?|remet|mets?)\b.*\b(?:a\s+)?zero\b/.test(text) && /\bpanier\b/.test(text)) {
    return true;
  }

  return false;
}

function singularize(token: string): string {
  if (token.length <= 3) return token;
  return token.endsWith("s") ? token.slice(0, -1) : token;
}

function normalizeForMatch(value: string): string {
  return singularize(normalizeLooseText(value));
}

function tokenizeWithPositions(input: string): TextToken[] {
  const tokens: TextToken[] = [];
  const matcher = /[\p{L}\p{N}]+/gu;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) != null) {
    const raw = match[0] || "";
    const normalized = normalizeForMatch(raw);
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

function productTokens(lineName: string): string[] {
  const tokens = normalizeLooseText(lineName)
    .split(" ")
    .map(singularize)
    .filter(Boolean)
    .filter((token) => !PRODUCT_TOKEN_NOISE.has(token));

  return [...new Set(tokens)];
}

function queryTokens(value: string): string[] {
  return normalizeLooseText(value)
    .split(" ")
    .map(singularize)
    .filter(Boolean)
    .filter((token) => !TEXT_TOKEN_NOISE.has(token));
}

function tokenMatchesProduct(textToken: string, productToken: string): boolean {
  if (textToken === productToken) return true;
  if (textToken.length >= 4 && productToken.length >= 4 && (textToken.includes(productToken) || productToken.includes(textToken))) {
    return true;
  }
  return bestTokenSimilarity(textToken, [productToken]) >= 0.82;
}

function scoreLineInText(line: BasketLine, textTokens: TextToken[], sourceText: string): CandidateMatch {
  const name = basketLineName(line);
  const normalizedName = normalizeLooseText(name);
  const normalizedSource = normalizeLooseText(sourceText);
  const tokens = productTokens(name);
  const matchedTokenIndexes: number[] = [];

  if (!tokens.length || !textTokens.length) {
    return { line, name, query: name, score: 0, matchedTokenIndexes };
  }

  for (let index = 0; index < textTokens.length; index++) {
    const token = textTokens[index];
    if (!token || TEXT_TOKEN_NOISE.has(token.normalized)) continue;
    if (tokens.some((productToken) => tokenMatchesProduct(token.normalized, productToken))) {
      matchedTokenIndexes.push(index);
    }
  }

  const distinctMatchedTokens = new Set(
    matchedTokenIndexes.map((index) => textTokens[index]?.normalized).filter(Boolean)
  );
  const exactTokenMatches = tokens.filter((token) =>
    textTokens.some((textToken) => textToken.normalized === token)
  ).length;
  const fuzzyTokenMatches = tokens.filter((token) =>
    textTokens.some((textToken) => tokenMatchesProduct(textToken.normalized, token))
  ).length;
  const coverage = fuzzyTokenMatches / tokens.length;

  let score = 0;
  if (normalizedSource.includes(normalizedName)) score += 140;
  score += exactTokenMatches * 70;
  score += Math.max(0, fuzzyTokenMatches - exactTokenMatches) * 45;
  score += coverage * 60;
  score += Math.min(distinctMatchedTokens.size, 3) * 12;

  if (tokens.length === 1 && exactTokenMatches === 1) score += 45;
  if (tokens.length > 1 && fuzzyTokenMatches >= 2) score += 35;
  if (fuzzyTokenMatches === 0) score = 0;

  return { line, name, query: name, score, matchedTokenIndexes };
}

function scoreLineForQuery(line: BasketLine, rawQuery: string): CandidateMatch {
  const name = basketLineName(line);
  const tokens = productTokens(name);
  const qTokens = queryTokens(rawQuery);
  const matchedTokenIndexes: number[] = [];

  if (!tokens.length || !qTokens.length) {
    return { line, name, query: rawQuery || name, score: 0, matchedTokenIndexes };
  }

  const fuzzyMatches = tokens.filter((token) =>
    qTokens.some((qToken) => tokenMatchesProduct(qToken, token))
  ).length;
  const exactMatches = tokens.filter((token) => qTokens.includes(token)).length;
  const coverage = fuzzyMatches / tokens.length;
  const queryCoverage = qTokens.filter((qToken) =>
    tokens.some((token) => tokenMatchesProduct(qToken, token))
  ).length / qTokens.length;

  let score = exactMatches * 70 + Math.max(0, fuzzyMatches - exactMatches) * 45;
  score += coverage * 45 + queryCoverage * 45;

  if (normalizeLooseText(name).includes(normalizeLooseText(rawQuery))) score += 80;
  if (fuzzyMatches === 0) score = 0;

  return { line, name, query: rawQuery || name, score, matchedTokenIndexes };
}

function hasKeepIntent(normalizedText: string): boolean {
  return /\b(?:garde|gardes|garder|laisse|laisses|laisser|conserve|conserver|reste|restent)\b/.test(normalizedText) ||
    /\b(?:seulement|uniquement|juste)\b/.test(normalizedText) ||
    /\bplus\s+que\b/.test(normalizedText);
}

function hasRemoveIntent(normalizedText: string): boolean {
  return /\b(?:enleve|enlever|enleves|retire|retirer|retires|supprime|supprimer|supprimes|ote|oter|annule|annuler)\b/.test(normalizedText) ||
    /\b(?:je|j)\s+(?:n\s+)?(?:en\s+)?veux\s+(?:pas|plus)\b/.test(normalizedText) ||
    /\bpas\s+non\s+plus\b/.test(normalizedText) ||
    /\bnon\s+plus\b/.test(normalizedText);
}

function parseNumberToken(raw: string): number | undefined {
  const parsed = parseFrenchNumber(raw);
  if (parsed == null || !Number.isFinite(parsed)) return undefined;
  return parsed;
}

function parseNearbyQuantity(textTokens: TextToken[], match: CandidateMatch): number | undefined {
  if (!match.matchedTokenIndexes.length) return undefined;

  const firstIndex = Math.min(...match.matchedTokenIndexes);
  const numberCandidates: Array<{ value: number; distance: number; index: number }> = [];
  const numberRegex = new RegExp(`^(?:${NUMBER_PATTERN})$`, "i");

  for (let index = Math.max(0, firstIndex - 4); index < firstIndex; index++) {
    const token = textTokens[index];
    if (!token || !numberRegex.test(token.normalized)) continue;
    const value = parseNumberToken(token.raw);
    if (value == null) continue;
    numberCandidates.push({
      value,
      distance: Math.abs(firstIndex - index),
      index,
    });
  }

  numberCandidates.sort((left, right) => left.distance - right.distance || left.index - right.index);
  return numberCandidates[0]?.value;
}

function chooseBestMatches(candidates: CandidateMatch[]): CandidateMatch[] {
  const sorted = [...candidates]
    .filter((candidate) => candidate.score >= 95)
    .sort((left, right) => right.score - left.score);

  if (!sorted.length) return [];

  const selected: CandidateMatch[] = [];
  const usedProductIds = new Set<string>();

  for (const candidate of sorted) {
    const productId = candidate.line.productId ?? candidate.name;
    if (usedProductIds.has(productId)) continue;

    const competing = selected.some((existing) => {
      const existingIndexes = new Set(existing.matchedTokenIndexes);
      return candidate.matchedTokenIndexes.some((index) => existingIndexes.has(index));
    });
    if (competing) continue;

    const nextBest = sorted.find((other) => {
      if (other === candidate) return false;
      const otherId = other.line.productId ?? other.name;
      const candidateIndexes = new Set(candidate.matchedTokenIndexes);
      const overlaps = other.matchedTokenIndexes.some((index) => candidateIndexes.has(index));
      return otherId !== productId && overlaps && other.score >= candidate.score - 25;
    });

    if (nextBest && candidate.score < 180) continue;

    usedProductIds.add(productId);
    selected.push(candidate);
  }

  return selected;
}

function buildExtractedItem(
  match: CandidateMatch,
  textTokens: TextToken[],
  normalizedText: string
): ExtractedClearCartLine | null {
  const quantity = parseNearbyQuantity(textTokens, match);

  if (quantity != null && hasKeepIntent(normalizedText)) {
    return {
      line: match.line,
      name: match.name,
      query: match.query,
      operation: "set_exact",
      targetQuantity: Math.max(0, quantity),
      confidence: match.score,
    };
  }

  if (quantity != null && hasRemoveIntent(normalizedText)) {
    return {
      line: match.line,
      name: match.name,
      query: match.query,
      operation: "decrease",
      quantity: Math.max(0, quantity),
      confidence: match.score,
    };
  }

  if (quantity != null) {
    return null;
  }

  return {
    line: match.line,
    name: match.name,
    query: match.query,
    operation: "remove_all",
    confidence: match.score,
  };
}

export function extractClearCartPartialFromBasket(
  userText: string,
  basket: any,
  plannerQueries: string[] = []
): ClearCartPartialExtraction {
  const products = Array.isArray(basket?.products) ? (basket.products as BasketLine[]) : [];
  const text = String(userText || "").trim();
  const normalizedText = normalizeLooseText(text);
  const textTokens = tokenizeWithPositions(text);

  if (!products.length || !normalizedText) {
    return { items: [], unmatchedQueries: plannerQueries.filter(Boolean) };
  }

  const textMatches = products.map((line) => scoreLineInText(line, textTokens, text));
  const selectedFromText = chooseBestMatches(textMatches);

  if (selectedFromText.length) {
    const extractedItems = selectedFromText
      .map((match) => buildExtractedItem(match, textTokens, normalizedText))
      .filter((item): item is ExtractedClearCartLine => Boolean(item));

    return {
      items: extractedItems,
      unmatchedQueries: extractedItems.length ? [] : plannerQueries.filter(Boolean),
    };
  }

  const normalizedSource = normalizeLooseText(text);
  const usableQueries = plannerQueries
    .map((query) => String(query || "").trim())
    .filter(Boolean)
    .filter((query) => {
      const normalizedQuery = normalizeLooseText(query);
      return normalizedQuery && (normalizedSource.includes(normalizedQuery) || normalizedQuery.includes(normalizedSource));
    });

  if (!usableQueries.length) {
    return { items: [], unmatchedQueries: plannerQueries.filter(Boolean) };
  }

  const queryMatches = usableQueries
    .map((query) => products.map((line) => scoreLineForQuery(line, query)))
    .flat();
  const selectedFromQueries = chooseBestMatches(queryMatches);

  return {
    items: selectedFromQueries
      .map((match) => buildExtractedItem(match, textTokens, normalizedText))
      .filter((item): item is ExtractedClearCartLine => Boolean(item)),
    unmatchedQueries: usableQueries.filter((query) =>
      !selectedFromQueries.some((match) => normalizeLooseText(match.query) === normalizeLooseText(query))
    ),
  };
}
