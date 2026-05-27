import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");

function parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

async function loadEnv() {
  try {
    return parseEnv(await fs.readFile(envPath, "utf-8"));
  } catch {
    return {};
  }
}

const env = await loadEnv();
const baseUrl = (process.env.ZELO_TEST_BASE_URL || env.ZELO_TEST_BASE_URL || "http://127.0.0.1:3041").replace(/\/$/, "");
const username = process.env.ZELO_TEST_USERNAME || env.ZELO_TEST_USERNAME;
const password = process.env.ZELO_TEST_PASSWORD || env.ZELO_TEST_PASSWORD;
const userRef = process.env.ZELO_TEST_USER_REF || `discover-budget-ui-${Date.now()}`;

if (!username || !password) {
  throw new Error("Missing ZELO_TEST_USERNAME or ZELO_TEST_PASSWORD");
}

const cases = [
  { text: "quelque chose avec 100 franchs", expected: "target" },
  { text: "quelque chose mais j ai un budget de 100 fr", expected: "target" },
  { text: "une idée avec du lard pour 40 francs", expected: "target" },
  { text: "un repas avec 100 francs disponible", expected: "target" },
  { text: "je peux mettre 50 CHF pour un repas simple", expected: "target" },
  { text: "une proposition autour de 75 fr avec du poisson", expected: "target" },
  { text: "quelque chose pour max 30 francs", expected: "target" },
  { text: "j ai seulement 25 balles pour manger", expected: "target" },
  { text: "un apéro local pour 60.-", expected: "target" },
  { text: "des boissons pour 35 CHF", expected: "target" },
  { text: "des idées pas trop chères", expected: "economic" },
  { text: "un repas très cher", expected: "premium" },
  { text: "une idée premium pour ce soir", expected: "premium" },
  { text: "repas pour 4 personnes", expected: "none" },
  { text: "livraison vendredi à 18h", expected: "none" },
];

async function postJson(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    throw new Error(`${route} failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function hasEstimatedTotal(message) {
  return /total estim[eé]\s*:/i.test(String(message || ""));
}

function classifyStatus(expected, message, ok) {
  if (!ok) return "À corriger";
  const total = hasEstimatedTotal(message);
  if (expected === "target") return total ? "OK" : "À corriger";
  if (expected === "none") return total ? "À corriger" : "OK";
  return "OK";
}

await postJson("/ai/login", { userRef, username, password });

const results = [];
for (const entry of cases) {
  const data = await postJson("/ai/chat", {
    userRef,
    text: entry.text,
    frontendIntentHint: {
      actionKey: "discover_meals",
      confidence: 0.99,
      family: "meal",
      planner: "planner/discover_meals",
    },
  });

  const message = String(data.message ?? data.error ?? "");
  const result = {
    text: entry.text,
    expectedBudget: entry.expected,
    ok: data.ok === true,
    hasEstimatedTotal: hasEstimatedTotal(message),
    status: classifyStatus(entry.expected, message, data.ok === true),
    message,
  };
  results.push(result);
  console.log(`\n=== ${entry.text} ===`);
  console.log(message);
  console.log(`status=${result.status}`);
}

const summary = results.reduce(
  (acc, result) => {
    acc.total += 1;
    acc.ok += result.status === "OK" ? 1 : 0;
    return acc;
  },
  { total: 0, ok: 0 }
);

const output = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  userRef,
  summary,
  results,
};

const outputPath = path.join(root, ".cache", "discover-budget-ui-audit-results.json");
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`\n[discover-budget-ui-audit] ${summary.ok}/${summary.total} OK`);
console.log(`[discover-budget-ui-audit] wrote ${outputPath}`);

if (summary.ok !== summary.total) {
  process.exitCode = 1;
}
