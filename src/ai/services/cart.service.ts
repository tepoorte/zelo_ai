import { getPending, setPending, clearPending } from "../pending.js";
import {
  getCurrentBasket,
  ensureCurrentBasketFutureDelivery,
  addProductToBasket,
  clearCurrentBasket,
  placeCurrentBasketOrder,
  removeProductFromBasket,
  setProductQuantityInBasket,
} from "../../swissdata/cart.js";
import { fetchFullProduct, getAllProducts, type Product } from "../../swissdata/products.js";
import { computeBasketQty } from "./cart-quantity.service.js";
import { formatCartFr } from "./cart-format.service.js";
import { basketLineName, selectBasketLinesForRemoval } from "./cart-line-matcher.service.js";
import {
  extractClearCartPartialFromBasket,
  isExplicitClearAllRequest,
} from "./clear-cart-extractor.service.js";
import {
  formatOptionQuestion,
  resolveOptionsFromText,
  userChoseNoOptions,
} from "./product-options.service.js";
import {
  getNextHistorySuggestions,
  resetHistorySuggestions,
} from "./history-suggestions.service.js";
import { resolveProduct } from "./product-resolution.service.js";
import { timeAsync, timeSync } from "../../utils/perf.js";
import {
  fetchCurrentAssistantEligibleProduct,
  hasBlockedAssistantProductReference,
  isAssistantProductEligible,
  type AssistantCurrentProductReader,
} from "../product-eligibility.js";

type AddOutcomePending = {
  pending: true;
  message: string;
};

type AddOutcomeSuccess = {
  pending: false;
  result: any;
};

export type AddOutcome = AddOutcomePending | AddOutcomeSuccess;

export type AddToCartEligibilityDependencies = {
  getBasket?: typeof getCurrentBasket;
  fetchCatalogProduct?: typeof fetchFullProduct;
  fetchCurrentProduct?: AssistantCurrentProductReader;
  resolveCatalogProduct?: typeof resolveProduct;
  addProduct?: typeof addProductToBasket;
  ensureBasket?: typeof ensureCurrentBasketFutureDelivery;
  getHistorySuggestions?: typeof getNextHistorySuggestions;
  getCatalogProducts?: typeof getAllProducts;
};

export type ExecCartEligibilityDependencies = {
  getBasket?: typeof getCurrentBasket;
  fetchCurrentProduct?: AssistantCurrentProductReader;
  placeOrder?: typeof placeCurrentBasketOrder;
};

type ClearCartAction = {
  userRef?: string;
  mode?: "all" | "partial";
  items?: Array<{ query: string }>;
};

function resolvedProductIds(resolvedItems: any[]): string[] {
  return resolvedItems
    .map((item) => String(item?.product?.id ?? "").trim())
    .filter(Boolean);
}

export function shouldAskForProductOptions(itemCount: number): boolean {
  return itemCount === 1;
}

export type PendingOptionsEligibilityDependencies = {
  fetchProduct?: (userRef: string, productId: string) => Promise<Product | null>;
};

export async function tryResolvePendingOptions(
  userRef: string,
  userText: string,
  dependencies: PendingOptionsEligibilityDependencies = {}
): Promise<{ message: string } | null> {
  const pending = getPending(userRef);

  if (!pending || pending.type !== "awaiting_options") {
    return null;
  }

  // Pending state can outlive a catalog/policy change. Re-read the product and
  // fail closed before displaying its options or mutating the basket.
  const pendingProduct = await timeAsync(
    "pending.fetch_product_before_add",
    async () => dependencies.fetchProduct
      ? await dependencies.fetchProduct(userRef, pending.productId)
      : await fetchCurrentAssistantEligibleProduct(userRef, pending.productId),
    { productId: pending.productId }
  );
  if (!pendingProduct || !isAssistantProductEligible(pendingProduct)) {
    clearPending(userRef);
    return {
      message: "Ce produit n’est pas disponible via l’Assistant Zélo et n’a pas été ajouté.",
    };
  }

  const selected = timeSync(
    "pending.resolve_options_text",
    () => resolveOptionsFromText(userText, pending.availableOptions)
  );
  const choseNoOptions = timeSync(
    "pending.user_chose_no_options",
    () => userChoseNoOptions(userText, pending.availableOptions)
  );

  if (!selected.length && !choseNoOptions) {
    return {
      message:
        `Je n’ai pas reconnu les options demandées pour « ${pending.productName} ».\n\n` +
        formatOptionQuestion({
          id: pending.productId,
          name: pending.productName,
          availableOptions: pending.availableOptions,
        } as Product),
    };
  }

  const basket = await timeAsync(
    "pending.get_current_basket_before_add",
    async () => await getCurrentBasket(userRef)
  );

  await timeAsync(
    "pending.add_product_to_basket",
    async () =>
      await addProductToBasket(
        userRef,
        basket.id,
        pending.productId,
        pending.qty,
        choseNoOptions ? [] : selected.map(x => x.id)
      ),
    { productId: pending.productId, qty: pending.qty }
  );

  clearPending(userRef);

  const updated = await timeAsync(
    "pending.get_current_basket_after_add",
    async () => await ensureCurrentBasketFutureDelivery(userRef)
  );

  const baseMessage =
    (
      choseNoOptions
        ? `✅ J’ai ajouté « ${pending.productName} » sans option.\n\n`
        : `✅ J’ai ajouté « ${pending.productName} » avec les options : ${selected.map(x => x.name).join(", ")}.\n\n`
    ) + formatCartFr(updated);

  if (!pending.remainingItems?.length) {
    const historySuggestions = await getNextHistorySuggestions(userRef, {
      basket: updated,
      excludeProductIds: [pending.productId],
    }).catch(() => []);
    const suggestionBlock = historySuggestions.length
      ? `\n\nTu prends souvent aussi :\n${historySuggestions.map((item) => `• ${item.name}`).join("\n")}\nSi tu veux, écris « ajoute ... ».`
      : "";

    return { message: `${baseMessage}${suggestionBlock}` };
  }

  const followUpOutcome = await handleAddToCartAction(userRef, {
    items: pending.remainingItems,
  });

  if (followUpOutcome.pending) {
    return {
      message: `${baseMessage}\n\n${followUpOutcome.message}`,
    };
  }

  return {
    message: `${baseMessage}\n\n${formatCartFr(followUpOutcome.result.basket)}`,
  };
}

export async function handleAddToCartAction(
  userRef: string,
  action: {
    userRef?: string;
    items: Array<{
      query: string;
      qty: number;
      unit?: string;
      productId?: string;
    }>;
  },
  dependencies: AddToCartEligibilityDependencies = {}
): Promise<AddOutcome> {
  console.log("[ADD_TO_CART ACTION]", JSON.stringify(action, null, 2));

  const targetUserRef = action.userRef ?? userRef;
  const askForOptions = shouldAskForProductOptions(action.items.length);
  const basket = await timeAsync(
    "add.get_current_basket_before_items",
    async () => await (dependencies.getBasket ?? getCurrentBasket)(targetUserRef)
  );
  const referenceCatalog = await (dependencies.getCatalogProducts ?? getAllProducts)(targetUserRef);
  const resolvedItems: any[] = [];

  for (let index = 0; index < action.items.length; index++) {
    const it = action.items[index];
    let resolvedProduct: Product | null = null;

    if (hasBlockedAssistantProductReference(
      `${it.query} ${it.productId ?? ""}`,
      referenceCatalog
    )) {
      resolvedItems.push({
        query: it.query,
        ok: false,
        error: "Product not found or unavailable",
      });
      continue;
    }

    if (it.productId) {
      resolvedProduct = await timeAsync(
        "add.fetch_product_by_id",
        async () => await (dependencies.fetchCatalogProduct ?? fetchFullProduct)(targetUserRef, it.productId!),
        { productId: it.productId }
      );
    } else {
      resolvedProduct = await timeAsync(
        "add.resolve_product",
        async () => await (dependencies.resolveCatalogProduct ?? resolveProduct)(targetUserRef, it.query),
        { query: it.query }
      );
    }

    if (!resolvedProduct?.id || !isAssistantProductEligible(resolvedProduct)) {
      resolvedItems.push({
        query: it.query,
        ok: false,
        error: "Product not found or unavailable",
      });
      continue;
    }

    const currentProduct = await timeAsync(
      "add.revalidate_product_before_mutation",
      async () => await fetchCurrentAssistantEligibleProduct(
        targetUserRef,
        resolvedProduct!.id,
        dependencies.fetchCurrentProduct
      ),
      { productId: resolvedProduct.id }
    );
    if (!currentProduct) {
      resolvedItems.push({
        query: it.query,
        ok: false,
        error: "Product not found or unavailable",
      });
      continue;
    }
    resolvedProduct = {
      ...resolvedProduct,
      ...currentProduct,
      optionsIds: currentProduct.optionsIds ?? resolvedProduct.optionsIds,
      availableOptions: currentProduct.availableOptions ?? resolvedProduct.availableOptions,
      defaultSupplier: currentProduct.defaultSupplier ?? resolvedProduct.defaultSupplier,
    };

    const basketQty = timeSync(
      "add.compute_basket_qty",
      () => computeBasketQty(resolvedProduct, it.qty, it.unit),
      { query: it.query, requestedQty: it.qty, unit: it.unit ?? "piece" }
    );

    if (Array.isArray(resolvedProduct.optionsIds) && resolvedProduct.optionsIds.length > 0) {
      if (!askForOptions) {
        const addResult = await timeAsync(
          "add.add_product_to_basket",
          async () =>
            await (dependencies.addProduct ?? addProductToBasket)(
              targetUserRef,
              basket.id,
              resolvedProduct.id,
              basketQty,
              []
            ),
          { productId: resolvedProduct.id, basketQty, optionsCount: 0 }
        );

        resolvedItems.push({
          query: it.query,
          requestedQty: it.qty,
          requestedUnit: it.unit ?? "piece",
          basketQty,
          product: {
            id: resolvedProduct.id,
            name: resolvedProduct.name,
          },
          ok: true,
          optionsSkipped: true,
          result: addResult,
        });
        continue;
      }

      if (Array.isArray(resolvedProduct.availableOptions) && resolvedProduct.availableOptions.length > 0) {
        setPending(targetUserRef, {
          type: "awaiting_options",
          productId: resolvedProduct.id,
          productName: resolvedProduct.name,
          qty: Math.max(1, basketQty),
          unit: it.unit,
          remainingItems: action.items.slice(index + 1),
          availableOptions: resolvedProduct.availableOptions.map(opt => ({
            id: opt.id,
            name: opt.name || "Option",
            shortDescription: opt.shortDescription,
            description: opt.description,
          })),
        });

        return {
          pending: true,
          message: formatOptionQuestion(resolvedProduct),
        };
      }

      return {
        pending: true,
        message:
          `J’ai trouvé « ${resolvedProduct.name} », mais ce produit demande des options avant d’être ajouté.\n` +
          `Je n’ajoute rien automatiquement pour éviter une mauvaise commande.`,
      };
    }

    const addResult = await timeAsync(
      "add.add_product_to_basket",
      async () =>
        await (dependencies.addProduct ?? addProductToBasket)(
          targetUserRef,
          basket.id,
          resolvedProduct.id,
          basketQty
        ),
      { productId: resolvedProduct.id, basketQty }
    );

    resolvedItems.push({
      query: it.query,
      requestedQty: it.qty,
      requestedUnit: it.unit ?? "piece",
      basketQty,
      product: {
        id: resolvedProduct.id,
        name: resolvedProduct.name,
      },
      ok: true,
      result: addResult,
    });
  }

  const updated = await timeAsync(
    "add.get_current_basket_after_items",
    async () => await (dependencies.ensureBasket ?? ensureCurrentBasketFutureDelivery)(targetUserRef)
  );
  const addedProductIds = resolvedProductIds(resolvedItems);
  const historySuggestions = addedProductIds.length
    ? await (dependencies.getHistorySuggestions ?? getNextHistorySuggestions)(targetUserRef, {
        basket: updated,
        excludeProductIds: addedProductIds,
      }).catch(() => [])
    : [];

  console.log("[ADD_TO_CART RESULT]", JSON.stringify({
    resolvedItems: resolvedItems.map((item) => ({
      query: item.query,
      ok: item.ok,
      productId: item.product?.id,
      productName: item.product?.name,
      basketQty: item.basketQty,
      optionsSkipped: Boolean(item.optionsSkipped),
    })),
    basket: {
      id: typeof updated?.id === "string" ? `${updated.id.slice(0, 6)}…` : undefined,
      productLines: Array.isArray(updated?.products) ? updated.products.length : 0,
      totalPriceTTC: updated?.totalPriceTTC,
      estimatedDeliveryDate: updated?.estimatedDeliveryDate,
    },
  }, null, 2));

  return {
    pending: false,
    result: {
      ok: true,
      resolvedItems,
      basket: updated,
      historySuggestions,
    },
  };
}

export async function handleShowCartAction(userRef: string, action?: { userRef?: string }) {
  const basket = await ensureCurrentBasketFutureDelivery(action?.userRef ?? userRef);
  return basket;
}

function lineQuantity(line: any): number {
  const quantity = Number(line?.quantity ?? line?.qty ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

export async function handleClearCartAction(
  userRef: string,
  action?: { userRef?: string },
  userText = ""
) {
  const targetUserRef = action?.userRef ?? userRef;
  const typedAction = (action ?? {}) as ClearCartAction;

  if (typedAction.mode !== "all" && isExplicitClearAllRequest(userText)) {
    const updated = await clearCurrentBasket(targetUserRef);
    return {
      ok: true,
      mode: "all" as const,
      basket: updated,
    };
  }

  if (typedAction.mode === "partial" && Array.isArray(typedAction.items) && typedAction.items.length) {
    const basket = await getCurrentBasket(targetUserRef);
    const queries = typedAction.items
      .map((item) => String(item?.query ?? "").trim())
      .filter(Boolean);

    const extraction = extractClearCartPartialFromBasket(userText || queries.join(", "), basket, queries);
    const matched = extraction.items;
    const unmatched = extraction.items.length
      ? extraction.unmatchedQueries
      : selectBasketLinesForRemoval(basket, queries).unmatched;
    const removedItems: Array<{ name: string; quantity: number }> = [];

    for (const item of matched) {
      const line = item.line;
      if (!line?.productId) continue;
      const currentQuantity = lineQuantity(line);
      const optionsIds = Array.isArray(line.optionsIds) ? line.optionsIds : [];

      if (item.operation === "set_exact") {
        const targetQuantity = Math.max(0, Number(item.targetQuantity ?? currentQuantity));
        const removedQuantity = Math.max(0, currentQuantity - targetQuantity);
        if (removedQuantity <= 0) continue;

        if (targetQuantity <= 0) {
          await removeProductFromBasket(
            targetUserRef,
            basket.id,
            String(line.productId),
            optionsIds
          );
        } else {
          await setProductQuantityInBasket(
            targetUserRef,
            basket.id,
            String(line.productId),
            targetQuantity,
            optionsIds
          );
        }

        removedItems.push({
          name: basketLineName(line),
          quantity: removedQuantity,
        });
        continue;
      }

      if (item.operation === "decrease") {
        const requestedQuantity = Math.max(0, Number(item.quantity ?? currentQuantity));
        const removedQuantity = Math.min(currentQuantity, requestedQuantity);
        const targetQuantity = Math.max(0, currentQuantity - requestedQuantity);
        if (removedQuantity <= 0) continue;

        if (targetQuantity <= 0) {
          await removeProductFromBasket(
            targetUserRef,
            basket.id,
            String(line.productId),
            optionsIds
          );
        } else {
          await setProductQuantityInBasket(
            targetUserRef,
            basket.id,
            String(line.productId),
            targetQuantity,
            optionsIds
          );
        }

        removedItems.push({
          name: basketLineName(line),
          quantity: removedQuantity,
        });
        continue;
      }

      await removeProductFromBasket(
        targetUserRef,
        basket.id,
        String(line.productId),
        optionsIds
      );

      removedItems.push({
        name: basketLineName(line),
        quantity: currentQuantity,
      });
    }

    const updated = await ensureCurrentBasketFutureDelivery(targetUserRef);
    return {
      ok: true,
      mode: "partial" as const,
      removedItems,
      unmatchedQueries: unmatched,
      basket: updated,
    };
  }

  const updated = await clearCurrentBasket(targetUserRef);
  return {
    ok: true,
    mode: "all" as const,
    basket: updated,
  };
}

export async function handleExecCartAction(
  userRef: string,
  action?: { userRef?: string },
  dependencies: ExecCartEligibilityDependencies = {}
) {
  const targetUserRef = action?.userRef ?? userRef;
  const basket = await (dependencies.getBasket ?? getCurrentBasket)(targetUserRef);
  const basketLines = Array.isArray(basket?.products) ? basket.products : [];
  const productIds = [...new Set<string>(
    basketLines
      .map((line: any) => String(line?.productId ?? line?.product?.id ?? line?.id ?? "").trim())
      .filter((productId: string) => Boolean(productId))
  )];
  const unavailableProducts: string[] = basketLines
    .filter((line: any) =>
      !String(line?.productId ?? line?.product?.id ?? line?.id ?? "").trim()
    )
    .map((line: any) => String(
      line?.name ?? line?.productName ?? line?.product?.name ?? "Produit non identifié"
    ));

  // A cart can survive a deployment or catalog-policy change. Never turn a
  // stale forbidden line into an order; it remains visible/removable instead.
  for (const productId of productIds) {
    const product = await fetchCurrentAssistantEligibleProduct(
      targetUserRef,
      productId,
      dependencies.fetchCurrentProduct
    );
    if (!product) {
      const line = basketLines.find(
        (candidate: any) =>
          String(candidate?.productId ?? candidate?.product?.id ?? candidate?.id ?? "").trim() === productId
      );
      unavailableProducts.push(String(
        line?.name ?? line?.productName ?? line?.product?.name ?? productId
      ));
    }
  }

  if (unavailableProducts.length) {
    return {
      ok: false,
      error: "ASSISTANT_PRODUCT_UNAVAILABLE",
      unavailableProducts,
    };
  }

  const order = await (dependencies.placeOrder ?? placeCurrentBasketOrder)(targetUserRef);
  resetHistorySuggestions(targetUserRef);

  return {
    ok: true,
    order,
  };
}
