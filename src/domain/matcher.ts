import { Product } from "../swissdata/products.js";
import { normalizeText } from "./normalizer.js";
import { textSimilarity } from "./text-similarity.js";

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

    const textScore = textSimilarity(normIngredient, normProduct);

    const historyScore = history[p.id]
      ? Math.min(1, history[p.id] / 5)
      : 0;

    if (textScore < 0.25) {
      continue;
    }

    const finalScore =
      textScore +
      (textScore >= 0.75 ? historyScore * 0.015 : 0);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      best = p;
    }
  }

  return bestScore > 0.35 ? best : null;
}
