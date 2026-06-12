import { env } from "../config/env.js";
import { swissdataClient, withSwissdataReadRetry } from "./client.js";
import { timeAsync, timeSync } from "../utils/perf.js";
import { normalizeText, tokenizeForMatch } from "../domain/normalizer.js";
import { textSimilarity } from "../domain/text-similarity.js";

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type CatalogCacheEntry = {
  expiresAt: number;
  items: Product[];
};

export type GetAllProductsOptions = {
  forceRefresh?: boolean;
};

const CATALOG_CACHE = new Map<string, CatalogCacheEntry>();

export type ProductOption = {
  id: string;
  name?: string;
  description?: string;
  shortDescription?: string;
  price?: any;
  countryPrices?: any;
};

export type ProductMetadata = {
  key: string;
  value: any;
};

export type Product = {
  id: string;
  name: string;
  description?: string;
  shortDescription?: string;
  price?: any;
  countryPrices?: any;
  tags?: string[];
  optionsIds?: string[];
  availableOptions?: ProductOption[];
  size?: string;
  priceType?: string;
  refWeight?: number;
  refWeightUnit?: string;
  defaultSupplier?: any;

  unit?: string;
  type?: string;
  metadata?: ProductMetadata[];
  categories?: string[];
};

async function getCatalog(userRef: string, forceRefresh = false): Promise<Product[]> {
  const cacheKey = userRef || "__anonymous__";
  const cached = CATALOG_CACHE.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return timeSync(
      "swissdata.catalog_cache_hit",
      () => cached.items,
      { count: cached.items.length }
    );
  }

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY");

  const api = swissdataClient(userRef);

  const res = await timeAsync(
    "swissdata.catalog_api",
    async () =>
      await api.get(`/shop/${shopId}/product`, {
        params: {
          country,
          autoFetch: "availableOptions,defaultSupplier",
        },
      })
  );

  const items = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);

  CATALOG_CACHE.set(cacheKey, {
    items,
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
  });

  return items;
}

export async function searchProducts(
  userRef: string,
  query: string,
  limit = 10
): Promise<Product[]> {
  const items = await getCatalog(userRef);

  return rankProductsByQuery(query, items, limit);
}

export function rankProductsByQuery(
  query: string,
  items: Product[],
  limit = 10
): Product[] {
  const q = normalizeText(query);
  const qMatchTokens = tokenizeForMatch(query);
  const qMatchTokenSet = new Set(qMatchTokens);

  return items
    .map((p) => {
      const name = normalizeText(p?.name ?? "");
      const nameMatchTokens = tokenizeForMatch(p?.name ?? "");
      const nameMatchTokenSet = new Set(nameMatchTokens);
      const overlap = [...qMatchTokenSet].filter((token) => nameMatchTokenSet.has(token)).length;
      const fuzzy = textSimilarity(query, p?.name ?? "");
      const allQueryTokensIncluded =
        qMatchTokens.length > 0 &&
        qMatchTokens.every((token) => nameMatchTokenSet.has(token));

      const score =
        name.includes(q) ? 5 :
        allQueryTokensIncluded ? 4 :
        fuzzy >= 0.72 ? 3 :
        overlap >= 2 ? 2 :
        overlap >= 1 ? 1 :
        fuzzy >= 0.58 ? 0.5 : 0;

      return { p, score, fuzzy };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.fuzzy - a.fuzzy))
    .slice(0, limit)
    .map((x) => x.p);
}

export async function fetchFullProduct(
  userRef: string,
  productId: string
): Promise<Product | null> {
  const items = await getCatalog(userRef);
  return items.find((p) => p.id === productId) ?? null;
}

export async function fetchProductById(
  userRef: string,
  productId: string
): Promise<Product | null> {
  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY");
  if (!productId) return null;

  const api = swissdataClient(userRef);
  const encodedProductId = encodeURIComponent(productId);

  const res = await withSwissdataReadRetry(
    `swissdata.product_by_id.${productId}`,
    async () =>
      await timeAsync(
        "swissdata.product_by_id_api",
        async () =>
          await api.get(`/shop/${shopId}/product/${encodedProductId}`, {
            params: { country },
          }),
        { productId }
      )
  );

  return res.data && typeof res.data === "object" ? res.data : null;
}

export async function getAllProducts(
  userRef: string,
  options: GetAllProductsOptions = {}
): Promise<Product[]> {
  return await getCatalog(userRef, Boolean(options.forceRefresh));
}

export function invalidateProductsCache(userRef?: string) {
  if (userRef) {
    CATALOG_CACHE.delete(userRef || "__anonymous__");
    return;
  }

  CATALOG_CACHE.clear();
}
