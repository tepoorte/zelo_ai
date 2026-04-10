import { ollamaChat, safeJsonParse } from "./ollama-client.js";
import { timeAsync, timeSync } from "../../utils/perf.js";
import { env } from "../../config/env.js";

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
  | { type: "exec_cart"; userRef?: string }
  | { type: "discover_meal_ideas"; userRef?: string }
  | {
      type: "build_meal";
      meal: string;
      servings?: number;
      userRef?: string;   
    }
  | { type: "noop"; reason?: string };

type Plan = {
  intent: string;
  actions: PlannedAction[];
  userFacingDraft?: string;
};


function normalizePlannedAction(action: any): PlannedAction | null {
  if (!action || typeof action !== "object") return null;

  if (action.type === "discover_meal_ideas" || action.type === "DISCOVER_MEALS") {
    return { type: "discover_meal_ideas", userRef: action.userRef };
  }

  return action as PlannedAction;
}

function normalizePlan(parsed: Plan | null): Plan | null {
  if (!parsed) return null;

  const normalizedActions = Array.isArray(parsed.actions)
    ? parsed.actions
        .map((action) => normalizePlannedAction(action))
        .filter(Boolean) as PlannedAction[]
    : [];

  if (parsed.intent === "DISCOVER_MEALS" && normalizedActions.length === 0) {
    normalizedActions.push({ type: "discover_meal_ideas" });
  }

  return {
    ...parsed,
    actions: normalizedActions,
  };
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

Le JSON final doit contenir uniquement:
- "intent"
- "actions"
- "userFacingDraft" (optionnel)

N'inclus jamais dans la sortie:
- "UserRef"
- "UserMessage"
- "message"
- "text"
- "input"
- "output"
- toute autre clé non demandée

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
5) {"type":"exec_cart","userRef":"..."}
6) {"type":"build_meal","meal":"...","servings":2}
7) {"type":"discover_meal_ideas"}
8) {"type":"noop","reason":"..."}

IMPORTANT:
- Pour add_to_cart, n'invente jamais de productId si l'utilisateur n'en donne pas.
- Si l'utilisateur donne un nom produit, mets-le dans "query".
- "unit" peut être par exemple: "g", "kg", "ml", "l", "litre", "litres", "piece".
- Si l'utilisateur veut voir son panier:
  {"intent":"SHOW_CART","actions":[{"type":"get_cart"}]}
- Si l'utilisateur veut ajouter des produits:
  {"intent":"ADD_ITEMS","actions":[{"type":"add_to_cart","items":[...]}]}
- Si l'utilisateur corrige sa demande ("non finalement pas de cacahuètes"), tu peux ignorer l'article annulé dans la version finale du plan.
- Si le message est un salut, un remerciement, une formule de politesse, une question générale,
  une question personnelle, ou une phrase qui ne demande aucune action sur le panier, les produits,
  la commande ou un repas, utilise:
  {"intent":"NOOP","actions":[{"type":"noop","reason":"small_talk"}]}
- Exemples typiques de NOOP:
  "bonjour", "salut", "comment ça va ?", "comment ca va bro ?",
  "merci", "super merci", "tu peux m'aider ?",
  "que fais-tu aujourd'hui ?", "quel temps fait-il aujourd'hui ?",
  "quelle heure est-il ?", "qui es-tu ?", "ça roule ?", "quoi de neuf ?"
- Ne classe jamais ces messages comme SHOW_CART, ADD_ITEMS, CLEAR_CART, EXEC_CART, BUILD_MEAL ou DISCOVER_MEALS.
- Dès qu'aucune action shopping claire n'est demandée, préfère NOOP.
- Si l'utilisateur veut vider complètement son panier:
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart"}]}
- Si l'utilisateur veut passer la commande, finaliser le panier, checkout ou confirmer l'achat:
  {"intent":"EXEC_CART","actions":[{"type":"exec_cart"}]}
- Si l'utilisateur écrit exactement:
  "Qu'est-ce que tu me proposes aujourd'hui ?"
  utilise:
  {"intent":"DISCOVER_MEALS","actions":[{"type":"discover_meal_ideas"}]}
- Pour toute autre phrase, n'utilise jamais DISCOVER_MEALS.
- Si l'utilisateur demande "de quoi faire ..." ou veut préparer un plat / repas / usage,
  utilise:
  {"intent":"BUILD_MEAL","actions":[{"type":"build_meal","meal":"...","servings":2}]}

RÈGLE POUR LE SMALL TALK ET LES QUESTIONS GÉNÉRALES:
- Si le message est un salut, un remerciement, une formule de politesse,
  une question générale, ou une phrase sans intention shopping exploitable,
  utilise:
  {"intent":"NOOP","actions":[{"type":"noop","reason":"small_talk"}]}
- Si aucun panier, produit, commande ou repas concret n'est demandé, préfère NOOP.
- Si tu hésites entre une action shopping et une conversation générale, préfère NOOP.
- Si le message demande seulement une réponse naturelle, retourne NOOP.

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
"Passe la commande"
Réponse:
{
  "intent":"EXEC_CART",
  "actions":[
    {"type":"exec_cart"}
  ]
}

Message:
"Passer la commande"
Réponse:
{
  "intent":"EXEC_CART",
  "actions":[
    {"type":"exec_cart"}
  ]
}

Message:
"Qu'est-ce que tu me proposes aujourd'hui ?"
Réponse:
{
  "intent":"DISCOVER_MEALS",
  "actions":[
    {"type":"discover_meal_ideas"}
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

Message:
"Comment ca va bro ?"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"small_talk"}
  ]
}

Message:
"Quel temps fait-il aujourd'hui ?"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"generic_chat"}
  ]
}

Message:
"Merci beaucoup"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"small_talk"}
  ]
}
`;
}

function plannerPrompt2() {
  return `
Tu es un planner de test minimal.
Réponds toujours uniquement avec ce JSON exact, pour n'importe quel message:
{"intent":"NOOP","actions":[{"type":"noop","reason":"general_chat"}]}
`;
}


export async function planUserIntent(
  userRef: string,
  userText: string
): Promise<Plan | null> {
  const raw = await timeAsync(
    "planner.ollama_chat",
    async () =>
      await ollamaChat(
        [
          { role: "system", content: plannerPrompt() },
          { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
        ],
        0,
        {
          model: env.ollamaPlannerModel,
          format: "json",
          keepAlive: "30m",
          numPredict: 160,
          numCtx: 2048,
        }
      )
  );

  const parsed = timeSync(
    "planner.safe_json_parse",
    () => safeJsonParse<Plan>(raw)
  );
  const normalized = timeSync(
    "planner.normalize_plan",
    () => normalizePlan(parsed)
  );

  console.log("[PLAN RAW]", raw);
  console.log("[PLAN PARSED]", JSON.stringify(normalized, null, 2));

  return normalized;
}
