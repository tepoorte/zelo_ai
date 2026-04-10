import { MealBuildHelpersV2 } from "../MealBuildHelpers.v2.js";
import { clearPending, getPending, setPending } from "../pending.js";
import { getAllProducts, type Product } from "../../swissdata/products.js";
import { formatCartFr } from "./cart-helpers.service.js";
import { handleAddToCartAction } from "./cart.service.js";

type FoodCategoryChoice = {
  id: string;
  name: string;
};

type FoodSuggestion = {
  productId: string;
  name: string;
};

function normalizeLoose(text: string): string {
  return MealBuildHelpersV2.normalizeText(text);
}

function toDisplayCategoryName(raw: string): string {
  return raw
    .split(" ")
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }
      return part;
    })
    .join(", ")
    .replace(" patisseries", " pâtisseries")
    .replace(" oeufs", " oeufs")
    .replace(" epices", "épices")
    .replace(" huiles", " huiles")
    .replace(" sauces", " sauces");
}

function buildFoodCategoryChoices(products: Product[]): FoodCategoryChoice[] {
  const choices: FoodCategoryChoice[] = [];

  for (const categoryId of MealBuildHelpersV2.FOOD_CATEGORY_IDS) {
    const hasProducts = products.some((product) =>
      Array.isArray(product.categories) &&
      product.categories.map(String).includes(categoryId)
    );

    if (!hasProducts) continue;

    const rawName = MealBuildHelpersV2.CATEGORY_NAME_BY_ID[categoryId] || categoryId;
    choices.push({
      id: categoryId,
      name: toDisplayCategoryName(rawName),
    });
  }

  return choices;
}

function buildSuggestionsForCategory(products: Product[], categoryId: string): FoodSuggestion[] {
  return products
    .filter(
      (product) =>
        Array.isArray(product.categories) &&
        product.categories.map(String).includes(categoryId)
    )
    .slice(0, 5)
    .map((product) => ({
      productId: product.id,
      name: product.name,
    }));
}

function parseChoiceByNumberOrName<T extends { name: string }>(
  userText: string,
  options: T[]
): T | null {
  const normalized = normalizeLoose(userText);
  if (!normalized) return null;

  const numMatch = normalized.match(/\b(\d+)\b/);
  if (numMatch) {
    const index = Number(numMatch[1]) - 1;
    if (index >= 0 && index < options.length) {
      return options[index];
    }
  }

  const exact = options.find((option) => normalizeLoose(option.name) === normalized);
  return exact ?? null;
}

function looksLikeFreshIntent(userText: string): boolean {
  const normalized = normalizeLoose(userText);
  if (!normalized) return false;

  return /^(ajoute|montre|vide|supprime|passe|passer|de quoi faire|je veux|pour cuisiner|qu est ce que tu me proposes aujourd hui)\b/.test(
    normalized
  );
}

function formatCategoryQuestion(categories: FoodCategoryChoice[]): string {
  const lines = [
    "Je peux vous proposer quelques idees par categorie alimentaire.",
    "",
    ...categories.map((category, index) => `${index + 1}. ${category.name}`),
    "",
    "Quelle categorie vous tente ?",
  ];

  return lines.join("\n");
}

function formatSuggestionQuestion(categoryName: string, suggestions: FoodSuggestion[]): string {
  const lines = [
    `Voici quelques idees dans « ${categoryName} » :`,
    "",
    ...suggestions.map((suggestion, index) => `${index + 1}. ${suggestion.name}`),
    "",
    "Lequel voulez-vous ajouter au panier ?",
  ];

  return lines.join("\n");
}

export async function handleDiscoverMealIdeasAction(userRef: string) {
  const products = await getAllProducts(userRef);
  const categories = buildFoodCategoryChoices(products);

  setPending(userRef, {
    type: "awaiting_food_category",
    categories,
  });

  return {
    ok: true,
    categories,
    message: formatCategoryQuestion(categories),
  };
}

export async function tryResolvePendingMealDiscovery(
  userRef: string,
  userText: string
): Promise<{ message: string } | null> {
  const pending = getPending(userRef);

  if (!pending) return null;

  if (looksLikeFreshIntent(userText)) {
    clearPending(userRef);
    return null;
  }

  if (pending.type === "awaiting_food_category") {
    const selectedCategory = parseChoiceByNumberOrName(userText, pending.categories);
    if (!selectedCategory) {
      return {
        message:
          "Je n’ai pas reconnu la categorie choisie.\n\n" +
          formatCategoryQuestion(pending.categories),
      };
    }

    const products = await getAllProducts(userRef);
    const suggestions = buildSuggestionsForCategory(products, selectedCategory.id);

    setPending(userRef, {
      type: "awaiting_category_suggestion",
      categoryId: selectedCategory.id,
      categoryName: selectedCategory.name,
      suggestions,
    });

    return {
      message: formatSuggestionQuestion(selectedCategory.name, suggestions),
    };
  }

  if (pending.type === "awaiting_category_suggestion") {
    const selectedSuggestion = parseChoiceByNumberOrName(userText, pending.suggestions);
    if (!selectedSuggestion) {
      return {
        message:
          "Je n’ai pas reconnu votre choix.\n\n" +
          formatSuggestionQuestion(pending.categoryName, pending.suggestions),
      };
    }

    clearPending(userRef);

    const addOutcome = await handleAddToCartAction(userRef, {
      items: [
        {
          productId: selectedSuggestion.productId,
          query: selectedSuggestion.name,
          qty: 1,
          unit: "piece",
        },
      ],
    });

    if (addOutcome.pending) {
      return { message: addOutcome.message };
    }

    return {
      message:
        `✅ J’ai ajouté « ${selectedSuggestion.name} » à votre panier.\n\n` +
        formatCartFr(addOutcome.result?.basket),
    };
  }

  return null;
}
