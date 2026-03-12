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
Transformer une demande vague de repas / usage en une liste d'ingrédients plausibles
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

- Utilise des mots simples utilisables pour une recherche catalogue.
- 2 à 6 ingrédients max.
- Toujours inclure les éléments essentiels.
- Les condiments peuvent être optional=true.
- Jamais de productId.
- Réponds en français.
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

  return parsed.ingredients
    .filter((x) => x?.query && typeof x.query === "string")
    .map((x) => ({
      query: String(x.query).trim(),
      qty: Number(x.qty ?? 1),
      unit: x.unit ? String(x.unit) : "piece",
      role: x.role ? String(x.role) : undefined,
      optional: !!x.optional,
    }));
}