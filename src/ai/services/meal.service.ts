import { buildMealIngredients } from "../meal-builder.js";
import { hasEnoughMealCoverage, suggestMealAlternatives } from "../meal-fallbacks.js";
import { semanticProductCandidates } from "../catalog-embeddings.js";
import { addProductToBasket, getCurrentBasket } from "../../swissdata/cart.js";
import { computeBasketQty } from "./cart-helpers.service.js";
import { type Product } from "../../swissdata/products.js";


function normalizeLoose(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function overlapScore(a?: string, b?: string): number {
  const aa = normalizeLoose(a || "");
  const bb = normalizeLoose(b || "");

  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.85;

  const aWords = aa.split(" ").filter(Boolean);
  const bWords = new Set(bb.split(" ").filter(Boolean));

  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }

  return overlap / Math.max(aWords.length, 1);
}

function productCatalogText(product: any): string {
  const px = product as any;
  const metadata = Array.isArray(px.metadata) ? px.metadata : [];

  const usefulMetadata = metadata
    .filter((m: any) =>
      ["ConservationRecommendation", "LocalZeroOpinion", "Fresh"].includes(String(m?.key))
    )
    .map((m: any) =>
      typeof m?.value === "string" ? m.value : JSON.stringify(m?.value)
    )
    .join(" ");

  return [
    px?.name,
    px?.shortDescription,
    px?.description,
    px?.size,
    px?.unit,
    px?.type,
    px?.defaultSupplier?.companyName,
    ...(Array.isArray(px?.tags) ? px.tags : []),
    usefulMetadata,
  ]
    .filter(Boolean)
    .join(" ");
}



export async function handleBuildMealAction(
  userRef: string,
  action: { meal: string; servings?: number; userRef?: string }
) {
  console.log("[BUILD_MEAL ACTION]", JSON.stringify(action, null, 2));

  const targetUserRef = action.userRef ?? userRef;
  const basket = await getCurrentBasket(targetUserRef);

  const ingredients = await buildMealIngredients(
    action.meal,
    action.servings ?? 2
  );

  console.log("[BUILD_MEAL INGREDIENTS]", ingredients);

  const resolvedItems: any[] = [];

  for (const ing of ingredients) {
    console.log("\n[MEAL INPUT]");
console.log({
  meal: action.meal,
  query: ing.query,
  role: ing.role,
  description: ing.description,
  usageContext: ing.usageContext,
  constraints: ing.constraints,
  priority: ing.priority,
  isCore: ing.isCore,
});
    const candidates = await semanticProductCandidates(
  {
    query: ing.query,
    description: ing.description,
    usageContext: ing.usageContext,
    constraints: ing.constraints,
  },
  8
);

const best = candidates[0];
console.log("\n[CHOSEN PRODUCT]");
console.log({
  ingredientQuery: ing.query,
  chosenProduct: best?.product?.name ?? null,
  chosenDescription: best?.product?.description ?? null,
  finalScore: best?.finalScore ?? null,
});

    if (!best || !best.product || best.finalScore < 0.72) {
      resolvedItems.push({
        query: ing.query,
        role: ing.role,
        isCore: !!ing.isCore,
        ok: false,
        error: "semantic_low_score",
        score: best?.finalScore ?? -1,
      });
      continue;
    }

    const resolvedProduct = best.product as Product;

console.log("[MEAL RERANK]", {
  query: ing.query,
  role: ing.role,
  chosen: best?.product?.name ?? null,
  finalScore: best?.finalScore ?? -1,
  nameScore: best?.nameScore ?? -1,
  descriptionScore: best?.descriptionScore ?? -1,
  constraintPenalty: best?.constraintPenalty ?? -1,
});
    if (
      Array.isArray(resolvedProduct.optionsIds) &&
      resolvedProduct.optionsIds.length > 0
    ) {
      resolvedItems.push({
        query: ing.query,
        role: ing.role,
        isCore: !!ing.isCore,
        ok: false,
        error: "needs_options",
        product: {
          id: resolvedProduct.id,
          name: resolvedProduct.name,
        },
        resolvedProduct,
        requestedQty: ing.qty ?? 1,
        requestedUnit: ing.unit ?? "piece",
      });
      continue;
    }

    const basketQty = computeBasketQty(
      resolvedProduct,
      ing.qty ?? 1,
      ing.unit
    );

    resolvedItems.push({
      query: ing.query,
      role: ing.role,
      isCore: !!ing.isCore,
      ok: true,
      requestedQty: ing.qty ?? 1,
      requestedUnit: ing.unit ?? "piece",
      basketQty,
      product: {
        id: resolvedProduct.id,
        name: resolvedProduct.name,
      },
      resolvedProduct,
    });
  }

  const enoughCoverage = hasEnoughMealCoverage(action.meal, resolvedItems);

  if (!enoughCoverage) {
    const alternatives = suggestMealAlternatives(action.meal);

    return {
      ok: false,
      meal: action.meal,
      resolvedItems,
      alternatives,
      basket,
    };
  }

  for (const item of resolvedItems) {
    if (!item.ok) continue;

    await addProductToBasket(
      targetUserRef,
      basket.id,
      item.product.id,
      item.basketQty
    );
  }

  const updated = await getCurrentBasket(targetUserRef);

  return {
    ok: true,
    meal: action.meal,
    resolvedItems,
    basket: updated,
  };
}
