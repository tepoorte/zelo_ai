import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";

export async function getCurrentBasket(userRef: string) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY (e.g. CHE)");

  const res = await api.get(`/shop/${shopId}/order/current-basket`, {
    params: { country },
  });

  return res.data;
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