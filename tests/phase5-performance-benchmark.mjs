import fs from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const outputPath = "/private/tmp/phase5_benchmark_results.json";
const baseUrl = "http://127.0.0.1:3041";
const username = "public-contact-003@example.invalid";
const iterations = 40;

function parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseProcStat(line) {
  const close = line.lastIndexOf(")");
  const fields = line.slice(close + 2).trim().split(/\s+/);
  return Number(fields[11] || 0) + Number(fields[12] || 0);
}

function appSnapshot() {
  const output = run("docker", [
    "exec",
    "zelo_ai",
    "sh",
    "-lc",
    [
      "cat /proc/1/stat",
      "cat /proc/18/stat",
      "cat /proc/30/stat",
      "cat /sys/fs/cgroup/memory.current",
      "cat /sys/class/net/eth0/statistics/rx_bytes",
      "cat /sys/class/net/eth0/statistics/tx_bytes",
    ].join("; "),
  ]);
  const lines = output.trim().split(/\r?\n/);
  return {
    cpuTicks: lines.slice(0, 3).reduce((sum, line) => sum + parseProcStat(line), 0),
    memoryBytes: Number(lines[3] || 0),
    rxBytes: Number(lines[4] || 0),
    txBytes: Number(lines[5] || 0),
  };
}

function parseCpuTime(value) {
  const parts = value.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0] || 0);
}

function ollamaProcessSnapshot() {
  const output = run("ps", ["-axo", "pid=,time=,rss=,%cpu=,command="]);
  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    const command = match[5];
    if (
      !command.includes("/ollama") ||
      (!/\bollama serve\b/.test(command) && !/\bollama runner\b/.test(command))
    ) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      cpuSeconds: parseCpuTime(match[2]),
      rssBytes: Number(match[3]) * 1024,
      role: /\bollama runner\b/.test(command) ? "runner" : "serve",
    });
  }
  return {
    cpuSeconds: processes.reduce((sum, item) => sum + item.cpuSeconds, 0),
    rssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
    processes,
  };
}

async function ollamaState() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/ps");
    if (!response.ok) return [];
    const body = await response.json();
    return (Array.isArray(body.models) ? body.models : []).map((model) => ({
      name: model.name,
      size: model.size,
      sizeVram: model.size_vram,
      expiresAt: model.expires_at,
    }));
  } catch {
    return [];
  }
}

function countOllamaChats() {
  try {
    const log = fs.readFileSync("/opt/homebrew/var/log/ollama.log", "utf8");
    return (log.match(/POST\s+"\/api\/chat"/g) || []).length;
  } catch {
    return null;
  }
}

function percentile(sorted, probability) {
  if (!sorted.length) return null;
  const rank = Math.ceil(probability * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function aggregate(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    n: values.length,
    meanMs: values.length ? sum / values.length : null,
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    minMs: values[0] ?? null,
    maxMs: values.at(-1) ?? null,
  };
}

const training = JSON.parse(
  fs.readFileSync(`${root}/.cache/intent-training.runtime.json`, "utf8")
);
const classifierSource = fs.readFileSync(
  `${root}/public/predictor/intent-classifier.js`,
  "utf8"
);
const classifierContext = { window: {}, console };
vm.createContext(classifierContext);
vm.runInContext(classifierSource, classifierContext);
const classifier = await classifierContext.window.ZeloIntentClassifier.create(training);

function intentHint(text) {
  const prediction = classifier.predict(text);
  const acceptedHint =
    prediction?.actionKey &&
    !(prediction.accepted === false && prediction.actionKey === "noop");
  return {
    prediction: {
      actionKey: prediction?.actionKey || null,
      confidence: Number(prediction?.confidence || 0),
      accepted: prediction?.accepted !== false,
    },
    hint: acceptedHint
      ? {
          actionKey: prediction.actionKey,
          confidence: Number(prediction.confidence || 0),
          family: prediction.family || "general",
          planner: prediction.planner || "planner/general",
        }
      : null,
  };
}

const scenarios = [
  {
    id: "hello",
    text: "hello",
    expectedOllamaCalls: 1,
    validate(body) {
      return body?.ok === true && /tu peux me demander|je suis là/i.test(String(body?.message || ""));
    },
  },
  {
    id: "add_cart_without_options",
    text: "ajoute 1 Pain Saint-Abbondio",
    expectedOllamaCalls: 0,
    validate(body) {
      const message = String(body?.message || "");
      return (
        body?.ok === true &&
        /Pain Saint-Abbondio/i.test(message) &&
        /ajout/i.test(message) &&
        /panier/i.test(message)
      );
    },
  },
  // L'ordre add_cart -> clear_all est volontaire : chaque itération remet le
  // panier dans son état vide avant les autres scénarios.
  {
    id: "clear_all",
    text: "vide tout",
    expectedOllamaCalls: 1,
    validate(body) {
      return body?.ok === true && /vid[ée]|aucun produit/i.test(String(body?.message || ""));
    },
  },
  {
    id: "discover_evening",
    text: "propose moi quelque chose pour ce soir",
    expectedOllamaCalls: 1,
    validate(body) {
      const proposals = Array.isArray(body?.discover?.proposals) ? body.discover.proposals : [];
      return body?.ok === true && (proposals.length > 0 || /proposer|idée|repas/i.test(String(body?.message || "")));
    },
  },
  {
    id: "recurring_list",
    text: "mes commandes recurrantes",
    expectedOllamaCalls: 0,
    validate(body) {
      const message = String(body?.message || "");
      return body?.ok === true && /commandes récurrentes/i.test(message) && /Samuel3/i.test(message);
    },
  },
  {
    id: "recurring_prepare_add_without_options",
    // Ce produit sans options permet de mesurer le flux récurrent actuel sans
    // masquer la limite distincte des produits à options (p. ex. Pain Balance).
    // Cette limite appartient uniquement au flux récurrent; add_cart reste inchangé.
    text: "ajoute 1 Pain Saint-Abbondio a ma commande recurrante Samuel3",
    cleanupText: "annule",
    expectedOllamaCalls: 0,
    validate(body) {
      const message = String(body?.message || "");
      return (
        body?.ok === true &&
        /Je prépare la modification/i.test(message) &&
        /Ajout/i.test(message) &&
        /Pain Saint-Abbondio/i.test(message)
      );
    },
    validateCleanup(body) {
      return (
        body?.ok === true &&
        /je n.ai pas modifié ta commande récurrente/i.test(String(body?.message || ""))
      );
    },
  },
];

const env = parseEnv(fs.readFileSync(`${root}/.env`, "utf8"));
const password = env.ZELO_TEST_PASSWORD;
if (!password) throw new Error("ZELO_TEST_PASSWORD non trovato nel .env");

let cookie = "";
async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  return { status: response.status, body };
}

async function postJson(path, body) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const login = await postJson("/ai/login", { username, password });
if (login.status !== 200 || login.body?.ok !== true) {
  throw new Error("Login locale non riuscito");
}

async function chatWithIntent(text) {
  const intent = intentHint(text);
  const response = await postJson("/ai/chat", {
    text,
    ...(intent.hint ? { frontendIntentHint: intent.hint } : {}),
  });
  return { intent, response };
}

const recurringBaseline = await chatWithIntent("mes commandes recurrantes");
const recurringBaselineMessage = String(recurringBaseline.response.body?.message || "");
if (
  recurringBaseline.response.status !== 200 ||
  recurringBaseline.response.body?.ok !== true ||
  !/Samuel3/i.test(recurringBaselineMessage)
) {
  throw new Error("Précontrôle de la commande récurrente Samuel3 non concluant");
}

const metadata = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  channel: "web_api_with_ui_basket_refresh",
  iterations,
  orderPolicy: "fixed_add_then_clear",
  scenarios: scenarios.map(({ id, text, cleanupText, expectedOllamaCalls }) => ({
    id,
    text,
    cleanupText: cleanupText || null,
    expectedOllamaCalls,
  })),
  requestedSamples: iterations * scenarios.length,
  ollamaAtStart: await ollamaState(),
  ollamaChatCountAtStart: countOllamaChats(),
};

const appBefore = appSnapshot();
const ollamaBefore = ollamaProcessSnapshot();
const rows = [];

console.log(JSON.stringify({
  event: "benchmark_start",
  requestedSamples: metadata.requestedSamples,
  ollamaLoaded: metadata.ollamaAtStart.length > 0,
}));

for (let iteration = 0; iteration < iterations; iteration += 1) {
  for (const scenario of scenarios) {
    const intent = intentHint(scenario.text);
    const chatStartedAt = performance.now();
    let chat;
    let chatMs;
    let basket;
    let basketMs;
    let cleanup;
    let cleanupMs = 0;
    let transportError = null;
    let cleanupError = null;

    try {
      chat = await postJson("/ai/chat", {
        text: scenario.text,
        ...(intent.hint ? { frontendIntentHint: intent.hint } : {}),
      });
      chatMs = performance.now() - chatStartedAt;
      const basketStartedAt = performance.now();
      basket = await request("/ai/basket");
      basketMs = performance.now() - basketStartedAt;
    } catch (error) {
      transportError = error instanceof Error ? error.message : String(error);
      if (!Number.isFinite(chatMs)) chatMs = performance.now() - chatStartedAt;
      basketMs = Number.isFinite(basketMs) ? basketMs : 0;
    } finally {
      if (scenario.cleanupText) {
        const cleanupIntent = intentHint(scenario.cleanupText);
        const cleanupStartedAt = performance.now();
        try {
          cleanup = await postJson("/ai/chat", {
            text: scenario.cleanupText,
            ...(cleanupIntent.hint ? { frontendIntentHint: cleanupIntent.hint } : {}),
          });
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        } finally {
          cleanupMs = performance.now() - cleanupStartedAt;
        }
      }
    }

    const cleanupOk =
      !scenario.cleanupText ||
      (!cleanupError &&
        cleanup?.status === 200 &&
        (typeof scenario.validateCleanup !== "function" ||
          scenario.validateCleanup(cleanup?.body)));
    const functionalOk =
      !transportError &&
      chat?.status === 200 &&
      basket?.status === 200 &&
      scenario.validate(chat?.body) &&
      cleanupOk;

    rows.push({
      iteration: iteration + 1,
      scenario: scenario.id,
      text: scenario.text,
      prediction: intent.prediction,
      chatStatus: chat?.status ?? null,
      basketStatus: basket?.status ?? null,
      cleanupStatus: cleanup?.status ?? null,
      transportError,
      cleanupError,
      functionalOk,
      chatMs,
      basketRefreshMs: basketMs,
      cleanupMs,
      e2eMs: chatMs + basketMs,
      responseLength: String(chat?.body?.message || "").length,
    });

    if (!cleanupOk) {
      throw new Error(
        `Nettoyage du scénario ${scenario.id} non confirmé; benchmark interrompu pour éviter de contaminer la session`
      );
    }
  }

  if ((iteration + 1) % 5 === 0 || iteration + 1 === iterations) {
    console.log(JSON.stringify({
      event: "progress",
      iterationsCompleted: iteration + 1,
      samplesCompleted: rows.length,
      functionalFailures: rows.filter((row) => !row.functionalOk).length,
    }));
  }
}

const appAfter = appSnapshot();
const ollamaAfter = ollamaProcessSnapshot();
const ollamaChatCountAtEnd = countOllamaChats();

const recurringPostcheck = await chatWithIntent("mes commandes recurrantes");
const recurringPostcheckMessage = String(recurringPostcheck.response.body?.message || "");
const recurringStateUnchanged =
  recurringPostcheck.response.status === 200 &&
  recurringPostcheck.response.body?.ok === true &&
  recurringPostcheckMessage === recurringBaselineMessage;
if (!recurringStateUnchanged) {
  throw new Error(
    "Le post-contrôle diffère de l’état récurrent initial; résultat non publié"
  );
}

const aggregates = {};
for (const scenario of scenarios) {
  const scenarioRows = rows.filter((row) => row.scenario === scenario.id);
  aggregates[scenario.id] = {
    chat: aggregate(scenarioRows, "chatMs"),
    basketRefresh: aggregate(scenarioRows, "basketRefreshMs"),
    endToEnd: aggregate(scenarioRows, "e2eMs"),
    functionalFailures: scenarioRows.filter((row) => !row.functionalOk).length,
    errorRate: scenarioRows.length
      ? scenarioRows.filter((row) => !row.functionalOk).length / scenarioRows.length
      : null,
    expectedOllamaCallsPerRequest: scenario.expectedOllamaCalls,
  };
}

const result = {
  metadata: {
    ...metadata,
    completedAt: new Date().toISOString(),
    completedSamples: rows.length,
    ollamaAtEnd: await ollamaState(),
    ollamaChatCountAtEnd,
    observedOllamaChatCalls:
      metadata.ollamaChatCountAtStart == null || ollamaChatCountAtEnd == null
        ? null
        : ollamaChatCountAtEnd - metadata.ollamaChatCountAtStart,
    auxiliaryCleanupChatRequests: rows.filter((row) => row.cleanupStatus != null).length,
    recurringStateUnchanged,
  },
  resources: {
    appCpuSeconds: Math.max(0, appAfter.cpuTicks - appBefore.cpuTicks) / 100,
    appMemoryStartBytes: appBefore.memoryBytes,
    appMemoryEndBytes: appAfter.memoryBytes,
    appRxBytes: Math.max(0, appAfter.rxBytes - appBefore.rxBytes),
    appTxBytes: Math.max(0, appAfter.txBytes - appBefore.txBytes),
    ollamaCpuSeconds: Math.max(0, ollamaAfter.cpuSeconds - ollamaBefore.cpuSeconds),
    ollamaRssStartBytes: ollamaBefore.rssBytes,
    ollamaRssEndBytes: ollamaAfter.rssBytes,
  },
  aggregates,
  overall: {
    chat: aggregate(rows, "chatMs"),
    basketRefresh: aggregate(rows, "basketRefreshMs"),
    endToEnd: aggregate(rows, "e2eMs"),
    functionalFailures: rows.filter((row) => !row.functionalOk).length,
    errorRate: rows.length ? rows.filter((row) => !row.functionalOk).length / rows.length : null,
  },
  rows,
};

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  event: "benchmark_complete",
  outputPath,
  completedSamples: rows.length,
  functionalFailures: result.overall.functionalFailures,
  observedOllamaChatCalls: result.metadata.observedOllamaChatCalls,
  overallEndToEnd: result.overall.endToEnd,
  resources: result.resources,
}));
