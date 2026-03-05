import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";

export type Product = {
  id: string;
  name: string;
  price?: any;
  tags?: string[];
};

export async function searchProducts(userRef: string, query: string, limit = 10): Promise<Product[]> {
  const q = query.toLowerCase().trim();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  // Questo endpoint nel tuo caso risponde anche senza Bearer
  const api = swissdataClient(userRef); // se non sei loggato, funziona uguale se l’endpoint è pubblico
  const res = await api.get(`/shop/${shopId}/product`);

  const items: Product[] = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);

  return items
    .map(p => {
      const name = (p?.name ?? "").toLowerCase();
      const score =
        name.includes(q) ? 2 :
        name.split(" ").some(w => q.split(" ").includes(w)) ? 1 : 0;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.p);
}