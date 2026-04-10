import { env } from "../config/env.js";
import { swissdataClient } from "./client.js";
import { getAllProducts } from "./products.js";
import { timeAsync, timeSync } from "../utils/perf.js";

export type SwissdataPaymentMethod =
  | "credit-card"
  | "twint"
  | "invoice"
  | "other";

type BasketLike = {
  id?: string;
  region?: string;
  deliveryType?: string;
  deliverySlotId?: string;
  estimatedDeliveryDate?: string;
  deliveryAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  paymentMethod?: string;
  acceptedTermsDate?: string | null;
  products?: Array<{ productType?: string }>;
};

type CustomerAddress = {
  street?: string;
  zip?: string;
  city?: string;
  country?: string;
  description?: string;
  lat?: number;
  lng?: number;
};

type CustomerProfile = {
  region?: string;
  favoriteDeliveryType?: string;
  addresses?: CustomerAddress[];
};

type DeliveryType = {
  id: string;
  availableRegions?: string[];
  zones?: string;
  useDeliverySlots?: boolean;
};

type DeliverySlot = {
  id: string;
  date: string;
  timeStart: number;
  timeEnd?: number;
  quantity?: number;
  ordersIds?: string[];
  deliveriesIds?: string[];
  isAvailable?: boolean;
};

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

function basketNeedsDeliverySlot(basket: BasketLike): boolean {
  const products = Array.isArray(basket?.products) ? basket.products : [];
  return products.some((product) => product?.productType === "sell");
}

function isAddressComplete(address: Record<string, unknown> | undefined): boolean {
  return Boolean(
    address &&
      typeof address.street === "string" &&
      address.street &&
      typeof address.zip === "string" &&
      address.zip &&
      typeof address.city === "string" &&
      address.city &&
      typeof address.country === "string" &&
      address.country
  );
}

function todayAsBasketDate(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear());
  return `${day}-${month}-${year}`;
}

function formatEstimatedDeliveryDate(dateValue: string, timeStart: number): string {
  const raw = String(dateValue ?? "").slice(0, 10);
  const normalized = /^\d{2}-\d{2}-\d{4}$/.test(raw)
    ? raw
    : (() => {
        const [year, month, day] = raw.split("-");
        return `${day}-${month}-${year}`;
      })();
  const hours = String(Math.floor(timeStart / 60)).padStart(2, "0");
  const minutes = String(timeStart % 60).padStart(2, "0");
  return `${normalized} ${hours}:${minutes}`;
}

async function updateBasketProperties(userRef: string, basketId: string, body: Record<string, unknown>) {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY");

  const res = await api.put(`/shop/${shopId}/order/${basketId}`, body, {
    params: { country },
  });

  return res.data;
}

async function fetchCurrentCustomer(userRef: string): Promise<CustomerProfile | null> {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.get(`/shop/${shopId}/customer/current`);
  return res.data ?? null;
}

async function fetchDeliveryTypes(userRef: string): Promise<DeliveryType[]> {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.get(`/shop/${shopId}/delivery-type`);
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchFutureDeliverySlots(userRef: string, region: string, deliveryTypeId: string): Promise<DeliverySlot[]> {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.get(`/shop/${shopId}/delivery-slot`, {
    params: {
      region,
      deliveryTypeId,
      sort: "date,timeStart",
      onlyAvailable: "1",
    },
  });

  return Array.isArray(res.data) ? res.data : [];
}

function formatDateForSlot(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}-${month}-${year}`;
}

function nextFutureSlotDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 3);
  return formatDateForSlot(date);
}

async function fetchAdminDeliverySlots(
  userRef: string,
  region: string,
  deliveryTypeId: string
): Promise<DeliverySlot[]> {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.get(`/shop/admin/${shopId}/delivery-slot`, {
    params: {
      region,
      deliveryTypeId,
      limit: 100,
      sort: "-date,-timeStart",
    },
  });

  return Array.isArray(res.data) ? res.data : [];
}

async function updateAdminDeliverySlotDate(
  userRef: string,
  slotId: string,
  date: string
): Promise<void> {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  await api.put(`/shop/admin/${shopId}/delivery-slot/${slotId}`, { date });
}

async function ensureFutureDeliverySlots(
  userRef: string,
  region: string,
  deliveryTypeId: string
): Promise<DeliverySlot[]> {
  const available = await fetchFutureDeliverySlots(userRef, region, deliveryTypeId);
  if (available.length || env.nodeEnv === "production") {
    return available;
  }

  try {
    const adminSlots = await fetchAdminDeliverySlots(userRef, region, deliveryTypeId);
    const reusableSlots = adminSlots
      .filter((slot) => {
        const orders = Array.isArray(slot.ordersIds) ? slot.ordersIds : [];
        const deliveries = Array.isArray(slot.deliveriesIds) ? slot.deliveriesIds : [];
        return orders.length === 0 && deliveries.length === 0;
      })
      .slice(0, 3);

    if (!reusableSlots.length) {
      return available;
    }

    const futureDate = nextFutureSlotDate();
    for (const slot of reusableSlots) {
      await updateAdminDeliverySlotDate(userRef, slot.id, futureDate);
    }

    return await fetchFutureDeliverySlots(userRef, region, deliveryTypeId);
  } catch {
    return available;
  }
}

function isDeliveryTypeAvailableInRegion(deliveryType: DeliveryType | undefined, region: string | undefined): boolean {
  if (!deliveryType) return false;
  const regions = Array.isArray(deliveryType.availableRegions) ? deliveryType.availableRegions : [];
  return !region || regions.length === 0 || regions.includes(region);
}

function isDeliveryTypeAvailableInZone(deliveryType: DeliveryType | undefined, zip: string | undefined): boolean {
  if (!deliveryType) return false;
  const zones = typeof deliveryType.zones === "string"
    ? deliveryType.zones.split(",").map((zone) => zone.trim()).filter(Boolean)
    : [];
  return !zip || zones.length === 0 || zones.includes(zip);
}

function selectDeliveryType(
  customer: CustomerProfile | null,
  basket: BasketLike,
  deliveryTypes: DeliveryType[]
): string | undefined {
  const region = basket.region ?? customer?.region;
  const zip = String((basket.deliveryAddress as CustomerAddress | undefined)?.zip ?? "");

  const favorite = customer?.favoriteDeliveryType
    ? deliveryTypes.find((deliveryType) => deliveryType.id === customer.favoriteDeliveryType)
    : undefined;

  if (favorite && isDeliveryTypeAvailableInRegion(favorite, region) && isDeliveryTypeAvailableInZone(favorite, zip)) {
    return favorite.id;
  }

  const firstAvailable = deliveryTypes.find(
    (deliveryType) =>
      isDeliveryTypeAvailableInRegion(deliveryType, region) &&
      isDeliveryTypeAvailableInZone(deliveryType, zip)
  );

  return firstAvailable?.id;
}

async function prepareBasketForCheckout(
  userRef: string,
  basket: BasketLike,
  paymentMethod: SwissdataPaymentMethod
) {
  if (!basket?.id) return basket;

  const customer = await fetchCurrentCustomer(userRef);
  const primaryAddress = Array.isArray(customer?.addresses) ? customer.addresses[0] : undefined;
  const patch: Record<string, unknown> = {};

  if (!isAddressComplete(basket.deliveryAddress) && primaryAddress) {
    patch.deliveryAddress = primaryAddress;
  }

  if (!isAddressComplete(basket.billingAddress)) {
    if (primaryAddress) {
      patch.billingAddress = primaryAddress;
    } else if (isAddressComplete(basket.deliveryAddress)) {
      patch.billingAddress = basket.deliveryAddress;
    }
  }

  if (!basket.region && customer?.region) {
    patch.region = customer.region;
  }

  if (!basket.paymentMethod) {
    patch.paymentMethod = paymentMethod;
  }

  if (!basket.acceptedTermsDate) {
    patch.acceptedTermsDate = todayAsBasketDate();
  }

  const candidateBasket: BasketLike = {
    ...basket,
    ...patch,
  };

  if (basketNeedsDeliverySlot(candidateBasket) && !candidateBasket.deliveryType) {
    const deliveryTypes = await fetchDeliveryTypes(userRef);
    const deliveryType = selectDeliveryType(customer, candidateBasket, deliveryTypes);
    if (deliveryType) {
      patch.deliveryType = deliveryType;
    }
  }

  const candidateWithDeliveryType: BasketLike = {
    ...candidateBasket,
    ...patch,
  };

  if (
    basketNeedsDeliverySlot(candidateWithDeliveryType) &&
    candidateWithDeliveryType.region &&
    candidateWithDeliveryType.deliveryType &&
    !candidateWithDeliveryType.deliverySlotId
  ) {
    const slots = await ensureFutureDeliverySlots(
      userRef,
      candidateWithDeliveryType.region,
      candidateWithDeliveryType.deliveryType
    );
    const firstSlot = slots[0];
    if (firstSlot?.id) {
      patch.deliverySlotId = firstSlot.id;
      patch.estimatedDeliveryDate = formatEstimatedDeliveryDate(firstSlot.date, firstSlot.timeStart);
    }
  }

  if (!Object.keys(patch).length) {
    return basket;
  }

  await updateBasketProperties(userRef, basket.id, patch);
  return await getCurrentBasket(userRef);
}

export async function getCurrentBasket(userRef: string) {
  const api = swissdataClient(userRef);

  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing env SWISSDATA_COUNTRY (e.g. CHE)");

  const res = await timeAsync(
    "swissdata.current_basket_api",
    async () =>
      await api.get(`/shop/${shopId}/order/current-basket`, {
        params: { country },
      })
  );

  const basket = res.data;
  const catalog = await timeAsync(
    "swissdata.current_basket_catalog",
    async () => await getAllProducts(userRef)
  );

  return timeSync(
    "swissdata.current_basket_enrich_names",
    () => enrichBasketProductsWithNames(basket, catalog),
    { products: Array.isArray(basket?.products) ? basket.products.length : 0 }
  );
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

  const res = await timeAsync(
    "swissdata.add_product_api",
    async () =>
      await api.put(
        `/shop/${shopId}/order/basket/${basketId}/add/${productId}/${qty}`,
        { optionsIds }
      ),
    { productId, qty, optionsCount: optionsIds.length }
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

  const currentBasket = await getCurrentBasket(userRef);
  const basket = await prepareBasketForCheckout(userRef, currentBasket, paymentMethod);

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
