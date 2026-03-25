/*import type { MealMatchSummaryV2 } from "./meal-types.v2.js";

export function hasEnoughMealCoverageV2(summary: MealMatchSummaryV2): boolean {
  const core = summary.matches.filter((m) => m.ingredient.isCore);
  const acceptedCore = summary.accepted.filter((m) => m.ingredient.isCore);

  if (core.length === 0) {
    return summary.accepted.length > 0;
  }

  const ratio = acceptedCore.length / core.length;

  // piatto accettabile se almeno 70% dei core è trovato
  return ratio >= 0.7;
}

export function buildMealCoverageMessageV2(
  summary: MealMatchSummaryV2
): string | undefined {
  if (hasEnoughMealCoverageV2(summary)) return undefined;

  const missingCore = summary.missing
    .filter((m) => m.ingredient.isCore)
    .map((m) => m.ingredient.label);

  if (!missingCore.length) {
    return `Coverage too weak for meal "${summary.meal}".`;
  }

  return `Missing core ingredients for "${summary.meal}": ${missingCore.join(", ")}`;
}*/