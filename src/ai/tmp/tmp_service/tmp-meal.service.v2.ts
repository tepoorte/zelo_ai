/*import { addProductToBasket, getCurrentBasket } from "../../swissdata/cart.js";
import { buildMealIngredientsV2 } from "../meal-builder.v2.js";
import { buildCatalogIndexV2 } from "../catalog-index.v2.js";
import {
  buildMealCoverageMessageV2,
  hasEnoughMealCoverageV2,
} from "../meal-fallbacks.v2.js";
import { matchMealIngredientsV2 } from "../meal-matcher.v2.js";
import type { MealMatchSummaryV2 } from "../meal-types.v2.js";

type ResolvedItemV2 = {
  ingredient: string;
  productId: string;
  productName: string;
  qty: number;
};

type BuildMealActionV2 = {
  type: "build_meal";
  meal: string;
  servings?: number;
};

type AddedLineV2 = {
  ingredient: string;
  productId: string;
  productName: string;
  qty: number;
  unit?: string;
  confidence: string;
};

type MissingLineV2 = {
  ingredient: string;
  reason?: string;
  optional: boolean;
};

export type HandleBuildMealResultV2 = {
  ok: boolean;
  meal: string;
  servings: number;
  summary: MealMatchSummaryV2;
  added: AddedLineV2[];
  missing: MissingLineV2[];
  message: string;
  resolvedItems: ResolvedItemV2[];
};

async function addAcceptedMatchesToBasket(
  userRef: string,
  summary: MealMatchSummaryV2
): Promise<AddedLineV2[]> {
  const added: AddedLineV2[] = [];

  const basket = await getCurrentBasket(userRef);
  const basketId = basket.id;

  for (const match of summary.accepted) {
    if (!match.accepted) continue;

    const product = match.accepted.product;
    const qty = Math.max(1, Math.round(match.ingredient.qty || 1));

    try {
      await addProductToBasket(userRef, basketId, product.id, qty);

      added.push({
        ingredient: match.ingredient.label,
        productId: product.id,
        productName: product.name,
        qty,
        unit: match.ingredient.unit,
        confidence: match.confidence,
      });
    } catch (err) {
      console.error("[BUILD_MEAL_V2 ADD ERROR]", {
        ingredient: match.ingredient.label,
        productId: product.id,
        error: (err as Error).message,
      });
    }
  }

  return added;
}

function buildMissing(summary: MealMatchSummaryV2): MissingLineV2[] {
  return summary.missing.map((m) => ({
    ingredient: m.ingredient.label,
    reason: m.missingReason,
    optional: m.ingredient.optional,
  }));
}

function buildUserMessage(
  meal: string,
  added: AddedLineV2[],
  missing: MissingLineV2[],
  coverageMessage?: string
): string {
  const lines: string[] = [];

  if (added.length) {
    lines.push(`J’ai ajouté pour "${meal}" :`);
    for (const a of added) {
      lines.push(`- ${a.productName}`);
    }
  }

  if (missing.length) {
    lines.push(`Ingrédients manquants :`);
    for (const m of missing) {
      lines.push(`- ${m.ingredient}`);
    }
  }

  if (coverageMessage) {
    lines.push(coverageMessage);
  }

  if (!lines.length) {
    return `Je n’ai pas trouvé d’ingrédients fiables pour "${meal}".`;
  }

  return lines.join("\n");
}

export async function handleBuildMealActionV2(
  userRef: string,
  action: BuildMealActionV2
): Promise<HandleBuildMealResultV2> {
  const meal = String(action.meal || "").trim();
  const servings = Number(action.servings || 1);

  if (!meal) {
    throw new Error("Missing meal name");
  }

  await buildCatalogIndexV2(userRef);

  const plan = await buildMealIngredientsV2(meal, servings);

  const summary = await matchMealIngredientsV2(
    userRef,
    plan.ingredients,
    plan.meal,
    plan.servings
  );

  const coverageOk = hasEnoughMealCoverageV2(summary);
  const coverageMessage = buildMealCoverageMessageV2(summary);

  const added = coverageOk
    ? await addAcceptedMatchesToBasket(userRef, summary)
    : [];

  const missing = buildMissing(summary);

  const message = buildUserMessage(
    plan.meal,
    added,
    missing,
    coverageMessage
  );

  console.log("[BUILD_MEAL_V2 RESULT]", {
    meal: plan.meal,
    servings: plan.servings,
    accepted: summary.accepted.length,
    missing: summary.missing.length,
    coverageOk,
  });

  const resolvedItems = added.map((a) => ({
  ingredient: a.ingredient,
  productId: a.productId,
  productName: a.productName,
  qty: a.qty,
}));
  return {
    ok: coverageOk,
    meal: plan.meal,
    servings: plan.servings,
    summary,
    added,
    missing,
    message,
    resolvedItems
  };
}*/