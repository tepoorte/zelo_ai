import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import { ollamaEmbed } from "../services/ollama-client.js";
import {
  getBuildMealLearnedExamples,
  getBuildMealRejectedExamples,
} from "./learning.service.js";
import {
  areBuildMealFamiliesCompatible,
  inferBuildMealFamily,
  type BuildMealFamilyInference,
} from "./recipe-family.service.js";
import type {
  BuildMealDetectedRequest,
  BuildMealRecipeCandidate,
  BuildMealRecipeTraining,
  BuildMealTrainingSeed,
} from "./types.js";

type MemorySource = "alias" | "example" | "generated" | "learned";

type RecipeMemoryEntry = {
  mealKey: string;
  mealLabel: string;
  text: string;
  normalizedText: string;
  source: MemorySource;
  embedding?: number[];
};

type RecipeMemoryCache = {
  version: number;
  signature: string;
  items: RecipeMemoryEntry[];
};

const MEMORY_VERSION = 2;
const CACHE_DIR = path.join(process.cwd(), ".cache");
const MEMORY_FILE = path.join(CACHE_DIR, "build-meal-recipe-memory.json");
const QUERY_EMBEDDING_CACHE = new Map<string, number[]>();
let embeddingFailureUntil = 0;
const LEADING_ARTICLES = new Set(["un", "une", "des", "du", "de", "la", "le", "les", "l", "d"]);
const MATCH_STOPWORDS = new Set([
  ...LEADING_ARTICLES,
  "a",
  "au",
  "aux",
  "avec",
  "et",
  "en",
  "pour",
]);

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function hasAllTokens(text: string, alias: string): boolean {
  const textTokens = new Set(tokenizeForMatch(text));
  const aliasTokens = tokenizeForMatch(alias);
  return aliasTokens.length > 0 && aliasTokens.every((token) => textTokens.has(token));
}

function stripRequestPattern(text: string, training: BuildMealTrainingSeed): string {
  let value = normalizeText(text);
  const patterns = [...(training.requestPatterns || [])]
    .map((pattern) => normalizeText(pattern))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const pattern of patterns) {
    if (value.startsWith(pattern)) {
      value = value.slice(pattern.length).trim();
      break;
    }
  }

  value = value
    .replace(/\bpour\s+\d+\b/g, " ")
    .replace(/\b\d+\s*(?:personnes?|pers|personne)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = value.split(" ").filter(Boolean);
  while (tokens.length && LEADING_ARTICLES.has(tokens[0])) {
    tokens.shift();
  }

  return tokens.join(" ").trim() || normalizeText(text);
}

function tokenizeRecipeText(value: string): string[] {
  return tokenizeForMatch(String(value || "").replace(/[_-]+/g, " "));
}

function meaningfulRecipeTokens(value: string): string[] {
  return tokenizeRecipeText(value).filter((token) => !MATCH_STOPWORDS.has(token));
}

function tokenMatches(left: string, right: string): boolean {
  return left === right ||
    left.length > 3 && left.endsWith("s") && left.slice(0, -1) === right ||
    right.length > 3 && right.endsWith("s") && right.slice(0, -1) === left;
}

function tokenSetHas(tokens: Set<string>, expected: string): boolean {
  for (const token of tokens) {
    if (tokenMatches(token, expected)) return true;
  }
  return false;
}

function tokensContainAll(textTokens: Set<string>, expectedTokens: string[]): boolean {
  return expectedTokens.length > 0 && expectedTokens.every((token) => tokenSetHas(textTokens, token));
}

function recipeFamilyTokens(recipe: BuildMealRecipeTraining): string[] {
  if (recipe.family) return meaningfulRecipeTokens(recipe.family);
  return meaningfulRecipeTokens(recipe.label).slice(0, 1);
}

function recipeModifierTokens(recipe: BuildMealRecipeTraining): string[] {
  const familyTokens = new Set(recipeFamilyTokens(recipe));
  return meaningfulRecipeTokens(recipe.label).filter((token) => !familyTokens.has(token));
}

function recipeFamily(recipe: BuildMealRecipeTraining): string {
  if (recipe.family) return normalizeText(recipe.family);
  return inferBuildMealFamily({
    label: recipe.label,
    ingredients: recipe.ingredients,
  }).family;
}

function inferRequestedFamily(
  userText: string,
  training: BuildMealTrainingSeed
): BuildMealFamilyInference {
  const label = stripRequestPattern(userText, training);
  return inferBuildMealFamily({
    label,
    sourceText: userText,
    existingRecipes: training.meals,
  });
}

function hasRecipeFamilyConflict(
  requestedFamily: BuildMealFamilyInference,
  recipe: BuildMealRecipeTraining
): boolean {
  if (requestedFamily.source === "generic" || requestedFamily.confidence < 0.7) {
    return false;
  }

  return !areBuildMealFamiliesCompatible(requestedFamily.family, recipeFamily(recipe));
}

function tokenAllowedByRecipe(token: string, allowedTokens: Set<string>): boolean {
  if (allowedTokens.has(token)) return true;
  if (token.length > 3 && token.endsWith("s") && allowedTokens.has(token.slice(0, -1))) {
    return true;
  }
  return false;
}

function recipeAnchorTexts(recipe: BuildMealRecipeTraining): string[] {
  return [
    recipe.label,
    ...(recipe.aliases || []),
    ...(recipe.examples || []),
  ]
    .map((value) => stripLeadingRequestWords(value))
    .filter(Boolean);
}

function stripLeadingRequestWords(text: string): string {
  const normalized = normalizeText(String(text || "").replace(/[_-]+/g, " "));
  const tokens = normalized.split(" ").filter(Boolean);
  while (tokens.length && LEADING_ARTICLES.has(tokens[0])) {
    tokens.shift();
  }
  return tokens.join(" ");
}

function hasAnchoredRecipeText(requestTokens: Set<string>, recipe: BuildMealRecipeTraining): boolean {
  for (const anchor of recipeAnchorTexts(recipe)) {
    const anchorTokens = meaningfulRecipeTokens(anchor);
    if (tokensContainAll(requestTokens, anchorTokens)) {
      return true;
    }
  }
  return false;
}

function hasRecipeIdentityAnchor(
  userText: string,
  training: BuildMealTrainingSeed,
  recipe: BuildMealRecipeTraining
): boolean {
  const requestTokens = new Set(meaningfulRecipeTokens(stripRequestPattern(userText, training)));
  if (!requestTokens.size) return false;

  if (hasAnchoredRecipeText(requestTokens, recipe)) {
    return true;
  }

  const familyTokens = recipeFamilyTokens(recipe);
  const modifierTokens = recipeModifierTokens(recipe);
  const hasFamily = tokensContainAll(requestTokens, familyTokens);
  if (!hasFamily) return false;

  if (modifierTokens.length) {
    return tokensContainAll(requestTokens, modifierTokens);
  }

  return !hasUnexpectedBaseRecipeModifier(userText, training, recipe);
}

function isLearnedEntryTrusted(
  learnedText: string,
  training: BuildMealTrainingSeed,
  meal: BuildMealRecipeTraining
): boolean {
  return hasRecipeIdentityAnchor(learnedText, training, meal);
}

function isRejectedExample(
  rejectedExamples: Array<{ mealKey: string; normalizedText: string }>,
  mealKey: string,
  normalizedText: string
): boolean {
  return rejectedExamples.some(
    (item) => item.mealKey === mealKey && item.normalizedText === normalizedText
  );
}

function hasUnexpectedBaseRecipeModifier(
  userText: string,
  training: BuildMealTrainingSeed,
  recipe: BuildMealRecipeTraining
): boolean {
  const modifierTokens = recipeModifierTokens(recipe);
  if (modifierTokens.length) return false;

  const requestTokens = tokenizeForMatch(stripRequestPattern(userText, training));
  const allowedTokens = new Set([
    ...recipeFamilyTokens(recipe),
    ...tokenizeForMatch(recipe.label),
    ...tokenizeForMatch(recipe.key),
  ]);

  if (!allowedTokens.size) return false;

  const hasRecipeIdentity = [...recipeFamilyTokens(recipe)].every((token) =>
    requestTokens.some((requestToken) => requestToken === token || requestToken.endsWith("s") && requestToken.slice(0, -1) === token)
  );
  if (!hasRecipeIdentity) return false;

  return requestTokens.some((token) => !tokenAllowedByRecipe(token, allowedTokens));
}

function hasRecipeModifierMismatch(
  userText: string,
  training: BuildMealTrainingSeed,
  recipe: BuildMealRecipeTraining
): boolean {
  const modifierTokens = recipeModifierTokens(recipe);
  if (!modifierTokens.length) return false;

  const requestTokens = new Set(tokenizeForMatch(stripRequestPattern(userText, training)));
  const familyTokens = recipeFamilyTokens(recipe);
  const hasRecipeFamily = familyTokens.length > 0 && familyTokens.every((token) => requestTokens.has(token));
  if (!hasRecipeFamily) return false;

  return !modifierTokens.every((token) => requestTokens.has(token));
}

function aliasScore(normalizedText: string, candidateText: string): number {
  const normalizedCandidate = normalizeText(candidateText);
  if (!normalizedCandidate) return 0;
  if (normalizedText === normalizedCandidate) return 100;
  if (normalizedText.includes(normalizedCandidate)) return 90 + normalizedCandidate.length / 100;
  if (hasAllTokens(normalizedText, normalizedCandidate)) return 80;

  const textTokens = tokenizeForMatch(normalizedText);
  const candidateTokens = tokenizeForMatch(normalizedCandidate);
  if (!textTokens.length || !candidateTokens.length) return 0;

  const overlap = candidateTokens.filter((token) => textTokens.includes(token)).length;
  if (!overlap) return 0;

  return (overlap / candidateTokens.length) * 50;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function buildSignature(
  training: BuildMealTrainingSeed,
  learnedExamples: Array<{ mealKey: string; normalizedText: string; count: number; status?: string }>,
  rejectedExamples: Array<{ mealKey: string; normalizedText: string; count: number }>
): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        memoryVersion: MEMORY_VERSION,
        version: training.version,
        requestPatterns: training.requestPatterns,
        meals: training.meals.map((meal) => ({
          key: meal.key,
          label: meal.label,
          family: meal.family,
          aliases: meal.aliases,
          examples: meal.examples || [],
        })),
        learnedExamples,
        rejectedExamples,
      })
    )
    .digest("hex");
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureCacheDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function maybeEmbedText(text: string): Promise<number[] | undefined> {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  if (QUERY_EMBEDDING_CACHE.has(normalized)) {
    return QUERY_EMBEDDING_CACHE.get(normalized);
  }
  if (Date.now() < embeddingFailureUntil) {
    return undefined;
  }

  try {
    const vector = await ollamaEmbed(normalized);
    if (vector.length) {
      QUERY_EMBEDDING_CACHE.set(normalized, vector);
      return vector;
    }
  } catch {
    embeddingFailureUntil = Date.now() + 5 * 60 * 1000;
  }
  return undefined;
}

function pushUniqueEntry(
  entries: RecipeMemoryEntry[],
  meal: BuildMealRecipeTraining,
  text: string,
  source: MemorySource
) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return;
  const alreadyExists = entries.some(
    (entry) => entry.mealKey === meal.key && entry.normalizedText === normalizedText
  );
  if (alreadyExists) return;

  entries.push({
    mealKey: meal.key,
    mealLabel: meal.label,
    text: text.trim(),
    normalizedText,
    source,
  });
}

async function buildEntries(training: BuildMealTrainingSeed): Promise<RecipeMemoryEntry[]> {
  const [learnedExamples, rejectedExamples] = await Promise.all([
    getBuildMealLearnedExamples(),
    getBuildMealRejectedExamples(),
  ]);
  const entries: RecipeMemoryEntry[] = [];

  for (const meal of training.meals) {
    for (const alias of meal.aliases || []) {
      pushUniqueEntry(entries, meal, alias, "alias");
      for (const pattern of training.requestPatterns || []) {
        pushUniqueEntry(entries, meal, `${pattern} ${alias}`, "generated");
      }
    }

    for (const example of meal.examples || []) {
      pushUniqueEntry(entries, meal, example, "example");
    }

    for (const item of learnedExamples.items.filter((example) => example.mealKey === meal.key)) {
      if (item.status === "rejected") continue;
      if (isRejectedExample(rejectedExamples.items, meal.key, item.normalizedText)) continue;
      if (!isLearnedEntryTrusted(item.text, training, meal)) continue;
      pushUniqueEntry(entries, meal, item.text, "learned");
    }
  }

  return entries;
}

async function loadRecipeMemory(training: BuildMealTrainingSeed): Promise<RecipeMemoryEntry[]> {
  const [learnedExamples, rejectedExamples] = await Promise.all([
    getBuildMealLearnedExamples(),
    getBuildMealRejectedExamples(),
  ]);
  const signature = buildSignature(
    training,
    learnedExamples.items.map((item) => ({
      mealKey: item.mealKey,
      normalizedText: item.normalizedText,
      count: item.count,
      status: item.status,
    })),
    rejectedExamples.items.map((item) => ({
      mealKey: item.mealKey,
      normalizedText: item.normalizedText,
      count: item.count,
    }))
  );

  const cached = await readJsonFile<RecipeMemoryCache | null>(MEMORY_FILE, null);
  if (
    cached?.version === MEMORY_VERSION &&
    cached.signature === signature &&
    Array.isArray(cached.items) &&
    cached.items.length
  ) {
    return cached.items;
  }

  const entries = await buildEntries(training);
  const items: RecipeMemoryEntry[] = [];
  for (const entry of entries) {
    const embedding = await maybeEmbedText(entry.normalizedText);
    items.push(embedding?.length ? { ...entry, embedding } : entry);
  }

  await writeJsonFile(MEMORY_FILE, {
    version: MEMORY_VERSION,
    signature,
    items,
  } satisfies RecipeMemoryCache);

  return items;
}

function buildCandidateScore(
  lexicalScore: number,
  semanticScore: number,
  source: MemorySource
): number {
  const lexical = clamp(lexicalScore / 100);
  const semantic = clamp(semanticScore);
  const sourceBonus =
    source === "learned" ? 0.04 :
    source === "example" ? 0.025 :
    source === "alias" ? 0.015 : 0;

  return clamp(
    Math.max(lexical, semantic * 0.92, lexical * 0.7 + semantic * 0.3 + sourceBonus)
  );
}

export function looksLikeMealRequest(normalizedText: string, training: BuildMealTrainingSeed): boolean {
  return (training.requestPatterns || []).some((pattern) =>
    normalizedText.includes(normalizeText(pattern))
  );
}

export async function getRecipeCandidates(
  userText: string,
  training: BuildMealTrainingSeed
): Promise<BuildMealRecipeCandidate[]> {
  const normalizedText = normalizeText(userText);
  if (!normalizedText) return [];

  const requestedFamily = inferRequestedFamily(userText, training);
  const recipesByKey = new Map((training.meals || []).map((recipe) => [recipe.key, recipe]));
  const [memory, queryEmbedding, rejectedExamples] = await Promise.all([
    loadRecipeMemory(training),
    maybeEmbedText(normalizedText),
    getBuildMealRejectedExamples(),
  ]);

  const bestByMeal = new Map<string, BuildMealRecipeCandidate>();

  for (const entry of memory) {
    const recipe = recipesByKey.get(entry.mealKey);
    if (isRejectedExample(rejectedExamples.items, entry.mealKey, normalizedText)) {
      continue;
    }
    if (recipe && hasRecipeFamilyConflict(requestedFamily, recipe)) {
      continue;
    }
    if (recipe && !hasRecipeIdentityAnchor(userText, training, recipe)) {
      continue;
    }

    const lexicalScore = aliasScore(normalizedText, entry.normalizedText);
    const semanticScore =
      queryEmbedding?.length && entry.embedding?.length
        ? Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding))
        : 0;
    const score = buildCandidateScore(lexicalScore, semanticScore, entry.source);
    if (score <= 0) continue;

    const candidate: BuildMealRecipeCandidate = {
      mealKey: entry.mealKey,
      mealLabel: entry.mealLabel,
      matchedText: entry.text,
      score,
      lexicalScore: clamp(lexicalScore / 100),
      semanticScore,
      source: entry.source,
    };

    const current = bestByMeal.get(entry.mealKey);
    if (!current || candidate.score > current.score) {
      bestByMeal.set(entry.mealKey, candidate);
    }
  }

  return [...bestByMeal.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

export async function detectRecipeRequest(
  userText: string,
  training: BuildMealTrainingSeed,
  servings: number,
  options?: { force?: boolean }
): Promise<BuildMealDetectedRequest | null> {
  const normalizedText = normalizeText(userText);
  if (!normalizedText) return null;

  const candidates = await getRecipeCandidates(userText, training);
  if (!candidates.length) return null;

  const requestedFamily = inferRequestedFamily(userText, training);
  const mealRequest = looksLikeMealRequest(normalizedText, training);

  for (let index = 0; index < candidates.length; index += 1) {
    const best = candidates[index];
    const recipe = training.meals.find((item) => item.key === best.mealKey);
    if (!recipe) continue;

    if (hasRecipeFamilyConflict(requestedFamily, recipe)) {
      continue;
    }
    if (hasRecipeModifierMismatch(userText, training, recipe)) {
      continue;
    }
    if (hasUnexpectedBaseRecipeModifier(userText, training, recipe)) {
      continue;
    }
    if (!hasRecipeIdentityAnchor(userText, training, recipe)) {
      continue;
    }

    const runnerUp = candidates[index + 1];
    const margin = best.score - (runnerUp?.score || 0);
    const lexicalStrong = best.lexicalScore >= 0.8;
    const lexicalSoft = best.lexicalScore >= 0.45;
    const semanticStrong = best.semanticScore >= 0.9;
    const hybridStrong = best.score >= 0.72 && margin >= 0.05;
    const forcedHybrid = best.score >= 0.58 && margin >= 0.04;

    const shouldAccept =
      lexicalStrong ||
      (semanticStrong && lexicalSoft) ||
      (mealRequest && hybridStrong) ||
      (options?.force && mealRequest && forcedHybrid);

    if (!shouldAccept) continue;

    const strategy =
      best.lexicalScore >= 0.8 ? "lexical" :
      best.semanticScore >= 0.9 && best.lexicalScore < 0.45 ? "semantic" :
      "hybrid";

    return {
      normalizedText,
      servings,
      matchedAlias: best.matchedText,
      recipe,
      confidence: best.score,
      strategy,
      candidates,
    };
  }

  return null;
}
