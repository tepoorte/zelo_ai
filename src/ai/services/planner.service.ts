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
  | {
      type: "clear_cart";
      userRef?: string;
      mode?: "all" | "partial";
      items?: Array<{
        query: string;
      }>;
    }
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
4) {"type":"clear_cart","userRef":"...","mode":"all|partial","items":[{"query":"..."}]}
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
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart","mode":"all"}]}
- Si l'utilisateur veut retirer seulement un ou plusieurs produits précis du panier:
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart","mode":"partial","items":[{"query":"..."}]}]}
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
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Supprime tout de mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Supprime Crottins de chèvre par 2"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {
      "type":"clear_cart",
      "mode":"partial",
      "items":[
        {"query":"crottins de chèvre par 2"}
      ]
    }
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

export type FrontendIntentHint = {
  actionKey?:
    | "add_items"
    | "clear_cart"
    | "show_cart"
    | "exec_cart"
    | "build_meal"
    | "discover_meals"
    | "noop";
  confidence?: number;
  family?: string;
  planner?: string;
};

function plannerPromptOutputRules() {
  return `
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
`;
}

function plannerPromptNoopFallbackRules() {
  return `
RÈGLE DE REPLI:
- Si le message ne correspond finalement pas à l'intention attendue pour ce planner spécialisé,
  retourne NOOP.
- Si tu hésites sérieusement, préfère NOOP.
- Exemple:
  {"intent":"NOOP","actions":[{"type":"noop","reason":"general_chat"}]}
`;
}

function plannerPromptAddItems() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé ADD_ITEMS.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour ajouter un ou plusieurs produits au panier.

${plannerPromptOutputRules()}

Actions autorisées:
1) {
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
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est ADD_ITEMS.
- Pour add_to_cart, n'invente jamais de productId si l'utilisateur n'en donne pas.
- Si l'utilisateur donne un nom produit, mets-le dans "query".
- "unit" peut être par exemple: "g", "kg", "ml", "l", "litre", "litres", "piece".
- Retourne un seul objet {"type":"add_to_cart"} avec un tableau "items", même si plusieurs produits sont demandés.
- Si l'utilisateur corrige sa demande ("non finalement pas de cacahuètes"), tu peux ignorer l'article annulé dans la version finale du plan.
- Si l'utilisateur demande d'ajouter quelque chose au panier, même de manière vague, essaie d'extraire une query produit simple et exploitable.
- La query doit être le nom commun le plus utile pour rechercher le produit dans le catalogue.
- Supprime les déterminants inutiles: "du", "de la", "des", "un", "une", "de", "d’", "d'".
- Garde uniquement le coeur utile de la demande produit.
- Si aucune quantité explicite n'est donnée, utilise qty=1.
- Si aucune unité explicite n'est donnée, utilise unit="piece".
- Si une query produit raisonnable peut être déduite, préfère ADD_ITEMS.
- Si le message ne demande pas réellement un ajout panier, retourne NOOP.

RÈGLE POUR LES QUANTITÉS:
- "150g de lard de Begnins" -> query="lard de Begnins", qty=150, unit="g"
- "1 litre de lait normal" -> query="lait normal", qty=1, unit="litre"
- "3 pains anglais" -> query="pains anglais", qty=3, unit="piece"

EXEMPLES DE TRANSFORMATION GÉNÉRALE:
- "Ajoute des courses à mon panier" -> query="courses", qty=1, unit="piece"
- "Ajoute du lait à mon panier" -> query="lait", qty=1, unit="piece"
- "Ajoute du pain à mon panier" -> query="pain", qty=1, unit="piece"
- "Ajoute des tomates à mon panier" -> query="tomates", qty=1, unit="piece"
- "Ajoute du lard à mon panier" -> query="lard", qty=1, unit="piece"
- "Ajoute quelque chose pour l'apéro" -> query="apéro", qty=1, unit="piece"

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
"Ajoute 1 lard de Begnins, 1 pain anglais et 1 panier budget 50"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"lard de Begnins","qty":1,"unit":"piece"},
        {"query":"pain anglais","qty":1,"unit":"piece"},
        {"query":"panier budget 50","qty":1,"unit":"piece"}
      ]
    }
  ]
}

Message:
"Comment ça va ?"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"general_chat"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptClearCart() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé CLEAR_CART.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour retirer des produits du panier, soit totalement, soit de manière ciblée.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"clear_cart","userRef":"...","mode":"all|partial","items":[{"query":"..."}]}
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est CLEAR_CART.
- Utilise {"type":"clear_cart","mode":"all"} si l'utilisateur veut que le panier devienne vide.
- Cela inclut les formulations explicites ou indirectes comme:
  "vide mon panier", "supprime tout", "enlève tout", "je ne veux plus rien",
  "mon panier ne doit rien contenir", "fais en sorte que mon panier soit vide".
- Utilise {"type":"clear_cart","mode":"partial","items":[...]} si l'utilisateur veut retirer un ou plusieurs produits précis du panier.
- Cela inclut des formulations comme:
  "supprime Crottins de chèvre par 2", "enlève le lait bio de mon panier",
  "retire le lard de begnins", "enlève seulement le pain anglais".
- En mode partial, mets dans "items" une ou plusieurs queries produit simples et exploitables.
- Ne retourne jamais SHOW_CART, ADD_ITEMS, EXEC_CART, BUILD_MEAL ou DISCOVER_MEALS dans ce planner.
- Si le message parle du panier mais ne demande pas clairement une suppression totale ou ciblée, retourne NOOP.

Exemples:

Message:
"Vide mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Supprime tout de mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Je veux que mon panier soit vide"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Ahh, je voudrais que mon panier ne contienne rien non plus"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {"type":"clear_cart","mode":"all"}
  ]
}

Message:
"Supprime Crottins de chèvre par 2"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {
      "type":"clear_cart",
      "mode":"partial",
      "items":[
        {"query":"crottins de chèvre par 2"}
      ]
    }
  ]
}

Message:
"Enlève le lait bio de mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {
      "type":"clear_cart",
      "mode":"partial",
      "items":[
        {"query":"lait bio"}
      ]
    }
  ]
}

Message:
"Montre-moi mon panier"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"wrong_specialized_hint"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptShowCart() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé SHOW_CART.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour afficher le panier actuel.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"get_cart","userRef":"..."}
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est SHOW_CART.
- Utilise SHOW_CART uniquement si l'utilisateur veut voir, afficher, connaître ou relire le contenu du panier.
- Cela inclut des formulations comme:
  "montre-moi mon panier", "qu'y a-t-il dans mon panier ?", "affiche mon panier",
  "je veux voir mon panier", "c'est quoi dans mon panier ?"
- Ne retourne jamais CLEAR_CART, EXEC_CART, ADD_ITEMS, BUILD_MEAL ou DISCOVER_MEALS dans ce planner.
- Si le message ne demande pas explicitement à voir le panier, retourne NOOP.

Exemples:

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
"Qu'y a-t-il dans mon panier ?"
Réponse:
{
  "intent":"SHOW_CART",
  "actions":[
    {"type":"get_cart"}
  ]
}

Message:
"Affiche mon panier"
Réponse:
{
  "intent":"SHOW_CART",
  "actions":[
    {"type":"get_cart"}
  ]
}

Message:
"Passe la commande"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"wrong_specialized_hint"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptExecCart() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé EXEC_CART.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour passer la commande.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"exec_cart","userRef":"..."}
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est EXEC_CART.
- Utilise EXEC_CART si l'utilisateur veut passer la commande, finaliser le panier, checkout, confirmer l'achat ou lancer l'étape finale.
- Exemples de formulations compatibles:
  "passe la commande", "passer la commande", "finalise", "checkout", "valide l'achat".
- Ne retourne jamais SHOW_CART, CLEAR_CART, ADD_ITEMS, BUILD_MEAL ou DISCOVER_MEALS dans ce planner.
- Si le message ne demande pas clairement la finalisation de la commande, retourne NOOP.

Exemples:

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
"Checkout"
Réponse:
{
  "intent":"EXEC_CART",
  "actions":[
    {"type":"exec_cart"}
  ]
}

Message:
"Montre-moi mon panier"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"wrong_specialized_hint"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptBuildMeal() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé BUILD_MEAL.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour construire un repas ou un plat à partir d'une envie précise.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"build_meal","meal":"...","servings":2}
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est BUILD_MEAL.
- Utilise BUILD_MEAL si l'utilisateur demande "de quoi faire ..." ou veut préparer un plat / repas / usage précis.
- Extrais le nom du plat dans "meal".
- Si le nombre de portions n'est pas explicite, utilise servings=2.
- Si le message parle d'inspiration générale du jour sans plat précis, retourne NOOP.
- Ne retourne jamais ADD_ITEMS, SHOW_CART, CLEAR_CART, EXEC_CART ou DISCOVER_MEALS dans ce planner.

Exemples:

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
"Je veux préparer une carbonara pour 4"
Réponse:
{
  "intent":"BUILD_MEAL",
  "actions":[
    {"type":"build_meal","meal":"carbonara","servings":4}
  ]
}

Message:
"Qu'est-ce que tu me proposes aujourd'hui ?"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"wrong_specialized_hint"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptDiscoverMeals() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé DISCOVER_MEALS.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour lancer un flow de découverte d'idées repas.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"discover_meal_ideas"}
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est DISCOVER_MEALS.
- Utilise DISCOVER_MEALS si l'utilisateur demande explicitement des idées, propositions ou suggestions du jour.
- Cas de référence principal:
  "Qu'est-ce que tu me proposes aujourd'hui ?"
- Tu peux accepter des variantes proches comme:
  "tu me proposes quoi aujourd'hui ?", "quelles idées de repas aujourd'hui ?"
- Si l'utilisateur demande un plat précis ou "de quoi faire ..." retourne NOOP.
- Ne retourne jamais ADD_ITEMS, SHOW_CART, CLEAR_CART, EXEC_CART ou BUILD_MEAL dans ce planner.

Exemples:

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
"Tu me proposes quoi aujourd'hui ?"
Réponse:
{
  "intent":"DISCOVER_MEALS",
  "actions":[
    {"type":"discover_meal_ideas"}
  ]
}

Message:
"Quelles idées de repas aujourd'hui ?"
Réponse:
{
  "intent":"DISCOVER_MEALS",
  "actions":[
    {"type":"discover_meal_ideas"}
  ]
}

Message:
"De quoi faire une fondue"
Réponse:
{
  "intent":"NOOP",
  "actions":[
    {"type":"noop","reason":"wrong_specialized_hint"}
  ]
}

${plannerPromptNoopFallbackRules()}
`;
}

function plannerPromptNoop() {
  return `
Tu es l'IA de Zelo. Tu es un planner spécialisé NOOP.
Ta mission est de transformer le message utilisateur en PLAN JSON strict quand il s'agit de small talk, de politesse ou de conversation générale.

${plannerPromptOutputRules()}

Actions autorisées:
1) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est NOOP.
- Utilise NOOP pour les salutations, remerciements, formules sociales, questions générales, questions personnelles,
  ou toute phrase qui ne demande aucune action sur le panier, les produits, la commande ou un repas.
- Ne classe jamais ces messages comme SHOW_CART, ADD_ITEMS, CLEAR_CART, EXEC_CART, BUILD_MEAL ou DISCOVER_MEALS.
- Si aucun panier, produit, commande ou repas concret n'est demandé, retourne NOOP.

Exemples typiques de NOOP:
- "bonjour"
- "salut"
- "comment ça va ?"
- "comment ca va bro ?"
- "merci"
- "super merci"
- "tu peux m'aider ?"
- "que fais-tu aujourd'hui ?"
- "quel temps fait-il aujourd'hui ?"
- "quelle heure est-il ?"
- "qui es-tu ?"
- "ça roule ?"
- "quoi de neuf ?"

Exemples:

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

export function selectPlannerPrompt(intentHint?: FrontendIntentHint) {
  switch (intentHint?.actionKey) {
    case "add_items":
      return plannerPromptAddItems();
    case "clear_cart":
      return plannerPromptClearCart();
    case "show_cart":
      return plannerPromptShowCart();
    case "exec_cart":
      return plannerPromptExecCart();
    case "build_meal":
      return plannerPromptBuildMeal();
    case "discover_meals":
      return plannerPromptDiscoverMeals();
    case "noop":
      return plannerPromptNoop();
    default:
      return plannerPrompt();
  }
}

function selectPlannerBudget(intentHint?: FrontendIntentHint) {
  switch (intentHint?.actionKey) {
    case "add_items":
    case "clear_cart":
    case "show_cart":
    case "exec_cart":
    case "noop":
      return { numPredict: 96, numCtx: 2048 };
    case "build_meal":
    case "discover_meals":
      return { numPredict: 96, numCtx: 2048 };
    default:
      return { numPredict: 160, numCtx: 2048 };
  }
}


export async function planUserIntent(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<Plan | null> {
  const selectedPrompt = selectPlannerPrompt(intentHint);
  const plannerBudget = selectPlannerBudget(intentHint);

  const raw = await timeAsync(
    "planner.ollama_chat",
    async () =>
      await ollamaChat(
        [
          { role: "system", content: selectedPrompt },
          { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
        ],
        0,
        {
          model: env.ollamaPlannerModel,
          format: "json",
          keepAlive: "30m",
          numPredict: plannerBudget.numPredict,
          numCtx: plannerBudget.numCtx,
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
  console.log("[PLANNER HINT]", JSON.stringify(intentHint ?? null));

  return normalized;
}
