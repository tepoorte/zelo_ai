import { performance } from "node:perf_hooks";
import { planUserIntent } from "../src/ai/services/planner.service.js";

const args = process.argv.slice(2);
const userRef =
  args[0] && args[0].trim().length > 0
    ? args[0].trim()
    : `remote-smoke-${Date.now()}`;
const userMessage =
  args.slice(1).join(" ").trim() || "Ajoute 1 lard de Begnins à mon panier";

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "(not set)";
const plannerModel = process.env.OLLAMA_PLANNER_MODEL ?? "(default)";
const defaultModel = process.env.OLLAMA_MODEL ?? "(default)";

console.log(
  JSON.stringify(
    {
      phase: "start",
      ollamaBaseUrl,
      plannerModel,
      defaultModel,
      userRef,
      userMessage,
      startedAt: new Date().toISOString(),
    },
    null,
    2
  )
);

const startedAt = performance.now();
const plan = await planUserIntent(userRef, userMessage);
const elapsedMs = Math.round(performance.now() - startedAt);

console.log(
  JSON.stringify(
    {
      phase: "done",
      elapsedMs,
      plan,
      finishedAt: new Date().toISOString(),
    },
    null,
    2
  )
);
