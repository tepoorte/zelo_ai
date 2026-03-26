const RECIPES: Record<string, string[]> = {
  caesar: ["lattuga", "parmigiano", "croûtons", "pollo", "salsa caesar"],
};

export function localNlpFallback(text: string) {
  const t = text.toLowerCase();

  const wantsCaesar =
    t.includes("caesar") || t.includes("cesar") || t.includes("cesare");

  if (wantsCaesar) {
    return {
      intent: "ADD_RECIPE",
      proposedCartItems: RECIPES.caesar,
      note: "fallback-local (no OpenAI)",
    };
  }

  return {
    intent: "UNKNOWN",
    proposedCartItems: [],
    note: "fallback-local (no OpenAI)",
  };
}