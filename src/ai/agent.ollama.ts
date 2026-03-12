// src/ai/agent.ollama.ts
import { env } from "../config/env.js";
import { systemPrompt } from "./prompts.js";
import { getMemory, addToMemory } from "./memory.js";
import { searchProducts, fetchFullProduct, type Product } from "../swissdata/products.js";
import {
  getCurrentBasket,
  addProductToBasket,
  removeProductFromBasket,
  clearCurrentBasket
} from "../swissdata/cart.js";
import { matchIngredientToProduct } from "../domain/matcher.js";
import { getPurchaseHistory } from "../swissdata/history.js";
import { getPending, setPending, clearPending } from "./pending.js";
import { buildMealIngredients } from "./meal-builder.js";

type PlannedAction =
  | { type: "search_products"; query: string; limit?: number }
  | {
      type: "add_to_cart";
      userRef?: string;
      items: Array<{
        query: string;
        qty: number;
        unit?: string;
        productId?: string;
      }>;
    }
  | { type: "get_cart"; userRef?: string }
  | { type: "clear_cart"; userRef?: string }
  | {
      type: "build_meal";
      meal: string;
      servings?: number;
      userRef?: string;   // ⭐⭐⭐ AGGIUNGI QUESTO
    }
  | { type: "noop"; reason?: string };

type Plan = {
  intent: string;
  actions: PlannedAction[];
  userFacingDraft?: string;
};

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";

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

function plannerPrompt() {
  return `
Tu es l'IA de Zelo. Transforme le message utilisateur en PLAN JSON strict.

RÈGLES DE SORTIE:
- Réponds uniquement avec du JSON valide.
- Aucun markdown.
- Aucun texte avant ou après le JSON.

Structure:
{
  "intent": "...",
  "actions": [ ... ]
}

Actions autorisées:
1) {"type":"search_products","query":"...","limit":5}
2) {
     "type":"add_to_cart",
     "userRef":"...",
     "items":[
       {
         "query":"...",
         "qty":150,
         "unit":"g"
       }
     ]
   }
3) {"type":"get_cart","userRef":"..."}
4) {"type":"clear_cart","userRef":"..."}
5) {"type":"build_meal","meal":"...","servings":2}
6) {"type":"noop","reason":"..."}

IMPORTANT:
- Pour add_to_cart, n'invente jamais de productId si l'utilisateur n'en donne pas.
- Si l'utilisateur donne un nom produit, mets-le dans "query".
- "unit" peut être par exemple: "g", "kg", "ml", "l", "litre", "litres", "piece".
- Si l'utilisateur veut voir son panier:
  {"intent":"SHOW_CART","actions":[{"type":"get_cart"}]}
- Si l'utilisateur veut ajouter des produits:
  {"intent":"ADD_ITEMS","actions":[{"type":"add_to_cart","items":[...]}]}
- Si l'utilisateur corrige sa demande ("non finalement pas de cacahuètes"), tu peux ignorer l'article annulé dans la version finale du plan.
- N'utilise noop que si aucune intention utile ne peut être extraite.
- Si l'utilisateur veut vider complètement son panier:
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart"}]}
- Si l'utilisateur demande "de quoi faire ..." ou veut préparer un plat / repas / usage,
  utilise:
  {"intent":"BUILD_MEAL","actions":[{"type":"build_meal","meal":"...","servings":2}]}

RÈGLE GÉNÉRALE POUR LES DEMANDES VAGUES:
- Si l'utilisateur demande d'ajouter quelque chose au panier, même de manière vague, essaie d'extraire une query produit simple et exploitable.
- La query doit être le nom commun le plus utile pour rechercher le produit dans le catalogue.
- Supprime les déterminants inutiles: "du", "de la", "des", "un", "une", "de", "d’", "d'".
- Garde uniquement le coeur utile de la demande produit.
- Si aucune quantité explicite n'est donnée, utilise qty=1.
- Si aucune unité explicite n'est donnée, utilise unit="piece".
- Ne retourne pas noop si une query produit raisonnable peut être déduite.

EXEMPLES DE TRANSFORMATION GÉNÉRALE:
- "Ajoute des courses à mon panier" -> query="courses", qty=1, unit="piece"
- "Ajoute du lait à mon panier" -> query="lait", qty=1, unit="piece"
- "Ajoute du pain à mon panier" -> query="pain", qty=1, unit="piece"
- "Ajoute des tomates à mon panier" -> query="tomates", qty=1, unit="piece"
- "Ajoute du lard à mon panier" -> query="lard", qty=1, unit="piece"
- "Ajoute quelque chose pour l'apéro" -> query="apéro", qty=1, unit="piece"
- "Ajoute de quoi faire des hot dog" -> query="hot dog", qty=1, unit="piece"

RÈGLE POUR LES QUANTITÉS:
- "150g de lard de Begnins" -> query="lard de Begnins", qty=150, unit="g"
- "1 litre de lait normal" -> query="lait normal", qty=1, unit="litre"
- "3 pains anglais" -> query="pains anglais", qty=3, unit="piece"

Exemples:

Message:
"Ajoute 1 lard de Begnins à mon panier"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"lard de Begnins","qty":1,"unit":"piece"}
      ]
    }
  ]
}

Message:
"Ajoute 150g de lard de Begnins à mon panier"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"lard de Begnins","qty":150,"unit":"g"}
      ]
    }
  ]
}

Message:
"Ajoute 1 litre de lait normal à mon panier"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"lait normal","qty":1,"unit":"litre"}
      ]
    }
  ]
}

Message:
"Ajoute des courses à mon panier"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"courses","qty":1,"unit":"piece"}
      ]
    }
  ]
}

Message:
"Montre-moi mon panier"
Réponse:
{
  "intent":"SHOW_CART",
  "actions":[
    {"type":"get_cart"}
  ]
}

Message:
"Vide mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart"}
  ]
}

Message:
"Supprime tout de mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart"}
  ]
}

Message:
"Je veux de quoi faire des hot dog"
Réponse:
{
  "intent":"BUILD_MEAL",
  "actions":[
    {"type":"build_meal","meal":"hot dog","servings":2}
  ]
}

Message:
"De quoi faire une fondue"
Réponse:
{
  "intent":"BUILD_MEAL",
  "actions":[
    {"type":"build_meal","meal":"fondue","servings":2}
  ]
}
`;
}

function generalChatPrompt() {
  return `
You are Zelo AI, a friendly shopping and food assistant.

Rules:
- Reply naturally and helpfully.
- If the user asks normal questions, answer normally.
- If the question is about food, recipes, shopping, or products, stay practical.
- Always reply in French.
- Keep answers concise but useful.
`;
}

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

function looksLikeProductId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value.trim());
}

async function resolveProduct(userRef: string, rawItem: string): Promise<Product | null> {
  const item = rawItem.trim();

  if (looksLikeProductId(item)) {
    return {
      id: item,
      name: item,
    } as Product;
  }

  const candidates = await searchProducts(userRef, item, 20);
  console.log("[RESOLVE] item =", item);
  console.log("[RESOLVE] candidates =", candidates.map(c => ({
    id: c.id,
    name: c.name
  })));

  if (!candidates.length) return null;

  const history = await getPurchaseHistory(userRef);
  console.log("[RESOLVE] history =", history);

  const best = matchIngredientToProduct(item, candidates, history);
  console.log("[RESOLVE] best full =", JSON.stringify(best, null, 2));

  const selected = best ?? candidates[0] ?? null;
  if (!selected?.id) return null;

  const full = await fetchFullProduct(userRef, selected.id);
  console.log("[RESOLVE] fetched full =", JSON.stringify(full, null, 2));

  return full ?? selected;
  //return best ?? candidates[0] ?? null;
}

function computeBasketQty(product: any, requestedQty: number, requestedUnit?: string): number {
  const unit = String(requestedUnit || "piece").toLowerCase();

  if (unit === "piece") {
    return Math.max(1, requestedQty);
  }

  if (unit === "g" || unit === "kg") {
    const requestedGrams = unit === "kg" ? requestedQty * 1000 : requestedQty;

    if (
      product?.priceType === "per-weight" &&
      typeof product?.refWeight === "number" &&
      String(product?.refWeightUnit || "").toLowerCase() === "g"
    ) {
      return Math.max(1, Math.ceil(requestedGrams / product.refWeight));
    }

    const size = String(product?.size || "").toLowerCase();
    const gMatch = size.match(/(\d+)\s*g\b/);
    if (gMatch) {
      const grams = Number(gMatch[1]);
      if (grams > 0) return Math.max(1, Math.ceil(requestedGrams / grams));
    }

    return 1;
  }

  if (unit === "l" || unit === "litre" || unit === "litres" || unit === "ml") {
    const requestedMl = unit === "ml" ? requestedQty : requestedQty * 1000;

    const size = String(product?.size || "").toLowerCase().replace(",", ".");

    if (size.includes("1 litre") || size.includes("1l") || size.includes("1 l")) {
      return Math.max(1, Math.ceil(requestedMl / 1000));
    }

    const mlMatch = size.match(/(\d+(?:\.\d+)?)\s*ml\b/);
    if (mlMatch) {
      const ml = Number(mlMatch[1]);
      if (ml > 0) return Math.max(1, Math.ceil(requestedMl / ml));
    }

    const lMatch = size.match(/(\d+(?:\.\d+)?)\s*(?:l|litre|litres)\b/);
    if (lMatch) {
      const litres = Number(lMatch[1]);
      if (litres > 0) return Math.max(1, Math.ceil(requestedMl / (litres * 1000)));
    }

    return Math.max(1, requestedQty);
  }

  return Math.max(1, requestedQty);
}

function formatOptionQuestion(product: Product): string {
  const options = Array.isArray(product.availableOptions) ? product.availableOptions : [];

  if (!options.length) {
    return `J’ai trouvé “${product.name}”, mais je n’ai pas réussi à lire ses options.`;
  }

  const lines: string[] = [];
  lines.push(`J’ai trouvé « ${product.name} ».`);
  lines.push(`Il y a plusieurs options disponibles :`);
  lines.push("");

  options.forEach((opt, index) => {
    const label = opt?.name || `Option ${index + 1}`;
    const extra = opt?.shortDescription || opt?.description || "";
    lines.push(`${index + 1}. ${label}${extra ? ` — ${extra}` : ""}`);
  });

  lines.push("");
  lines.push("Quelles options veux-tu sélectionner ?");

  return lines.join("\n");
}

function normalizeLooseText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveOptionsFromText(
  userText: string,
  availableOptions: Array<{ id: string; name: string; shortDescription?: string; description?: string }>
) {
  const text = normalizeLooseText(userText);

  const selected: Array<{ id: string; name: string }> = [];

  for (const opt of availableOptions) {
    const haystacks = [
      opt.name,
      opt.shortDescription,
      opt.description
    ]
      .filter(Boolean)
      .map(v => normalizeLooseText(String(v)));

    const matched = haystacks.some(h =>
      h && (text.includes(h) || h.includes(text))
    );

    if (matched) {
      selected.push({ id: opt.id, name: opt.name });
      continue;
    }

    // match par mots
    const optWords = normalizeLooseText(opt.name).split(" ").filter(Boolean);
    const hasWordOverlap = optWords.some(w => w.length > 2 && text.includes(w));
    if (hasWordOverlap) {
      selected.push({ id: opt.id, name: opt.name });
    }
  }

  // dédup
  const seen = new Set<string>();
  return selected.filter(x => {
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

async function runGeneralChat(userRef: string, userText: string): Promise<{ message: string }> {
  const mem = getMemory(userRef);

  const messages = [
    { role: "system", content: generalChatPrompt() },
    ...mem.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const reply = await ollamaChat(messages, 0.5);

  addToMemory(userRef, "user", userText);
  addToMemory(userRef, "assistant", reply || "Je ne sais pas quoi répondre pour le moment.");

  return {
    message: reply || "Je ne sais pas quoi répondre pour le moment.",
  };
}

export async function runAgentOllama(
  userRef: string,
  userText: string
): Promise<{ message: string }> {
  const lower = userText.toLowerCase();

    const pending = getPending(userRef);
  if (pending && pending.type === "awaiting_options") {
    const selected = resolveOptionsFromText(userText, pending.availableOptions);

    if (!selected.length) {
      return {
        message:
          `Je n’ai pas reconnu les options demandées pour « ${pending.productName} ».\n\n` +
          formatOptionQuestion({
            id: pending.productId,
            name: pending.productName,
            availableOptions: pending.availableOptions,
          } as Product),
      };
    }

    const basket = await getCurrentBasket(userRef);
    await addProductToBasket(
      userRef,
      basket.id,
      pending.productId,
      pending.qty,
      selected.map(x => x.id)
    );

    clearPending(userRef);

    const updated = await getCurrentBasket(userRef);

    return {
      message:
        `✅ J’ai ajouté « ${pending.productName} » avec les options : ${selected.map(x => x.name).join(", ")}.\n\n` +
        formatCartFr(updated),
    };
  }

  // 1) SHOW CART deterministic
  if (/(carrello|basket|panier|cart)/i.test(lower) && /(montre|mostra|show|voir)/i.test(lower)) {
    const basket = await getCurrentBasket(userRef);
    return { message: formatCartFr(basket) };
  }

  // 2) PLAN with Ollama for everything shopping-related
  const planText = await ollamaChat(
    [
      { role: "system", content: plannerPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
    ],
    0.2
  );

  const plan = safeJsonParse<Plan>(planText);
  console.log("[PLAN RAW]", planText);
console.log("[PLAN PARSED]", JSON.stringify(plan, null, 2));

  if (!plan || !Array.isArray(plan.actions)) {
    if (/(carrello|basket|panier|cart)/i.test(lower)) {
      const basket = await getCurrentBasket(userRef);
      return { message: formatCartFr(basket) };
    }

    return await runGeneralChat(userRef, userText);
  }

  const toolResults: any[] = [];

  for (const action of plan.actions) {
    if (action.type === "search_products") {
      const r = await searchProducts(userRef, action.query, action.limit ?? 5);
      toolResults.push({ action, result: r });
      continue;
    }

    if (action.type === "add_to_cart") {
      console.log("[ADD_TO_CART ACTION]", JSON.stringify(action, null, 2));
      const basket = await getCurrentBasket(action.userRef ?? userRef);
      const resolvedItems: any[] = [];

      for (const it of action.items) {
        let resolvedProduct: Product | null = null;

        if (it.productId) {
          resolvedProduct = { id: it.productId, name: it.productId } as Product;
        } else {
          resolvedProduct = await resolveProduct(userRef, it.query);
        }
        

        if (!resolvedProduct?.id) {
          resolvedItems.push({
            query: it.query,
            ok: false,
            error: "Product not found",
          });
          
          continue;
        }

          if (Array.isArray(resolvedProduct.optionsIds) && resolvedProduct.optionsIds.length > 0) {
  // Se abbiamo anche i dettagli leggibili delle opzioni, chiediamo bene.
  if (Array.isArray(resolvedProduct.availableOptions) && resolvedProduct.availableOptions.length > 0) {
    setPending(userRef, {
      type: "awaiting_options",
      productId: resolvedProduct.id,
      productName: resolvedProduct.name,
      qty: Math.max(1, computeBasketQty(resolvedProduct, it.qty, it.unit)),
      unit: it.unit,
      availableOptions: resolvedProduct.availableOptions.map(opt => ({
        id: opt.id,
        name: opt.name || "Option",
        shortDescription: opt.shortDescription,
        description: opt.description,
      })),
    });

    return {
      message: formatOptionQuestion(resolvedProduct),
    };
  }

  // Sinon on bloque l'ajout automatique pour éviter une mauvaise commande.
  return {
    message:
      `J’ai trouvé « ${resolvedProduct.name} », mais ce produit demande des options avant d’être ajouté.\n` +
      `Je n’ajoute rien automatiquement pour éviter une mauvaise commande.`
  };
}
        
        const basketQty = computeBasketQty(resolvedProduct, it.qty, it.unit);

        const addResult = await addProductToBasket(
          action.userRef ?? userRef,
          basket.id,
          resolvedProduct.id,
          basketQty
        );

        resolvedItems.push({
          query: it.query,
          requestedQty: it.qty,
          requestedUnit: it.unit ?? "piece",
          basketQty,
          product: {
            id: resolvedProduct.id,
            name: resolvedProduct.name,
          },
          ok: true,
          result: addResult,
        });
      }

      const updated = await getCurrentBasket(action.userRef ?? userRef);
      toolResults.push({
        action,
        result: {
          ok: true,
          resolvedItems,
          basket: updated,
        },
      });
      console.log("[ADD_TO_CART RESULT]", JSON.stringify({
  resolvedItems,
  updated
}, null, 2));
      continue;
    }

    if (action.type === "get_cart") {
      const r = await getCurrentBasket(action.userRef ?? userRef);
      toolResults.push({ action, result: r });
      continue;
    }

        if (action.type === "clear_cart") {
      const updated = await clearCurrentBasket(action.userRef ?? userRef);

      toolResults.push({
        action,
        result: {
          ok: true,
          basket: updated,
        },
      });

      continue;
    }


    if (action.type === "build_meal") {
  console.log("[BUILD_MEAL ACTION]", JSON.stringify(action, null, 2));

  const basket = await getCurrentBasket(action.userRef ?? userRef);

  const ingredients = await buildMealIngredients(
    action.meal,
    action.servings ?? 2
  );

  console.log("[BUILD_MEAL INGREDIENTS]", ingredients);

  const resolvedItems: any[] = [];

  for (const ing of ingredients) {
    const resolvedProduct = await resolveProduct(userRef, ing.query);

    if (!resolvedProduct?.id) {
      resolvedItems.push({
        query: ing.query,
        ok: false,
        error: "not_found",
      });
      continue;
    }

    // ⚠️ gestione opzioni (importantissimo)
    if (
      Array.isArray(resolvedProduct.availableOptions) &&
      resolvedProduct.availableOptions.length > 0
    ) {
      setPending(userRef, {
        type: "awaiting_options",
        productId: resolvedProduct.id,
        productName: resolvedProduct.name,
        qty: Math.max(1, ing.qty ?? 1),
        unit: ing.unit,
        availableOptions: resolvedProduct.availableOptions.map((opt) => ({
          id: opt.id,
          name: opt.name || "Option",
          shortDescription: opt.shortDescription,
          description: opt.description,
        })),
      });

      return {
        message:
          `Pour préparer « ${action.meal} », j’ai trouvé un produit avec options.\n\n` +
          formatOptionQuestion(resolvedProduct),
      };
    }

    const basketQty = computeBasketQty(
      resolvedProduct,
      ing.qty ?? 1,
      ing.unit
    );

    await addProductToBasket(
      action.userRef ?? userRef,
      basket.id,
      resolvedProduct.id,
      basketQty
    );

    resolvedItems.push({
      query: ing.query,
      ok: true,
      product: resolvedProduct.name,
      basketQty,
      role: ing.role,
      optional: ing.optional,
    });
  }

  const updated = await getCurrentBasket(action.userRef ?? userRef);

  toolResults.push({
    action,
    result: {
      ok: true,
      meal: action.meal,
      resolvedItems,
      basket: updated,
    },
  });

  continue;
}





    toolResults.push({ action, result: { ok: true } });
  }

  if (plan.intent === "SHOW_CART") {
    const cartResult = toolResults.find((x) => x.action?.type === "get_cart")?.result;
    return { message: formatCartFr(cartResult) };
  }
  if (plan.intent === "CLEAR_CART") {
  const clearResult = toolResults.find(
    (x) => x.action?.type === "clear_cart"
  )?.result;

  return {
    message:
      `🧹 J’ai vidé votre panier.\n\n` +
      formatCartFr(clearResult?.basket),
  };
}

if (plan.intent === "ADD_ITEMS") {
  const addResult = toolResults.find((x) => x.action?.type === "add_to_cart")?.result;
  const basket = addResult?.basket;

  const summaryLines: string[] = [];

  if (Array.isArray(addResult?.resolvedItems)) {
    for (const it of addResult.resolvedItems) {
      if (it.ok) {
        summaryLines.push(
          `— ${it.requestedQty}${it.requestedUnit && it.requestedUnit !== "piece" ? it.requestedUnit : ""} de ${it.product?.name ?? it.query} → quantité panier: ${it.targetBasketQty ?? it.basketQty ?? "?"}`
        );
      } else {
        summaryLines.push(`— ${it.query} : introuvable`);
      }
    }
  }

  if (!summaryLines.length) {
    return {
      message: "Je n’ai pas trouvé de produit suffisamment clair à ajouter. Essaie avec un nom plus précis, par exemple « Courses pour 2 » ou « Courses pour 4 »."
    };
  }

  return {
    message:
      `✅ J’ai traité votre demande :\n` +
      summaryLines.join("\n") +
      `\n\n` +
      (basket ? formatCartFr(basket) : "Le panier a été mis à jour, mais je n’ai pas pu relire son contenu.")
  };
}

if (plan.intent === "BUILD_MEAL") {
  const mealResult = toolResults.find(
    (x) => x.action?.type === "build_meal"
  )?.result;

  if (!mealResult) {
    return {
      message: "Je n’ai pas réussi à préparer les ingrédients pour ce repas.",
    };
  }

  const lines: string[] = [];

  for (const it of mealResult.resolvedItems) {
    if (it.ok) {
      lines.push(
        `— ${it.product} (${it.role || "ingrédient"})`
      );
    } else {
      lines.push(`— ${it.query} : introuvable`);
    }
  }

  return {
    message:
      `🍽️ J’ai ajouté des ingrédients pour préparer « ${mealResult.meal} » :\n` +
      lines.join("\n") +
      "\n\n" +
      formatCartFr(mealResult.basket),
  };
}


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