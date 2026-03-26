import { ollamaChat, safeJsonParse } from "./ollama-client.js";

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
5) {"type":"exec_cart","userRef":"..."}
6) {"type":"build_meal","meal":"...","servings":2}
7) {"type":"noop","reason":"..."}

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
- Si l'utilisateur veut passer la commande, finaliser le panier, checkout ou confirmer l'achat:
  {"intent":"EXEC_CART","actions":[{"type":"exec_cart"}]}
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



export async function planUserIntent(
  userRef: string,
  userText: string
): Promise<Plan | null> {
  const raw = await ollamaChat(
    [
      { role: "system", content: plannerPrompt() },
      { role: "user", content: `UserRef=${userRef}\nUserMessage=${userText}` },
    ],
    0.2
  );

  const parsed = safeJsonParse<Plan>(raw);

  console.log("[PLAN RAW]", raw);
  console.log("[PLAN PARSED]", JSON.stringify(parsed, null, 2));

  return parsed;
}
