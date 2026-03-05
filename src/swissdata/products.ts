import { swissdata } from "./client.js";

export type Product = {
  id: string;
  name: string;
  price?: number;
  tags?: string[];
};

export async function searchProducts(query: string, limit: number = 10): Promise<Product[]> {
  // Adatta endpoint al tuo Swissdata reale:
  // esempio: GET /shop/products/search?q=...
  const res = await swissdata.get("/shop/products/search", { params: { q: query, limit } });
  return res.data?.items ?? res.data ?? [];
}

//export { searchProducts };