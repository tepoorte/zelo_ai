import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import type { FrontendIntentHint } from "./planner-types.js";

type ServerIntentPrediction = {
  actionKey?: string;
  confidence?: number;
  family?: string;
  planner?: string;
  accepted?: boolean;
};

type ServerIntentClassifier = {
  predict(text: string): ServerIntentPrediction;
};

type ZeloIntentClassifierFactory = {
  create(source: unknown): Promise<ServerIntentClassifier>;
};

let classifierPromise: Promise<ServerIntentClassifier | null> | null = null;

async function loadServerIntentClassifier(): Promise<ServerIntentClassifier | null> {
  if (classifierPromise) {
    return classifierPromise;
  }

  classifierPromise = (async () => {
    try {
      const root = process.cwd();
      const [trainingRaw, predictorSource] = await Promise.all([
        fs.readFile(path.join(root, ".cache", "intent-training.runtime.json"), "utf-8"),
        fs.readFile(path.join(root, "public", "predictor", "intent-classifier.js"), "utf-8"),
      ]);

      const context: { window: Record<string, unknown>; console: Console } = {
        window: {},
        console,
      };
      vm.createContext(context);
      vm.runInContext(predictorSource, context, {
        filename: "public/predictor/intent-classifier.js",
      });

      const factory = context.window.ZeloIntentClassifier as
        | ZeloIntentClassifierFactory
        | undefined;
      if (!factory?.create) {
        return null;
      }

      return await factory.create(JSON.parse(trainingRaw));
    } catch (error) {
      console.warn("[intent-hint] server predictor unavailable", error);
      return null;
    }
  })();

  return classifierPromise;
}

export async function buildServerFrontendIntentHint(
  text: string
): Promise<FrontendIntentHint | undefined> {
  const classifier = await loadServerIntentClassifier();
  if (!classifier) {
    return undefined;
  }

  const prediction = classifier.predict(String(text || ""));
  if (!prediction?.actionKey) {
    return undefined;
  }

  if (prediction.accepted === false && prediction.actionKey === "noop") {
    return undefined;
  }

  return {
    actionKey: prediction.actionKey as FrontendIntentHint["actionKey"],
    confidence: Number(prediction.confidence || 0),
    family: prediction.family || "general",
    planner: prediction.planner || "planner/general",
  };
}

export function resetServerIntentHintCacheForTests(): void {
  classifierPromise = null;
}
