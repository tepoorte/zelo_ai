import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const training = JSON.parse(
  await fs.readFile(path.join(root, ".cache", "intent-training.runtime.json"), "utf-8")
);
const model = JSON.parse(
  await fs.readFile(path.join(root, ".cache", "intent-classifier-model.json"), "utf-8")
);
const source = await fs.readFile(
  path.join(root, "public", "predictor", "intent-classifier.js"),
  "utf-8"
);

const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(source, context);
const classifier = await context.window.ZeloIntentClassifier.create(training);

const cases = Array.isArray(model.uiHoldout) ? model.uiHoldout : [];
const results = cases.map((entry) => {
  const prediction = classifier.predict(entry.text);
  const expected = String(entry.label || "");
  const detected = prediction.actionKey;
  const ok = detected === expected;
  return {
    text: entry.text,
    expected,
    detected,
    confidence: prediction.confidence,
    accepted: prediction.accepted !== false,
    ambiguity: Boolean(prediction.ambiguity),
    secondChoice: prediction.secondChoice?.actionKey || null,
    status: ok ? "OK" : "À corriger",
  };
});

const summary = results.reduce((acc, row) => {
  acc.total += 1;
  acc.ok += row.status === "OK" ? 1 : 0;
  acc.byExpected[row.expected] = acc.byExpected[row.expected] || { total: 0, ok: 0 };
  acc.byExpected[row.expected].total += 1;
  acc.byExpected[row.expected].ok += row.status === "OK" ? 1 : 0;
  return acc;
}, { total: 0, ok: 0, byExpected: {} });

const output = {
  generatedAt: new Date().toISOString(),
  summary,
  results,
};

const outputPath = path.join(root, ".cache", "intent-ui-audit-results.json");
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");
console.log(`[intent-ui-audit] ${summary.ok}/${summary.total} OK`);
console.log(`[intent-ui-audit] wrote ${outputPath}`);

if (summary.ok !== summary.total) {
  console.log("[intent-ui-audit] first failures:");
  for (const row of results.filter((entry) => entry.status !== "OK").slice(0, 20)) {
    console.log(`- "${row.text}" expected=${row.expected} got=${row.detected} confidence=${row.confidence} accepted=${row.accepted}`);
  }
  process.exit(1);
}
