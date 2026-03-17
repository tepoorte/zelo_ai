export type ProductSemanticType =
  | "ingredient"
  | "prepared_meal"
  | "snack"
  | "drink"
  | "packaging"
  | "non_food"
  | "unknown";

export function guessProductSemanticType(p: any): ProductSemanticType {
  const text =
    `${p?.name ?? ""} ${p?.shortDescription ?? ""} ${p?.description ?? ""}`
      .toLowerCase();

  // NON FOOD
  if (
    text.includes("savon") ||
    text.includes("shampo") ||
    text.includes("sac ") ||
    text.includes("boîte") ||
    text.includes("gobelet")
  ) {
    return "non_food";
  }

  // PACKAGING
  if (
    text.includes("boîte") ||
    text.includes("sac") ||
    text.includes("emballage")
  ) {
    return "packaging";
  }

  // DRINK
  if (
    text.includes("jus") ||
    text.includes("vin") ||
    text.includes("bière") ||
    text.includes("boisson")
  ) {
    return "drink";
  }

  // SNACK / READY
  if (
    text.includes("chips") ||
    text.includes("croissant") ||
    text.includes("sandwich") ||
    text.includes("naan") ||
    text.includes("wrap")
  ) {
    return "snack";
  }

  // PREPARED MEAL
  if (
    text.includes("menu") ||
    text.includes("plateau") ||
    text.includes("box")
  ) {
    return "prepared_meal";
  }

  // INGREDIENT fallback
  return "ingredient";
}