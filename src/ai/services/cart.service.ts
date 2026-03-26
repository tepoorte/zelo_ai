import { getPending, setPending, clearPending } from "../pending.js";
import { getCurrentBasket, addProductToBasket, clearCurrentBasket, placeCurrentBasketOrder } from "../../swissdata/cart.js";
import { type Product } from "../../swissdata/products.js";
import {
  formatCartFr,
  resolveProduct,
  computeBasketQty,
  formatOptionQuestion,
  resolveOptionsFromText,
  userChoseNoOptions,
} from "./cart-helpers.service.js";

type AddOutcomePending = {
  pending: true;
  message: string;
};

type AddOutcomeSuccess = {
  pending: false;
  result: any;
};

export type AddOutcome = AddOutcomePending | AddOutcomeSuccess;

export async function tryResolvePendingOptions(
  userRef: string,
  userText: string
): Promise<{ message: string } | null> {
  const pending = getPending(userRef);

  if (!pending || pending.type !== "awaiting_options") {
    return null;
  }

  const selected = resolveOptionsFromText(userText, pending.availableOptions);
  const choseNoOptions = userChoseNoOptions(userText);

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

  const basket = await getCurrentBasket(userRef);

  await addProductToBasket(
    userRef,
    basket.id,
    pending.productId,
    pending.qty,
    choseNoOptions ? [] : selected.map(x => x.id)
  );

  clearPending(userRef);

  const updated = await getCurrentBasket(userRef);

  return {
    message:
      (
        choseNoOptions
          ? `✅ J’ai ajouté « ${pending.productName} » sans option.\n\n`
          : `✅ J’ai ajouté « ${pending.productName} » avec les options : ${selected.map(x => x.name).join(", ")}.\n\n`
      ) +
      formatCartFr(updated),
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
  const basket = await getCurrentBasket(targetUserRef);
  const resolvedItems: any[] = [];

  for (const it of action.items) {
    let resolvedProduct: Product | null = null;

    if (it.productId) {
      resolvedProduct = { id: it.productId, name: it.productId } as Product;
    } else {
      resolvedProduct = await resolveProduct(targetUserRef, it.query);
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

    const basketQty = computeBasketQty(resolvedProduct, it.qty, it.unit);

    const addResult = await addProductToBasket(
      targetUserRef,
      basket.id,
      resolvedProduct.id,
      basketQty
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

  const updated = await getCurrentBasket(targetUserRef);

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
  const basket = await getCurrentBasket(action?.userRef ?? userRef);
  return basket;
}

export async function handleClearCartAction(userRef: string, action?: { userRef?: string }) {
  const updated = await clearCurrentBasket(action?.userRef ?? userRef);
  return {
    ok: true,
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
