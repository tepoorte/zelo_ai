import { normalizeLooseText } from "./product-options.service.js";

export type BasketLine = {
  productId?: string;
  optionsIds?: string[];
  name?: string;
  productName?: string;
  product?: { name?: string };
  quantity?: number;
  qty?: number;
};

function normalizeBasketMatchToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function basketMatchTokens(value: string): string[] {
  return normalizeLooseText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => normalizeBasketMatchToken(token));
}

function basketMatchText(value: string): string {
  return basketMatchTokens(value).join(" ");
}

export function basketLineName(line: BasketLine): string {
  return String(
    line?.name ??
    line?.productName ??
    line?.product?.name ??
    line?.productId ??
    "Produit"
  );
}

function scoreBasketLine(query: string, lineName: string): number {
  const normalizedQuery = normalizeLooseText(query);
  const normalizedLine = normalizeLooseText(lineName);
  const matchQuery = basketMatchText(query);
  const matchLine = basketMatchText(lineName);

  if (!normalizedQuery || !normalizedLine) return 0;
  if (normalizedLine === normalizedQuery) return 100;
  if (normalizedLine.includes(normalizedQuery)) return 90;
  if (normalizedQuery.includes(normalizedLine)) return 75;
  if (matchLine === matchQuery) return 100;
  if (matchLine.includes(matchQuery)) return 90;
  if (matchQuery.includes(matchLine)) return 75;

  const queryTokens = basketMatchTokens(query);
  const lineTokens = new Set(basketMatchTokens(lineName));
  const overlap = queryTokens.filter((token) => lineTokens.has(token)).length;

  if (!overlap) return 0;

  const coverage = overlap / queryTokens.length;
  if (coverage >= 1) return 70;
  if (coverage >= 0.75) return 55;
  if (coverage >= 0.5) return 40;
  return 0;
}

export function selectBasketLinesForRemoval(
  basket: any,
  queries: string[]
): { matched: BasketLine[]; unmatched: string[] } {
  const products = Array.isArray(basket?.products) ? (basket.products as BasketLine[]) : [];
  const matched: BasketLine[] = [];
  const unmatched: string[] = [];
  const usedIndexes = new Set<number>();

  for (const query of queries) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let index = 0; index < products.length; index++) {
      if (usedIndexes.has(index)) continue;
      const line = products[index];
      const score = scoreBasketLine(query, basketLineName(line));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore >= 40) {
      usedIndexes.add(bestIndex);
      matched.push(products[bestIndex]);
    } else {
      unmatched.push(query);
    }
  }

  return { matched, unmatched };
}
