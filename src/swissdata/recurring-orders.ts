import { env } from "../config/env.js";
import { swissdataAdminClient } from "./admin-client.js";
import { swissdataClient, withSwissdataReadRetry } from "./client.js";
import { getAllProducts } from "./products.js";
import {
  isWhatsAppUserRef,
  requireWhatsAppCustomerSession,
} from "./whatsapp-customer-session.js";

export type RecurringOrderProductLine = {
  productId: string;
  quantity: number;
  name?: string;
  productName?: string;
  product?: {
    id?: string;
    name?: string;
  };
};

export type CustomerRecurringOrder = {
  id: string;
  name: string;
  customerId: string;
  daysOfWeek: number[];
  deliveryTime?: string | null;
  frequencyUnit?: string | null;
  recurringOrderStatus?: string | null;
  start?: string | null;
  end?: string | null;
  nextDates: string[];
  products: RecurringOrderProductLine[];
  raw?: Record<string, unknown>;
};

export type RecurringCustomerContext = {
  customerId: string;
};

function requireShopId(): string {
  if (!env.swissdataShopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  return env.swissdataShopId;
}

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "toString" in value) return String(value);
  return "";
}

function sameId(left: unknown, right: unknown): boolean {
  const leftId = idOf(left);
  const rightId = idOf(right);
  return Boolean(leftId && rightId && leftId === rightId);
}

function listFromResponse(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function recurringId(order: any): string {
  return idOf(order?.id ?? order?._id);
}

function recurringCustomerId(order: any): string {
  return idOf(order?.customerId ?? order?.customer?.id ?? order?.customer?._id);
}

function productName(line: any, productNames: Map<string, string>): string {
  const productId = idOf(line?.productId ?? line?.product?.id ?? line?.product?._id);
  return String(
    line?.name ??
      line?.productName ??
      line?.product?.name ??
      productNames.get(productId) ??
      productId ??
      "Produit"
  );
}

function normalizeProducts(lines: any[], productNames: Map<string, string>): RecurringOrderProductLine[] {
  const normalized: RecurringOrderProductLine[] = [];

  for (const line of lines) {
    const productId = idOf(line?.productId ?? line?.product?.id ?? line?.product?._id);
    if (!productId) continue;
    const quantity = Number(line?.quantity ?? line?.qty ?? 1);
    normalized.push({
        productId,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        name: productName(line, productNames),
    });
  }

  return normalized;
}

function normalizeRecurringOrder(
  order: any,
  customerId: string,
  productNames: Map<string, string>,
  nextDates: string[] = []
): CustomerRecurringOrder | null {
  const id = recurringId(order);
  if (!id || !sameId(recurringCustomerId(order), customerId)) return null;

  const days = Array.isArray(order?.daysOfWeek)
    ? order.daysOfWeek.map((day: unknown) => Number(day)).filter((day: number) => Number.isFinite(day))
    : [];

  const rawNextDates = Array.isArray(order?.nextDeliveryDates)
    ? order.nextDeliveryDates
    : Array.isArray(order?.nextDates)
      ? order.nextDates
      : nextDates;

  return {
    id,
    name: String(order?.name ?? "Commande récurrente"),
    customerId,
    daysOfWeek: days,
    deliveryTime: typeof order?.deliveryTime === "string" ? order.deliveryTime : null,
    frequencyUnit: typeof order?.frequencyUnit === "string" ? order.frequencyUnit : null,
    recurringOrderStatus: typeof order?.recurringOrderStatus === "string" ? order.recurringOrderStatus : null,
    start: order?.start ? String(order.start) : null,
    end: order?.end ? String(order.end) : null,
    nextDates: rawNextDates.map((date: unknown) => String(date)).filter(Boolean).slice(0, 5),
    products: normalizeProducts(Array.isArray(order?.products) ? order.products : [], productNames),
    raw: order && typeof order === "object" ? order : undefined,
  };
}

async function productNameMap(userRef: string): Promise<Map<string, string>> {
  const catalog = await getAllProducts(userRef).catch(() => []);
  const names = new Map<string, string>();
  for (const product of catalog) {
    if (product?.id && product?.name) {
      names.set(String(product.id), String(product.name));
    }
  }
  return names;
}

async function fetchWebCustomerContext(userRef: string): Promise<RecurringCustomerContext> {
  const api = swissdataClient(userRef);
  const shopId = requireShopId();
  const res = await api.get(`/shop/${shopId}/customer/current`);
  const customerId = idOf(res.data?.id ?? res.data?._id);
  if (!customerId) throw new Error("Swissdata customer current not found");
  return { customerId };
}

export async function getRecurringCustomerContext(userRef: string): Promise<RecurringCustomerContext> {
  if (isWhatsAppUserRef(userRef)) {
    const session = requireWhatsAppCustomerSession(userRef);
    return { customerId: session.customerId };
  }

  return await fetchWebCustomerContext(userRef);
}

async function fetchRecurringOrderDates(
  userRef: string,
  recurringOrder: CustomerRecurringOrder
): Promise<string[]> {
  const shopId = requireShopId();

  try {
    if (isWhatsAppUserRef(userRef)) {
      const api = await swissdataAdminClient();
      const res = await api.get(`/shop/admin/${shopId}/order`, {
        params: {
          customerId: recurringOrder.customerId,
          recurringId: recurringOrder.id,
          sort: "estimatedDeliveryDate",
          limit: 20,
        },
      });
      return listFromResponse(res.data)
        .filter((order) => !order?.customerId || sameId(order.customerId, recurringOrder.customerId))
        .map((order) => String(order?.estimatedDeliveryDate ?? order?.deliveryDate ?? ""))
        .filter(Boolean)
        .slice(0, 5);
    }

    const api = swissdataClient(userRef);
    const res = await api.get(`/shop/${shopId}/recurring-order/${recurringOrder.id}/order`);
    return listFromResponse(res.data)
      .map((order) => String(order?.estimatedDeliveryDate ?? order?.deliveryDate ?? ""))
      .filter(Boolean)
      .slice(0, 5);
  } catch {
    return recurringOrder.nextDates;
  }
}

export async function listCustomerRecurringOrders(userRef: string): Promise<CustomerRecurringOrder[]> {
  const shopId = requireShopId();
  const context = await getRecurringCustomerContext(userRef);
  const names = await productNameMap(userRef);

  const rawOrders = await withSwissdataReadRetry("swissdata.recurring_orders", async () => {
    if (isWhatsAppUserRef(userRef)) {
      const api = await swissdataAdminClient();
      const res = await api.get(`/shop/admin/${shopId}/recurring-order`, {
        params: {
          customerId: context.customerId,
          autoFetch: "nextDeliveryDates",
          limit: 100,
        },
      });
      return listFromResponse(res.data);
    }

    const api = swissdataClient(userRef);
    const res = await api.get(`/shop/${shopId}/recurring-order`, {
      params: {
        autoFetch: "products,nextDeliveryDates",
        limit: 100,
      },
    });
    return listFromResponse(res.data);
  });

  const normalized = rawOrders
    .map((order) => normalizeRecurringOrder(order, context.customerId, names))
    .filter((order): order is CustomerRecurringOrder => Boolean(order));

  return await Promise.all(
    normalized.map(async (order) => ({
      ...order,
      nextDates: order.nextDates.length ? order.nextDates : await fetchRecurringOrderDates(userRef, order),
    }))
  );
}

export async function updateCustomerRecurringProducts(
  userRef: string,
  recurringOrderId: string,
  products: Array<{ productId: string; quantity: number }>
): Promise<CustomerRecurringOrder> {
  const shopId = requireShopId();
  const ownedOrders = await listCustomerRecurringOrders(userRef);
  const target = ownedOrders.find((order) => sameId(order.id, recurringOrderId));
  if (!target) {
    throw new Error("Recurring order not found for current customer");
  }

  const safeProducts = products
    .map((line) => ({
      productId: idOf(line.productId),
      quantity: Math.max(0, Number(line.quantity ?? 0)),
    }))
    .filter((line) => line.productId && line.quantity > 0);

  if (isWhatsAppUserRef(userRef)) {
    const api = await swissdataAdminClient();
    await api.put(`/shop/admin/${shopId}/recurring-order/${target.id}`, {
      products: safeProducts,
    });
  } else {
    const api = swissdataClient(userRef);
    await api.put(`/shop/${shopId}/recurring-order/${target.id}`, {
      products: safeProducts,
    });
  }

  const refreshed = await listCustomerRecurringOrders(userRef);
  const updated = refreshed.find((order) => sameId(order.id, target.id));
  if (!updated) throw new Error("Recurring order update ownership check failed");
  return updated;
}
