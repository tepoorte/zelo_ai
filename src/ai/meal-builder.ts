import { env } from "../config/env.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";

type MealIngredient = {
  query: string;
  qty: number;
  unit?: string;
  role?: string;
  optional?: boolean;
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
      optional: !!x.optional,
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
Tu es un assistant courses intelligent.

Ta mission:
Transformer un repas ou usage en une liste d'ingrédients plausibles
qui peuvent être cherchés dans un catalogue e-commerce alimentaire.

RÈGLES:
- Réponds uniquement avec du JSON valide.
- Structure EXACTE:
{
  "meal": "...",
  "ingredients": [
    {
      "query": "...",
      "qty": 1,
      "unit": "piece",
      "role": "...",
      "optional": false
    }
  ]
}

RÈGLES IMPORTANTES:
- Ne répète PAS le nom du plat comme ingrédient, sauf si le plat est lui-même un produit directement achetable dans un catalogue.
- Pour un plat composé, décompose-le en éléments concrets à acheter.
- Utilise des noms simples et utiles pour une recherche catalogue.
- 2 à 6 ingrédients max.
- Mets les éléments indispensables en optional=false.
- Les sauces, toppings, accompagnements peuvent être optional=true.
- Ne mets jamais de productId.
- Réponds en français.
- Évite les accompagnements non essentiels si le cœur du plat n'est pas encore couvert.
- Priorité: base du plat + protéine/élément principal + condiment principal éventuel.

EXEMPLES:

Repas: hot dog
Réponse:
{
  "meal": "hot dog",
  "ingredients": [
    { "query": "pain hot dog", "qty": 2, "unit": "piece", "role": "base", "optional": false },
    { "query": "saucisse", "qty": 2, "unit": "piece", "role": "principal", "optional": false },
    { "query": "moutarde", "qty": 1, "unit": "piece", "role": "condiment", "optional": true }
  ]
}

Repas: burger
Réponse:
{
  "meal": "burger",
  "ingredients": [
    { "query": "pain burger", "qty": 2, "unit": "piece", "role": "base", "optional": false },
    { "query": "steak haché", "qty": 2, "unit": "piece", "role": "principal", "optional": false },
    { "query": "fromage burger", "qty": 1, "unit": "piece", "role": "garniture", "optional": true }
  ]
}

Repas: sandwich
Réponse:
{
  "meal": "sandwich",
  "ingredients": [
    { "query": "pain de mie", "qty": 1, "unit": "piece", "role": "base", "optional": false },
    { "query": "jambon", "qty": 1, "unit": "piece", "role": "principal", "optional": false },
    { "query": "fromage", "qty": 1, "unit": "piece", "role": "garniture", "optional": true }
  ]
}

Repas: fondue
Réponse:
{
  "meal": "fondue",
  "ingredients": [
    { "query": "fondue", "qty": 1, "unit": "piece", "role": "principal", "optional": false },
    { "query": "pain", "qty": 1, "unit": "piece", "role": "base", "optional": false }
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