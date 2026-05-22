import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import type {
  DiscoverNeedLabel,
  DiscoverNeedScore,
  DiscoverMlIntentClassifier,
  DiscoverTrainingArtifacts,
} from "./types.js";
import { DISCOVER_NEED_LABELS } from "./types.js";

function labelUniverse(training?: DiscoverTrainingArtifacts): DiscoverNeedLabel[] {
  const labels = new Set<DiscoverNeedLabel>(DISCOVER_NEED_LABELS);
  for (const label of training?.model?.intentClassifier?.labels ?? []) labels.add(label);
  for (const example of training?.queryIntents ?? []) {
    for (const label of example.labels ?? []) labels.add(label);
  }
  return [...labels];
}

const DISCOVER_QUERY_STOPWORDS = new Set([
  "chose",
  "quelque",
  "quelques",
  "idee",
  "idees",
  "propose",
  "proposes",
  "proposer",
  "suggestion",
  "suggestions",
  "donne",
  "moi",
  "quoi",
  "veux",
  "voudrais",
  "cherche",
]);

function tokenizeQuery(text: string): string[] {
  return tokenizeForMatch(text)
    .flatMap((token) => normalizeText(token).split(/\s+/))
    .filter((token) => token && !DISCOVER_QUERY_STOPWORDS.has(token));
}

function labelTokenWeights(
  training: DiscoverTrainingArtifacts,
  labels: DiscoverNeedLabel[]
): Map<DiscoverNeedLabel, Map<string, number>> {
  const perLabel = new Map<DiscoverNeedLabel, Map<string, number>>();
  const globalCounts = new Map<string, number>();

  for (const label of labels) {
    perLabel.set(label, new Map());
  }

  for (const example of training.queryIntents) {
    const tokens = tokenizeQuery(example.text);
    for (const token of new Set(tokens)) {
      globalCounts.set(token, (globalCounts.get(token) ?? 0) + 1);
      for (const label of example.labels) {
        const bucket = perLabel.get(label);
        if (!bucket) continue;
        bucket.set(token, (bucket.get(token) ?? 0) + 1);
      }
    }
  }

  for (const [label, bucket] of perLabel.entries()) {
    for (const [token, count] of bucket.entries()) {
      const global = globalCounts.get(token) ?? count;
      bucket.set(token, count / Math.sqrt(global));
    }

  }

  return perLabel;
}

function normalizeScores(
  scores: Map<DiscoverNeedLabel, number>,
  labels: DiscoverNeedLabel[]
): DiscoverNeedScore[] {
  const maxScore = Math.max(...scores.values(), 0);
  const normalized = labels
    .map((label) => ({
      label,
      score: maxScore > 0 ? (scores.get(label) ?? 0) / maxScore : 0,
    }))
    .filter((entry) => entry.score >= 0.2)
    .sort((a, b) => b.score - a.score);

  if (!normalized.length) {
    return [{ label: "discovery_open", score: 0.35 }];
  }

  const hasSpecificNeed = normalized.some(
    (entry) => entry.label !== "discovery_open" && entry.score >= 0.45
  );

  if (!hasSpecificNeed && !normalized.some((entry) => entry.label === "discovery_open")) {
    normalized.push({ label: "discovery_open", score: 0.35 });
  }

  return normalized.slice(0, 5);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function classifyWithModel(
  query: string,
  model: DiscoverMlIntentClassifier
): DiscoverNeedScore[] {
  const tokens = tokenizeQuery(query);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  const vector = new Array(model.idf.length).fill(0);
  for (const [token, count] of counts.entries()) {
    const index = model.vocabulary[token];
    if (typeof index !== "number") continue;
    vector[index] = count * (model.idf[index] ?? 1);
  }

  const scores = new Map<DiscoverNeedLabel, number>();
  for (const label of model.labels) {
    const weights = model.weights[label] ?? [];
    let raw = model.bias[label] ?? 0;
    for (let index = 0; index < vector.length; index += 1) {
      raw += (vector[index] ?? 0) * (weights[index] ?? 0);
    }
    const probability = sigmoid(raw);
    const threshold = model.thresholds[label] ?? 0.35;
    if (probability >= threshold) {
      scores.set(label, probability);
    }
  }

  return normalizeScores(scores, model.labels);
}

export function classifyDiscoverNeeds(
  query: string,
  training: DiscoverTrainingArtifacts
): DiscoverNeedScore[] {
  if (training.model?.intentClassifier) {
    return classifyWithModel(query, training.model.intentClassifier);
  }

  const tokens = tokenizeQuery(query);
  const tokenSet = new Set(tokens);
  const labels = labelUniverse(training);
  const weightsByLabel = labelTokenWeights(training, labels);
  const scores = new Map<DiscoverNeedLabel, number>();

  for (const label of labels) {
    scores.set(label, 0);
  }

  for (const [label, weights] of weightsByLabel.entries()) {
    let score = 0;
    for (const token of tokenSet) {
      score += weights.get(token) ?? 0;
    }
    scores.set(label, score);
  }

  const normalizedQuery = normalizeText(query);
  if (/idee|idees|propose|proposition|suggestion|quoi commander|quoi prendre/.test(normalizedQuery)) {
    scores.set("discovery_open", (scores.get("discovery_open") ?? 0) + 1);
  }

  return normalizeScores(scores, labels);
}

export function discoverConfidence(needs: DiscoverNeedScore[]): number {
  return Math.max(...needs.map((need) => need.score), 0);
}
