import { Product } from "../swissdata/products.js";
import { normalizeText, tokenizeForMatch } from "./normalizer.js";

export function matchIngredientToProduct(
  ingredientName: string,
  products: Product[],
  history: Record<string, number> = {}
): Product | null {

  const normIngredient = normalizeText(ingredientName);

  let bestScore = 0;
  let best: Product | null = null;

  for (const p of products) {

    const normProduct = normalizeText(p.name);

    const textScore = similarity(normIngredient, normProduct);

    const historyScore = history[p.id]
      ? Math.min(1, history[p.id] / 5)
      : 0;

    const finalScore =
      textScore * 0.7 +
      historyScore * 0.3;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      best = p;
    }
  }

  return bestScore > 0.35 ? best : null;
}

function similarity(a: string, b: string): number {

  if (a === b) return 1;

  if (b.includes(a) || a.includes(b)) return 0.8;

  const aWords = new Set(tokenizeForMatch(a));
  const bWords = new Set(tokenizeForMatch(b));

  const intersection = [...aWords].filter(w => bWords.has(w)).length;

  if (intersection > 0 && [...aWords].every((word) => bWords.has(word))) {
    return 0.92;
  }

  return intersection / Math.max(aWords.size, bWords.size);
}
