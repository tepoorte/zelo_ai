import { getPending, setPending, clearPending } from "../pending.js";
import {
  getCurrentBasket,
  ensureCurrentBasketFutureDelivery,
  addProductToBasket,
  clearCurrentBasket,
  placeCurrentBasketOrder,
  removeProductFromBasket,
} from "../../swissdata/cart.js";
import { type Product } from "../../swissdata/products.js";
import {
  formatCartFr,
  resolveProduct,
  computeBasketQty,
  formatOptionQuestion,
  resolveOptionsFromText,
  userChoseNoOptions,
  normalizeLooseText,
} from "./cart-helpers.service.js";
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

type BasketLine = {
  productId?: string;
  optionsIds?: string[];
  name?: string;
  productName?: string;
  product?: { name?: string };
  quantity?: number;
  qty?: number;
};

function normalizeBasketMatchToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function basketMatchTokens(value: string): string[] {
  return normalizeLooseText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => normalizeBasketMatchToken(token));
}

function basketMatchText(value: string): string {
  return basketMatchTokens(value).join(" ");
}

function basketLineName(line: BasketLine): string {
  return String(
    line?.name ??
    line?.productName ??
    line?.product?.name ??
    line?.productId ??
    "Produit"
  );
}

function scoreBasketLine(query: string, lineName: string): number {
  const normalizedQuery = normalizeLooseText(query);
  const normalizedLine = normalizeLooseText(lineName);
  const matchQuery = basketMatchText(query);
  const matchLine = basketMatchText(lineName);

  if (!normalizedQuery || !normalizedLine) return 0;
  if (normalizedLine === normalizedQuery) return 100;
  if (normalizedLine.includes(normalizedQuery)) return 90;
  if (normalizedQuery.includes(normalizedLine)) return 75;
  if (matchLine === matchQuery) return 100;
  if (matchLine.includes(matchQuery)) return 90;
  if (matchQuery.includes(matchLine)) return 75;

  const queryTokens = basketMatchTokens(query);
  const lineTokens = new Set(basketMatchTokens(lineName));
  const overlap = queryTokens.filter((token) => lineTokens.has(token)).length;

  if (!overlap) return 0;

  const coverage = overlap / queryTokens.length;
  if (coverage >= 1) return 70;
  if (coverage >= 0.75) return 55;
  if (coverage >= 0.5) return 40;
  return 0;
}

function selectBasketLinesForRemoval(
  basket: any,
  queries: string[]
): { matched: BasketLine[]; unmatched: string[] } {
  const products = Array.isArray(basket?.products) ? (basket.products as BasketLine[]) : [];
  const matched: BasketLine[] = [];
  const unmatched: string[] = [];
  const usedIndexes = new Set<number>();

  for (const query of queries) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let index = 0; index < products.length; index++) {
      if (usedIndexes.has(index)) continue;
      const line = products[index];
      const score = scoreBasketLine(query, basketLineName(line));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestScore >= 40) {
      usedIndexes.add(bestIndex);
      matched.push(products[bestIndex]);
    } else {
      unmatched.push(query);
    }
  }

  return { matched, unmatched };
}

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
      resolvedProduct = { id: it.productId, name: it.productId } as Product;
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
