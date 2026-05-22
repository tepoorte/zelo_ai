import { canonicalizeQuantityUnit } from "../../domain/quantity-units.js";

export function computeBasketQty(product: any, requestedQty: number, requestedUnit?: string): number {
  const unit = canonicalizeQuantityUnit(requestedUnit) ?? "piece";

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
    const gramsMatch = size.match(/(\d+)\s*g\b/);
    if (gramsMatch) {
      const grams = Number(gramsMatch[1]);
      if (grams > 0) return Math.max(1, Math.ceil(requestedGrams / grams));
    }

    return 1;
  }

  if (unit === "litre" || unit === "ml") {
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

    const litreMatch = size.match(/(\d+(?:\.\d+)?)\s*(?:l|litre|litres)\b/);
    if (litreMatch) {
      const litres = Number(litreMatch[1]);
      if (litres > 0) return Math.max(1, Math.ceil(requestedMl / (litres * 1000)));
    }

    return Math.max(1, requestedQty);
  }

  return Math.max(1, requestedQty);
}
