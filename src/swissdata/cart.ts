import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";

export async function getCurrentBasket(userRef: string) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY (e.g. CHE)");

  const res = await api.get(`/shop/${shopId}/order/current-basket`, {
    params: { country }, // apiKey è già dentro al client
  });

  return res.data;
}

export async function addProductToBasket(
  userRef: string,
  basketId: string,
  productId: string,
  qty: number
) {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.put(
    `/shop/${shopId}/order/basket/${basketId}/add/${productId}/${qty}`,
    {}
  );

  return res.data;
}