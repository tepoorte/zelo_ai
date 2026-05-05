import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import type {
  BuildMealFamilySource,
  BuildMealIngredientTraining,
  BuildMealRecipeTraining,
} from "./types.js";

export type BuildMealFamilyInference = {
  family: string;
  source: BuildMealFamilySource;
  confidence: number;
  reasons: string[];
};

type NameRule = {
  family: string;
  confidence: number;
  phrases: string[];
  reasons: string[];
};

type IngredientProfile = {
  text: string;
  tokens: Set<string>;
  categories: Set<string>;
  explicitSlots: Set<string>;
};

const KNOWN_STABLE_FAMILIES = new Set([
  "pizza",
  "pasta",
  "salade",
  "sandwich",
  "burger",
  "hot_dog",
  "soupe",
  "riz",
  "risotto",
  "poke",
  "curry",
  "wok",
  "omelette",
  "quiche",
  "tarte_salee",
  "tarte_sucree",
  "gratin",
  "crepe",
  "fondue",
  "raclette",
  "plat_poisson",
  "plat_viande",
  "dessert",
  "dessert_biscuit",
  "dessert_biscuit_creme",
  "dessert_creme",
  "dessert_creme_gelifie",
  "dessert_creme_cuite",
  "dessert_chocolat",
  "dessert_fruit",
  "dessert_gateau",
]);

const NAME_RULES: NameRule[] = [
  {
    family: "dessert_biscuit_creme",
    confidence: 0.98,
    phrases: ["tiramisu", "tiramisù", "tirami su", "tiramisu maison"],
    reasons: ["recipe-name:tiramisu"],
  },
  {
    family: "dessert_creme_gelifie",
    confidence: 0.98,
    phrases: ["panna cotta", "panacotta", "pana cotta"],
    reasons: ["recipe-name:panna-cotta"],
  },
  {
    family: "dessert_creme_cuite",
    confidence: 0.96,
    phrases: ["creme brulee", "creme caramel", "flan"],
    reasons: ["recipe-name:cream-custard-dessert"],
  },
  {
    family: "dessert_gateau",
    confidence: 0.94,
    phrases: ["gateau", "cake", "muffin", "brownie", "fondant", "moelleux"],
    reasons: ["recipe-name:cake-dessert"],
  },
  {
    family: "dessert_tarte",
    confidence: 0.92,
    phrases: ["tarte aux", "tarte sucree", "tartelette"],
    reasons: ["recipe-name:sweet-tart"],
  },
  {
    family: "pizza",
    confidence: 0.97,
    phrases: ["pizza", "pizzas"],
    reasons: ["recipe-name:pizza"],
  },
  {
    family: "pasta",
    confidence: 0.95,
    phrases: [
      "pasta",
      "pates",
      "spaghetti",
      "maccheroni",
      "macaroni",
      "penne",
      "fusilli",
      "tagliatelle",
      "lasagne",
      "gnocchi",
      "ravioli",
    ],
    reasons: ["recipe-name:pasta"],
  },
  {
    family: "salade",
    confidence: 0.95,
    phrases: ["salade", "salad"],
    reasons: ["recipe-name:salad"],
  },
  {
    family: "poke",
    confidence: 0.94,
    phrases: ["poke", "poke bowl", "bowl hawaien", "bowl hawaiien"],
    reasons: ["recipe-name:poke-bowl"],
  },
  {
    family: "burger",
    confidence: 0.94,
    phrases: ["hamburger", "burger", "cheeseburger"],
    reasons: ["recipe-name:burger"],
  },
  {
    family: "hot_dog",
    confidence: 0.94,
    phrases: ["hot dog", "hot-dog"],
    reasons: ["recipe-name:hot-dog"],
  },
  {
    family: "sandwich",
    confidence: 0.9,
    phrases: ["sandwich", "panini", "wrap", "baguette garnie"],
    reasons: ["recipe-name:sandwich"],
  },
  {
    family: "soupe",
    confidence: 0.94,
    phrases: ["soupe", "potage", "veloute", "bouillon"],
    reasons: ["recipe-name:soup"],
  },
  {
    family: "riz",
    confidence: 0.88,
    phrases: ["riz", "rice"],
    reasons: ["recipe-name:rice"],
  },
  {
    family: "risotto",
    confidence: 0.95,
    phrases: ["risotto"],
    reasons: ["recipe-name:risotto"],
  },
  {
    family: "curry",
    confidence: 0.92,
    phrases: ["curry", "korma", "tikka masala"],
    reasons: ["recipe-name:curry"],
  },
  {
    family: "wok",
    confidence: 0.9,
    phrases: ["wok", "saute asiatique", "nouilles sautees"],
    reasons: ["recipe-name:wok"],
  },
  {
    family: "omelette",
    confidence: 0.95,
    phrases: ["omelette", "oeufs brouilles", "oeuf brouille"],
    reasons: ["recipe-name:eggs"],
  },
  {
    family: "quiche",
    confidence: 0.94,
    phrases: ["quiche"],
    reasons: ["recipe-name:quiche"],
  },
  {
    family: "tarte_salee",
    confidence: 0.88,
    phrases: ["tarte salee", "tourte", "feuillete"],
    reasons: ["recipe-name:savoury-pie"],
  },
  {
    family: "gratin",
    confidence: 0.92,
    phrases: ["gratin"],
    reasons: ["recipe-name:gratin"],
  },
  {
    family: "crepe",
    confidence: 0.92,
    phrases: ["crepe", "crepes", "galette"],
    reasons: ["recipe-name:crepe"],
  },
  {
    family: "fondue",
    confidence: 0.95,
    phrases: ["fondue"],
    reasons: ["recipe-name:fondue"],
  },
  {
    family: "raclette",
    confidence: 0.95,
    phrases: ["raclette"],
    reasons: ["recipe-name:raclette"],
  },
];

function makeKey(value: string): string {
  return (
    normalizeText(value)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "recette"
  );
}

function includesPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) return false;
  if (normalizedText.includes(normalizedPhrase)) return true;

  const textTokens = new Set(tokenizeForMatch(normalizedText));
  const phraseTokens = tokenizeForMatch(normalizedPhrase);
  return phraseTokens.length > 0 && phraseTokens.every((token) => textTokens.has(token));
}

function firstMeaningfulToken(label: string): string {
  return normalizeText(label)
    .split(" ")
    .filter((token) => !["un", "une", "des", "du", "de", "la", "le", "les", "l", "d"].includes(token))[0] || "";
}

function normalizeFamilyCandidate(value?: string | null): string {
  const raw = String(value || "").trim();
  return raw ? makeKey(raw) : "";
}

function isUsefulProvidedFamily(
  requestedFamily: string,
  label: string,
  existingRecipes?: BuildMealRecipeTraining[]
): boolean {
  if (!requestedFamily) return false;
  if (KNOWN_STABLE_FAMILIES.has(requestedFamily)) return true;
  if (requestedFamily.includes("_")) return true;

  const existingFamilies = new Set(
    (existingRecipes || [])
      .map((recipe) => normalizeFamilyCandidate(recipe.family))
      .filter(Boolean)
  );
  if (existingFamilies.has(requestedFamily)) return true;

  return requestedFamily !== firstMeaningfulToken(label);
}

function buildIngredientProfile(
  ingredients: BuildMealIngredientTraining[] = []
): IngredientProfile {
  const textParts: string[] = [];
  const categories = new Set<string>();
  const explicitSlots = new Set<string>();

  for (const ingredient of ingredients) {
    textParts.push(
      ingredient.key,
      ingredient.label,
      ingredient.conceptKey || "",
      ingredient.slot || "",
      ingredient.preferredProductName || "",
      ...(ingredient.synonyms || []),
      ...(ingredient.fallbackSearchTerms || []),
      ...(ingredient.categoryNames || [])
    );
    for (const category of ingredient.categoryNames || []) {
      categories.add(normalizeText(category));
    }
    if (ingredient.slot) {
      explicitSlots.add(normalizeText(ingredient.slot));
    }
  }

  const text = normalizeText(textParts.join(" "));
  return {
    text,
    tokens: new Set(tokenizeForMatch(text)),
    categories,
    explicitSlots,
  };
}

function hasAny(profile: IngredientProfile, terms: string[]): boolean {
  return terms.some((term) => includesPhrase(profile.text, term));
}

function hasCategory(profile: IngredientProfile, category: string): boolean {
  return profile.categories.has(normalizeText(category));
}

function inferDessertFamily(profile: IngredientProfile): BuildMealFamilyInference | null {
  const hasSweetSignal = hasAny(profile, [
    "sucre",
    "miel",
    "sirop",
    "chocolat",
    "cacao",
    "cafe",
    "vanille",
    "biscuit",
    "boudoir",
    "savoiardi",
    "speculoos",
    "mascarpone",
    "creme",
    "gelatine",
    "agar",
    "gateau",
    "cake",
  ]);
  if (!hasSweetSignal) return null;

  const facets: string[] = [];
  const reasons = ["ingredient-rule:dessert"];
  const hasBiscuit = hasAny(profile, ["biscuit", "boudoir", "savoiardi", "speculoos", "cookie"]);
  const hasCreme = hasAny(profile, [
    "creme",
    "mascarpone",
    "fromage frais",
    "sere",
    "yogourt",
    "yaourt",
    "lait",
    "oeuf",
    "oeufs",
  ]) || hasCategory(profile, "lait fromages oeufs");
  const hasGel = hasAny(profile, ["gelatine", "agar", "agar agar", "pectine"]);
  const hasChocolate = hasAny(profile, ["chocolat", "cacao"]);
  const hasCoffee = hasAny(profile, ["cafe", "espresso"]);
  const hasFruit = hasAny(profile, ["fraise", "framboise", "fruit", "coulis", "ananas", "pomme", "poire"]);
  const hasCake = hasAny(profile, ["gateau", "cake", "muffin", "brownie", "farine"]);

  if (hasBiscuit) {
    facets.push("biscuit");
    reasons.push("facet:biscuit");
  }
  if (hasCreme) {
    facets.push("creme");
    reasons.push("facet:creme");
  }
  if (hasGel) {
    facets.push("gelifie");
    reasons.push("facet:gelifie");
  }
  if (!facets.length && hasChocolate) {
    facets.push("chocolat");
    reasons.push("facet:chocolat");
  }
  if (!facets.length && hasFruit) {
    facets.push("fruit");
    reasons.push("facet:fruit");
  }
  if (!facets.length && hasCake) {
    facets.push("gateau");
    reasons.push("facet:gateau");
  }
  if (facets.length === 1 && facets[0] === "biscuit" && (hasCoffee || hasChocolate)) {
    facets.push(hasCoffee ? "cafe" : "chocolat");
  }

  return {
    family: ["dessert", ...facets.slice(0, 2)].join("_"),
    source: "ingredient_rule",
    confidence: facets.length ? 0.78 : 0.62,
    reasons,
  };
}

function inferIngredientFamily(profile: IngredientProfile): BuildMealFamilyInference {
  const rules: Array<{ family: string; confidence: number; match: boolean; reason: string }> = [
    {
      family: "pizza",
      confidence: 0.86,
      match: hasAny(profile, ["farine pizza", "pate pizza", "pizza"]),
      reason: "ingredient-rule:pizza",
    },
    {
      family: "pasta",
      confidence: 0.84,
      match: hasAny(profile, ["spaghetti", "maccheroni", "macaroni", "penne", "fusilli", "tagliatelle", "lasagne", "pates"]),
      reason: "ingredient-rule:pasta-or-starch",
    },
    {
      family: "salade",
      confidence: 0.82,
      match: hasAny(profile, ["salade", "batavia", "laitue", "roquette", "radis"]),
      reason: "ingredient-rule:salad",
    },
    {
      family: "soupe",
      confidence: 0.78,
      match: hasAny(profile, ["soupe", "bouillon", "potage", "veloute"]),
      reason: "ingredient-rule:soup",
    },
    {
      family: "sandwich",
      confidence: 0.76,
      match: hasAny(profile, ["pain", "baguette", "bun"]) && hasCategory(profile, "viande poisson"),
      reason: "ingredient-rule:bread-protein",
    },
    {
      family: "riz",
      confidence: 0.75,
      match: hasAny(profile, ["riz", "rice"]),
      reason: "ingredient-rule:rice",
    },
    {
      family: "plat_poisson",
      confidence: 0.72,
      match: hasAny(profile, ["poisson", "perche", "saumon", "thon", "filet"]) && hasCategory(profile, "viande poisson"),
      reason: "ingredient-rule:fish",
    },
    {
      family: "plat_viande",
      confidence: 0.7,
      match: hasAny(profile, ["boeuf", "poulet", "porc", "viande", "steak", "jambon", "lardons"]) && hasCategory(profile, "viande poisson"),
      reason: "ingredient-rule:meat",
    },
  ];

  const dessert = inferDessertFamily(profile);
  if (dessert) return dessert;

  const match = rules.find((rule) => rule.match);
  if (match) {
    return {
      family: match.family,
      source: "ingredient_rule",
      confidence: match.confidence,
      reasons: [match.reason],
    };
  }

  return {
    family: "recette_generale",
    source: "generic",
    confidence: 0.35,
    reasons: ["fallback:generic-recipe"],
  };
}

export function inferBuildMealFamily(input: {
  label: string;
  sourceText?: string;
  requestedFamily?: string | null;
  ingredients?: BuildMealIngredientTraining[];
  existingRecipes?: BuildMealRecipeTraining[];
}): BuildMealFamilyInference {
  const label = String(input.label || "").trim();
  const normalizedLabel = normalizeText([label, input.sourceText || ""].join(" "));
  const requestedFamily = normalizeFamilyCandidate(input.requestedFamily);

  if (isUsefulProvidedFamily(requestedFamily, label, input.existingRecipes)) {
    return {
      family: requestedFamily,
      source: "provided",
      confidence: 0.9,
      reasons: ["provided-family"],
    };
  }

  for (const rule of NAME_RULES) {
    if (rule.phrases.some((phrase) => includesPhrase(normalizedLabel, phrase))) {
      return {
        family: rule.family,
        source: "name_rule",
        confidence: rule.confidence,
        reasons: rule.reasons,
      };
    }
  }

  const profile = buildIngredientProfile(input.ingredients || []);
  return inferIngredientFamily(profile);
}

export function familyFacets(family: string): string[] {
  return makeKey(family).split("_").filter(Boolean);
}

export function relatedFamilyScore(left: string, right: string): number {
  const leftFacets = new Set(familyFacets(left));
  const rightFacets = familyFacets(right);
  if (!leftFacets.size || !rightFacets.length) return 0;
  const overlap = rightFacets.filter((facet) => leftFacets.has(facet));
  if (!overlap.length) return 0;
  return overlap.length / Math.max(leftFacets.size, rightFacets.length);
}

export function shouldTransferIngredientToFamily(
  ingredient: BuildMealIngredientTraining,
  targetFamily: string
): boolean {
  const facets = new Set(familyFacets(targetFamily));
  const profile = buildIngredientProfile([ingredient]);

  if (facets.has("pizza")) {
    return hasAny(profile, ["farine pizza", "pate pizza", "sauce tomate", "mozzarella", "gruyere", "huile", "sel"]);
  }
  if (facets.has("pasta")) {
    return hasAny(profile, ["pates", "spaghetti", "maccheroni", "penne", "sauce", "tomate", "fromage"]);
  }
  if (facets.has("salade")) {
    return hasAny(profile, ["salade", "batavia", "laitue", "sauce", "huile", "vinaigre"]);
  }
  if (facets.has("dessert")) {
    if (hasAny(profile, ["sucre", "miel", "sirop"])) return true;
    if (facets.has("creme") && hasAny(profile, ["creme", "mascarpone", "lait", "oeuf", "oeufs", "sere", "yogourt", "yaourt"])) return true;
    if (facets.has("biscuit") && hasAny(profile, ["biscuit", "boudoir", "savoiardi", "speculoos"])) return true;
    if (facets.has("gelifie") && hasAny(profile, ["gelatine", "agar", "pectine"])) return true;
    if (facets.has("chocolat") && hasAny(profile, ["chocolat", "cacao"])) return true;
    if (facets.has("cafe") && hasAny(profile, ["cafe", "espresso"])) return true;
    if (facets.has("fruit") && hasAny(profile, ["fruit", "fraise", "framboise", "coulis", "ananas", "pomme", "poire"])) return true;
    if (facets.has("gateau") && hasAny(profile, ["farine", "levure", "beurre", "oeuf", "sucre"])) return true;
  }

  return false;
}
