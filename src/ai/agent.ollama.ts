// src/ai/agent.ollama.ts
import { env } from "../config/env.js";
import { systemPrompt } from "./prompts.js";

import { searchProducts } from "../swissdata/products.js";
import { addToCart, getCart } from "../swissdata/cart.js";

type PlannedAction =
  | { type: "search_products"; query: string; limit?: number }
  | { type: "add_to_cart"; userRef: string; items: Array<{ productId: string; qty: number }> }
  | { type: "get_cart"; userRef: string }
  | { type: "noop"; reason?: string };

type Plan = {
  intent: string;
  actions: PlannedAction[];
  userFacingDraft?: string;
};

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";

/**
 * Chiamata generica a Ollama chat API
 */
async function ollamaChat(messages: any[], temperature = 0.2): Promise<string> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: { temperature },
    }),
  });

  const data = await resp.json();
  return data?.message?.content ?? "";
}

function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Prompt planner: deve produrre SOLO JSON
 */
function plannerPrompt() {
  return `
Sei l'AI di Zelo. Devi trasformare il messaggio utente in un "PLAN" JSON.

Regole:
- Rispondi SOLO con JSON valido (niente markdown).
- Struttura: {"intent": "...", "actions": [ ... ]}

actions ammessi:
1) {"type":"search_products","query":"...","limit":5}
2) {"type":"add_to_cart","userRef":"...","items":[{"productId":"...","qty":2}]}
3) {"type":"get_cart","userRef":"..."}
4) {"type":"noop","reason":"..."}

Se l'utente chiede una ricetta (es. "caesar per 2"):
- identifica gli ingredienti
- fai search_products per ogni ingrediente
- poi add_to_cart con quantità plausibili.

Se non sei sicuro → usa noop.
`;
}

export async function runAgentOllama(
  userRef: string,
  userText: string
): Promise<{ message: string }> {

  /**
   * STEP 1 — PLAN
   */
  const planText = await ollamaChat(
    [
      { role: "system", content: plannerPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
    ],
    0.2
  );

  const plan = safeJsonParse<Plan>(planText);

  if (!plan || !Array.isArray(plan.actions)) {
    return {
      message:
        "Non sono riuscito a capire bene. Prova con: “voglio una caesar per 2 persone” oppure “aggiungi parmigiano al carrello”.",
    };
  }

  /**
   * STEP 2 — EXECUTE TOOLS
   */
  const toolResults: any[] = [];

  for (const action of plan.actions) {
    if (action.type === "search_products") {
      const r = await searchProducts(action.query, action.limit ?? 5);
      toolResults.push({ action, result: r });
      continue;
    }

    if (action.type === "add_to_cart") {
      const r = await addToCart({
        userRef: action.userRef ?? userRef,
        items: action.items,
      });
      toolResults.push({ action, result: r });
      continue;
    }

    if (action.type === "get_cart") {
      const r = await getCart(action.userRef ?? userRef);
      toolResults.push({ action, result: r });
      continue;
    }

    toolResults.push({ action, result: { ok: true } });
  }

  /**
   * STEP 3 — FINAL MESSAGE
   */
  const message = await ollamaChat(
    [
      { role: "system", content: systemPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
      { role: "assistant", content: `PLAN: ${JSON.stringify(plan)}` },
      { role: "assistant", content: `TOOL_RESULTS: ${JSON.stringify(toolResults)}` },
      {
        role: "user",
        content:
          "Scrivi la risposta finale per l'utente: conferma cosa hai capito e cosa hai aggiunto al carrello o cosa manca.",
      },
    ],
    0.4
  );

  return { message: message || "Ok." };
}