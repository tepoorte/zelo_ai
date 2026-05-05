import { normalizeText, tokenizeForMatch } from "../../domain/normalizer.js";
import { getAllProducts, type Product } from "../../swissdata/products.js";
import { CATEGORY_NAME_BY_ID, EXCLUDED_CATEGORY_IDS } from "../food-taxonomy.js";
import type { BuildMealIngredientTraining } from "./types.js";

type CatalogProductDoc = {
  product: Product;
  normalizedName: string;
  nameTokens: string[];
  categoryIds: string[];
  categoryNames: string[];
};

const CATALOG_DOC_CACHE_TTL_MS = 5 * 60 * 1000;

type CatalogDocCacheEntry = {
  expiresAt: number;
  docs: CatalogProductDoc[];
};

const catalogDocCache = new Map<string, CatalogDocCacheEntry>();

function overlapScore(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter((token) => rightSet.has(token)).length;
  return overlap / left.length;
}

function nameIncludesTerm(doc: CatalogProductDoc, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  return doc.normalizedName.includes(normalizedTerm);
}

function matchesBannedName(doc: CatalogProductDoc, bannedName: string): boolean {
  const bannedTokens = tokenizeForMatch(bannedName);
  if (!bannedTokens.length) return false;
  const productTokenSet = new Set(doc.nameTokens);
  return bannedTokens.every((token) => productTokenSet.has(token));
}

function normalizeCategoryHints(ingredient: BuildMealIngredientTraining): string[] {
  return [...new Set((ingredient.categoryNames || [])
    .map((categoryName) => normalizeText(categoryName))
    .filter(Boolean))];
}

function filterDocsByCategories(
  docs: CatalogProductDoc[],
  categoryHints: string[]
): CatalogProductDoc[] {
  if (!categoryHints.length) return docs;
  return docs.filter((doc) =>
    doc.categoryNames.some((categoryName) => categoryHints.includes(categoryName))
  );
}

async function getCatalogDocs(userRef: string): Promise<CatalogProductDoc[]> {
  const cacheKey = userRef || "__anonymous__";
  const cached = catalogDocCache.get(cacheKey);
  if (cached?.docs.length && cached.expiresAt > Date.now()) return cached.docs;

  // The training stays stable, but product availability/names/categories must follow Swissdata.
  const products = await getAllProducts(userRef, { forceRefresh: Boolean(cached) });
  const docs = products
    .filter((product) => {
      const categoryIds = Array.isArray(product.categories) ? product.categories.map(String) : [];
      return !categoryIds.some((categoryId) => EXCLUDED_CATEGORY_IDS.includes(categoryId as never));
    })
    .map((product) => {
      const categoryIds = Array.isArray(product.categories) ? product.categories.map(String) : [];
      return {
        product,
        normalizedName: normalizeText(product.name),
        nameTokens: tokenizeForMatch(product.name),
        categoryIds,
        categoryNames: categoryIds
          .map((categoryId) => normalizeText(CATEGORY_NAME_BY_ID[categoryId] || ""))
          .filter(Boolean),
      } satisfies CatalogProductDoc;
    });

  catalogDocCache.set(cacheKey, {
    docs,
    expiresAt: Date.now() + CATALOG_DOC_CACHE_TTL_MS,
  });
  return docs;
}

function scoreFallbackCandidate(
  ingredient: BuildMealIngredientTraining,
  doc: CatalogProductDoc,
  context: { categoryHints: string[]; categoryMatched: boolean }
): number {
  const terms = [
    ingredient.label,
    ingredient.preferredProductName || "",
    ...(ingredient.fallbackSearchTerms || []),
  ]
    .map((term) => normalizeText(term))
    .filter(Boolean);

  const bannedIds = new Set((ingredient.bannedProductIds || []).map(String));
  const bannedNames = ingredient.bannedProductNames || [];

  if (bannedIds.has(String(doc.product.id))) return -100;
  if (bannedNames.some((bannedName) => matchesBannedName(doc, bannedName))) return -100;

  let score = 0;
  for (const term of terms) {
    const termTokens = tokenizeForMatch(term);
    const overlap = overlapScore(termTokens, doc.nameTokens);

    if (doc.normalizedName === term) score = Math.max(score, 5);
    else if (nameIncludesTerm(doc, term)) score = Math.max(score, 4);
    else if (overlap >= 1) score = Math.max(score, 3.5);
    else if (overlap >= 0.5) score = Math.max(score, 2.5);
    else if (overlap > 0) score = Math.max(score, 1 + overlap);
  }

  if (context.categoryHints.length) {
    if (context.categoryMatched) {
      score += 1;
    } else {
      score -= 1;
    }
  }

  return score;
}

export async function resolveCatalogProduct(
  userRef: string,
  ingredient: BuildMealIngredientTraining
): Promise<Product | null> {
  const docs = await getCatalogDocs(userRef);
  const categoryHints = normalizeCategoryHints(ingredient);
  const bannedIds = new Set((ingredient.bannedProductIds || []).map(String));
  const bannedNames = ingredient.bannedProductNames || [];
  const categoryScopedDocs = filterDocsByCategories(docs, categoryHints);
  const candidatePool = categoryScopedDocs.length ? categoryScopedDocs : docs;

  if (ingredient.preferredProductId) {
    const byId = candidatePool.find(
      (doc) => String(doc.product.id) === String(ingredient.preferredProductId)
    ) ?? docs.find((doc) => String(doc.product.id) === String(ingredient.preferredProductId));
    if (
      byId &&
      !bannedIds.has(String(byId.product.id)) &&
      !bannedNames.some((bannedName) => matchesBannedName(byId, bannedName))
    ) {
      return byId.product;
    }
  }

  if (ingredient.preferredProductName) {
    const normalizedPreferredName = normalizeText(ingredient.preferredProductName);
    const byName = candidatePool.find((doc) => doc.normalizedName === normalizedPreferredName)
      ?? docs.find((doc) => doc.normalizedName === normalizedPreferredName);
    if (
      byName &&
      !bannedIds.has(String(byName.product.id)) &&
      !bannedNames.some((bannedName) => matchesBannedName(byName, bannedName))
    ) {
      return byName.product;
    }
  }

  const ranked = candidatePool
    .map((doc) => ({
      product: doc.product,
      score: scoreFallbackCandidate(ingredient, doc, {
        categoryHints,
        categoryMatched:
          !categoryHints.length ||
          doc.categoryNames.some((categoryName) => categoryHints.includes(categoryName)),
      }),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (ranked[0]?.score && ranked[0].score >= 2) {
    return ranked[0].product;
  }

  const fallbackRanked = categoryScopedDocs.length
    ? docs
        .map((doc) => ({
          product: doc.product,
          score: scoreFallbackCandidate(ingredient, doc, {
            categoryHints,
            categoryMatched:
              !categoryHints.length ||
              doc.categoryNames.some((categoryName) => categoryHints.includes(categoryName)),
          }),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
    : [];

  return fallbackRanked[0]?.score && fallbackRanked[0].score >= 3
    ? fallbackRanked[0].product
    : ranked[0]?.product ?? null;
}

export function invalidateBuildMealCatalogCache(userRef?: string) {
  if (userRef) {
    catalogDocCache.delete(userRef || "__anonymous__");
    return;
  }
  catalogDocCache.clear();
}
