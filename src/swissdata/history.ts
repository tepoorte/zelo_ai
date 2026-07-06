import { env } from "../config/env.js";
import { swissdataAdminClient } from "./admin-client.js";
import { swissdataClient } from "./client.js";
import { timeAsync } from "../utils/perf.js";
import {
  isWhatsAppUserRef,
  requireWhatsAppCustomerSession,
} from "./whatsapp-customer-session.js";

export type PurchaseHistory = Record<string, number>;

type SwissdataOrderLine = {
  productId?: unknown;
  product?: { id?: unknown; _id?: unknown };
  quantity?: unknown;
};

type SwissdataOrder = {
  status?: string;
  customerId?: unknown;
  customer?: { id?: unknown; _id?: unknown };
  products?: SwissdataOrderLine[];
};

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const candidate = value as { id?: unknown; _id?: unknown; $oid?: unknown };
    return idOf(candidate.id ?? candidate._id ?? candidate.$oid);
  }
  return String(value);
}

function sameId(left: unknown, right: unknown): boolean {
  const a = idOf(left);
  const b = idOf(right);
  return Boolean(a && b && a === b);
}

function orderCustomerId(order: SwissdataOrder): string {
  return idOf(order.customerId ?? order.customer?.id ?? order.customer?._id);
}

function listFromResponse(data: unknown): SwissdataOrder[] {
  if (Array.isArray(data)) return data as SwissdataOrder[];
  if (data && typeof data === "object") {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items as SwissdataOrder[];
  }
  return [];
}

function addOrderProductsToHistory(history: PurchaseHistory, order: SwissdataOrder): void {
  for (const p of order.products ?? []) {
    const id = idOf(p.productId ?? p.product?.id ?? p.product?._id);
    const qty = Number(p.quantity ?? 0);

    if (!id || !Number.isFinite(qty) || qty <= 0) continue;
    history[id] = (history[id] ?? 0) + qty;
  }
}

function historyFromOrders(orders: SwissdataOrder[]): PurchaseHistory {
  const history: PurchaseHistory = {};

  for (const order of orders) {
    if (order?.status === "basket") continue;
    addOrderProductsToHistory(history, order);
  }

  return history;
}

async function getWebPurchaseHistory(userRef: string): Promise<PurchaseHistory> {
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

async function getWhatsAppPurchaseHistory(userRef: string): Promise<PurchaseHistory> {
  const session = requireWhatsAppCustomerSession(userRef);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;

  const res = await timeAsync(
    "swissdata.history_api",
    async () =>
      await api.get(`/shop/admin/${shopId}/order`, {
        params: {
          customerId: session.customerId,
          limit: 50,
          sort: "-estimatedDeliveryDate",
        },
      }),
    { limit: 50, source: "whatsapp" }
  );

  const orders = listFromResponse(res.data).filter((order) => {
    const customerId = orderCustomerId(order);
    return !customerId || sameId(customerId, session.customerId);
  });

  return historyFromOrders(orders);
}

export async function getPurchaseHistory(userRef: string): Promise<PurchaseHistory> {
  if (isWhatsAppUserRef(userRef)) {
    return await getWhatsAppPurchaseHistory(userRef);
  }

  return await getWebPurchaseHistory(userRef);
}
