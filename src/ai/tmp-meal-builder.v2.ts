/*import { env } from "../config/env.js";
import type { MealBuildPlanV2, MealIngredientV2 } from "./meal-types.v2.js";

type OllamaMealResponseV2 = {
  meal: string;
  servings: number;
  ingredients: MealIngredientV2[];
};

function cleanJsonBlock(input: string): string {
  return input
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}
function normalizeLigatures(input: string): string {
  return input
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "oe");
}
function normalizeIngredient(raw: Partial<MealIngredientV2>, meal: string): MealIngredientV2 {
  return {
    label: normalizeLigatures(String(raw.label || "").trim()),
    canonicalLabel: normalizeLigatures(String(raw.canonicalLabel || raw.label || "").trim().toLowerCase()),
    qty: Number(raw.qty || 1),
    unit: raw.unit ? String(raw.unit) : "piece",
    role: raw.role || "other",
    optional: Boolean(raw.optional),
    isCore: Boolean(raw.isCore),
    mealContext: raw.mealContext || meal,
    notes: raw.notes ? String(raw.notes) : undefined,
    matchingHints: {
      synonyms: Array.isArray(raw.matchingHints?.synonyms)
        ? raw.matchingHints!.synonyms.map(String).map(s => s.trim()).filter(Boolean)
        : [],
      broaderTerms: Array.isArray(raw.matchingHints?.broaderTerms)
        ? raw.matchingHints!.broaderTerms.map(String).map(s => s.trim()).filter(Boolean)
        : [],
      narrowerTerms: Array.isArray(raw.matchingHints?.narrowerTerms)
        ? raw.matchingHints!.narrowerTerms.map(String).map(s => s.trim()).filter(Boolean)
        : [],
      avoidTerms: Array.isArray(raw.matchingHints?.avoidTerms)
        ? raw.matchingHints!.avoidTerms.map(String).map(s => s.trim()).filter(Boolean)
        : [],
      preferredCategoryIds: Array.isArray(raw.matchingHints?.preferredCategoryIds)
        ? raw.matchingHints!.preferredCategoryIds.map(String)
        : [],
      forbiddenCategoryIds: Array.isArray(raw.matchingHints?.forbiddenCategoryIds)
        ? raw.matchingHints!.forbiddenCategoryIds.map(String)
        : [],
      preferredCategoryNames: Array.isArray(raw.matchingHints?.preferredCategoryNames)
        ? raw.matchingHints!.preferredCategoryNames.map(String)
        : [],
      forbiddenCategoryNames: Array.isArray(raw.matchingHints?.forbiddenCategoryNames)
        ? raw.matchingHints!.forbiddenCategoryNames.map(String)
        : [],
      productForm: raw.matchingHints?.productForm || "unknown",
    },
  };
}

function validatePlan(data: unknown, meal: string, servings: number): MealBuildPlanV2 {
  const obj = (data || {}) as Partial<OllamaMealResponseV2>;
  const ingredients = Array.isArray(obj.ingredients) ? obj.ingredients : [];

  return {
    meal: String(obj.meal || meal),
    servings: Number(obj.servings || servings),
    ingredients: ingredients
      .map(i => normalizeIngredient(i, meal))
      .filter(i => i.label.length > 0),
  };
}

export async function buildMealIngredientsV2(
  meal: string,
  servings = 1
): Promise<MealBuildPlanV2> {
  const system = `
Tu es un assistant spécialisé dans la décomposition de plats
en ingrédients réellement recherchables dans un catalogue e-commerce alimentaire.

OBJECTIF:
Maximiser les chances de matching EXACT avec des produits catalogue.

Tu dois penser comme un moteur de recherche produit, PAS comme un chef.

--------------------------------------------------
RÈGLES FONDAMENTALES
--------------------------------------------------

- Propose uniquement des ingrédients simples et achetables.
- Évite les formulations culinaires abstraites.
- Évite les ingrédients incertains ou sophistiqués.
- Ne propose jamais de plats préparés.
- Ne propose jamais de sandwichs, paninis, pizzas prêtes, menus.
- Si un ingrédient n’est pas sûr → NE PAS le proposer.
- Préfère des termes catalog-friendly.

IMPORTANT:
Un ingrédient CORE doit être indispensable.
Un ingrédient OPTIONAL doit rester plausible.

--------------------------------------------------
BONNES DÉCOMPOSITIONS (EXEMPLES)
--------------------------------------------------

Plat: carbonara

OK:
- spaghetti (core)
- oeufs (core)
- jambon ou lard (core)
- parmesan (optional)

PAS OK:
- crème
- beurre
- sauce carbonara
- panini jambon
- salade de pâtes


Plat: hot dog

OK:
- saucisse (core)
- pain hot dog (core)
- ketchup (optional)
- moutarde (optional)

PAS OK:
- sandwich hot dog
- menu hot dog
- pizza hot dog
- snack préparé


Plat: pizza margherita maison

OK:
- farine pizza (core)
- sauce tomate (core)
- mozzarella (core)

OPTIONAL:
- tomate fraîche
- basilic

PAS OK:
- pizza margherita prête
- panini mozzarella
- sandwich tomate


Plat: fondue

OK:
- fromage fondue ou fromage (core)
- pain (core)
- vin blanc (optional)

PAS OK:
- plateau fromage apéro
- sandwich fromage
- vinaigre blanc


Plat: omelette

OK:
- oeufs (core)
OPTIONAL:
- fromage
- jambon
- oignons

PAS OK:
- croissant
- dessert
- glace


--------------------------------------------------
MATCHING HINTS
--------------------------------------------------

- synonyms = variantes catalogue probables
- broaderTerms = termes plus généraux
- avoidTerms = produits composés ou pièges catalogue

--------------------------------------------------
CATÉGORIES À PRIVILÉGIER
--------------------------------------------------

- lait fromages oeufs
- boulangerie patisseries
- fruits legumes
- farines cereales noix
- feculents
- viande poisson
- epices huiles sauces

--------------------------------------------------
CATÉGORIES À ÉVITER
--------------------------------------------------

- menus pizzas
- boissons
- contenants
- cosmetiques hygiene
- menage accessoires

--------------------------------------------------
FORMAT OBLIGATOIRE JSON
--------------------------------------------------

Retourne UNIQUEMENT du JSON valide.

{
  "meal": "...",
  "servings": 2,
  "ingredients": [
    {
      "label": "spaghetti",
      "canonicalLabel": "spaghetti",
      "qty": 1,
      "unit": "piece",
      "role": "base",
      "optional": false,
      "isCore": true,
      "mealContext": "carbonara",
      "notes": "",
      "matchingHints": {
        "synonyms": ["pates spaghetti"],
        "broaderTerms": ["pates"],
        "narrowerTerms": [],
        "avoidTerms": ["plat prepare","salade","menu"],
        "preferredCategoryIds": [],
        "forbiddenCategoryIds": [],
        "preferredCategoryNames": ["feculents"],
        "forbiddenCategoryNames": ["menus pizzas","boissons","contenants"],
        "productForm": "ingredient"
      }
    }
  ]
}
`.trim();

  const user = `
Plat: ${meal}
Nombre de portions: ${servings}

Décompose ce plat en ingrédients réalistes pour un panier de courses.
Évite les produits préparés.
Retourne seulement du JSON.
`.trim();

  const resp = await fetch(`${env.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: env.ollamaModel,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: {
        temperature: 0.2,
      },
      format: "json",
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Meal builder v2 failed: ${resp.status} ${txt}`);
  }

  const data = (await resp.json()) as {
    message?: { content?: string };
  };

  const raw = cleanJsonBlock(data?.message?.content || "{}");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("[BUILD_MEAL_V2 RAW]", raw);
    throw new Error(`Meal builder v2 JSON parse failed: ${(err as Error).message}`);
  }

  const plan = validatePlan(parsed, meal, servings);
  console.log("[BUILD_MEAL_V2 INGREDIENTS]", plan.ingredients);

  return plan;
}*/