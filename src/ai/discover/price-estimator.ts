import type { Product } from "../../swissdata/products.js";

export type ProductPriceEstimate = {
  amountCHF: number | null;
  reliable: boolean;
  source: string;
};

function asNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export function estimateProductPriceCHF(product: Product): ProductPriceEstimate {
  const price = asNumber(product.price?.price);
  if (price == null) {
    return {
      amountCHF: null,
      reliable: false,
      source: "missing_price",
    };
  }

  return {
    amountCHF: Math.round(price * 100) / 100,
    reliable: true,
    source: product.priceType ? `catalog_${product.priceType}` : "catalog_price",
  };
}

export function estimatedTotalCHF(products: Array<{ estimatedPriceCHF?: number }>): number | null {
  let total = 0;
  for (const product of products) {
    const amount = asNumber(product.estimatedPriceCHF);
    if (amount == null) return null;
    total += amount;
  }
  return Math.round(total * 100) / 100;
}
