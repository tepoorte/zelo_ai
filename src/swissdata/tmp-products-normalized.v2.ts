/*import type {
  ProductFacetScoresV2,
  ProductIndexDocV2,
  SwissdataProductV2,
} from "../ai/meal-types.v2.js";
import { getAllProducts } from "./products.js";

export const FOOD_CATEGORY_IDS = new Set([
  "5dcfc1616f4a93324a0a2b1a", // Lait, Fromages, Oeufs
  "5dcfddcb6f4a93324a0a2b1e", // Boulangerie, Pâtisseries
  "5dcfde1f6f4a93324a0a2b1f", // Fruits, Légumes
  "5dcfde5d6f4a93324a0a2b20", // Farines, Céréales, Noix
  "5dcfdec16f4a93324a0a2b21", // Féculents
  "5dcfdf0e6f4a93324a0a2b22", // Viande, Poisson
  "5dcfdf4c6f4a93324a0a2b23", // Epices, Huiles, Sauces
]);

export const PREPARED_CATEGORY_IDS = new Set([
  "5f00d2cda5761c0007833362", // Menus, Pizzas
]);

export const EXCLUDED_CATEGORY_IDS = new Set([
  "5dcfdf736f4a93324a0a2b24", // Cosmétiques, Hygiène
  "5dcfdf906f4a93324a0a2b25", // Ménage, accessoires
  "5dea5c3d7e6ac104dac9fde2", // Boissons, café
  "5f718b85d9f31d00075c9899", // Contenants
]);

const CATEGORY_NAME_BY_ID: Record<string, string> = {
  "5dcfc1616f4a93324a0a2b1a": "lait fromages oeufs",
  "5dcfddcb6f4a93324a0a2b1e": "boulangerie patisseries",
  "5dcfde1f6f4a93324a0a2b1f": "fruits legumes",
  "5dcfde5d6f4a93324a0a2b20": "farines cereales noix",
  "5dcfdec16f4a93324a0a2b21": "feculents pates pommes de terre riz",
  "5dcfdf0e6f4a93324a0a2b22": "viande poisson",
  "5dcfdf4c6f4a93324a0a2b23": "epices huiles sauces",
  "5f00d2cda5761c0007833362": "menus pizzas",
  "5dcfdf736f4a93324a0a2b24": "cosmetiques hygiene",
  "5dcfdf906f4a93324a0a2b25": "menage accessoires",
  "5dea5c3d7e6ac104dac9fde2": "boissons cafe",
  "5f718b85d9f31d00075c9899": "contenants",
};

const STOPWORDS = new Set([
  "de", "du", "des", "la", "le", "les", "au", "aux", "a", "à", "en", "et",
  "ou", "pour", "par", "avec", "sur", "un", "une", "d", "l", "the"
]);

function stripAccents(input: string): string {
  return input.normalize("NFD").replace(/\p{Diacritic}+/gu, "");
}

export function normalizeTextLoose(input?: string | null): string {
  if (!input) return "";
  return stripAccents(input)
    .toLowerCase()
    .replace(/[%°]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeLoose(input?: string | null): string[] {
  const txt = normalizeTextLoose(input);
  if (!txt) return [];
  return txt
    .split(" ")
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t));
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function metadataValue(product: SwissdataProductV2, key: string): unknown {
  return product.metadata?.find(m => m.key === key)?.value;
}

function metadataText(product: SwissdataProductV2): string[] {
  const keys = [
    "ConservationRecommendation",
    "LocalZeroOpinion",
    "NextPossibleDelivery",
    "Region",
  ];

  return keys
    .map(k => metadataValue(product, k))
    .flatMap(v => {
      if (Array.isArray(v)) return v.map(x => String(x ?? ""));
      if (v == null) return [];
      return [String(v)];
    })
    .filter(Boolean);
}

function hasAny(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term));
}

export function inferProductFacets(product: SwissdataProductV2): ProductFacetScoresV2 {
  const name = normalizeTextLoose(product.name);
  const shortDesc = normalizeTextLoose(product.shortDescription);
  const desc = normalizeTextLoose(product.description);
  const tags = (product.tags || []).map(normalizeTextLoose).join(" ");
  const cats = (product.categories || []).map(id => CATEGORY_NAME_BY_ID[id] || "").join(" ");
  const meta = metadataText(product).map(normalizeTextLoose).join(" ");

  const text = [name, shortDesc, desc, tags, cats, meta].join(" ").trim();

  const preparedTerms = [
    "panini", "sandwich", "croissant au", "pizza ", "menu", "plat prepare",
    "tartare", "choucroute garnie", "plateau", "salade", "baguette jambon"
  ];

  const containerTerms = [
    "box", "boite", "contenants", "contenant", "maybox", "plateau"
  ];

  const condimentTerms = [
    "moutarde", "sauce", "mayonnaise", "ketchup", "huile", "vinaigre", "epice"
  ];

  const breadTerms = [
    "pain", "baguette", "bun", "hot dog", "boulangerie", "croissant"
  ];

  const cheeseTerms = [
    "fromage", "gruyere", "mozzarella", "parmesan", "chevre", "emmental", "gorgonzola"
  ];

  const meatTerms = [
    "jambon", "lard", "lardon", "saucisse", "salami", "boeuf", "porc", "poulet", "dinde", "poisson"
  ];

  const sauceTerms = [
    "sauce", "tomate", "pomodoro", "coulis", "pesto"
  ];

  const ingredientTerms = [
    "oeuf", "farine", "riz", "pates", "spaghetti", "cornettes", "coquilles",
    "tomate", "fromage", "mozzarella", "parmesan", "jambon", "lard", "saucisse",
    "moutarde", "huile", "pain", "baguette", "pomme", "fruit", "legume"
  ];

  const preparedness =
    (PREPARED_CATEGORY_IDS.hasAny?.(product.categories || []) ? 0.9 : 0) ||
    (hasAny(text, preparedTerms) ? 0.85 : 0.05);

  return {
    ingredientness:
      FOOD_CATEGORY_IDS.hasAny?.(product.categories || [])
        ? hasAny(text, ingredientTerms) ? 0.95 : 0.65
        : 0.1,
    preparedness:
      (product.categories || []).some(c => PREPARED_CATEGORY_IDS.has(c)) ? 0.95
      : hasAny(text, preparedTerms) ? 0.85
      : 0.05,
    condimentness:
      (product.categories || []).includes("5dcfdf4c6f4a93324a0a2b23") ? 0.9
      : hasAny(text, condimentTerms) ? 0.8
      : 0.05,
    containerness:
      (product.categories || []).some(c => EXCLUDED_CATEGORY_IDS.has(c) && c === "5f718b85d9f31d00075c9899") ? 1
      : hasAny(text, containerTerms) ? 0.9
      : 0,
    breadness:
      (product.categories || []).includes("5dcfddcb6f4a93324a0a2b1e") ? 0.85
      : hasAny(text, breadTerms) ? 0.75
      : 0.05,
    cheeseness:
      hasAny(text, cheeseTerms) ? 0.9 : 0.05,
    meatness:
      (product.categories || []).includes("5dcfdf0e6f4a93324a0a2b22") ? 0.85
      : hasAny(text, meatTerms) ? 0.75
      : 0.05,
    sauceness:
      hasAny(text, sauceTerms) ? 0.8 : 0.05,
  };
}

// helper piccolo
declare global {
  interface Set<T> {
    hasAny?(values: T[]): boolean;
  }
}
if (!Set.prototype.hasAny) {
  Set.prototype.hasAny = function <T>(this: Set<T>, values: T[]) {
    return values.some(v => this.has(v));
  };
}

export function classifyCatalogBucket(product: SwissdataProductV2): "food" | "prepared" | "exclude" | "uncategorized" {
  const cats = product.categories || [];
  if (!cats.length) return "uncategorized";
  if (cats.some(c => EXCLUDED_CATEGORY_IDS.has(c))) return "exclude";
  if (cats.some(c => PREPARED_CATEGORY_IDS.has(c))) return "prepared";
  if (cats.some(c => FOOD_CATEGORY_IDS.has(c))) return "food";
  return "uncategorized";
}

export function buildProductIndexDocV2(product: SwissdataProductV2): ProductIndexDocV2 {
  const normalizedName = normalizeTextLoose(product.name);
  const normalizedShortDescription = normalizeTextLoose(product.shortDescription);
  const normalizedDescription = normalizeTextLoose(product.description);

  const normalizedTags = (product.tags || [])
    .map(t => normalizeTextLoose(t))
    .filter(Boolean);

  const normalizedCategoryIds = (product.categories || []).map(String);
  const normalizedCategoryNames = normalizedCategoryIds
    .map(id => normalizeTextLoose(CATEGORY_NAME_BY_ID[id] || ""))
    .filter(Boolean);

  const searchableText = uniq([
    normalizedName,
    normalizedShortDescription,
    normalizedDescription,
    ...normalizedTags,
    ...normalizedCategoryNames,
    ...metadataText(product).map(normalizeTextLoose),
  ])
    .filter(Boolean)
    .join(" ");

  const tokens = uniq(tokenizeLoose(searchableText));

  return {
    id: String(product.id),
    product,
    normalizedName,
    normalizedShortDescription,
    normalizedDescription,
    normalizedTags,
    normalizedCategoryIds,
    normalizedCategoryNames,
    searchableText,
    tokens,
    facets: inferProductFacets(product),
  };
}

export async function getAllProductsNormalizedV2(userRef: string): Promise<ProductIndexDocV2[]> {
  const products = (await getAllProducts(userRef)) as SwissdataProductV2[];

  return products
    .filter(Boolean)
    .map(buildProductIndexDocV2);
}

export function filterCatalogForMealV2(index: ProductIndexDocV2[]): ProductIndexDocV2[] {
  return index.filter(doc => {
    const bucket = classifyCatalogBucket(doc.product);
    return bucket === "food" || bucket === "prepared" || bucket === "uncategorized";
  });
}*/