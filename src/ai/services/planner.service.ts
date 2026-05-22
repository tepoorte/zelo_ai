import { ollamaChat, safeJsonParse } from "./ollama-client.js";
import { timeAsync, timeSync } from "../../utils/perf.js";
import { env } from "../../config/env.js";
import {
  discoverPlannerJsonSchema,
  discoverPlannerPrompt,
  discoverPlannerVocabularyFromTraining,
  enrichDiscoverPlannerChoicesFromQuery,
  filterDiscoverPlannerChoicesByQuery,
  fallbackDiscoverPlannerVocabulary,
  normalizeDiscoverPlannerChoices,
} from "../discover/planner-vocabulary.js";
import { loadDiscoverTrainingArtifacts } from "../discover/training-artifacts.js";
import {
  normalizePlan,
  normalizePlannerUserText,
} from "./planner-normalization.service.js";
import type { FrontendIntentHint, Plan } from "./planner-types.js";

export type { FrontendIntentHint, Plan, PlannedAction } from "./planner-types.js";

function plannerPrompt() {
  return `
Tu es l’Assistant Zélo. Transforme le message utilisateur en PLAN JSON strict.

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
         "qty":1,
         "unit":"..."
       }
     ]
   }
3) {"type":"get_cart","userRef":"..."}
4) {"type":"clear_cart","userRef":"...","mode":"all|partial","items":[{"query":"..."}]}
5) {"type":"exec_cart","userRef":"..."}
6) {"type":"discover_meal_ideas","query":"..."}
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
- Si le message est un salut, un remerciement, une formule de politesse, une question générale,
  une question personnelle, ou une phrase qui ne demande aucune action sur le panier, les produits,
  la commande ou un repas, utilise:
  {"intent":"NOOP","actions":[{"type":"noop","reason":"small_talk"}]}
- Exemples typiques de NOOP:
  "bonjour", "salut", "comment ça va ?", "comment ca va bro ?",
  "merci", "super merci", "tu peux m'aider ?",
  "que fais-tu aujourd'hui ?", "quel temps fait-il aujourd'hui ?",
  "quelle heure est-il ?", "qui es-tu ?", "ça roule ?", "quoi de neuf ?"
- Ne classe jamais ces messages comme SHOW_CART, ADD_ITEMS, CLEAR_CART, EXEC_CART ou DISCOVER_MEALS.
- Dès qu'aucune action shopping claire n'est demandée, préfère NOOP.
- Si l'utilisateur veut vider complètement son panier:
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart","mode":"all"}]}
- Si l'utilisateur veut retirer seulement un ou plusieurs produits précis du panier:
  {"intent":"CLEAR_CART","actions":[{"type":"clear_cart","mode":"partial","items":[{"query":"..."}]}]}
- Si l'utilisateur veut passer la commande, finaliser le panier, checkout ou confirmer l'achat:
  {"intent":"EXEC_CART","actions":[{"type":"exec_cart"}]}
- Si l'utilisateur demande des idées, propositions, suggestions, inspiration, conseils d'achat,
  ou quoi choisir sans demander l'ajout direct d'un produit précis:
  {"intent":"DISCOVER_MEALS","actions":[{"type":"discover_meal_ideas","query":"message utilisateur"}]}
- DISCOVER_MEALS doit servir pour les demandes vagues comme santé, végétarien, apéro, petit déjeuner,
  repas rapide, budget, local, dessert ou boissons.
- Si l'utilisateur demande "de quoi faire ..." ou veut préparer un plat / repas / usage,
  retourne NOOP dans ce planner: le flow build_meal est traité ailleurs.

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
- Garde uniquement le cœur utile de la demande produit.
- Si aucune quantité explicite n'est donnée, utilise qty=1.
- Par défaut, si aucune unité explicite n'est écrite dans le message, utilise unit="piece".
- Ne retourne pas noop si une query produit raisonnable peut être déduite.

EXEMPLES DE TRANSFORMATION GÉNÉRALE:
- "Ajoute des courses à mon panier" -> query="courses", qty=1, unit="piece"
- "Ajoute du lait à mon panier" -> query="lait", qty=1, unit="piece"
- "Ajoute du pain à mon panier" -> query="pain", qty=1, unit="piece"
- "Ajoute des tomates à mon panier" -> query="tomates", qty=1, unit="piece"
- "Ajoute du lard à mon panier" -> query="lard", qty=1, unit="piece"
- "Ajoute quelque chose pour l'apéro" -> query="apéro", qty=1, unit="piece"

RÈGLE POUR LES QUANTITÉS:
- Si un nombre est écrit sans unité de poids/volume, garde exactement ce nombre et utilise unit="piece" ; n'invente jamais "g", "kg", "ml", "l", "litre" ou "litres".
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
    {"type":"discover_meal_ideas","query":"Qu'est-ce que tu me proposes aujourd'hui ?"}
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

function plannerPromptAddItems2() {
  return `
Tu es l’Assistant Zélo. Tu es un planner spécialisé ADD_ITEMS.
Ta mission est de transformer le message utilisateur en PLAN JSON strict pour ajouter un ou plusieurs produits au panier.

${plannerPromptOutputRules()}

Actions autorisées:
1) {
     "type":"add_to_cart",
     "items":[
       {
         "query":"...",
         "qty":1,
         "unit":"piece|g|kg|litre|litres"
       }
     ]
   }
2) {"type":"noop","reason":"..."}

IMPORTANT:
- Ton intent principal est ADD_ITEMS.
- Pour add_to_cart, n'invente jamais de productId si l'utilisateur n'en donne pas.
- Si l'utilisateur donne un nom produit, mets-le dans "query".
- Ignore totalement les métadonnées techniques éventuellement visibles dans l'entrée, par exemple:
  "UserRef=...", "UserMessage=...", "local-dev", "anonymous", un email, un id, un token.
- N'utilise jamais ces métadonnées techniques dans "query".
- L'expression "à mon panier", "dans mon panier", "au panier" ou "pour mon panier" indique seulement la destination.
  Elle ne doit jamais créer un produit nommé "panier".
- N'ajoute jamais une query comme "panier", "panier local-dev", "panier anonymous" ou toute autre combinaison
  fabriquée à partir de mots techniques ou de la destination du panier.
- N'utilise "panier" dans "query" que si l'utilisateur demande explicitement un vrai produit dont le nom contient
  ce mot, par exemple "Panier Budget 50", "panier de légumes", "panier de fruits".
- La valeur de "unit" doit être uniquement l'une de: "piece", "g", "kg", "litre", "litres".
- Toute autre valeur est interdite.
- Canonise strictement les unités en sortie:
  "pièce", "pièces", "pieces" -> "piece"
  "gr", "gramme", "grammes", "grams", "grains" -> "g"
  "kilogramme", "kilogrammes" -> "kg"
  "l" -> "litre" ou "litres"
- N'écris jamais autre chose.
- Retourne un seul objet {"type":"add_to_cart"} avec un tableau "items", même si plusieurs produits sont demandés.
- Ne retourne jamais deux actions "add_to_cart" ou plus.
- Tous les produits à ajouter doivent être regroupés dans un seul tableau "items".
- Si plusieurs produits sont demandés, n'ouvre jamais une deuxième action: continue simplement la liste dans le même tableau "items".
- Si le message contient une longue phrase, des politesses, des bullets, des virgules ou des retours à la ligne,
  ignore le bruit conversationnel et extrais uniquement les produits à mettre dans un seul "items".
- Si le message contient une liste de produits, tu dois extraire toutes les lignes utiles de la liste.
- Ne perds jamais les derniers produits d'une liste longue: continue jusqu'à la fin du message.
- Si l'utilisateur corrige sa demande ("non finalement pas de cacahuètes"), tu peux ignorer l'article annulé dans la version finale du plan.
- Si l'utilisateur demande d'ajouter quelque chose au panier, même de manière vague, essaie d'extraire une query produit simple et exploitable.
- La query doit être le nom commun le plus utile pour rechercher le produit dans le catalogue.
- Supprime les déterminants inutiles: "du", "de la", "des", "un", "une", "de", "d’", "d'".
- Garde uniquement le cœur utile de la demande produit.
- Si aucune quantité explicite n'est donnée, utilise qty=1.
- Par défaut, si aucune unité explicite n'est écrite dans le message, utilise unit="piece".
- Si une query produit raisonnable peut être déduite, préfère ADD_ITEMS.
- Si le message ne demande pas réellement un ajout panier, retourne NOOP.

RÈGLE POUR LES QUANTITÉS:
- Si l'utilisateur écrit un nombre sans unité explicite de poids ou volume, conserve ce nombre et utilise unit="piece".
- Si l'utilisateur écrit un poids en grammes, utilise toujours unit="g".
- Si l'utilisateur écrit un poids en kilogrammes, utilise toujours unit="kg".
- Si l'utilisateur écrit un volume en litres, utilise unit="litre" pour 1 et unit="litres" pour 2 ou plus.
- "1 lard de Begnins" -> query="lard de Begnins", qty=1, unit="piece"
- "150g de lard de Begnins" -> query="lard de Begnins", qty=150, unit="g"
- "250 gr de fromage aléatoire gimelan" -> query="fromage aléatoire gimelan", qty=250, unit="g"
- "2kg de pommes" -> query="pommes", qty=2, unit="kg"
- "1 litre de lait normal" -> query="lait normal", qty=1, unit="litre"
- "2 litres de lait sapalet" -> query="lait sapalet", qty=2, unit="litres"
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
"UserRef=local-dev
UserMessage=Ajoute 1 lard de Begnins à mon panier"
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
"Bonjour André, selon les dispos je veux bien stp : 1 panier de fruits classique petit, 1 panier de légumes local moyen, 1 pain balance et 1 gruyère d'alpage"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"panier de fruits classique petit","qty":1,"unit":"piece"},
        {"query":"panier de légumes local moyen","qty":1,"unit":"piece"},
        {"query":"pain balance","qty":1,"unit":"piece"},
        {"query":"gruyère d'alpage","qty":1,"unit":"piece"}
      ]
    }
  ]
}

Message:
"Bonjour André, selon les dispos je veux bien stp :
• 1 panier de fruits classique petit
• 1 panier de légumes local moyen
• 1 pain balance
• 1 gruyère d'alpage
• 1 tomme vaudoise
• 1 beurre frais
Merci bien, Oriana"
Réponse:
{
  "intent":"ADD_ITEMS",
  "actions":[
    {
      "type":"add_to_cart",
      "items":[
        {"query":"panier de fruits classique petit","qty":1,"unit":"piece"},
        {"query":"panier de légumes local moyen","qty":1,"unit":"piece"},
        {"query":"pain balance","qty":1,"unit":"piece"},
        {"query":"gruyère d'alpage","qty":1,"unit":"piece"},
        {"query":"tomme vaudoise","qty":1,"unit":"piece"},
        {"query":"beurre frais","qty":1,"unit":"piece"}
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


export function plannerPromptAddItems() {
  return `
Message déjà classé ADD_ITEMS.
Ta seule tâche: découper les produits demandés.

Réponds uniquement avec ce JSON:
{"intent":"ADD_ITEMS","actions":[{"type":"add_to_cart","items":[{"raw":"..."}]}]}

Règles:
- 1 produit = 1 raw.
- raw = extrait exact copié du message original.
- Garde quantité et unité si elles sont dans cet extrait.
- Ignore salutations, livraison, disponibilité, politesse, signature.
- Ne modifie rien: pas de correction, pas de traduction, pas d’ajout.
- Ne sépare jamais les mots d’un même produit.
- Aucune autre clé.

Exemple:
"Salut, 3l de lait et 2 grands yoghourt Straciatella, merci"
=> {"intent":"ADD_ITEMS","actions":[{"type":"add_to_cart","items":[{"raw":"3l de lait"},{"raw":"2 grands yoghourt Straciatella"}]}]}
`.trim();
}


function plannerPromptClearCart() {
  return `
Tu es l’Assistant Zélo. Tu es un planner spécialisé CLEAR_CART.
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
- Attention: le mot "panier" peut faire partie du nom d'un produit, par exemple
  "Panier Budget 50", "Panier de légumes Bio", "Panier de fruits exotiques".
- Si l'utilisateur demande de supprimer / enlever / retirer un produit précis dont le nom contient "panier",
  cela reste un retrait ciblé en mode "partial", pas un vidage total.
- N'utilise le mode "all" que si la demande parle clairement de tout vider:
  "tout", "rien", "vide", "complètement", "entièrement", "tout le panier".
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
"Supprime 1 panier budget 50"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {
      "type":"clear_cart",
      "mode":"partial",
      "items":[
        {"query":"panier budget 50"}
      ]
    }
  ]
}

Message:
"Retire le panier budget 50 de mon panier"
Réponse:
{
  "intent":"CLEAR_CART",
  "actions":[
    {
      "type":"clear_cart",
      "mode":"partial",
      "items":[
        {"query":"panier budget 50"}
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
Tu es l’Assistant Zélo. Tu es un planner spécialisé SHOW_CART.
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
Tu es l’Assistant Zélo. Tu es un planner spécialisé EXEC_CART.
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

function plannerPromptDiscoverMeals() {
  return discoverPlannerPrompt(fallbackDiscoverPlannerVocabulary());
}

function plannerPromptNoop() {
  return `
Tu es l’Assistant Zélo. Tu es un planner spécialisé NOOP.
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
      return { numPredict: 192, numCtx: 2048 };
    case "clear_cart":
    case "show_cart":
    case "exec_cart":
    case "noop":
      return { numPredict: 96, numCtx: 2048 };
    case "discover_meals":
      return { numPredict: 160, numCtx: 2048 };
    default:
      return { numPredict: 160, numCtx: 2048 };
  }
}

export function buildDiscoverPlanFromPlannerChoices(
  query: string,
  choices: ReturnType<typeof normalizeDiscoverPlannerChoices>
): Plan {
  return {
    intent: "DISCOVER_MEALS",
    actions: [
      {
        type: "discover_meal_ideas",
        query,
        ...(choices.needs.length ? { needHints: choices.needs } : {}),
        ...(choices.roles.length ? { roleHints: choices.roles } : {}),
      },
    ],
  };
}

async function planDiscoverUserIntent(
  userRef: string,
  normalizedUserText: string,
  intentHint?: FrontendIntentHint
): Promise<Plan> {
  const training = await loadDiscoverTrainingArtifacts();
  const vocabulary = discoverPlannerVocabularyFromTraining(training);
  const plannerBudget = selectPlannerBudget(intentHint);
  const selectedPrompt = discoverPlannerPrompt(vocabulary);
  const raw = await timeAsync(
    "planner.ollama_chat",
    async () =>
      await ollamaChat(
        [
          { role: "system", content: selectedPrompt },
          { role: "user", content: `UserRef=${userRef}\nUserMessage=${normalizedUserText}` },
        ],
        0,
        {
          model: env.ollamaPlannerModel,
          format: discoverPlannerJsonSchema(vocabulary),
          keepAlive: "30m",
          numPredict: plannerBudget.numPredict,
          numCtx: plannerBudget.numCtx,
        }
      )
  );
  const parsed = timeSync(
    "planner.safe_json_parse",
    () => safeJsonParse<unknown>(raw)
  );
  const choices = timeSync(
    "planner.normalize_discover_choices",
    () => enrichDiscoverPlannerChoicesFromQuery(
      normalizedUserText,
      filterDiscoverPlannerChoicesByQuery(
        normalizedUserText,
        normalizeDiscoverPlannerChoices(parsed, vocabulary)
      ),
      vocabulary
    )
  );
  const plan = buildDiscoverPlanFromPlannerChoices(normalizedUserText, choices);

  console.log("[PLAN RAW]", raw);
  console.log("[PLAN DISCOVER VOCAB]", JSON.stringify(vocabulary));
  console.log("[PLAN PARSED]", JSON.stringify(plan, null, 2));
  console.log("[PLANNER HINT]", JSON.stringify(intentHint ?? null));

  return plan;
}


export async function planUserIntent(
  userRef: string,
  userText: string,
  intentHint?: FrontendIntentHint
): Promise<Plan | null> {
  const normalizedUserText = normalizePlannerUserText(userText);

  if (intentHint?.actionKey === "discover_meals") {
    const plan = await planDiscoverUserIntent(userRef, normalizedUserText, intentHint);
    if (normalizedUserText !== userText) {
      console.log("[PLANNER USER TEXT NORMALIZED]", normalizedUserText);
    }
    return plan;
  }

  const selectedPrompt = selectPlannerPrompt(intentHint);
  const plannerBudget = selectPlannerBudget(intentHint);

  const raw = await timeAsync(
    "planner.ollama_chat",
    async () =>
      await ollamaChat(
        [
          { role: "system", content: selectedPrompt },
          { role: "user", content: `UserRef=${userRef}\nUserMessage=${normalizedUserText}` },
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
  if (normalizedUserText !== userText) {
    console.log("[PLANNER USER TEXT NORMALIZED]", normalizedUserText);
  }

  return normalized;
}
