import fs from "node:fs/promises";
import path from "node:path";
import type {
  BuildMealLearnedExample,
  BuildMealLearnedExamplesStore,
  BuildMealRecipeCandidate,
  BuildMealUnknownRecipeInbox,
  BuildMealUnknownRecipeRecord,
} from "./types.js";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const LEARNED_EXAMPLES_FILE = path.join(CACHE_DIR, "build-meal-recipe-examples.json");
const UNKNOWN_INBOX_FILE = path.join(CACHE_DIR, "build-meal-learning-inbox.json");

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

export async function getBuildMealLearnedExamples(): Promise<BuildMealLearnedExamplesStore> {
  return await readJsonFile<BuildMealLearnedExamplesStore>(LEARNED_EXAMPLES_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: [],
  });
}

export async function rememberBuildMealConfirmedExample(input: {
  mealKey: string;
  text: string;
  normalizedText: string;
  userRef?: string | null;
}): Promise<BuildMealLearnedExample | null> {
  const normalizedText = String(input.normalizedText || "").trim();
  const text = String(input.text || "").trim();
  if (!input.mealKey || !normalizedText || !text) return null;

  const store = await getBuildMealLearnedExamples();
  const now = new Date().toISOString();
  const existing = store.items.find(
    (item) => item.mealKey === input.mealKey && item.normalizedText === normalizedText
  );

  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    if (input.userRef) {
      const refs = new Set(existing.userRefs || []);
      refs.add(input.userRef);
      existing.userRefs = [...refs];
    }
    store.updatedAt = now;
    await writeJsonFile(LEARNED_EXAMPLES_FILE, store);
    return existing;
  }

  const created: BuildMealLearnedExample = {
    mealKey: input.mealKey,
    text,
    normalizedText,
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    userRefs: input.userRef ? [input.userRef] : [],
  };

  store.items.push(created);
  store.updatedAt = now;
  await writeJsonFile(LEARNED_EXAMPLES_FILE, store);
  return created;
}

export async function getBuildMealUnknownInbox(): Promise<BuildMealUnknownRecipeInbox> {
  return await readJsonFile<BuildMealUnknownRecipeInbox>(UNKNOWN_INBOX_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: [],
  });
}

function mergeCandidateLists(
  existing: BuildMealRecipeCandidate[] | undefined,
  incoming: BuildMealRecipeCandidate[] | undefined
): BuildMealRecipeCandidate[] | undefined {
  const merged = new Map<string, BuildMealRecipeCandidate>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const key = `${item.mealKey}:${item.matchedText}`;
    const current = merged.get(key);
    if (!current || item.score > current.score) {
      merged.set(key, item);
    }
  }

  const sorted = [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return sorted.length ? sorted : undefined;
}

export async function rememberUnknownBuildMealRequest(input: {
  text: string;
  normalizedText: string;
  userRef?: string | null;
  topCandidates?: BuildMealRecipeCandidate[];
}): Promise<BuildMealUnknownRecipeRecord | null> {
  const normalizedText = String(input.normalizedText || "").trim();
  const sampleText = String(input.text || "").trim();
  if (!normalizedText || !sampleText) return null;

  const inbox = await getBuildMealUnknownInbox();
  const now = new Date().toISOString();
  const existing = inbox.items.find((item) => item.normalizedText === normalizedText);

  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    if (input.userRef) {
      const refs = new Set(existing.userRefs || []);
      refs.add(input.userRef);
      existing.userRefs = [...refs];
    }
    existing.topCandidates = mergeCandidateLists(existing.topCandidates, input.topCandidates);
    inbox.updatedAt = now;
    await writeJsonFile(UNKNOWN_INBOX_FILE, inbox);
    return existing;
  }

  const created: BuildMealUnknownRecipeRecord = {
    normalizedText,
    sampleText,
    count: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    userRefs: input.userRef ? [input.userRef] : [],
    topCandidates: mergeCandidateLists(undefined, input.topCandidates),
  };

  inbox.items.push(created);
  inbox.updatedAt = now;
  await writeJsonFile(UNKNOWN_INBOX_FILE, inbox);
  return created;
}

export async function getBuildMealLearningState() {
  const [examples, inbox] = await Promise.all([
    getBuildMealLearnedExamples(),
    getBuildMealUnknownInbox(),
  ]);

  return {
    examples,
    inbox,
    summary: {
      learnedExampleCount: examples.items.length,
      unknownRecipeCount: inbox.items.length,
      topUnknownRecipes: [...inbox.items]
        .sort((left, right) => right.count - left.count)
        .slice(0, 10),
    },
  };
}
