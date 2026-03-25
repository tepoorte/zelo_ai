import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";

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

async function getCatalog(userRef: string): Promise<Product[]> {
  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY");

  const api = swissdataClient(userRef);

  const res = await api.get(`/shop/${shopId}/product`, {
    params: {
      country,
      autoFetch: "availableOptions,defaultSupplier",
    },
  });

  return Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
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