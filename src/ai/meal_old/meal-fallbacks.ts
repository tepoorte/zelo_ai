// src/ai/meal-fallbacks.ts

export function hasEnoughMealCoverage(
  meal: string,
  resolvedItems: Array<{ ok: boolean; query?: string; product?: { name?: string } }>
): boolean {
  const lowerMeal = meal.toLowerCase();

  const names = resolvedItems
    .filter(x => x.ok)
    .map(x => String(x.product?.name ?? x.query ?? "").toLowerCase());

  if (lowerMeal.includes("hot dog")) {
    const hasBread = names.some(n =>
      n.includes("pain") || n.includes("bun")
    );

    const hasProtein = names.some(n =>
      n.includes("saucisse") ||
      n.includes("hot dog") ||
      n.includes("wurst") ||
      n.includes("würst")
    );

    return hasBread && hasProtein;
  }

  if (lowerMeal.includes("fondue")) {
    const hasCheese = names.some(n =>
      n.includes("fondue") ||
      n.includes("fromage")
    );
    return hasCheese;
  }

  // fallback generico: almeno 2 ingredienti trovati
  return resolvedItems.filter(x => x.ok).length >= 2;
}

export function suggestMealAlternatives(meal: string): string[] {
  const lowerMeal = meal.toLowerCase();

  if (lowerMeal.includes("hot dog")) {
    return ["burger", "sandwich", "wrap", "apéro"];
  }

  if (lowerMeal.includes("fondue")) {
    return ["raclette", "burger", "pâtes"];
  }

  if (lowerMeal.includes("apéro")) {
    return ["sandwich", "pizza", "burger"];
  }

  return ["sandwich", "pizza", "burger"];
}