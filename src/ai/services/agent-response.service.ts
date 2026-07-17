import type {
  BuildMealFeedbackContext,
  BuildMealUnknownRecipeContext,
} from "../build-meal/types.js";
import type { DiscoverResult } from "../discover/types.js";
import type { HistorySuggestion } from "./history-suggestions.service.js";
import { formatCartFr } from "./cart-format.service.js";
import { handleShowCartAction } from "./cart.service.js";

export type AgentResponse = {
  message: string;
  buildMeal?: BuildMealFeedbackContext;
  buildMealUnknown?: BuildMealUnknownRecipeContext;
  discover?: Pick<DiscoverResult, "query" | "needs" | "confidence" | "proposals">;
};

const NO_CLEAR_PRODUCT_MESSAGE =
  "Je n’ai pas trouvé de produit suffisamment clair à ajouter. Essaie avec un nom plus précis.";

export function formatNoClearProductResponse(): AgentResponse {
  return { message: NO_CLEAR_PRODUCT_MESSAGE };
}

export function formatHistorySuggestionsBlock(suggestions: HistorySuggestion[] | undefined): string {
  if (!Array.isArray(suggestions) || !suggestions.length) return "";

  return (
    `\n\nTu prends souvent aussi :\n` +
    suggestions.map((suggestion) => `• ${suggestion.name}`).join("\n") +
    `\nSi tu veux, écris « ajoute ... », ou « ok » pour passer la commande.`
  );
}

export function formatAddItemsResponse(addResult: any): AgentResponse {
  const basket = addResult?.basket;
  const summaryLines: string[] = [];

  if (Array.isArray(addResult?.resolvedItems)) {
    for (const item of addResult.resolvedItems) {
      if (item.ok) {
        summaryLines.push(
          `• ${item.requestedQty}${item.requestedUnit && item.requestedUnit !== "piece" ? item.requestedUnit : ""} de ${item.product?.name ?? item.query} → quantité du panier : ${item.targetBasketQty ?? item.basketQty ?? "?"}`
        );
      } else {
        summaryLines.push(`• ${item.query} : introuvable`);
      }
    }
  }

  if (!summaryLines.length) {
    return formatNoClearProductResponse();
  }

  return {
    message:
      `✅ J’ai traité ta demande :\n` +
      summaryLines.join("\n") +
      `\n\n` +
      (basket ? formatCartFr(basket) : "Le panier a été mis à jour, mais je n’ai pas pu relire son contenu.") +
      formatHistorySuggestionsBlock(addResult?.historySuggestions),
  };
}

export async function formatBuildMealResult(
  userRef: string,
  mealResult: any
): Promise<AgentResponse> {
  if (!mealResult) {
    return {
      message: "Je n’ai pas réussi à préparer les ingrédients pour ce repas.",
    };
  }

  if (!mealResult.ok) {
    return {
      message:
        mealResult.message ??
        `Je ne trouve pas tous les ingrédients nécessaires pour « ${mealResult.meal} ».`,
      ...(mealResult.feedbackContext ? { buildMeal: mealResult.feedbackContext } : {}),
      ...(mealResult.unknownRecipe ? { buildMealUnknown: mealResult.unknownRecipe } : {}),
    };
  }

  const addedLines = Array.isArray(mealResult.added)
    ? mealResult.added.map((item: { productName?: string; ingredient?: string }) => `• ${item.productName ?? item.ingredient ?? "Produit"}`)
    : [];
  const missingLines = Array.isArray(mealResult.missing)
    ? mealResult.missing.map((item: { ingredient?: string }) => `- ${item.ingredient ?? "Ingrédient"}`)
    : [];
  const missingBlock = missingLines.length
    ? `\nIngrédients manquants :\n${missingLines.join("\n")}`
    : "";

  try {
    const basket = await handleShowCartAction(userRef);

    return {
      message:
        `🍽️ J’ai ajouté des ingrédients pour préparer « ${mealResult.meal} » :\n` +
        (addedLines.length ? `${addedLines.join("\n")}\n` : "\n") +
        missingBlock +
        `\n\n` +
        formatCartFr(basket),
      ...(mealResult.feedbackContext ? { buildMeal: mealResult.feedbackContext } : {}),
    };
  } catch {
    return {
      message:
        `🍽️ J’ai ajouté des ingrédients pour préparer « ${mealResult.meal} » :\n` +
        (addedLines.length ? addedLines.join("\n") : (mealResult.message ?? "Ajout effectué.")) +
        missingBlock,
      ...(mealResult.feedbackContext ? { buildMeal: mealResult.feedbackContext } : {}),
    };
  }
}

export function formatClearCartResponse(clearResult: any): AgentResponse {
  if (clearResult?.mode !== "partial") {
    return {
      message:
        `🧹 J’ai vidé ton panier.\n\n` +
        formatCartFr(clearResult?.basket),
    };
  }

  const removedItems = Array.isArray(clearResult?.removedItems) ? clearResult.removedItems : [];
  const unmatchedQueries = Array.isArray(clearResult?.unmatchedQueries) ? clearResult.unmatchedQueries : [];

  if (!removedItems.length) {
    return {
      message:
        `Je n’ai pas trouvé clairement l’article à retirer dans ton panier.\n\n` +
        formatCartFr(clearResult?.basket),
    };
  }

  const removedLines = removedItems.map(
    (item: any) => `• ${item?.quantity ?? 1} × ${item?.name ?? "Produit"}`
  );
  const unmatchedBlock = unmatchedQueries.length
    ? `\n\nJe n’ai pas retrouvé clairement :\n${unmatchedQueries.map((query: string) => `• ${query}`).join("\n")}`
    : "";

  return {
    message:
      `🧹 J’ai retiré du panier :\n` +
      removedLines.join("\n") +
      unmatchedBlock +
      `\n\n` +
      formatCartFr(clearResult?.basket),
  };
}

export function formatExecCartResponse(execResult: any): AgentResponse {
  if (!execResult?.ok) {
    if (
      execResult?.error === "ASSISTANT_PRODUCT_UNAVAILABLE" &&
      Array.isArray(execResult?.unavailableProducts) &&
      execResult.unavailableProducts.length
    ) {
      return {
        message:
          "Je ne peux pas passer la commande tant que le panier contient " +
          "un ou plusieurs produits indisponibles via l’Assistant Zélo :\n" +
          execResult.unavailableProducts.map((name: string) => `• ${name}`).join("\n") +
          "\nRetire les produits indiqués du panier, puis confirme à nouveau.",
      };
    }
    return {
      message: "Je n’ai pas réussi à passer la commande.",
    };
  }

  const orderId =
    execResult?.order?.id ??
    execResult?.order?._id ??
    execResult?.order?.orderNb ??
    null;

  return {
    message:
      `✅ J’ai bien passé la commande.` +
      (orderId ? `\nRéférence : ${orderId}` : ""),
  };
}

export function formatDiscoverMealResponse(discoverResult: any): AgentResponse {
  return {
    message:
      discoverResult?.message ??
      "Je peux te proposer quelques idées par catégorie alimentaire.",
    ...(Array.isArray(discoverResult?.proposals)
      ? {
          discover: {
            query: String(discoverResult?.query ?? ""),
            needs: Array.isArray(discoverResult?.needs) ? discoverResult.needs : [],
            confidence: Number(discoverResult?.confidence ?? 0),
            proposals: discoverResult.proposals,
          },
        }
      : {}),
  };
}
