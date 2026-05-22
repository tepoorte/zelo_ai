import { getPending, setPending, clearPending } from "../pending.js";
import {
  getCurrentBasket,
  ensureCurrentBasketFutureDelivery,
  addProductToBasket,
  clearCurrentBasket,
  placeCurrentBasketOrder,
  removeProductFromBasket,
} from "../../swissdata/cart.js";
import { fetchFullProduct, type Product } from "../../swissdata/products.js";
import { computeBasketQty } from "./cart-quantity.service.js";
import { formatCartFr } from "./cart-format.service.js";
import { basketLineName, selectBasketLinesForRemoval } from "./cart-line-matcher.service.js";
import {
  formatOptionQuestion,
  resolveOptionsFromText,
  userChoseNoOptions,
} from "./product-options.service.js";
import { resolveProduct } from "./product-resolution.service.js";
import { timeAsync, timeSync } from "../../utils/perf.js";

type AddOutcomePending = {
  pending: true;
  message: string;
};

type AddOutcomeSuccess = {
  pending: false;
  result: any;
};

export type AddOutcome = AddOutcomePending | AddOutcomeSuccess;

type ClearCartAction = {
  userRef?: string;
  mode?: "all" | "partial";
  items?: Array<{ query: string }>;
};

export async function tryResolvePendingOptions(
  userRef: string,
  userText: string
): Promise<{ message: string } | null> {
  const pending = getPending(userRef);

  if (!pending || pending.type !== "awaiting_options") {
    return null;
  }

  const selected = timeSync(
    "pending.resolve_options_text",
    () => resolveOptionsFromText(userText, pending.availableOptions)
  );
  const choseNoOptions = timeSync(
    "pending.user_chose_no_options",
    () => userChoseNoOptions(userText)
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
    return { message: baseMessage };
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
  }
): Promise<AddOutcome> {
  console.log("[ADD_TO_CART ACTION]", JSON.stringify(action, null, 2));

  const targetUserRef = action.userRef ?? userRef;
  const basket = await timeAsync(
    "add.get_current_basket_before_items",
    async () => await getCurrentBasket(targetUserRef)
  );
  const resolvedItems: any[] = [];

  for (let index = 0; index < action.items.length; index++) {
    const it = action.items[index];
    let resolvedProduct: Product | null = null;

    if (it.productId) {
      resolvedProduct = await timeAsync(
        "add.fetch_product_by_id",
        async () => await fetchFullProduct(targetUserRef, it.productId!),
        { productId: it.productId }
      ) ?? { id: it.productId, name: it.query || it.productId } as Product;
    } else {
      resolvedProduct = await timeAsync(
        "add.resolve_product",
        async () => await resolveProduct(targetUserRef, it.query),
        { query: it.query }
      );
    }

    if (!resolvedProduct?.id) {
      resolvedItems.push({
        query: it.query,
        ok: false,
        error: "Product not found",
      });
      continue;
    }

    if (Array.isArray(resolvedProduct.optionsIds) && resolvedProduct.optionsIds.length > 0) {
      if (Array.isArray(resolvedProduct.availableOptions) && resolvedProduct.availableOptions.length > 0) {
        setPending(targetUserRef, {
          type: "awaiting_options",
          productId: resolvedProduct.id,
          productName: resolvedProduct.name,
          qty: Math.max(1, computeBasketQty(resolvedProduct, it.qty, it.unit)),
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

    const basketQty = timeSync(
      "add.compute_basket_qty",
      () => computeBasketQty(resolvedProduct, it.qty, it.unit),
      { query: it.query, requestedQty: it.qty, unit: it.unit ?? "piece" }
    );

    const addResult = await timeAsync(
      "add.add_product_to_basket",
      async () =>
        await addProductToBasket(
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
    async () => await ensureCurrentBasketFutureDelivery(targetUserRef)
  );

  console.log("[ADD_TO_CART RESULT]", JSON.stringify({
    resolvedItems,
    updated,
  }, null, 2));

  return {
    pending: false,
    result: {
      ok: true,
      resolvedItems,
      basket: updated,
    },
  };
}

export async function handleShowCartAction(userRef: string, action?: { userRef?: string }) {
  const basket = await ensureCurrentBasketFutureDelivery(action?.userRef ?? userRef);
  return basket;
}

export async function handleClearCartAction(userRef: string, action?: { userRef?: string }) {
  const targetUserRef = action?.userRef ?? userRef;
  const typedAction = (action ?? {}) as ClearCartAction;

  if (typedAction.mode === "partial" && Array.isArray(typedAction.items) && typedAction.items.length) {
    const basket = await getCurrentBasket(targetUserRef);
    const queries = typedAction.items
      .map((item) => String(item?.query ?? "").trim())
      .filter(Boolean);

    const { matched, unmatched } = selectBasketLinesForRemoval(basket, queries);

    for (const line of matched) {
      if (!line?.productId) continue;
      await removeProductFromBasket(
        targetUserRef,
        basket.id,
        String(line.productId),
        Array.isArray(line.optionsIds) ? line.optionsIds : []
      );
    }

    const updated = await ensureCurrentBasketFutureDelivery(targetUserRef);
    return {
      ok: true,
      mode: "partial" as const,
      removedItems: matched.map((line) => ({
        name: basketLineName(line),
        quantity: line?.quantity ?? line?.qty ?? 1,
      })),
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

export async function handleExecCartAction(userRef: string, action?: { userRef?: string }) {
  const order = await placeCurrentBasketOrder(action?.userRef ?? userRef);
  return {
    ok: true,
    order,
  };
}
