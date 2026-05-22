import { normalizeText } from "./normalizer.js";

export type CanonicalQuantityUnit = "piece" | "g" | "kg" | "ml" | "litre";

const UNIT_ALIASES: Record<CanonicalQuantityUnit, string[]> = {
  piece: [
    "piece",
    "pieces",
    "pièce",
    "pièces",
    "pc",
    "pcs",
    "unité",
    "unités",
  ],
  g: [
    "g",
    "gr",
    "gram",
    "grams",
    "gramme",
    "grammes",
  ],
  kg: [
    "kg",
    "kilo",
    "kilos",
    "kilogramme",
    "kilogrammes",
  ],
  ml: [
    "ml",
    "millilitre",
    "millilitres",
  ],
  litre: [
    "l",
    "lt",
    "litre",
    "litres",
    "liter",
    "liters",
  ],
};

const NORMALIZED_ALIAS_TO_UNIT = new Map<string, CanonicalQuantityUnit>(
  Object.entries(UNIT_ALIASES).flatMap(([unit, aliases]) =>
    aliases.map((alias) => [normalizeText(alias), unit as CanonicalQuantityUnit])
  )
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function canonicalizeQuantityUnit(value?: string): CanonicalQuantityUnit | undefined {
  const normalized = normalizeText(String(value || ""));
  if (!normalized) return undefined;
  return NORMALIZED_ALIAS_TO_UNIT.get(normalized);
}

export function quantityUnitPatternSource(): string {
  return Object.values(UNIT_ALIASES)
    .flat()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

export function isQuantityUnitToken(value: string): boolean {
  return Boolean(canonicalizeQuantityUnit(value));
}
