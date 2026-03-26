import { env } from "../../config/env.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";
/*
type MealIngredient = {
  query: string;
  qty: number;
  unit?: string;
  role?: string;
  optional?: boolean;
};
*/
type MealIngredient = {
  query: string;
  qty: number;
  unit?: string;
  role?: string;
  description?: string;
  usageContext?: string;
  constraints?: string;
  priority?: number;
  isCore?: boolean;
};

type MealBuildResult = {
  meal: string;
  ingredients: MealIngredient[];
};

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

function normalizeLoose(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeLoose(text)
      .split(" ")
      .filter((w) => w.length > 2)
  );
}

function overlapRatio(a: string, b: string): number {
  const aSet = tokenSet(a);
  const bSet = tokenSet(b);

  if (!aSet.size || !bSet.size) return 0;

  let overlap = 0;
  for (const t of aSet) {
    if (bSet.has(t)) overlap++;
  }

  return overlap / Math.max(aSet.size, bSet.size);
}

function cleanMealIngredients(meal: string, ingredients: MealIngredient[]): MealIngredient[] {
  const normalizedMeal = normalizeLoose(meal);
  const cleaned = ingredients
    .filter((x) => x?.query && typeof x.query === "string")
    .map((x) => ({
      query: String(x.query).trim(),
      qty: Number(x.qty ?? 1),
      unit: x.unit ? String(x.unit) : "piece",
      role: x.role ? String(x.role) : undefined,
      description: x.description ? String(x.description) : undefined,
      usageContext: x.usageContext ? String(x.usageContext) : undefined,
      constraints: x.constraints
  ? String(x.constraints)
  : "ne doit pas être un plat préparé, une boisson ou un dessert",
      priority: typeof x.priority === "number" ? x.priority : Number(x.priority ?? 0.5),
      isCore: !!x.isCore,
    }))
    .filter((x) => x.query.length > 1)
    .filter((x) => {
      const normalizedQuery = normalizeLoose(x.query);

      if (!normalizedQuery) return false;

      // Évite juste les copies quasi exactes du nom du plat
      // sans hardcoder des plats particuliers.
      const sameString = normalizedQuery === normalizedMeal;
      const tooClose = overlapRatio(normalizedQuery, normalizedMeal) >= 0.95;

      if (sameString || tooClose) {
        // on garde seulement si le modèle a explicitement marqué ça comme principal
        // et qu’il n’y a pas d’autre ingrédient meilleur
        return false;
      }

      return true;
    });

  const dedup = new Map<string, MealIngredient>();

  for (const item of cleaned) {
    const key = normalizeLoose(item.query);
    if (!dedup.has(key)) {
      dedup.set(key, item);
    }
  }

  return [...dedup.values()];
}

/**
 * Costruisce ingredienti plausibili per un "meal intent"
 * es: hot dog → pain hot dog + saucisse + moutarde
 */
export async function buildMealIngredients(
  meal: string,
  servings = 2
): Promise<MealIngredient[]> {
  const messages = [
    {
      role: "system",
content: `
Tu es un assistant courses intelligent spécialisé dans la décomposition sémantique de repas.

Ta mission:
Transformer un repas ou une intention culinaire en une liste d’ingrédients réels et achetables,
décrits de manière suffisamment précise pour permettre un matching NLP vectoriel avec un catalogue e-commerce.

Tu ne connais PAS le catalogue.
Tu dois donc décrire les ingrédients de façon sémantique, concrète et discriminante.

Tu dois produire UNIQUEMENT du JSON valide.

STRUCTURE EXACTE:

{
  "meal": "...",
  "ingredients": [
    {
      "query": "...",
      "qty": 1,
      "unit": "piece",
      "role": "...",
      "description": "...",
      "usageContext": "...",
      "constraints": "...",
      "priority": 1,
      "isCore": true
    }
  ]
}

RÈGLES IMPORTANTES:

- Ne répète PAS le nom du plat comme ingrédient sauf si le plat est réellement vendu comme produit.
- Décompose toujours un plat en éléments culinaires réels.
- Utilise des noms simples et naturels (ex: "oeufs", "riz", "pain", "crème").
- 3 à 6 ingrédients maximum.
- Le champ "constraints" doit être spécifique à l’ingrédient.
- N’utilise pas de contrainte générique.
- Mentionne au moins 2 exclusions concrètes liées au faux matching probable.
- La query doit être aussi spécifique que possible.
- Préfère "spaghetti secs", "oeufs entiers", "fromage râpé affiné", "lardons fumés" plutôt que des termes trop larges.
- Priorité:
  - base du plat
  - élément protéique ou central
  - liant / sauce principale
  - garnitures secondaires

DESCRIPTION (champ critique):

- Doit ressembler à une vraie description produit alimentaire.
- Doit préciser:
  - nature de l’ingrédient (viande crue, fromage râpé, pâte sèche…)
  - forme ou état (tranches, entier, râpé, cru, cuit…)
  - usage principal (cuisson, salade froide, pâtisserie…)
- Doit aider à distinguer cet ingrédient d’autres produits proches.

USAGE CONTEXT:

- Décrit comment l’ingrédient est utilisé dans CE plat.
- Exemple: "mélangé avec des pâtes chaudes", "utilisé cru en garniture", "fondu dans une sauce".

NEGATIVE CONSTRAINTS (très important):

- Décrit ce que l’ingrédient ne doit PAS être.
- Sert à éviter les faux matchs sémantiques.
- Exemple:
  - "ne doit pas être une viande préparée ou un plat cuisiné"
  - "ne doit pas contenir de boeuf"
  - "ne doit pas être un dessert ou un produit sucré"
  - "ne doit pas être une boisson"

PRIORITY:

- Score entre 0 et 1.
- 1 = indispensable pour reconnaître le plat.
- 0.4-0.7 = secondaire.

ISCORE:

- true si sans cet ingrédient le plat n’a plus son identité.

AUTRES RÈGLES:

- N’utilise PAS de classification rigide (pas de catégories techniques).
- N’invente PAS d’ingrédients absurdes.
- Évite les formulations marketing.
- Évite les termes trop vagues (ex: "aliment", "produit").
- Favorise la précision culinaire.

EXEMPLES:

Repas: carbonara

{
  "meal": "carbonara",
  "ingredients": [
    {
      "query": "spaghetti",
      "qty": 2,
      "unit": "portion",
      "role": "base",
      "description": "Pâtes alimentaires sèches longues à base de blé dur destinées à être cuites dans l’eau pour préparation de plats chauds.",
      "usageContext": "mélangées avec une sauce chaude à base d'oeufs et de fromage",
      "negativeConstraints": "ne doit pas être un plat préparé ni contenir déjà de la viande ou de la sauce",
      "priority": 1,
      "isCore": true
    },
    {
      "query": "oeufs",
      "qty": 2,
      "unit": "piece",
      "role": "liant",
      "description": "Produit alimentaire brut issu de la ponte de poules, utilisé entier ou battu pour créer des sauces ou des préparations culinaires.",
      "usageContext": "émulsionnés avec fromage et chaleur des pâtes pour former une sauce",
      "negativeConstraints": "ne doit pas être de la viande ni un produit contenant du boeuf ou du tartare",
      "priority": 1,
      "isCore": true
    },
    {
      "query": "fromage râpé affiné",
      "qty": 1,
      "unit": "portion",
      "role": "garniture",
      "description": "Fromage affiné sec destiné à être râpé ou utilisé déjà râpé pour incorporation dans des sauces ou plats de pâtes chauds.",
      "usageContext": "mélangé à une sauce chaude pour pâtes et utilisé en finition",
      "constraints": "ne doit pas être un pain garni au fromage, ni un snack, ni une préparation boulangère",
      "priority": 0.8,
      "isCore": true
    },
    {
      "query": "lardons",
      "qty": 1,
      "unit": "portion",
      "role": "protéine",
      "description": "Petits morceaux de viande de porc salée ou fumée destinés à être poêlés pour garnir des plats chauds.",
      "usageContext": "cuits puis mélangés aux pâtes",
      "negativeConstraints": "ne doit pas être du jambon dans un sandwich ni un plat préparé",
      "priority": 0.7,
      "isCore": false
    }
  ]
}
`,
    },
    {
      role: "user",
      content: `Repas ou usage: ${meal}\nNombre de portions: ${servings}`,
    },
  ];

  const raw = await ollamaChat(messages, 0.2);

  const parsed = safeJsonParse<MealBuildResult>(raw);

  if (!parsed?.ingredients || !Array.isArray(parsed.ingredients)) {
    return [];
  }

  return cleanMealIngredients(meal, parsed.ingredients);
}