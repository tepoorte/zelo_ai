import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_DISCOVER_PRODUCT_ROLES,
  DEFAULT_DISCOVER_QUERY_INTENTS,
  DEFAULT_DISCOVER_RANKING_EXAMPLES,
} from "./training-defaults.js";
import type {
  DiscoverIntentExample,
  DiscoverProductRoleExample,
  DiscoverRankingExample,
  DiscoverTrainingArtifacts,
} from "./types.js";

const TRAINING_DIR = path.join(process.cwd(), "ml", "discover-meals");
const TRAINING_ARTIFACT_PATH = path.join(process.cwd(), ".cache", "discover-meals-model.json");

let cachedArtifacts: DiscoverTrainingArtifacts | null = null;

async function readJsonl<T>(fileName: string): Promise<T[]> {
  const filePath = path.join(TRAINING_DIR, fileName);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("#"))
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function readTrainingArtifact(): Promise<Partial<DiscoverTrainingArtifacts> | null> {
  try {
    const raw = await fs.readFile(TRAINING_ARTIFACT_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DiscoverTrainingArtifacts>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }

  return output;
}

export async function loadDiscoverTrainingArtifacts(): Promise<DiscoverTrainingArtifacts> {
  if (cachedArtifacts) return cachedArtifacts;

  const artifact = await readTrainingArtifact();

  const [queryIntents, productRoles, proposalRankingExamples, rankingExamples] = await Promise.all([
    readJsonl<DiscoverIntentExample>("query_intents.jsonl"),
    readJsonl<DiscoverProductRoleExample>("product_roles.jsonl"),
    readJsonl<DiscoverRankingExample>("proposal_ranking.jsonl"),
    readJsonl<DiscoverRankingExample>("ranking_examples.jsonl"),
  ]);

  cachedArtifacts = {
    queryIntents: uniqueBy(
      [...DEFAULT_DISCOVER_QUERY_INTENTS, ...(artifact?.queryIntents ?? []), ...queryIntents],
      (item) => `${item.text}|${item.labels.join(",")}`
    ),
    productRoles: uniqueBy(
      [...DEFAULT_DISCOVER_PRODUCT_ROLES, ...(artifact?.productRoles ?? []), ...productRoles],
      (item) => `${item.productId ?? ""}|${item.name ?? ""}|${item.roles.join(",")}`
    ),
    rankingExamples: uniqueBy(
      [
        ...DEFAULT_DISCOVER_RANKING_EXAMPLES,
        ...(artifact?.rankingExamples ?? []),
        ...proposalRankingExamples,
        ...rankingExamples,
      ],
      (item) => `${item.query}|${item.acceptedRoles?.join(",") ?? ""}`
    ),
    model: artifact?.model,
  };

  return cachedArtifacts;
}

export function clearDiscoverTrainingArtifactCache(): void {
  cachedArtifacts = null;
}
