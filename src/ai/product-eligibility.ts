import {
  fetchProductById,
  rankProductsByQuery,
  type Product,
} from "../swissdata/products.js";
import { normalizeText, tokenizeForMatch } from "../domain/normalizer.js";
import { bestTokenSimilarity } from "../domain/text-similarity.js";

/**
 * Hard product boundary shared by every Assistant Zélo product flow.
 *
 * Keep these values independent from Discover training artifacts: changing this
 * policy must take effect immediately, without rebuilding embeddings or models.
 */
export const BLOCKED_ASSISTANT_CATEGORY_IDS: readonly string[] = Object.freeze([
  "60ee03d44287bd00089fbb40", // Vélos cargos, casques
  "5f718b85d9f31d00075c9899", // Contenants
  "60238e4d92d477000754db98", // Formules, soutien, audit
]);

/**
 * Defence in depth for the current credit products plus the uncategorized
 * container-recovery product. Non-sell products are already rejected below;
 * explicit IDs keep these products blocked if their Swissdata type drifts.
 */
export const BLOCKED_ASSISTANT_PRODUCT_IDS: readonly string[] = Object.freeze([
  "5f48c885e0e73100076c928d",
  "5f5b2fa69abcd50007e10564",
  "6030df0d8a57810007b4590a",
  "6034920a8a57810007b46484",
  "605d8564c80a860008b730de",
  "605d89bfc80a860008b730f1",
  "605d89f6c80a860008b730f2",
  "67fec5837a580500255053dc",
  "60e67c431c068c000984cfe8", // Récupération contenants: sell, no category upstream
]);

const blockedCategoryIds = new Set(BLOCKED_ASSISTANT_CATEGORY_IDS);
const blockedProductIds = new Set(BLOCKED_ASSISTANT_PRODUCT_IDS);
const MIN_BLOCKED_REFERENCE_SCORE = 0.66;
const MIN_BLOCKED_REFERENCE_LEAD = 0.08;

export type AssistantProductIneligibilityReason =
  | "missing_product"
  | "missing_id"
  | "blocked_product"
  | "non_sell_product"
  | "invalid_categories"
  | "blocked_category";

export function assistantProductIneligibilityReason(
  product: Pick<Product, "id" | "type" | "categories"> | null | undefined
): AssistantProductIneligibilityReason | null {
  if (!product) return "missing_product";

  const productId = String(product.id ?? "").trim();
  if (!productId) return "missing_id";
  if (blockedProductIds.has(productId)) return "blocked_product";

  const productType = String(product.type ?? "").trim().toLowerCase();
  if (productType !== "sell") return "non_sell_product";

  if (product.categories != null && !Array.isArray(product.categories)) {
    return "invalid_categories";
  }

  const hasBlockedCategory = (product.categories ?? [])
    .map((categoryId) => String(categoryId).trim())
    .some((categoryId) => blockedCategoryIds.has(categoryId));
  if (hasBlockedCategory) return "blocked_category";

  return null;
}

export function isAssistantProductEligible(
  product: Pick<Product, "id" | "type" | "categories"> | null | undefined
): boolean {
  return assistantProductIneligibilityReason(product) === null;
}

export function filterAssistantEligibleProducts<T extends Product>(products: readonly T[]): T[] {
  return products.filter((product) => isAssistantProductEligible(product));
}

function includesNormalizedPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function referenceTokens(value: string): string[] {
  return [...new Set(
    tokenizeForMatch(value).filter((token) => token.length >= 3 && /[a-z]/i.test(token))
  )];
}

/**
 * Scores only lexical evidence that points at a catalog product. Unmatched
 * context words do not lower the score, while product-token coverage and a
 * second matching token strengthen a specific name match.
 */
function productReferenceScore(textTokens: string[], productName: string): number {
  const productTokens = referenceTokens(productName);
  if (!textTokens.length || !productTokens.length) return 0;

  const textMatchScores = textTokens
    .map((token) => bestTokenSimilarity(token, productTokens))
    .filter((score) => score >= 0.74);
  if (!textMatchScores.length) return 0;

  const meanTextMatch = textMatchScores.reduce((sum, score) => sum + score, 0) /
    textMatchScores.length;
  const matchedProductTokens = productTokens.filter(
    (token) => bestTokenSimilarity(token, textTokens) >= 0.74
  ).length;
  const productCoverage = matchedProductTokens / productTokens.length;
  const evidenceCount = Math.min(
    1,
    textMatchScores.length / Math.min(2, productTokens.length)
  );

  return meanTextMatch * 0.7 + productCoverage * 0.2 + evidenceCount * 0.1;
}

/**
 * Detects an explicit forbidden request before fuzzy matching can substitute an
 * unrelated allowed product. Exact IDs/names and fuzzy partial-name evidence
 * are derived from the current catalog rather than global keyword bans.
 */
export function hasBlockedAssistantProductReference(
  text: string,
  products: readonly Product[] = []
): boolean {
  const raw = String(text ?? "").toLowerCase();
  const normalized = normalizeText(text);
  if (!normalized && !raw) return false;

  for (const productId of BLOCKED_ASSISTANT_PRODUCT_IDS) {
    if (raw.includes(productId.toLowerCase())) return true;
  }

  const textTokens = referenceTokens(normalized);
  let bestBlockedScore = 0;
  let bestEligibleScore = 0;

  for (const product of products) {
    const eligible = isAssistantProductEligible(product);

    const productId = String(product?.id ?? "").trim().toLowerCase();
    if (!eligible && productId && raw.includes(productId)) return true;

    const productName = normalizeText(product?.name);
    if (
      !eligible &&
      productName.length >= 4 &&
      includesNormalizedPhrase(normalized, productName)
    ) {
      return true;
    }

    const score = productReferenceScore(textTokens, productName);
    if (eligible) {
      bestEligibleScore = Math.max(bestEligibleScore, score);
    } else {
      bestBlockedScore = Math.max(bestBlockedScore, score);
    }
  }

  return (
    bestBlockedScore >= MIN_BLOCKED_REFERENCE_SCORE &&
    bestBlockedScore >= bestEligibleScore + MIN_BLOCKED_REFERENCE_LEAD
  );
}

/** Filter before applying the result limit so blocked matches are replaced. */
export function rankAssistantEligibleProducts(
  query: string,
  products: readonly Product[],
  limit: number
): Product[] {
  return rankProductsByQuery(query, filterAssistantEligibleProducts(products), limit);
}

export type AssistantCurrentProductReader = (
  userRef: string,
  productId: string
) => Promise<Product | null>;

/**
 * Revalidates the immutable policy against the current Swissdata record.
 * Mutation boundaries use this instead of trusting the five-minute catalog
 * cache. Read failures are intentionally treated as ineligible.
 */
export async function fetchCurrentAssistantEligibleProduct(
  userRef: string,
  productId: string,
  readProduct: AssistantCurrentProductReader = fetchProductById
): Promise<Product | null> {
  const normalizedProductId = String(productId ?? "").trim();
  if (!normalizedProductId) return null;

  try {
    const product = await readProduct(userRef, normalizedProductId);
    if (String(product?.id ?? "").trim() !== normalizedProductId) return null;
    return product && isAssistantProductEligible(product) ? product : null;
  } catch {
    return null;
  }
}
