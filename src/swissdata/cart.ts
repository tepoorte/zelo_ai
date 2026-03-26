import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";
import { getAllProducts } from "./products.js";

export type SwissdataPaymentMethod =
  | "credit-card"
  | "twint"
  | "invoice"
  | "other";

function enrichBasketProductsWithNames(basket: any, catalog: Array<{ id: string; name?: string }>) {
  const products = Array.isArray(basket?.products) ? basket.products : [];
  if (!products.length) return basket;

  const namesById = new Map<string, string>();
  for (const product of catalog) {
    if (product?.id && product?.name) {
      namesById.set(String(product.id), String(product.name));
    }
  }

  basket.products = products.map((line: any) => {
    if (line?.name || line?.productName || line?.product?.name) {
      return line;
    }

    const productId = String(line?.productId ?? "");
    const resolvedName = namesById.get(productId);

    if (!resolvedName) return line;

    return {
      ...line,
      name: resolvedName,
      productName: resolvedName,
    };
  });

  return basket;
}

export async function getCurrentBasket(userRef: string) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY (e.g. CHE)");

  const res = await api.get(`/shop/${shopId}/order/current-basket`, {
    params: { country },
  });

  const basket = res.data;
  const catalog = await getAllProducts(userRef);

  return enrichBasketProductsWithNames(basket, catalog);
}

export async function addProductToBasket(
  userRef: string,
  basketId: string,
  productId: string,
  qty: number,
  optionsIds: string[] = []
) {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.put(
    `/shop/${shopId}/order/basket/${basketId}/add/${productId}/${qty}`,
    { optionsIds }
  );

  return res.data;
}

export async function removeProductFromBasket(
  userRef: string,
  basketId: string,
  productId: string,
  optionsIds: string[] = []
) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing SWISSDATA_COUNTRY");

  const res = await api.put(
    `/shop/${shopId}/order/basket/${basketId}/remove/${productId}`,
    { options: optionsIds },
    { params: { country } }
  );

  return res.data;
}

export async function clearCurrentBasket(userRef: string) {
  const basket = await getCurrentBasket(userRef);

  const products = Array.isArray(basket.products) ? basket.products : [];

  for (const p of products) {
    await removeProductFromBasket(
      userRef,
      basket.id,
      p.productId,
      Array.isArray(p.optionsIds) ? p.optionsIds : []
    );
  }

  return await getCurrentBasket(userRef);
}

export async function placeCurrentBasketOrder(
  userRef: string,
  paymentMethod: SwissdataPaymentMethod = "invoice"
) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY");

  const basket = await getCurrentBasket(userRef);

  if (!basket?.id) {
    throw new Error("Basket not found");
  }

  await api.put(
    `/shop/${shopId}/order/${basket.id}`,
    { paymentMethod },
    { params: { country } }
  );

  const res = await api.put(
    `/shop/${shopId}/order/basket/${basket.id}/place-order`,
    {},
    { params: { country } }
  );

  return res.data;
}
