// src/ai/agent.ollama.ts
import { env } from "../config/env.js";
import { systemPrompt } from "./prompts.js";

import { searchProducts } from "../swissdata/products.js";
import { getCurrentBasket, addProductToBasket } from "../swissdata/cart.js";

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
    headers: { "content-type": "application/json" },
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
    // fallback: estrai il primo blocco JSON tipo {...}
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybe = s.slice(start, end + 1);
      try {
        return JSON.parse(maybe) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Prompt planner: deve produrre SOLO JSON
 */
function plannerPrompt() {
  return `
Sei l'AI di Zelo. Devi trasformare il messaggio utente in un "PLAN" JSON.

REGOLE DI OUTPUT (OBBLIGATORIE):
- Rispondi SOLO con JSON valido.
- Niente markdown, niente commenti, niente testo fuori dal JSON.
- Deve iniziare con "{" e finire con "}".

Struttura:
{"intent":"...","actions":[ ... ]}

actions ammessi:
1) {"type":"search_products","query":"...","limit":5}
2) {"type":"add_to_cart","userRef":"...","items":[{"productId":"...","qty":2}]}
3) {"type":"get_cart","userRef":"..."}
4) {"type":"noop","reason":"..."}

INTENTI:
- Se l'utente chiede di vedere il carrello (parole chiave: "carrello", "basket", "panier", "cart", "mostrami il carrello"):
  -> intent="SHOW_CART"
  -> actions=[{"type":"get_cart","userRef":"<UserRef>"}]

- Se l'utente chiede una ricetta (es. "caesar per 2"):
  - identifica ingredienti
  - fai search_products per ogni ingrediente
  - poi add_to_cart con quantità plausibili.

Se non sei sicuro -> noop.
`;
}

/**
 * Format deterministico (FR) per SHOW_CART: niente output “misto”
 */
function formatCartFr(basket: any): string {
  if (!basket) return "Je n’ai pas pu récupérer votre panier.";

  const products = Array.isArray(basket.products) ? basket.products : [];
  const manualItems = Array.isArray(basket.manualItems) ? basket.manualItems : [];
  const fees = Array.isArray(basket.fees) ? basket.fees : [];
  const currency = basket.currency ?? "";

  const lines: string[] = [];
  lines.push("🧺 Voici votre panier :");

  if (products.length === 0 && manualItems.length === 0) {
    lines.push("— Aucun produit dans le panier pour l’instant.");
  } else {
    for (const p of products) {
      const name =
        p?.name ??
        p?.productName ??
        p?.product?.name ??
        p?.productId ??
        "Produit";
      const qty = p?.quantity ?? p?.qty ?? 1;
      lines.push(`— ${qty} × ${name}`);
    }
    for (const it of manualItems) {
      const name = it?.name ?? "Article";
      const qty = it?.quantity ?? it?.qty ?? 1;
      lines.push(`— ${qty} × ${name} (manuel)`);
    }
  }

  if (fees.length) {
    lines.push("");
    lines.push("Frais :");
    for (const f of fees) {
      const price = Number(f?.paidPriceTTC ?? f?.paidPrice ?? 0);
      lines.push(`— ${f?.name ?? "Frais"} : ${price.toFixed(2)} ${currency}`);
    }
  }

  lines.push("");
  if (basket.totalPriceTTC != null) {
    lines.push(`Total TTC : ${Number(basket.totalPriceTTC).toFixed(2)} ${currency}`);
  } else if (basket.totalPrice != null) {
    lines.push(`Total : ${Number(basket.totalPrice).toFixed(2)} ${currency}`);
  }

  if (basket.estimatedDeliveryDate) {
    lines.push(`Livraison estimée : ${basket.estimatedDeliveryDate}`);
  }

  return lines.join("\n");
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

  // fallback deterministico se Ollama non produce JSON ma l’utente chiede il carrello
  const lower = userText.toLowerCase();
  if (!plan || !Array.isArray(plan.actions)) {
    if (/(carrello|basket|panier|cart)/i.test(lower)) {
      const r = await getCurrentBasket(userRef);
      return { message: formatCartFr(r) };
    }
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
      const r = await searchProducts(userRef, action.query, action.limit ?? 5);
      toolResults.push({ action, result: r });
      continue;
    }

    if (action.type === "add_to_cart") {
      const basket = await getCurrentBasket(userRef);
      for (const it of action.items) {
        await addProductToBasket(userRef, basket.id, it.productId, it.qty);
      }
      const updated = await getCurrentBasket(userRef);
      toolResults.push({ action, result: { ok: true, basket: updated } });
      continue;
    }

    if (action.type === "get_cart") {
      const r = await getCurrentBasket(action.userRef ?? userRef);
      toolResults.push({ action, result: r });
      continue;
    }

    toolResults.push({ action, result: { ok: true } });
  }

  // ✅ Se è SHOW_CART: risposta deterministica in FR (niente Ollama Step 3)
  if (plan.intent === "SHOW_CART") {
    const cartResult = toolResults.find(x => x.action?.type === "get_cart")?.result;
    return { message: formatCartFr(cartResult) };
  }

  /**
   * STEP 3 — FINAL MESSAGE (lasciamo Ollama solo per ricette / add_to_cart)
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
          "Réponds UNIQUEMENT en français. Confirme ce que tu as compris et ce que tu as ajouté au panier, ou ce qui manque.",
      },
    ],
    0.4
  );

  return { message: message || "Ok." };
}