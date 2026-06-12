import { textSimilarity } from "../../domain/text-similarity.js";
import type {
  DiscoverBudgetPolicy,
  DiscoverBudgetSignal,
  DiscoverNeedLabel,
  DiscoverProductProfile,
  DiscoverProductRole,
  DiscoverProposal,
  DiscoverProposalProduct,
} from "./types.js";
import { budgetToleranceCHF } from "./budget-extractor.js";
import { estimateProductPriceCHF, estimatedTotalCHF } from "./price-estimator.js";

export type BudgetComposerEntry = {
  profile: DiscoverProductProfile;
  score: number;
  allowed: boolean;
  anchor: boolean;
  directFocus: boolean;
};

type BudgetBeam = {
  entries: BudgetComposerEntry[];
  total: number;
  score: number;
};

function productLimitForBudget(target: number): number {
  if (target <= 35) return 3;
  if (target <= 70) return 5;
  if (target <= 120) return 8;
  return 10;
}

function proposalLabels(labels: DiscoverNeedLabel[]): DiscoverNeedLabel[] {
  return labels.length ? labels : ["discovery_open"];
}

function productNameAlreadyUsed(entries: BudgetComposerEntry[], profile: DiscoverProductProfile): boolean {
  return entries.some((entry) => textSimilarity(entry.profile.product.name, profile.product.name) >= 0.74);
}

function hasAnyRole(profile: DiscoverProductProfile, roles: DiscoverProductRole[]): boolean {
  return roles.some((role) => profile.roles.has(role));
}

function productCompatibleWithLabels(profile: DiscoverProductProfile, labels: DiscoverNeedLabel[]): boolean {
  const labelSet = new Set(labels);

  if (labelSet.has("vegetarian") && hasAnyRole(profile, ["meat", "fish"])) return false;
  if (
    labelSet.has("breakfast") &&
    !labelSet.has("aperitif") &&
    !labelSet.has("dinner") &&
    hasAnyRole(profile, ["meat", "fish", "prepared_meal", "menu", "sauce", "oil", "cleaning", "hygiene"])
  ) {
    return false;
  }
  if (
    labelSet.has("kids") &&
    !labelSet.has("dinner") &&
    hasAnyRole(profile, ["alcohol", "meat", "fish", "prepared_meal", "menu", "sauce", "cleaning", "hygiene"])
  ) {
    return false;
  }
  if (
    labelSet.has("drink") &&
    !labelSet.has("aperitif") &&
    !labelSet.has("dinner") &&
    !labelSet.has("balanced") &&
    !profile.roles.has("drink")
  ) {
    return false;
  }
  if (labelSet.has("cleaning") && !hasAnyRole(profile, ["cleaning", "hygiene"])) return false;
  if (labelSet.has("hygiene") && !profile.roles.has("hygiene")) return false;

  return true;
}

function roleDiversityScore(entries: BudgetComposerEntry[]): number {
  const roles = new Set<DiscoverProductRole>();
  for (const entry of entries) {
    for (const role of entry.profile.roles) roles.add(role);
  }
  return Math.min(4, roles.size) * 0.7;
}

function beamScore(
  entries: BudgetComposerEntry[],
  target: number,
  tolerance: number,
  hasDirectFocus: boolean
): number {
  const total = entries.reduce((sum, entry) => sum + (estimateProductPriceCHF(entry.profile.product).amountCHF ?? 0), 0);
  const distance = Math.abs(target - total);
  const semanticScore = entries.reduce((sum, entry) => sum + Math.max(0, entry.score), 0);
  const focusScore = entries.some((entry) => entry.directFocus) ? 40 : entries.some((entry) => entry.anchor) ? 14 : 0;
  const missingFocusPenalty = hasDirectFocus && !entries.some((entry) => entry.directFocus) ? 80 : 0;
  const overBudgetPenalty = total > target + tolerance ? (total - target - tolerance) * 2.6 : 0;
  const underBudgetPenalty = total < target - tolerance ? (target - tolerance - total) * 0.9 : 0;
  const distanceScore = Math.max(0, 35 - distance);

  return semanticScore + focusScore + roleDiversityScore(entries) + distanceScore - overBudgetPenalty - underBudgetPenalty - missingFocusPenalty;
}

function proposalProduct(entry: BudgetComposerEntry, labels: DiscoverNeedLabel[]): DiscoverProposalProduct {
  const estimate = estimateProductPriceCHF(entry.profile.product);
  const primaryRole = [...entry.profile.roles][0];

  return {
    productId: String(entry.profile.product.id),
    name: entry.profile.product.name,
    roles: [...entry.profile.roles].slice(0, 5),
    reason: primaryRole ? `rôle catalogue : ${primaryRole}` : "produit du catalogue",
    hasOptions: entry.profile.hasOptions,
    ...(estimate.amountCHF != null ? { estimatedPriceCHF: estimate.amountCHF } : {}),
    priceEstimateReliable: estimate.reliable,
  };
}

function makeBudgetNote(total: number, target: number, tolerance: number): string {
  const distance = Math.round(Math.abs(total - target) * 100) / 100;
  if (distance <= tolerance) return `proche du budget demandé (${target.toFixed(2)} CHF)`;
  if (total < target) return `option la plus proche trouvée, environ ${distance.toFixed(2)} CHF sous le budget`;
  return `option la plus proche trouvée, environ ${distance.toFixed(2)} CHF au-dessus du budget`;
}

export function buildBudgetAwareProposal(input: {
  signal: DiscoverBudgetSignal;
  entries: BudgetComposerEntry[];
  labels: DiscoverNeedLabel[];
  focusTerms: string[];
  policy?: DiscoverBudgetPolicy;
}): DiscoverProposal | null {
  const target = input.signal.targetAmountCHF;
  if (input.signal.kind !== "target" || !target || target <= 0) return null;

  const tolerance = budgetToleranceCHF(input.signal, input.policy);
  const labels = proposalLabels(input.labels);
  const pricedCandidates = input.entries
    .filter((entry) => entry.allowed && entry.score > -70)
    .filter((entry) => productCompatibleWithLabels(entry.profile, labels))
    .map((entry) => ({ entry, estimate: estimateProductPriceCHF(entry.profile.product) }))
    .filter((item) => item.estimate.amountCHF != null && item.estimate.amountCHF <= Math.max(target + tolerance * 2, target * 1.4));
  const semanticTop = [...pricedCandidates].sort((left, right) => {
    if (left.entry.directFocus !== right.entry.directFocus) return left.entry.directFocus ? -1 : 1;
    if (left.entry.anchor !== right.entry.anchor) return left.entry.anchor ? -1 : 1;
    return right.entry.score - left.entry.score;
  })
    .slice(0, 42);
  const priceFillers = [...pricedCandidates]
    .filter((item) => item.estimate.amountCHF != null && item.estimate.amountCHF >= Math.max(4, target * 0.08))
    .sort((left, right) => {
      const leftPrice = left.estimate.amountCHF ?? 0;
      const rightPrice = right.estimate.amountCHF ?? 0;
      return right.entry.score - left.entry.score || rightPrice - leftPrice;
    })
    .slice(0, 28);
  const usableById = new Map<string, BudgetComposerEntry>();
  for (const item of [...semanticTop, ...priceFillers]) {
    usableById.set(String(item.entry.profile.product.id), item.entry);
  }
  const usable = [...usableById.values()];

  if (!usable.length) return null;

  const hasDirectFocus = usable.some((entry) => entry.directFocus);
  const seed = hasDirectFocus
    ? usable.filter((entry) => entry.directFocus).slice(0, 4)
    : usable.filter((entry) => entry.anchor).slice(0, 4);
  const initialEntries = seed.length ? seed : usable.slice(0, 4);
  let beams: BudgetBeam[] = initialEntries.map((entry) => {
    const total = estimateProductPriceCHF(entry.profile.product).amountCHF ?? 0;
    return {
      entries: [entry],
      total,
      score: beamScore([entry], target, tolerance, hasDirectFocus),
    };
  });

  const maxProducts = productLimitForBudget(target);
  for (let depth = 1; depth < maxProducts; depth += 1) {
    const next: BudgetBeam[] = [...beams];
    for (const beam of beams) {
      for (const candidate of usable) {
        if (beam.entries.some((entry) => String(entry.profile.product.id) === String(candidate.profile.product.id))) continue;
        if (productNameAlreadyUsed(beam.entries, candidate.profile)) continue;
        const price = estimateProductPriceCHF(candidate.profile.product).amountCHF ?? 0;
        const entries = [...beam.entries, candidate];
        const total = Math.round((beam.total + price) * 100) / 100;
        next.push({
          entries,
          total,
          score: beamScore(entries, target, tolerance, hasDirectFocus),
        });
      }
    }
    beams = next
      .sort((left, right) => right.score - left.score)
      .slice(0, 80);
  }

  const best = beams.sort((left, right) => {
    const leftDistance = Math.abs(target - left.total);
    const rightDistance = Math.abs(target - right.total);
    const leftWithin = leftDistance <= tolerance;
    const rightWithin = rightDistance <= tolerance;
    if (leftWithin !== rightWithin) return leftWithin ? -1 : 1;
    const meaningfulDistanceGap = Math.max(1, tolerance / 3);
    if (Math.abs(leftDistance - rightDistance) > meaningfulDistanceGap) {
      return leftDistance - rightDistance;
    }
    return right.score - left.score || leftDistance - rightDistance;
  })[0];

  if (!best?.entries.length) return null;
  if (hasDirectFocus && !best.entries.some((entry) => entry.directFocus)) return null;

  const products = best.entries.map((entry) => proposalProduct(entry, labels));
  const total = estimatedTotalCHF(products);
  if (total == null) return null;
  const titleFocus = input.focusTerms.length ? ` autour de ${input.focusTerms.slice(0, 2).join(" / ")}` : "";

  return {
    id: "budget_target",
    title: `Idée budget${titleFocus}`,
    why: "composition construite à partir du catalogue et rapprochée du budget demandé",
    needs: labels,
    score: best.score + 60,
    products,
    estimatedTotalCHF: total,
    budgetDistanceCHF: Math.round(Math.abs(total - target) * 100) / 100,
    budgetTargetCHF: target,
    budgetKind: "target",
    budgetNote: makeBudgetNote(total, target, tolerance),
  };
}
