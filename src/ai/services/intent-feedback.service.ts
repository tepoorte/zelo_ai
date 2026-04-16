import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type IntentKey =
  | "add_items"
  | "clear_cart"
  | "show_cart"
  | "exec_cart"
  | "build_meal"
  | "discover_meals"
  | "noop";

type FeedbackKind = "positive" | "correction";

type IntentTraining = {
  version?: number;
  fallbackIntent?: IntentKey;
  common?: {
    stopwords?: string[];
  };
  intents?: Array<{
    key: IntentKey;
    family?: string;
    label?: string;
    planner?: string;
    reason?: string;
    canonical?: Record<string, unknown>;
    examples?: string[];
  }>;
  feedback?: {
    overrides?: Record<string, IntentKey>;
    reinforced?: Record<string, Array<{ text: string; normalized: string; count: number }>>;
  };
  updatedAt?: string;
};

type LedgerEvent = {
  id: string;
  kind: FeedbackKind;
  text: string;
  normalizedText: string;
  predictedAction: IntentKey;
  correctAction: IntentKey;
  createdAt: string;
  userRef?: string | null;
};

type LedgerFile = {
  version: number;
  updatedAt: string;
  events: LedgerEvent[];
};

type RecordIntentFeedbackInput = {
  text: string;
  predictedAction: IntentKey;
  correctAction?: IntentKey;
  kind?: FeedbackKind;
  userRef?: string;
};

const CACHE_DIR = path.join(process.cwd(), ".cache");
const PUBLIC_DIR = path.join(process.cwd(), "public", "predictor");
const SEED_FILE = path.join(PUBLIC_DIR, "intent-training.json");
const LEDGER_FILE = path.join(CACHE_DIR, "intent-feedback-ledger.json");
const RUNTIME_FILE = path.join(CACHE_DIR, "intent-training.runtime.json");

function normalizeText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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

async function loadSeedTraining(): Promise<IntentTraining> {
  const training = await readJsonFile<IntentTraining | null>(SEED_FILE, null);
  if (!training?.intents?.length) {
    throw new Error("Intent seed training introuvable ou invalide.");
  }
  return training;
}

async function loadLedger(): Promise<LedgerFile> {
  return await readJsonFile<LedgerFile>(LEDGER_FILE, {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    events: []
  });
}

function getAllowedIntentKeys(training: IntentTraining): Set<string> {
  return new Set((training.intents || []).map((intent) => intent.key));
}

function hasExample(intent: NonNullable<IntentTraining["intents"]>[number], normalized: string): boolean {
  const examples = Array.isArray(intent.examples) ? intent.examples : [];
  return examples.some((example) => normalizeText(example) === normalized);
}

function aggregateFeedback(ledger: LedgerFile): IntentTraining["feedback"] {
  const reinforced: Record<string, Array<{ text: string; normalized: string; count: number }>> = {};
  const byText: Record<string, { text: string; votes: Record<string, number> }> = {};

  for (const event of ledger.events) {
    const intentKey = event.correctAction;
    const weight = event.kind === "positive" ? 1 : 2;

    if (!reinforced[intentKey]) {
      reinforced[intentKey] = [];
    }

    const bucket = reinforced[intentKey];
    const existing = bucket.find((entry) => entry.normalized === event.normalizedText);
    if (existing) {
      existing.count = Math.min(existing.count + weight, 8);
      existing.text = event.text;
    } else {
      bucket.push({
        text: event.text,
        normalized: event.normalizedText,
        count: weight
      });
    }

    if (!byText[event.normalizedText]) {
      byText[event.normalizedText] = {
        text: event.text,
        votes: {}
      };
    }

    byText[event.normalizedText].votes[intentKey] = (byText[event.normalizedText].votes[intentKey] || 0) + weight;
    byText[event.normalizedText].text = event.text;
  }

  const overrides: Record<string, IntentKey> = {};

  for (const [normalized, entry] of Object.entries(byText)) {
    const ranking = Object.entries(entry.votes).sort((left, right) => right[1] - left[1]);
    const best = ranking[0];
    const second = ranking[1];
    if (!best) continue;

    const bestScore = best[1];
    const secondScore = second?.[1] || 0;

    if (bestScore >= 3 && bestScore >= secondScore + 2) {
      overrides[normalized] = best[0] as IntentKey;
    }
  }

  return {
    overrides,
    reinforced
  };
}

function mergeTraining(baseTraining: IntentTraining, feedback: IntentTraining["feedback"]): IntentTraining {
  const merged = deepClone(baseTraining);
  merged.feedback = feedback;
  merged.updatedAt = new Date().toISOString();

  const intents = Array.isArray(merged.intents) ? merged.intents : [];
  intents.forEach((intent) => {
    if (!Array.isArray(intent.examples)) {
      intent.examples = [];
    }

    const additions = feedback?.reinforced?.[intent.key] || [];
    additions.forEach((entry) => {
      if (!hasExample(intent, entry.normalized)) {
        intent.examples!.push(entry.text);
      }
    });
  });

  return merged;
}

export async function getIntentTrainingRuntime(): Promise<IntentTraining> {
  const cached = await readJsonFile<IntentTraining | null>(RUNTIME_FILE, null);
  if (cached?.intents?.length) {
    return cached;
  }

  return await rebuildIntentTrainingRuntime();
}

export async function rebuildIntentTrainingRuntime(): Promise<IntentTraining> {
  const baseTraining = await loadSeedTraining();
  const ledger = await loadLedger();
  const feedback = aggregateFeedback(ledger);
  const runtime = mergeTraining(baseTraining, feedback);
  await writeJsonFile(RUNTIME_FILE, runtime);
  return runtime;
}

export async function recordIntentFeedback(input: RecordIntentFeedbackInput): Promise<{
  event: LedgerEvent;
  training: IntentTraining;
}> {
  const baseTraining = await loadSeedTraining();
  const allowedKeys = getAllowedIntentKeys(baseTraining);

  const text = String(input.text || "").trim();
  const normalizedText = normalizeText(text);
  const predictedAction = String(input.predictedAction || "") as IntentKey;
  const kind = (input.kind || "correction") as FeedbackKind;
  const correctAction = (input.correctAction || predictedAction) as IntentKey;

  if (!text || !normalizedText) {
    throw new Error("Missing text");
  }

  if (!allowedKeys.has(predictedAction) || !allowedKeys.has(correctAction)) {
    throw new Error("Invalid action key");
  }

  if (kind !== "positive" && kind !== "correction") {
    throw new Error("Invalid feedback kind");
  }

  const ledger = await loadLedger();
  const event: LedgerEvent = {
    id: randomUUID(),
    kind,
    text,
    normalizedText,
    predictedAction,
    correctAction,
    createdAt: new Date().toISOString(),
    userRef: input.userRef || null
  };

  ledger.events.push(event);
  ledger.updatedAt = event.createdAt;
  await writeJsonFile(LEDGER_FILE, ledger);

  const training = await rebuildIntentTrainingRuntime();
  return { event, training };
}
