import { normalizeText } from "../../domain/normalizer.js";
import type { DiscoverBudgetPolicy, DiscoverBudgetSignal } from "./types.js";

const DEFAULT_POLICY: DiscoverBudgetPolicy = {
  schemaVersion: 1,
  currencyTerms: ["chf", "fr", "frs", "franc", "francs", "franchs", "balle", "balles", ".-"],
  targetCues: ["budget", "max", "maximum", "environ", "autour", "avec", "mettre", "depenser", "depenserais", "prix"],
  economicCues: ["pas cher", "pas chere", "pas cheres", "pas chers", "pas trop cher", "pas trop chere", "pas trop cheres", "pas trop chers", "economique", "raisonnable", "bon marche", "limiter budget"],
  premiumCues: ["tres cher", "tres chere", "tres cheres", "tres chers", "premium", "gourmand", "riche", "genereux", "genereuse"],
  hardNegativeCues: ["personne", "personnes", "kilo", "kilos", "kg", "gramme", "grammes", "g", "litre", "litres", "heure", "heures"],
  toleranceRatio: 0.15,
  toleranceMinCHF: 5,
};

function policyWithDefaults(policy?: DiscoverBudgetPolicy): DiscoverBudgetPolicy {
  const merge = (left: string[], right?: string[]) => [...new Set([...left, ...(right ?? [])])];
  return {
    ...DEFAULT_POLICY,
    ...(policy ?? {}),
    currencyTerms: merge(DEFAULT_POLICY.currencyTerms, policy?.currencyTerms),
    targetCues: merge(DEFAULT_POLICY.targetCues, policy?.targetCues),
    economicCues: merge(DEFAULT_POLICY.economicCues, policy?.economicCues),
    premiumCues: merge(DEFAULT_POLICY.premiumCues, policy?.premiumCues),
    hardNegativeCues: merge(DEFAULT_POLICY.hardNegativeCues, policy?.hardNegativeCues),
  };
}

function containsCue(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(normalizeText(cue)));
}

function parseAmount(value: string): number | null {
  const amount = Number(value.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return null;
  return Math.round(amount * 100) / 100;
}

function targetFromCurrencyPattern(normalized: string, policy: DiscoverBudgetPolicy): DiscoverBudgetSignal | null {
  const currency = policy.currencyTerms
    .map((term) => term === ".-" ? "\\.-" : normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const number = "(\\d+(?:[\\.,]\\d+)?)";
  const after = new RegExp(`\\b${number}\\s*(?:${currency})\\b`, "i");
  const before = new RegExp(`\\b(?:${currency})\\s*${number}\\b`, "i");

  const match = normalized.match(after) ?? normalized.match(before);
  if (!match) return null;
  const amount = parseAmount(match[1]);
  if (amount == null) return null;

  return {
    kind: "target",
    confidence: 0.98,
    targetAmountCHF: amount,
    source: match[0],
  };
}

function targetFromBudgetCue(normalized: string, policy: DiscoverBudgetPolicy): DiscoverBudgetSignal | null {
  const cuePattern = policy.targetCues
    .map((cue) => normalizeText(cue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const number = "(\\d+(?:[\\.,]\\d+)?)";
  const nearCue = new RegExp(`(?:${cuePattern})(?:\\s+\\w+){0,4}\\s+${number}\\b|\\b${number}\\s+(?:\\w+\\s+){0,4}(?:${cuePattern})`, "i");
  const match = normalized.match(nearCue);
  if (!match) return null;

  const amount = parseAmount(match[1] ?? match[2]);
  if (amount == null) return null;

  const window = match[0];
  if (containsCue(window, policy.hardNegativeCues) && !containsCue(window, policy.currencyTerms)) {
    return null;
  }

  return {
    kind: "target",
    confidence: 0.78,
    targetAmountCHF: amount,
    source: window,
  };
}

export function extractDiscoverBudgetSignal(query: string, policy?: DiscoverBudgetPolicy): DiscoverBudgetSignal {
  const effectivePolicy = policyWithDefaults(policy);
  const queryWithDashCurrency = String(query || "").replace(/(\d+(?:[\.,]\d+)?)\s*\.-/g, "$1 chf");
  const normalized = normalizeText(queryWithDashCurrency).replace(/\s+/g, " ").trim();

  const target = targetFromCurrencyPattern(normalized, effectivePolicy) ?? targetFromBudgetCue(normalized, effectivePolicy);
  if (target) return target;

  if (containsCue(normalized, effectivePolicy.premiumCues)) {
    return { kind: "premium", confidence: 0.72 };
  }

  if (containsCue(normalized, effectivePolicy.economicCues)) {
    return { kind: "economic", confidence: 0.72 };
  }

  return { kind: "none", confidence: 0 };
}

export function budgetToleranceCHF(signal: DiscoverBudgetSignal, policy?: DiscoverBudgetPolicy): number {
  const effectivePolicy = policyWithDefaults(policy);
  const target = signal.targetAmountCHF ?? 0;
  return Math.max(effectivePolicy.toleranceMinCHF, target * effectivePolicy.toleranceRatio);
}
