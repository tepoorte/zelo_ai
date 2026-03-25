import { env } from "../config/env.js";
import type { MealIngredientV2, MealPlanV2, ProductDocV2, RankedCandidateV2 } from "./MealBuildEngine.v2.js";

export class MealBuildHelpersV2 {
  static FOOD_CATEGORY_IDS = new Set([
    "5dcfc1616f4a93324a0a2b1a",
    "5dcfddcb6f4a93324a0a2b1e",
    "5dcfde1f6f4a93324a0a2b1f",
    "5dcfde5d6f4a93324a0a2b20",
    "5dcfdec16f4a93324a0a2b21",
    "5dcfdf0e6f4a93324a0a2b22",
    "5dcfdf4c6f4a93324a0a2b23",
  ]);

  static PREPARED_CATEGORY_IDS = new Set([
    "5f00d2cda5761c0007833362",
  ]);

  static EXCLUDED_CATEGORY_IDS = new Set([
    "5dcfdf736f4a93324a0a2b24",
    "5dcfdf906f4a93324a0a2b25",
    "5dea5c3d7e6ac104dac9fde2",
    "5f718b85d9f31d00075c9899",
  ]);

  static CATEGORY_NAME_BY_ID: Record<string, string> = {
    "5dcfc1616f4a93324a0a2b1a": "lait fromages oeufs",
    "5dcfddcb6f4a93324a0a2b1e": "boulangerie patisseries",
    "5dcfde1f6f4a93324a0a2b1f": "fruits legumes",
    "5dcfde5d6f4a93324a0a2b20": "farines cereales noix",
    "5dcfdec16f4a93324a0a2b21": "feculents",
    "5dcfdf0e6f4a93324a0a2b22": "viande poisson",
    "5dcfdf4c6f4a93324a0a2b23": "epices huiles sauces",
    "5f00d2cda5761c0007833362": "menus pizzas",
    "5dcfdf736f4a93324a0a2b24": "cosmetiques hygiene",
    "5dcfdf906f4a93324a0a2b25": "menage accessoires",
    "5dea5c3d7e6ac104dac9fde2": "boissons",
    "5f718b85d9f31d00075c9899": "contenants",
  };

  static normalizeText(input?: string | null) {
    if (!input) return "";
    return input
      .normalize("NFD")
      .replace(/\p{Diacritic}+/gu, "")
      .replace(/œ/gi, "oe")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static normalizeIngredient(raw: Partial<MealIngredientV2>, meal: string): MealIngredientV2 {
    const rawRole = String(raw.role || "other").toLowerCase();
    const role: MealIngredientV2["role"] =
      rawRole === "base" ||
      rawRole === "principal" ||
      rawRole === "garniture" ||
      rawRole === "condiment" ||
      rawRole === "sauce" ||
      rawRole === "side" ||
      rawRole === "other"
        ? rawRole
        : "other";

    return {
      label: this.normalizeText(String(raw.label || "")),
      canonicalLabel: this.normalizeText(String(raw.canonicalLabel || raw.label || "")),
      qty: Number(raw.qty || 1),
      unit: raw.unit ? String(raw.unit) : "piece",
      role,
      optional: Boolean(raw.optional),
      isCore: Boolean(raw.isCore),
      mealContext: raw.mealContext || meal,
      matchingHints: {
        synonyms: (raw.matchingHints?.synonyms || [])
          .map(x => this.normalizeText(x))
          .filter(Boolean),
        broaderTerms: (raw.matchingHints?.broaderTerms || [])
          .map(x => this.normalizeText(x))
          .filter(Boolean),
        avoidTerms: (raw.matchingHints?.avoidTerms || [])
          .map(x => this.normalizeText(x))
          .filter(Boolean),
        preferredCategoryNames: (raw.matchingHints?.preferredCategoryNames || [])
          .map(x => this.normalizeText(x))
          .filter(Boolean),
        forbiddenCategoryNames: (raw.matchingHints?.forbiddenCategoryNames || [])
          .map(x => this.normalizeText(x))
          .filter(Boolean),
        productForm: raw.matchingHints?.productForm || "unknown",
      },
    };
  }

static parseMealPlan(raw: string, fallbackMeal: string, fallbackServings: number): MealPlanV2 {
  const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(clean || "{}") as any;

  const meal = String(parsed.meal || parsed.nom || fallbackMeal);
  const servings = Number(parsed.servings || parsed.portions || fallbackServings);

  let ingredients: any[] = [];

  if (Array.isArray(parsed.ingredients)) {
    ingredients = parsed.ingredients;
  } else if (parsed.ingredients && typeof parsed.ingredients === "object") {
    const groups = parsed.ingredients;

    const pushGroup = (
  arr: any[],
  role: MealIngredientV2["role"],
  optional: boolean,
  isCore: boolean
) => {
  for (const item of arr || []) {
    if (typeof item === "string") {
      ingredients.push({
        label: item,
        canonicalLabel: item,
        qty: 1,
        unit: "piece",
        role,
        optional,
        isCore,
        matchingHints: {
          synonyms: [],
          broaderTerms: [],
          avoidTerms: [],
          preferredCategoryNames: [],
          forbiddenCategoryNames: [],
          productForm: "ingredient",
        },
      });
      continue;
    }

    if (item && typeof item === "object") {
      const label = String(item.label || item.nom || "").trim();
      const qty = Number(item.qty || item.quantite || 1);

      if (!label) continue;

      ingredients.push({
        label,
        canonicalLabel: label,
        qty,
        unit: "piece",
        role,
        optional,
        isCore,
        matchingHints: {
          synonyms: [],
          broaderTerms: [],
          avoidTerms: [],
          preferredCategoryNames: [],
          forbiddenCategoryNames: [],
          productForm: "ingredient",
        },
      });
    }
  }
};

pushGroup(groups.base || [], "base", false, true);
pushGroup(groups.principal || [], "principal", false, true);
pushGroup(groups.garniture || [], "garniture", true, false);
pushGroup(groups.options || [], "condiment", true, false);
pushGroup(groups.accessoires || [], "condiment", true, false);
  }

  return {
    meal,
    servings,
    ingredients: ingredients
      .map(i => this.normalizeIngredient(i, meal))
      .filter(i => i.label),
  };
}

  static classifyBucket(categories: string[]) {
    if (!categories?.length) return "uncategorized" as const;
    if (categories.some(c => this.EXCLUDED_CATEGORY_IDS.has(c))) return "exclude" as const;
    if (categories.some(c => this.PREPARED_CATEGORY_IDS.has(c))) return "prepared" as const;
    if (categories.some(c => this.FOOD_CATEGORY_IDS.has(c))) return "food" as const;
    return "uncategorized" as const;
  }

  static toProductDoc(product: any): ProductDocV2 {
    const categoryIds = (product.categories || []).map(String);
    const categoryNames = categoryIds
      .map((id: string) => this.normalizeText(this.CATEGORY_NAME_BY_ID[id] || ""))
      .filter(Boolean);

    return {
      id: String(product.id),
      product,
      normalizedName: this.normalizeText(product.name),
      normalizedCategoryIds: categoryIds,
      normalizedCategoryNames: categoryNames,
      bucket: this.classifyBucket(categoryIds),
    };
  }

  static async embedText(input: string): Promise<number[]> {
    const text = input.trim();
    if (!text) return [];

    const resp = await fetch(`${env.ollamaBaseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: text,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Embedding failed: ${resp.status} ${txt}`);
    }

    const data = (await resp.json()) as { embedding?: number[] };
    return data.embedding || [];
  }

  static cosineSimilarity(a: number[], b: number[]) {
    if (!a.length || !b.length || a.length !== b.length) return 0;

    let dot = 0;
    let na = 0;
    let nb = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }

    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  static lexicalScore(ingredient: MealIngredientV2, doc: ProductDocV2) {
    const terms = [
      ingredient.label,
      ingredient.canonicalLabel,
      ...(ingredient.matchingHints?.synonyms || []),
      ...(ingredient.matchingHints?.broaderTerms || []),
    ]
      .filter(Boolean)
      .map(t => this.normalizeText(t));

    if (!terms.length) return 0;

    let score = 0;

    for (const term of terms) {
      if (doc.normalizedName === term) score += 1.2;
      else if (
        doc.normalizedName.startsWith(term + " ") ||
        doc.normalizedName.endsWith(" " + term)
      ) score += 1.0;
      else if (doc.normalizedName.includes(term)) score += 0.6;
    }

    return score / terms.length;
  }

  static semanticScore(queryVec: number[], nameVec: number[]) {
    return this.cosineSimilarity(queryVec, nameVec);
  }

  static categoryScore(ingredient: MealIngredientV2, doc: ProductDocV2) {
    let score = 0;
    const preferred = ingredient.matchingHints?.preferredCategoryNames || [];
    const forbidden = ingredient.matchingHints?.forbiddenCategoryNames || [];

    if (preferred.some(p => doc.normalizedCategoryNames.some(c => c.includes(p)))) {
      score += 0.5;
    }

    if (forbidden.some(f => doc.normalizedCategoryNames.some(c => c.includes(f)))) {
      score -= 0.9;
    }

    if (doc.bucket === "prepared") score -= 0.8;
    if (doc.bucket === "uncategorized") score -= 0.2;

    return score;
  }

  static penaltyScore(ingredient: MealIngredientV2, doc: ProductDocV2) {
    let p = 0;
    const avoid = ingredient.matchingHints?.avoidTerms || [];

    if (avoid.some(t => doc.normalizedName.includes(t))) p += 1.0;

    if (
      doc.bucket === "prepared" &&
      (ingredient.isCore || ingredient.matchingHints?.productForm === "ingredient")
    ) {
      p += 1.0;
    }

    return p;
  }

static decideConfidence(
  ingredient: MealIngredientV2,
  candidate: RankedCandidateV2
): "EXACT" | "GOOD" | "WEAK" | "NONE" {
  const terms = [
    ingredient.label,
    ingredient.canonicalLabel,
    ...(ingredient.matchingHints?.synonyms || []),
  ]
    .filter(Boolean)
    .map(t => this.normalizeText(t));

  const strongLexical = terms.some(t => candidate.doc.normalizedName.includes(t));

  if (ingredient.isCore && !strongLexical) return "NONE";
  if (ingredient.isCore && candidate.lexicalScore >= 0.5) return "GOOD";
  if (candidate.score >= 0.75 && strongLexical) return "EXACT";
  if (candidate.score >= 0.55 && strongLexical) return "GOOD";
  if (!ingredient.isCore && candidate.score >= 0.45) return "WEAK";
  return "NONE";
}

  static hasEnoughCoverage(
    allIngredients: MealIngredientV2[],
    acceptedIngredients: MealIngredientV2[]
  ) {
    const core = allIngredients.filter(i => i.isCore);
    const acceptedCore = acceptedIngredients.filter(i => i.isCore);

    if (!core.length) return acceptedIngredients.length > 0;
    return acceptedCore.length / core.length >= 0.7;
  }

  static buildUserMessage(
    meal: string,
    added: Array<{ productName: string }>,
    missing: Array<{ ingredient: string }>,
    coverageOk: boolean
  ) {
    const lines: string[] = [];

    if (added.length) {
      lines.push(`J’ai ajouté pour "${meal}" :`);
      for (const a of added) lines.push(`- ${a.productName}`);
    }

    if (missing.length) {
      lines.push(`Ingrédients manquants :`);
      for (const m of missing) lines.push(`- ${m.ingredient}`);
    }

    if (!coverageOk && !missing.length) {
      lines.push(`Je n’ai pas trouvé assez d’ingrédients fiables pour "${meal}".`);
    }

    return lines.join("\n") || `Je n’ai pas trouvé d’ingrédients fiables pour "${meal}".`;
  }

static buildPlannerSystemPrompt() {
  return `
Tu es un assistant spécialisé dans la décomposition de plats
en ingrédients recherchables dans un catalogue alimentaire.

IMPORTANT:
Tu dois retourner STRICTEMENT un JSON avec EXACTEMENT cette structure:

{
  "meal": "string",
  "servings": 2,
  "ingredients": [
    {
      "label": "string",
      "canonicalLabel": "string",
      "qty": 1,
      "unit": "piece",
      "role": "base",
      "optional": false,
      "isCore": true,
      "mealContext": "string",
      "matchingHints": {
        "synonyms": [],
        "broaderTerms": [],
        "avoidTerms": [],
        "preferredCategoryNames": [],
        "forbiddenCategoryNames": [],
        "productForm": "ingredient"
      }
    }
  ]
}

RÈGLES OBLIGATOIRES:
- Utilise les clés EXACTES: meal, servings, ingredients
- ingredients doit être un ARRAY
- N'utilise JAMAIS: nom, quantite, portions, accessoires, options, base comme objet
- N'utilise JAMAIS une structure imbriquée pour ingredients
- Chaque ingrédient doit être un objet complet dans le tableau ingredients
- L’unité doit TOUJOURS être "piece" et la qty doit représenter un NOMBRE DE PRODUITS (jamais grammes, kg, ml, litres).
- Retourne uniquement du JSON valide
- Aucun texte avant ou après

EXEMPLE CORRECT pour "hot dog":
{
  "meal": "hot dog",
  "servings": 2,
  "ingredients": [
    {
      "label": "saucisse",
      "canonicalLabel": "saucisse",
      "qty": 1,
      "unit": "piece",
      "role": "base",
      "optional": false,
      "isCore": true,
      "mealContext": "hot dog",
      "matchingHints": {
        "synonyms": ["vienne", "saucisse de vienne"],
        "broaderTerms": [],
        "avoidTerms": ["sandwich", "menu", "panini", "pizza"],
        "preferredCategoryNames": ["viande poisson"],
        "forbiddenCategoryNames": ["menus pizzas", "boissons", "contenants"],
        "productForm": "ingredient"
      }
    },
    {
      "label": "pain hot dog",
      "canonicalLabel": "pain hot dog",
      "qty": 1,
      "unit": "piece",
      "role": "base",
      "optional": false,
      "isCore": true,
      "mealContext": "hot dog",
      "matchingHints": {
        "synonyms": ["bun", "pain saucisse"],
        "broaderTerms": ["pain"],
        "avoidTerms": ["sandwich", "panini", "croissant"],
        "preferredCategoryNames": ["boulangerie patisseries"],
        "forbiddenCategoryNames": ["menus pizzas", "contenants"],
        "productForm": "ingredient"
      }
    },
    {
      "label": "ketchup",
      "canonicalLabel": "ketchup",
      "qty": 1,
      "unit": "piece",
      "role": "condiment",
      "optional": true,
      "isCore": false,
      "mealContext": "hot dog",
      "matchingHints": {
        "synonyms": [],
        "broaderTerms": ["sauce"],
        "avoidTerms": [],
        "preferredCategoryNames": ["epices huiles sauces"],
        "forbiddenCategoryNames": ["boissons", "contenants"],
        "productForm": "condiment"
      }
    },
    {
      "label": "moutarde",
      "canonicalLabel": "moutarde",
      "qty": 1,
      "unit": "piece",
      "role": "condiment",
      "optional": true,
      "isCore": false,
      "mealContext": "hot dog",
      "matchingHints": {
        "synonyms": [],
        "broaderTerms": ["sauce"],
        "avoidTerms": [],
        "preferredCategoryNames": ["epices huiles sauces"],
        "forbiddenCategoryNames": ["boissons", "contenants"],
        "productForm": "condiment"
      }
    }
  ]
}
`.trim();
}

static buildPlannerUserPrompt(meal: string, servings: number) {
  return `
Plat: ${meal}
Nombre de portions: ${servings}

Retourne STRICTEMENT un JSON avec les clés exactes:
- meal
- servings
- ingredients

ingredients doit être un tableau d'objets complets.
N'utilise pas les clés "nom", "quantite", "portions".
N'utilise pas un objet ingredients avec base/accessoires/options.

Aucun texte hors JSON.
`.trim();
}
}