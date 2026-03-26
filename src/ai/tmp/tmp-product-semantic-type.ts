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

  // ---------- NON FOOD ----------
  if (
    text.includes("savon") ||
    text.includes("shampo") ||
    text.includes("dentifrice") ||
    text.includes("nettoyant") ||
    text.includes("lessive")
  ) {
    return "non_food";
  }

  // ---------- PACKAGING ----------
  if (
    text.includes("boîte") ||
    text.includes("sac") ||
    text.includes("emballage") ||
    text.includes("gobelet") ||
    text.includes("barquette")
  ) {
    return "packaging";
  }

  // ---------- DRINK ----------
  if (
    text.includes("jus") ||
    text.includes("vin") ||
    text.includes("aoc") ||
    text.includes("bière") ||
    text.includes("boisson") ||
    text.includes("cola") ||
    text.includes("thé") ||
    text.includes("café")
  ) {
    return "drink";
  }

  // ---------- PREPARED MEAL ----------
  if (
    text.includes("menu") ||
    text.includes("plateau") ||
    text.includes("box") ||
    text.includes("repas") ||
    text.includes("plat préparé")
  ) {
    return "prepared_meal";
  }

  // ---------- SNACK ----------
  if (
    text.includes("chips") ||
    text.includes("croissant") ||
    text.includes("pain au sucre") ||
    text.includes("viennoiserie") ||
    text.includes("sandwich") ||
    text.includes("naan") ||
    text.includes("wrap") ||
    text.includes("snack")
  ) {
    return "snack";
  }

  // ---------- INGREDIENT (default) ----------
  return "ingredient";
}