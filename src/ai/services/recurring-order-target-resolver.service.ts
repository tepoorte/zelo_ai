import type { PendingRecurringOrderSummary } from "../pending.js";
import { createHash } from "node:crypto";
import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import { textSimilarity } from "../../domain/text-similarity.js";
import { normalizeLooseText } from "./product-options.service.js";

export type RecurringOrderTargetResolution =
  | { status: "selected"; order: PendingRecurringOrderSummary; score: number; reasons: string[] }
  | {
      status: "ambiguous";
      candidates: Array<{ order: PendingRecurringOrderSummary; score: number; reasons: string[] }>;
      reason: string;
    }
  | { status: "missing"; reason: string };

const NUMBER_WORDS: Record<number, string[]> = {
  1: ["un", "une", "premier", "premiere"],
  2: ["deux", "deuxieme", "second", "seconde"],
  3: ["trois", "troisieme"],
  4: ["quatre", "quatrieme"],
  5: ["cinq", "cinquieme"],
  6: ["six", "sixieme"],
  7: ["sept", "septieme"],
  8: ["huit", "huitieme"],
  9: ["neuf", "neuvieme"],
  10: ["dix", "dixieme"],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => normalizeLooseText(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function uniqueRaw(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const normalized = normalizeLooseText(value);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function compact(value: string): string {
  return normalizeLooseText(value).replace(/\s+/g, "");
}

function phraseInText(normalizedText: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(normalizedPhrase)}(?:\\s|$)`).test(normalizedText);
}

function editDistance(left: string, right: string, maxDistance = 3): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = current[0] ?? 0;

    for (let col = 1; col <= right.length; col += 1) {
      const substitution = previous[col - 1] + (left[row - 1] === right[col - 1] ? 0 : 1);
      const insertion = current[col - 1] + 1;
      const deletion = previous[col] + 1;
      const value = Math.min(substitution, insertion, deletion);
      current[col] = value;
      rowMin = Math.min(rowMin, value);
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }

  return previous[right.length] ?? maxDistance + 1;
}

function tokenDistanceAllowance(token: string): number {
  if (/^\d+$/.test(token)) return 0;
  if (token.length >= 8) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

function numberTokenValue(token: string): number | null {
  const normalized = normalizeLooseText(token);
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    const value = Number(normalized);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  for (const [rawValue, aliases] of Object.entries(NUMBER_WORDS)) {
    const value = Number(rawValue);
    for (const alias of aliases) {
      if (normalized === alias) return value;

      const allowance = tokenDistanceAllowance(alias);
      if (allowance && editDistance(normalized, alias, allowance) <= allowance) {
        return value;
      }
    }
  }

  return null;
}

function fuzzyPhraseInText(normalizedText: string, normalizedPhrase: string): boolean {
  const phraseTokens = normalizedPhrase.split(" ").filter(Boolean);
  if (!phraseTokens.length) return false;

  const alphaLength = phraseTokens.join("").replace(/\d/g, "").length;
  if (alphaLength < 7) return false;

  const textTokens = normalizedText.split(" ").filter(Boolean);
  if (textTokens.length < phraseTokens.length) return false;

  const maxMismatchTokens = phraseTokens.length >= 4 ? 2 : 1;

  for (let start = 0; start <= textTokens.length - phraseTokens.length; start += 1) {
    let mismatchTokens = 0;
    let failed = false;

    for (let index = 0; index < phraseTokens.length; index += 1) {
      const expected = phraseTokens[index] ?? "";
      const actual = textTokens[start + index] ?? "";
      if (actual === expected) continue;

      const allowance = tokenDistanceAllowance(expected);
      if (!allowance || editDistance(actual, expected, allowance) > allowance) {
        failed = true;
        break;
      }

      mismatchTokens += 1;
      if (mismatchTokens > maxMismatchTokens) {
        failed = true;
        break;
      }
    }

    if (!failed) return true;
  }

  return false;
}

function digitTokens(value: string): string[] {
  return value.match(/\d+/g) ?? [];
}

function hasConflictingExplicitDigits(candidate: string, expected: string): boolean {
  const candidateDigits = digitTokens(candidate);
  const expectedDigits = digitTokens(expected);
  if (!candidateDigits.length || !expectedDigits.length) return false;

  const candidateSet = new Set(candidateDigits);
  const expectedSet = new Set(expectedDigits);
  if (candidateSet.size !== expectedSet.size) return true;

  for (const digit of candidateSet) {
    if (!expectedSet.has(digit)) return true;
  }

  return false;
}

function semanticPhraseSimilarityInText(normalizedText: string, normalizedPhrase: string): number {
  const phraseTokens = normalizedPhrase.split(" ").filter(Boolean);
  const textTokens = normalizedText.split(" ").filter(Boolean);
  if (!phraseTokens.length || !textTokens.length) return 0;

  const alphaLength = phraseTokens.join("").replace(/\d/g, "").length;
  if (alphaLength < 7 || phraseTokens.length < 2) return 0;

  const minWindowSize = Math.max(1, phraseTokens.length - 2);
  const maxWindowSize = Math.min(textTokens.length, phraseTokens.length + 2);
  let best = 0;

  for (let start = 0; start < textTokens.length; start += 1) {
    for (let size = minWindowSize; size <= maxWindowSize && start + size <= textTokens.length; size += 1) {
      const candidate = textTokens.slice(start, start + size).join(" ");
      if (hasConflictingExplicitDigits(candidate, normalizedPhrase)) continue;
      best = Math.max(best, textSimilarity(candidate, normalizedPhrase));
      if (best >= 0.98) return best;
    }
  }

  return best;
}

function semanticPhraseThreshold(normalizedPhrase: string): number {
  const tokenCount = normalizedPhrase.split(" ").filter(Boolean).length;
  if (tokenCount >= 4) return 0.86;
  if (tokenCount >= 3) return 0.88;
  return 0.9;
}

function recurringAliasMatchKind(
  normalizedText: string,
  alias: string,
  allowFuzzy: boolean
): "exact" | "fuzzy" | "semantic" | null {
  const normalizedAlias = normalizeLooseText(alias);
  if (phraseInText(normalizedText, normalizedAlias)) return "exact";
  if (allowFuzzy && fuzzyPhraseInText(normalizedText, normalizedAlias)) return "fuzzy";
  if (
    allowFuzzy &&
    semanticPhraseSimilarityInText(normalizedText, normalizedAlias) >= semanticPhraseThreshold(normalizedAlias)
  ) {
    return "semantic";
  }
  return null;
}

function recurringAliasExactOrFuzzyMatchKind(
  normalizedText: string,
  alias: string
): "exact" | "fuzzy" | null {
  const normalizedAlias = normalizeLooseText(alias);
  if (phraseInText(normalizedText, normalizedAlias)) return "exact";
  if (fuzzyPhraseInText(normalizedText, normalizedAlias)) return "fuzzy";
  return null;
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

function displayName(order: PendingRecurringOrderSummary): string {
  const rawName = String(order.name || "").replace(/^AI TEST\s*-\s*/i, "").trim();
  const firstDay = order.dayLabels[0];
  const recurringWithBareDay = rawName.match(
    /^commande\s+r[eé]currente\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)$/i
  );

  if (recurringWithBareDay?.[1]) {
    return `Commande récurrente du ${recurringWithBareDay[1].toLowerCase()}`;
  }

  if (!rawName && firstDay) {
    return `Commande récurrente du ${firstDay}`;
  }

  return rawName || "Commande récurrente";
}

function frequencyStep(order: PendingRecurringOrderSummary): { value: number; unit: "w" | "m" } | null {
  const raw = String(order.frequencyUnit || "");
  const match = raw.match(/^1\/(\d+)([wm])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: match[2].toLowerCase() as "w" | "m" };
}

type FrequencyMention = { value: number; unit: "w" | "m" };

function isWeekToken(token: string): boolean {
  if (["sem", "semaine", "semaines"].includes(token)) return true;
  return editDistance(token, "semaine", 1) <= 1 || editDistance(token, "semaines", 1) <= 1;
}

function isMonthToken(token: string): boolean {
  return token === "mois";
}

function nearestNumberBefore(tokens: string[], index: number): number | null {
  for (let offset = 1; offset <= 4 && index - offset >= 0; offset += 1) {
    const value = numberTokenValue(tokens[index - offset] || "");
    if (value != null) return value;
  }
  return null;
}

function numberAfterSur(tokens: string[], index: number): number | null {
  for (let offset = 1; offset <= 3 && index + offset < tokens.length; offset += 1) {
    if (tokens[index + offset] !== "sur") continue;
    for (let afterSur = offset + 1; afterSur <= offset + 3 && index + afterSur < tokens.length; afterSur += 1) {
      const value = numberTokenValue(tokens[index + afterSur] || "");
      if (value != null) return value;
    }
  }
  return null;
}

function hasWeeklyCueWithoutNumber(tokens: string[], index: number): boolean {
  const previous = tokens.slice(Math.max(0, index - 3), index);
  return previous.some((token) => ["chaque", "tous", "tout", "toute", "toutes"].includes(token));
}

function addFrequencyMention(mentions: FrequencyMention[], mention: FrequencyMention): void {
  if (mention.value <= 0) return;
  if (mentions.some((existing) => existing.unit === mention.unit && existing.value === mention.value)) return;
  mentions.push(mention);
}

function frequencyMentionsFromText(text: string): FrequencyMention[] {
  const normalized = normalizeLooseText(text);
  const tokens = normalized.split(" ").filter(Boolean);
  const mentions: FrequencyMention[] = [];

  if (fuzzyPhraseInText(normalized, "bimensuel") || fuzzyPhraseInText(normalized, "bi mensuel")) {
    addFrequencyMention(mentions, { value: 2, unit: "w" });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] || "";

    if (token === "hebdomadaire") {
      addFrequencyMention(mentions, { value: 1, unit: "w" });
      continue;
    }

    if (token === "mensuel") {
      addFrequencyMention(mentions, { value: 1, unit: "m" });
      continue;
    }

    if (isWeekToken(token)) {
      const afterSur = numberAfterSur(tokens, index);
      if (afterSur != null) {
        addFrequencyMention(mentions, { value: afterSur, unit: "w" });
        continue;
      }

      const before = nearestNumberBefore(tokens, index);
      if (before != null) {
        addFrequencyMention(mentions, { value: before, unit: "w" });
        continue;
      }

      if (hasWeeklyCueWithoutNumber(tokens, index)) {
        addFrequencyMention(mentions, { value: 1, unit: "w" });
      }
      continue;
    }

    if (isMonthToken(token)) {
      const afterSur = numberAfterSur(tokens, index);
      if (afterSur != null) {
        addFrequencyMention(mentions, { value: afterSur, unit: "m" });
        continue;
      }

      const before = nearestNumberBefore(tokens, index);
      if (before != null) {
        addFrequencyMention(mentions, { value: before, unit: "m" });
        continue;
      }

      if (hasWeeklyCueWithoutNumber(tokens, index)) {
        addFrequencyMention(mentions, { value: 1, unit: "m" });
      }
    }
  }

  return mentions;
}

function frequencyMentionMatchesStep(mention: FrequencyMention, step: { value: number; unit: "w" | "m" }): boolean {
  if (mention.unit === step.unit && mention.value === step.value) return true;

  // Swissdata stores "tous les 2 mois" as 1/8w in the observed recurring orders.
  if (mention.unit === "m" && step.unit === "w") return step.value === mention.value * 4;
  if (mention.unit === "w" && step.unit === "m") return mention.value === step.value * 4;

  return false;
}

export function recurringFrequencyLabel(order: PendingRecurringOrderSummary): string | null {
  if (order.frequencyLabel) return order.frequencyLabel;

  const step = frequencyStep(order);
  if (!step) return null;

  if (step.unit === "m") {
    return step.value === 1 ? "chaque mois" : `tous les ${step.value} mois`;
  }

  if (step.value === 1) return "chaque semaine";
  if (step.value === 2) return "1 sem. sur 2";
  return `toutes les ${step.value} semaines`;
}

export function recurringStatusLabel(status?: string | null): string | null {
  switch (normalizeLooseText(status || "")) {
    case "running":
      return "active";
    case "paused":
      return "en pause";
    case "finished":
      return "terminée";
    case "canceled":
    case "cancelled":
      return "annulée";
    case "getting ready":
      return "en préparation";
    default:
      return null;
  }
}

function numberAliases(value: number): string[] {
  return [String(value), ...(NUMBER_WORDS[value] || [])];
}

function weekFrequencyAliases(step: number): string[] {
  const aliases = [
    `1 sem sur ${step}`,
    `1 semaine sur ${step}`,
    `une semaine sur ${step}`,
    `toutes les ${step} sem`,
    `toutes les ${step} semaines`,
    `chaque ${step} semaines`,
  ];

  for (const word of numberAliases(step)) {
    aliases.push(`1 sem sur ${word}`);
    aliases.push(`1 semaine sur ${word}`);
    aliases.push(`une semaine sur ${word}`);
    aliases.push(`toutes les ${word} semaines`);
    aliases.push(`chaque ${word} semaines`);
  }

  if (step === 1) {
    aliases.push("chaque semaine", "toutes les semaines", "hebdomadaire");
  }

  if (step === 2) {
    aliases.push(
      "une semaine sur deux",
      "tous les quinze jours",
      "toutes les deux semaines",
      "bimensuel",
      "bi mensuel"
    );
  }

  if (step === 8) {
    aliases.push("tous les 2 mois", "tous les deux mois", "toutes les 8 sem", "toutes les huit semaines");
  }

  return aliases;
}

function frequencyAliases(order: PendingRecurringOrderSummary): string[] {
  const step = frequencyStep(order);
  const aliases = [recurringFrequencyLabel(order) || ""];
  if (!step) return unique(aliases);

  if (step.unit === "m") {
    if (step.value === 1) aliases.push("chaque mois", "mensuel", "tous les mois");
    if (step.value === 2) aliases.push("tous les 2 mois", "tous les deux mois", "bimestriel");
    aliases.push(`tous les ${step.value} mois`);
    return unique(aliases);
  }

  return unique([...aliases, ...weekFrequencyAliases(step.value)]);
}

function timeAliases(time?: string | null): string[] {
  if (!time) return [];
  const match = String(time).match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return unique([time]);
  const hour = Number(match[1]);
  const minute = match[2] || "00";
  const paddedHour = String(hour).padStart(2, "0");
  const compactMinute = minute === "00" ? "" : minute;
  return unique([
    `${paddedHour}:${minute}`,
    `${hour}:${minute}`,
    `${hour}h${compactMinute}`,
    `${hour} h ${compactMinute}`,
    minute === "00" ? `${hour}h` : "",
    minute === "00" ? `${hour} h` : "",
  ]);
}

function dateAliases(dates: string[]): string[] {
  const aliases: string[] = [];
  for (const date of dates) {
    aliases.push(date);
    const match = String(date).match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (!match) continue;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = match[3];
    const dd = String(day).padStart(2, "0");
    const mm = String(month).padStart(2, "0");
    aliases.push(`${dd}/${mm}/${year}`);
    aliases.push(`${day}/${month}/${year}`);
    aliases.push(`${dd}-${mm}-${year}`);
    aliases.push(`${day}-${month}-${year}`);
    aliases.push(`${dd}/${mm}`);
    aliases.push(`${day}/${month}`);
  }
  return unique(aliases);
}

function nameAliases(order: PendingRecurringOrderSummary): string[] {
  const names = [order.name, displayName(order)];
  for (const day of order.dayLabels) {
    names.push(`commande récurrente du ${day}`);
    names.push(`commande recurrente du ${day}`);
  }
  return unique(names);
}

function dayAliases(order: PendingRecurringOrderSummary): string[] {
  const aliases: string[] = [];
  for (const day of order.dayLabels) {
    aliases.push(day, `du ${day}`, `de ${day}`, `le ${day}`);
  }
  return unique(aliases);
}

function productAliases(order: PendingRecurringOrderSummary): string[] {
  return unique(order.products.map((line) => line.name).filter(Boolean));
}

const RECURRING_TARGET_MARKERS = [
  "commande recurrente",
  "commandes recurrentes",
  "commande recurrante",
  "commandes recurrantes",
  "commande recurrante",
  "commandes recurrantes",
  "commande recurrence",
  "commandes recurrence",
  "recurrence",
  "recurrance",
  "recurrante",
  "recurrantes",
  "recurrente",
  "recurrentes",
];

const TARGET_LEADING_FILLERS = new Set([
  "a",
  "au",
  "aux",
  "de",
  "des",
  "du",
  "d",
  "le",
  "la",
  "les",
  "ma",
  "mes",
  "mon",
]);

const TARGET_ACTION_TOKENS = new Set([
  "ajoute",
  "ajouter",
  "mets",
  "mettre",
  "modifie",
  "modifier",
  "retire",
  "retirer",
  "enleve",
  "enlever",
  "supprime",
  "supprimer",
  "garde",
  "garder",
]);

const TARGET_REMOVE_TOKENS = new Set([
  "retire",
  "retirer",
  "enleve",
  "enlever",
  "supprime",
  "supprimer",
  "garde",
  "garder",
  "sans",
]);

const TARGET_REASON_SET = new Set(["nom", "fréquence", "horaire", "date", "jour", "semantic_target"]);
const STRONG_TARGET_REASONS = ["nom", "fréquence", "horaire", "date"] as const;
const REMOVE_TARGET_STOP_TOKENS = new Set<string>([
  ...Array.from(TARGET_ACTION_TOKENS),
  "commande",
  "commandes",
  "recurrante",
  "recurrantes",
  "recurrente",
  "recurrentes",
  "recurrent",
  "recurrence",
  "recurrance",
]);

function isRemoveLikeRequest(text: string): boolean {
  return normalizeLooseText(text)
    .split(" ")
    .filter(Boolean)
    .some((token) => TARGET_REMOVE_TOKENS.has(token));
}

function removeTargetDescriptionFromText(text: string): string {
  const tokens = normalizeLooseText(text).split(" ").filter(Boolean);
  const removeIndex = tokens.findIndex((token) => TARGET_REMOVE_TOKENS.has(token));
  if (removeIndex < 0) return "";

  const targetTokens: string[] = [];
  for (let index = removeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!targetTokens.length && TARGET_LEADING_FILLERS.has(token)) {
      continue;
    }
    if (REMOVE_TARGET_STOP_TOKENS.has(token)) {
      break;
    }
    targetTokens.push(token);
  }

  return targetTokens.join(" ");
}

function targetDescriptionFromText(text: string): string {
  const normalized = normalizeLooseText(text);
  if (!normalized) return "";

  let target = normalized;
  let bestIndex = -1;
  let bestMarker = "";

  for (const marker of RECURRING_TARGET_MARKERS) {
    const index = normalized.indexOf(marker);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
      bestMarker = marker;
    }
  }

  if (bestIndex >= 0) {
    target = normalized.slice(bestIndex + bestMarker.length).trim();
  }

  const tokens = target.split(" ").filter(Boolean);

  const targetTokens: string[] = [];
  for (const token of tokens) {
    if (!targetTokens.length && TARGET_LEADING_FILLERS.has(token)) {
      continue;
    }

    if (TARGET_ACTION_TOKENS.has(token)) {
      if (targetTokens.length) break;
      continue;
    }

    targetTokens.push(token);
  }

  return targetTokens.join(" ");
}

function recurringSemanticTargetProfile(order: PendingRecurringOrderSummary): string {
  const values = uniqueRaw([
    order.name || "",
    displayName(order),
    ...order.dayLabels,
    ...dayAliases(order),
    recurringFrequencyLabel(order) || "",
    ...frequencyAliases(order),
    ...(order.deliveryTime ? [order.deliveryTime] : []),
    ...timeAliases(order.deliveryTime),
    ...dateAliases(order.nextDates),
    recurringStatusLabel(order.recurringOrderStatus) || "",
  ]);

  return normalizeText(values.join(" "));
}

function semanticTargetSimilarity(text: string, order: PendingRecurringOrderSummary): number {
  const target = targetDescriptionFromText(text);
  const targetTokens = tokenizeForMatch(target).filter((token) => token.length >= 2);
  if (targetTokens.length < 2) return 0;

  const profile = recurringSemanticTargetProfile(order);
  if (!profile) return 0;

  const lexical = textSimilarity(target, profile);
  const embedding = cosine(hashedEmbedding(target), hashedEmbedding(profile));
  return Math.max(lexical, embedding);
}

function semanticTargetScore(similarity: number): number {
  if (similarity >= 0.84) return 72;
  if (similarity >= 0.76) return 62;
  if (similarity >= 0.68) return 50;
  if (similarity >= 0.58) return 36;
  return 0;
}

function targetSignalCount(reasons: string[]): number {
  return new Set(reasons.filter((reason) => TARGET_REASON_SET.has(reason))).size;
}

function explicitRecurringChoiceIndex(text: string): number | null {
  const normalized = normalizeLooseText(text);
  const exactNumber = normalized.match(/^([1-9][0-9]?)$/);
  if (exactNumber) return Number(exactNumber[1]) - 1;

  const choiceNumber = normalized.match(/^(?:numero|num|n|choix|option|la|le)\s+([1-9][0-9]?)$/);
  if (choiceNumber) return Number(choiceNumber[1]) - 1;

  for (const [index, words] of Object.entries(NUMBER_WORDS)) {
    if (words.some((word) => normalized === word)) return Number(index) - 1;
  }

  return null;
}

function scoreOrder(
  text: string,
  order: PendingRecurringOrderSummary
): { score: number; reasons: string[] } {
  const normalizedText = normalizeLooseText(text);
  const compactText = compact(text);
  const frequencyMentions = frequencyMentionsFromText(normalizedText);
  const orderFrequencyStep = frequencyStep(order);
  const canScoreFrequency =
    !frequencyMentions.length ||
    !orderFrequencyStep ||
    frequencyMentions.some((mention) => frequencyMentionMatchesStep(mention, orderFrequencyStep));
  const reasons: string[] = [];
  let score = 0;

  for (const alias of nameAliases(order)) {
    const normalizedAlias = normalizeLooseText(alias);
    const compactAlias = compact(alias);
    const compactMatch =
      normalizedAlias.includes(" ") &&
      compactAlias.length >= 10 &&
      compactText.includes(compactAlias);

    if (phraseInText(normalizedText, normalizedAlias) || compactMatch) {
      score += 90;
      reasons.push("nom");
      break;
    }
  }

  let frequencyMatchedByMention = false;
  if (
    orderFrequencyStep &&
    frequencyMentions.some((mention) => frequencyMentionMatchesStep(mention, orderFrequencyStep))
  ) {
    score += 72;
    reasons.push("fréquence");
    frequencyMatchedByMention = true;
  }

  if (canScoreFrequency && !frequencyMatchedByMention) {
    for (const alias of frequencyAliases(order)) {
      const matchKind = recurringAliasExactOrFuzzyMatchKind(normalizedText, alias);
      if (matchKind) {
        score += matchKind === "exact" ? 65 : 58;
        reasons.push("fréquence");
        break;
      }
    }
  }

  for (const alias of timeAliases(order.deliveryTime)) {
    if (phraseInText(normalizedText, alias)) {
      score += 50;
      reasons.push("horaire");
      break;
    }
  }

  for (const alias of dateAliases(order.nextDates)) {
    if (phraseInText(normalizedText, alias)) {
      score += 55;
      reasons.push("date");
      break;
    }
  }

  for (const alias of dayAliases(order)) {
    const matchKind = recurringAliasExactOrFuzzyMatchKind(normalizedText, alias);
    if (matchKind) {
      score += matchKind === "exact" ? 25 : 20;
      reasons.push("jour");
      break;
    }
  }

  const normalizedRemoveTarget = normalizeLooseText(removeTargetDescriptionFromText(text));
  if (isRemoveLikeRequest(text) && normalizedRemoveTarget) {
    for (const alias of productAliases(order)) {
      if (alias.split(" ").some((token) => token.length >= 4 && phraseInText(normalizedRemoveTarget, token))) {
        score += 12;
        reasons.push("produit");
        break;
      }
    }
  }

  const targetSimilarity = semanticTargetSimilarity(text, order);
  const targetScore = semanticTargetScore(targetSimilarity);
  if (targetScore > 0) {
    score += targetScore;
    reasons.push("semantic_target");
  }

  return { score, reasons };
}

type ScoredRecurringOrder = {
  order: PendingRecurringOrderSummary;
  score: number;
  reasons: string[];
};

function uniqueCandidateWithReason(
  scored: ScoredRecurringOrder[],
  reason: string
): ScoredRecurringOrder | null {
  const candidates = scored.filter((entry) => entry.reasons.includes(reason));
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function recurringTargetAliases(order: PendingRecurringOrderSummary): string[] {
  return unique([
    ...nameAliases(order),
    ...frequencyAliases(order),
    ...timeAliases(order.deliveryTime),
    ...dateAliases(order.nextDates),
    ...dayAliases(order),
  ]);
}

export function resolveRecurringOrderTarget(
  text: string,
  orders: PendingRecurringOrderSummary[]
): RecurringOrderTargetResolution {
  if (!orders.length) return { status: "missing", reason: "no_orders" };
  if (orders.length === 1) {
    return { status: "selected", order: orders[0], score: 999, reasons: ["unique"] };
  }

  const selectedIndex = explicitRecurringChoiceIndex(text);
  if (selectedIndex != null) {
    const order = orders[selectedIndex];
    if (order) return { status: "selected", order, score: 999, reasons: ["numéro"] };
  }

  const scored: ScoredRecurringOrder[] = orders
    .map((order) => {
      const { score, reasons } = scoreOrder(text, order);
      return { order, score, reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length) {
    return { status: "missing", reason: "no_target_signal" };
  }

  const top = scored[0];
  const second = scored[1];
  const margin = top.score - (second?.score ?? 0);
  const hasStrongTargetSignal = top.reasons.some((reason) => TARGET_REASON_SET.has(reason));

  if (!hasStrongTargetSignal) {
    return { status: "missing", reason: "weak_product_only" };
  }

  const topSignalCount = targetSignalCount(top.reasons);
  const secondSignalCount = second ? targetSignalCount(second.reasons) : 0;

  if (!second) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  for (const reason of STRONG_TARGET_REASONS) {
    const unique = uniqueCandidateWithReason(scored, reason);
    if (unique && unique.score >= 45) {
      return {
        status: "selected",
        order: unique.order,
        score: unique.score,
        reasons: unique.reasons,
      };
    }
  }

  const uniqueDay = uniqueCandidateWithReason(scored, "jour");
  if (
    uniqueDay &&
    uniqueDay.score >= 25 &&
    !scored.some(
      (entry) =>
        entry.order.id !== uniqueDay.order.id &&
        entry.reasons.some((reason) =>
          STRONG_TARGET_REASONS.includes(reason as (typeof STRONG_TARGET_REASONS)[number])
        )
    )
  ) {
    return {
      status: "selected",
      order: uniqueDay.order,
      score: uniqueDay.score,
      reasons: uniqueDay.reasons,
    };
  }

  if (top.reasons.includes("jour") && !second?.reasons.includes("jour") && margin >= 20) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  if (top.reasons.includes("fréquence") && !second?.reasons.includes("fréquence") && margin >= 10) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  if (top.reasons.includes("semantic_target") && top.score >= 80 && margin >= 10) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  if (topSignalCount >= secondSignalCount + 1 && top.score >= 80 && margin >= 8) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  if (hasStrongTargetSignal && ((top.score >= 80 && margin >= 25) || (top.score >= 120 && margin >= 15))) {
    return { status: "selected", order: top.order, score: top.score, reasons: top.reasons };
  }

  return {
    status: "ambiguous",
    candidates: scored.slice(0, 5),
    reason: "low_margin",
  };
}
