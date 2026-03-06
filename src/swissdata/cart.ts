import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";
export async function getCurrentBasket(userRef: string) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY (e.g. CHE)");

  console.log("[getCurrentBasket] userRef =", userRef);
  console.log("[getCurrentBasket] shopId =", shopId, "country =", country);

  const res = await api.get(`/shop/${shopId}/order/current-basket`, {
    params: { country },
  });

  console.log("[getCurrentBasket] response.id =", res.data?.id, "customerId =", res.data?.customerId);
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

  console.log("[addProductToBasket] userRef =", userRef);
  console.log("[addProductToBasket] basketId =", basketId);
  console.log("[addProductToBasket] productId =", productId, "qty =", qty);

  const res = await api.put(
    `/shop/${shopId}/order/basket/${basketId}/add/${productId}/${qty}`,
    {}
  );

  console.log("[addProductToBasket] response.id =", res.data?.id, "customerId =", res.data?.customerId);
  return res.data;
}