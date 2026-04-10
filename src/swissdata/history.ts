import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";
import { timeAsync } from "../utils/perf.js";

export type PurchaseHistory = Record<string, number>;

export async function getPurchaseHistory(userRef: string): Promise<PurchaseHistory> {

  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  const res = await timeAsync(
    "swissdata.history_api",
    async () =>
      await api.get(`/shop/${shopId}/order`, {
        params: {
          country,
          limit: 50
        }
      }),
    { limit: 50 }
  );

  const orders = Array.isArray(res.data) ? res.data : [];

  const history: PurchaseHistory = {};

  for (const order of orders) {

    if (order?.status === "basket") continue;

    for (const p of order?.products ?? []) {

      const id = String(p.productId);
      const qty = Number(p.quantity ?? 0);

      history[id] = (history[id] ?? 0) + qty;
    }
  }

  return history;
}
