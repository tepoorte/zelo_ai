import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";
import { timeAsync, timeSync } from "../utils/perf.js";

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

type CatalogCacheEntry = {
  expiresAt: number;
  items: Product[];
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
  const q = query.toLowerCase().trim();
  const items = await getCatalog(userRef);

  return items
    .map((p) => {
      const name = (p?.name ?? "").toLowerCase();

      const score =
        name.includes(q) ? 3 :
        name.split(" ").some((w) => q.split(" ").includes(w)) ? 1 : 0;

      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
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

export async function getAllProducts(userRef: string): Promise<Product[]> {
  return await getCatalog(userRef);
}

export function invalidateProductsCache(userRef?: string) {
  if (userRef) {
    CATALOG_CACHE.delete(userRef || "__anonymous__");
    return;
  }

  CATALOG_CACHE.clear();
}
