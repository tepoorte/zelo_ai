import path from "node:path";
import { readJsonFile, writeJsonFile } from "../../utils/json-file.js";
import type {
  BuildMealLearnedExample,
  BuildMealLearnedExamplesStore,
  BuildMealRejectedExample,
  BuildMealRejectedExamplesStore,
  BuildMealRecipeCandidate,
  BuildMealUnknownRecipeInbox,
  BuildMealUnknownRecipeRecord,
} from "./types.js";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const LEARNED_EXAMPLES_FILE = path.join(CACHE_DIR, "build-meal-recipe-examples.json");
const REJECTED_EXAMPLES_FILE = path.join(CACHE_DIR, "build-meal-recipe-rejections.json");
const UNKNOWN_INBOX_FILE = path.join(CACHE_DIR, "build-meal-learning-inbox.json");

export async function getBuildMealLearnedExamples(): Promise<BuildMealLearnedExamplesStore> {
  return await readJsonFile<BuildMealLearnedExamplesStore>(LEARNED_EXAMPLES_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: [],
  });
}

export async function getBuildMealRejectedExamples(): Promise<BuildMealRejectedExamplesStore> {
  return await readJsonFile<BuildMealRejectedExamplesStore>(REJECTED_EXAMPLES_FILE, {
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
  source?: BuildMealLearnedExample["source"];
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
    existing.status = "verified";
    existing.source = input.source || existing.source || "explicit";
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
    status: "verified",
    source: input.source || "explicit",
  };

  store.items.push(created);
  store.updatedAt = now;
  await writeJsonFile(LEARNED_EXAMPLES_FILE, store);
  return created;
}

export async function rememberBuildMealRejectedExample(input: {
  mealKey: string;
  text: string;
  normalizedText: string;
  userRef?: string | null;
  reason?: string;
}): Promise<BuildMealRejectedExample | null> {
  const mealKey = String(input.mealKey || "").trim();
  const normalizedText = String(input.normalizedText || "").trim();
  const text = String(input.text || "").trim();
  if (!mealKey || !normalizedText || !text) return null;

  const now = new Date().toISOString();
  const [rejectedStore, learnedStore] = await Promise.all([
    getBuildMealRejectedExamples(),
    getBuildMealLearnedExamples(),
  ]);

  const existingRejected = rejectedStore.items.find(
    (item) => item.mealKey === mealKey && item.normalizedText === normalizedText
  );

  if (existingRejected) {
    existingRejected.count += 1;
    existingRejected.lastSeenAt = now;
    existingRejected.reason = input.reason || existingRejected.reason;
    if (input.userRef) {
      const refs = new Set(existingRejected.userRefs || []);
      refs.add(input.userRef);
      existingRejected.userRefs = [...refs];
    }
  } else {
    rejectedStore.items.push({
      mealKey,
      text,
      normalizedText,
      reason: input.reason,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      userRefs: input.userRef ? [input.userRef] : [],
    });
  }

  for (const item of learnedStore.items) {
    if (item.mealKey === mealKey && item.normalizedText === normalizedText) {
      item.status = "rejected";
      item.lastSeenAt = now;
    }
  }

  rejectedStore.updatedAt = now;
  learnedStore.updatedAt = now;
  await Promise.all([
    writeJsonFile(REJECTED_EXAMPLES_FILE, rejectedStore),
    writeJsonFile(LEARNED_EXAMPLES_FILE, learnedStore),
  ]);

  return (
    rejectedStore.items.find(
      (item) => item.mealKey === mealKey && item.normalizedText === normalizedText
    ) || null
  );
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
  const [examples, rejectedExamples, inbox] = await Promise.all([
    getBuildMealLearnedExamples(),
    getBuildMealRejectedExamples(),
    getBuildMealUnknownInbox(),
  ]);

  return {
    examples,
    rejectedExamples,
    inbox,
    summary: {
      learnedExampleCount: examples.items.length,
      rejectedExampleCount: rejectedExamples.items.length,
      unknownRecipeCount: inbox.items.length,
      topUnknownRecipes: [...inbox.items]
        .sort((left, right) => right.count - left.count)
        .slice(0, 10),
    },
  };
}
