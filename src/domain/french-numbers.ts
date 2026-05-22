function normalizeFrenchNumber(input: string): string {
  return String(input || "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-’']/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SIMPLE_NUMBERS: Record<string, number> = {
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
};

const TENS: Record<string, number> = {
  vingt: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
  soixante: 60,
  septante: 70,
  huitante: 80,
  octante: 80,
  nonante: 90,
};

const NUMBER_WORDS = [
  ...Object.keys(SIMPLE_NUMBERS),
  ...Object.keys(TENS),
  "cent",
  "cents",
  "mille",
  "milles",
  "et",
];

export const FRENCH_NUMBER_PATTERN_SOURCE =
  `(?:${NUMBER_WORDS.sort((left, right) => right.length - left.length).join("|")})(?:[\\s-]+(?:${NUMBER_WORDS.join("|")}))*`;

export function isFrenchNumberWord(value: string): boolean {
  const normalized = normalizeFrenchNumber(value);
  if (!normalized || normalized.includes(" ")) return false;
  return NUMBER_WORDS.includes(normalized);
}

function normalizeNumberToken(token: string): string {
  if (token === "cents") return "cent";
  if (token === "vingts") return "vingt";
  if (token === "milles") return "mille";
  return token;
}

function parseUnderTwenty(tokens: string[]): number | undefined {
  if (tokens.length === 1) return SIMPLE_NUMBERS[tokens[0]];

  if (tokens.length === 2 && tokens[0] === "dix") {
    const suffix = SIMPLE_NUMBERS[tokens[1]];
    if (suffix != null && suffix >= 7 && suffix <= 9) {
      return 10 + suffix;
    }
  }

  return undefined;
}

function parseBelowHundred(tokens: string[]): number | undefined {
  const clean = tokens
    .map(normalizeNumberToken)
    .filter((token) => token && token !== "et");

  if (!clean.length) return undefined;

  const underTwenty = parseUnderTwenty(clean);
  if (underTwenty != null) return underTwenty;

  const [first, second, third, ...rest] = clean;
  if (!first || rest.length) return undefined;

  if (first === "quatre" && second === "vingt") {
    if (!third) return 80;
    const suffix = parseUnderTwenty([third]);
    return suffix != null && suffix > 0 ? 80 + suffix : undefined;
  }

  const tensValue = TENS[first];
  if (tensValue == null) return undefined;
  if (!second) return tensValue;

  const suffixTokens = third ? [second, third] : [second];
  const suffix = parseUnderTwenty(suffixTokens);
  if (suffix == null) return undefined;

  if (first === "soixante" && suffix >= 10 && suffix <= 19) {
    return 60 + suffix;
  }

  if (suffix >= 1 && suffix <= 9 && tensValue >= 20) {
    return tensValue + suffix;
  }

  return undefined;
}

function parseFrenchNumberTokens(tokens: string[]): number | undefined {
  let total = 0;
  let current = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = normalizeNumberToken(tokens[index] || "");

    if (token === "et") {
      index += 1;
      continue;
    }

    if (token === "mille") {
      total += (current || 1) * 1000;
      current = 0;
      index += 1;
      continue;
    }

    if (token === "cent") {
      current = (current || 1) * 100;
      index += 1;
      continue;
    }

    const group: string[] = [];
    while (index < tokens.length) {
      const groupToken = normalizeNumberToken(tokens[index] || "");
      if (groupToken === "cent" || groupToken === "mille") break;
      group.push(groupToken);
      index += 1;
    }

    const value = parseBelowHundred(group);
    if (value == null) return undefined;
    current += value;
  }

  const result = total + current;
  return result > 0 ? result : undefined;
}

export function parseFrenchNumber(value?: string): number | undefined {
  if (!value) return undefined;

  const numeric = Number(String(value).replace(",", "."));
  if (Number.isFinite(numeric)) return numeric;

  const normalized = normalizeFrenchNumber(value);
  if (!normalized) return undefined;

  const tokens = normalized
    .split(" ")
    .map(normalizeNumberToken)
    .filter(Boolean);

  if (!tokens.length) return undefined;
  if (tokens.some((token) => !NUMBER_WORDS.includes(token))) return undefined;

  return parseFrenchNumberTokens(tokens);
}
