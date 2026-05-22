import { matchIngredientToProduct } from "../../domain/matcher.js";
import { getPurchaseHistory } from "../../swissdata/history.js";
import { fetchFullProduct, searchProducts, type Product } from "../../swissdata/products.js";
import { timeAsync, timeSync } from "../../utils/perf.js";

export function looksLikeProductId(value: string): boolean {
  return /^[a-f0-9]{24}$/i.test(value.trim());
}

export async function resolveProduct(userRef: string, rawItem: string): Promise<Product | null> {
  const item = rawItem.trim();

  if (looksLikeProductId(item)) {
    return {
      id: item,
      name: item,
    } as Product;
  }

  const candidates = await timeAsync(
    "resolve.search_products",
    async () => await searchProducts(userRef, item, 20),
    { query: item }
  );
  console.log("[RESOLVE] item =", item);
  console.log("[RESOLVE] candidates =", candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
  })));

  if (!candidates.length) return null;

  const history = await timeAsync(
    "resolve.purchase_history",
    async () => await getPurchaseHistory(userRef)
  );
  console.log("[RESOLVE] history =", history);

  const best = timeSync(
    "resolve.match_ingredient_to_product",
    () => matchIngredientToProduct(item, candidates, history),
    { candidates: candidates.length }
  );
  console.log("[RESOLVE] best full =", JSON.stringify(best, null, 2));

  const selected = best ?? candidates[0] ?? null;
  if (!selected?.id) return null;

  const full = await timeAsync(
    "resolve.fetch_full_product",
    async () => await fetchFullProduct(userRef, selected.id),
    { productId: selected.id }
  );
  console.log("[RESOLVE] fetched full =", JSON.stringify(full, null, 2));

  return full ?? selected;
}
