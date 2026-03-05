export type Ingredient = {
  name: string;
  quantity: number;
};

export function getRecipeIngredients(dish: string, servings = 2): Ingredient[] {
  const base = dish.toLowerCase();

  if (base.includes("caesar")) {
    return scaleIngredients([
      { name: "lattuga romana", quantity: 1 },
      { name: "parmigiano", quantity: 1 },
      { name: "croûtons", quantity: 1 },
      { name: "pollo", quantity: 1 },
      { name: "salsa caesar", quantity: 1 }
    ], servings);
  }

  return [];
}

function scaleIngredients(ingredients: Ingredient[], servings: number): Ingredient[] {
  const factor = servings / 2;
  return ingredients.map(i => ({
    ...i,
    quantity: Math.max(1, Math.round(i.quantity * factor))
  }));
}