import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

type Prediction = {
  actionKey: string;
  confidence: number;
  accepted?: boolean;
  ambiguity?: boolean;
  secondChoice?: { actionKey: string };
};

type Case = {
  text: string;
  expected: string;
};

async function loadClassifier(): Promise<{ predict(text: string): Prediction }> {
  const root = process.cwd();
  const training = JSON.parse(
    await fs.readFile(path.join(root, ".cache", "intent-training.runtime.json"), "utf-8")
  );
  const source = await fs.readFile(
    path.join(root, "public", "predictor", "intent-classifier.js"),
    "utf-8"
  );
  const context: any = { window: {}, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return await context.window.ZeloIntentClassifier.create(training);
}

async function loadModelCases(): Promise<Case[]> {
  const root = process.cwd();
  const model = JSON.parse(
    await fs.readFile(path.join(root, ".cache", "intent-classifier-model.json"), "utf-8")
  );
  const holdout = Array.isArray(model.uiHoldout) ? model.uiHoldout : [];
  return holdout.map((entry: any) => ({
    text: String(entry.text || ""),
    expected: String(entry.label || ""),
  })).filter((entry: Case) => entry.text && entry.expected);
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const requiredSpotChecks: Case[] = [
  { text: "De quoi faire un repas sain", expected: "discover_meals" },
  { text: "De quoi faire un repas végétarien", expected: "discover_meals" },
  { text: "J’aimerais faire des crêpes", expected: "discover_meals" },
  { text: "Salut André, tu peux me mettre deux pains aux noix et un litre de lait pour demain ?", expected: "add_items" },
  { text: "Finalement enlève tout ce que j'ai mis dans le panier", expected: "clear_cart" },
  { text: "Salut, tu vas bien aujourd'hui ?", expected: "noop" },
];

async function main(): Promise<void> {
  const classifier = await loadClassifier();
  const cases = await loadModelCases();
  assert(cases.length >= 80, `Expected at least 80 UI holdout cases, got ${cases.length}. Run npm run train:intents -- --full.`);

  const failures: Array<{ text: string; expected: string; prediction: Prediction }> = [];
  for (const testCase of [...cases, ...requiredSpotChecks]) {
    const prediction = classifier.predict(testCase.text);
    const ok = prediction.actionKey === testCase.expected;
    if (!ok) {
      failures.push({ text: testCase.text, expected: testCase.expected, prediction });
    }
  }

  assert(
    failures.length === 0,
    "Intent classifier failures:\n" + failures.slice(0, 20).map((failure) =>
      `- "${failure.text}" expected=${failure.expected} got=${failure.prediction.actionKey} confidence=${failure.prediction.confidence} accepted=${failure.prediction.accepted}`
    ).join("\n")
  );

  console.log(`[intent-classifier.test] ${cases.length + requiredSpotChecks.length} holdout checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
