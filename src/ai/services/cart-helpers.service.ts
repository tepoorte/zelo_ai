import { searchProducts, fetchFullProduct, type Product } from "../../swissdata/products.js";
import { matchIngredientToProduct } from "../../domain/matcher.js";
import { getPurchaseHistory } from "../../swissdata/history.js";

export function formatCartFr(basket: any): string {
  if (!basket) return "Je n’ai pas pu récupérer votre panier.";

  const products = Array.isArray(basket.products) ? basket.products : [];
  const manualItems = Array.isArray(basket.manualItems) ? basket.manualItems : [];
  const fees = Array.isArray(basket.fees) ? basket.fees : [];
  const currency = basket.currency ?? "";

  const lines: string[] = [];
  lines.push("🧺 Voici votre panier :");

  if (products.length === 0 && manualItems.length === 0) {
    lines.push("— Aucun produit dans le panier pour l’instant.");
  } else {
    for (const p of products) {
      const name =
        p?.name ??
        p?.productName ??
        p?.product?.name ??
        p?.productId ??
        "Produit";
      const qty = p?.quantity ?? p?.qty ?? 1;
      lines.push(`— ${qty} × ${name}`);
    }

    for (const it of manualItems) {
      const name = it?.name ?? "Article";
      const qty = it?.quantity ?? it?.qty ?? 1;
      lines.push(`— ${qty} × ${name} (manuel)`);
    }
  }

  if (fees.length) {
    lines.push("");
    lines.push("Frais :");
    for (const f of fees) {
      const price = Number(f?.paidPriceTTC ?? f?.paidPrice ?? 0);
      lines.push(`— ${f?.name ?? "Frais"} : ${price.toFixed(2)} ${currency}`);
    }
  }

  lines.push("");
  if (basket.totalPriceTTC != null) {
    lines.push(`Total TTC : ${Number(basket.totalPriceTTC).toFixed(2)} ${currency}`);
  } else if (basket.totalPrice != null) {
    lines.push(`Total : ${Number(basket.totalPrice).toFixed(2)} ${currency}`);
  }

  if (basket.estimatedDeliveryDate) {
    lines.push(`Livraison estimée : ${basket.estimatedDeliveryDate}`);
  }

  return lines.join("\n");
}

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

  const candidates = await searchProducts(userRef, item, 20);
  console.log("[RESOLVE] item =", item);
  console.log("[RESOLVE] candidates =", candidates.map(c => ({
    id: c.id,
    name: c.name
  })));

  if (!candidates.length) return null;

  const history = await getPurchaseHistory(userRef);
  console.log("[RESOLVE] history =", history);

  const best = matchIngredientToProduct(item, candidates, history);
  console.log("[RESOLVE] best full =", JSON.stringify(best, null, 2));

  const selected = best ?? candidates[0] ?? null;
  if (!selected?.id) return null;

  const full = await fetchFullProduct(userRef, selected.id);
  console.log("[RESOLVE] fetched full =", JSON.stringify(full, null, 2));

  return full ?? selected;
  //return best ?? candidates[0] ?? null;
}



export function computeBasketQty(product: any, requestedQty: number, requestedUnit?: string): number {
  const unit = String(requestedUnit || "piece").toLowerCase();

  if (unit === "piece") {
    return Math.max(1, requestedQty);
  }

  if (unit === "g" || unit === "kg") {
    const requestedGrams = unit === "kg" ? requestedQty * 1000 : requestedQty;

    if (
      product?.priceType === "per-weight" &&
      typeof product?.refWeight === "number" &&
      String(product?.refWeightUnit || "").toLowerCase() === "g"
    ) {
      return Math.max(1, Math.ceil(requestedGrams / product.refWeight));
    }

    const size = String(product?.size || "").toLowerCase();
    const gMatch = size.match(/(\d+)\s*g\b/);
    if (gMatch) {
      const grams = Number(gMatch[1]);
      if (grams > 0) return Math.max(1, Math.ceil(requestedGrams / grams));
    }

    return 1;
  }

  if (unit === "l" || unit === "litre" || unit === "litres" || unit === "ml") {
    const requestedMl = unit === "ml" ? requestedQty : requestedQty * 1000;

    const size = String(product?.size || "").toLowerCase().replace(",", ".");

    if (size.includes("1 litre") || size.includes("1l") || size.includes("1 l")) {
      return Math.max(1, Math.ceil(requestedMl / 1000));
    }

    const mlMatch = size.match(/(\d+(?:\.\d+)?)\s*ml\b/);
    if (mlMatch) {
      const ml = Number(mlMatch[1]);
      if (ml > 0) return Math.max(1, Math.ceil(requestedMl / ml));
    }

    const lMatch = size.match(/(\d+(?:\.\d+)?)\s*(?:l|litre|litres)\b/);
    if (lMatch) {
      const litres = Number(lMatch[1]);
      if (litres > 0) return Math.max(1, Math.ceil(requestedMl / (litres * 1000)));
    }

    return Math.max(1, requestedQty);
  }

  return Math.max(1, requestedQty);
}


export function formatOptionQuestion(product: Product): string {
  const options = Array.isArray(product.availableOptions) ? product.availableOptions : [];

  if (!options.length) {
    return `J’ai trouvé “${product.name}”, mais je n’ai pas réussi à lire ses options.`;
  }

  const lines: string[] = [];
  lines.push(`J’ai trouvé « ${product.name} ».`);
  lines.push(`Il y a plusieurs options disponibles :`);
  lines.push("");

  options.forEach((opt, index) => {
    const label = opt?.name || `Option ${index + 1}`;
    const extra = opt?.shortDescription || opt?.description || "";
    lines.push(`${index + 1}. ${label}${extra ? ` — ${extra}` : ""}`);
  });

  lines.push("");
  lines.push("Quelles options veux-tu sélectionner ?");

  return lines.join("\n");
}

export function normalizeLooseText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


export function resolveOptionsFromText(
  userText: string,
  availableOptions: Array<{ id: string; name: string; shortDescription?: string; description?: string }>
) {
  const text = normalizeLooseText(userText);

  const selected: Array<{ id: string; name: string }> = [];

  for (const opt of availableOptions) {
    const haystacks = [
      opt.name,
      opt.shortDescription,
      opt.description
    ]
      .filter(Boolean)
      .map(v => normalizeLooseText(String(v)));

    const matched = haystacks.some(h =>
      h && (text.includes(h) || h.includes(text))
    );

    if (matched) {
      selected.push({ id: opt.id, name: opt.name });
      continue;
    }

    // match par mots
    const optWords = normalizeLooseText(opt.name).split(" ").filter(Boolean);
    const hasWordOverlap = optWords.some(w => w.length > 2 && text.includes(w));
    if (hasWordOverlap) {
      selected.push({ id: opt.id, name: opt.name });
    }
  }

  // dédup
  const seen = new Set<string>();
  return selected.filter(x => {
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}
