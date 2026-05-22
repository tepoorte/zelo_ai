import { normalizeText, tokenizeForMatch } from "./normalizer.js";

export function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }

    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length] ?? 0;
}

export function tokenSimilarity(token: string, candidate: string): number {
  if (!token || !candidate) return 0;
  if (token === candidate) return 1;

  const minLength = Math.min(token.length, candidate.length);
  if (minLength >= 4 && (token.startsWith(candidate) || candidate.startsWith(token))) {
    return 0.86;
  }

  const distance = levenshteinDistance(token, candidate);
  if (minLength >= 8 && distance <= 3) return 0.76;
  if (minLength >= 6 && distance <= 2) return 0.76;
  if (minLength >= 5 && distance <= 1) return 0.82;
  if (minLength >= 3 && distance <= 1) return 0.74;

  return 0;
}

export function bestTokenSimilarity(token: string, candidates: string[]): number {
  let best = 0;

  for (const candidate of candidates) {
    best = Math.max(best, tokenSimilarity(token, candidate));
    if (best === 1) return best;
  }

  return best;
}

export function textSimilarity(a: string, b: string): number {
  const normA = normalizeText(a);
  const normB = normalizeText(b);

  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normB.includes(normA)) return 0.98;
  if (normA.includes(normB)) return 0.9;

  const aWords = [...new Set(tokenizeForMatch(normA))];
  const bWords = [...new Set(tokenizeForMatch(normB))];
  if (!aWords.length || !bWords.length) return 0;

  const exactIntersection = aWords.filter((word) => bWords.includes(word)).length;
  if (exactIntersection > 0 && aWords.every((word) => bWords.includes(word))) {
    return 0.92;
  }

  const forwardScore =
    aWords.reduce((sum, word) => sum + bestTokenSimilarity(word, bWords), 0) /
    Math.max(aWords.length, 1);
  const exactCoverage = exactIntersection / Math.max(aWords.length, 1);

  return Math.max(forwardScore, exactCoverage);
}
