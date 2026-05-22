export function normalizeText(input: string): string {
  return input
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^\w\s]/g, "")
    .trim();
}

const MATCH_STOPWORDS = new Set([
  "a",
  "au",
  "aux",
  "avec",
  "de",
  "des",
  "du",
  "d",
  "dans",
  "en",
  "et",
  "la",
  "le",
  "les",
  "l",
  "par",
  "pour",
  "un",
  "une",
]);

function singularizeMatchToken(token: string): string {
  if (token.length <= 3) return token;

  if (token.endsWith("s")) {
    return token.slice(0, -1);
  }

  return token;
}

export function tokenizeForMatch(input: string): string[] {
  const tokens = normalizeText(input)
    .split(" ")
    .filter((token) => token && !MATCH_STOPWORDS.has(token));
  const expanded = new Set<string>();

  for (const token of tokens) {
    expanded.add(token);

    const singular = singularizeMatchToken(token);
    if (singular && singular !== token) {
      expanded.add(singular);
    }
  }

  return [...expanded];
}
