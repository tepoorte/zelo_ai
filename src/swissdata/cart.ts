import { env } from "../config/env.js";
import { swissdataClient, withSwissdataReadRetry } from "./client.js";
import { getAllProducts } from "./products.js";
import { timeAsync, timeSync } from "../utils/perf.js";
import {
  formatEstimatedDeliveryDate,
  isBasketDeliveryDateFuture,
  sortSelectableDeliverySlots,
} from "./delivery-date.js";
import {
  type DeliveryType,
  isLivraisonDeliveryType,
  selectLivraisonDeliveryType,
} from "./delivery-type.js";

export type SwissdataPaymentMethod =
  | "credit-card"
  | "twint"
  | "invoice"
  | "other";

type BasketLike = {
  id?: string;
  region?: string;
  deliveryType?: string | null;
  deliverySlotId?: string | null;
  estimatedDeliveryDate?: string | null;
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

function basketAddressDiffersFromCustomer(
  basketAddress: Record<string, unknown> | undefined,
  customerAddress: CustomerAddress | undefined
): boolean {
  if (!customerAddress || !isAddressComplete(customerAddress as Record<string, unknown>)) {
    return false;
  }
  if (!isAddressComplete(basketAddress)) return true;

  return ["street", "zip", "city", "country"].some(
    (key) => String(basketAddress?.[key] ?? "") !== String((customerAddress as any)[key] ?? "")
  );
}

function todayAsBasketDate(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear());
  return `${day}-${month}-${year}`;
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

  return Array.isArray(res.data) ? sortSelectableDeliverySlots(res.data) : [];
}

async function ensureFutureDeliverySlots(
  userRef: string,
  region: string,
  deliveryTypeId: string
): Promise<DeliverySlot[]> {
  return await fetchFutureDeliverySlots(userRef, region, deliveryTypeId);
}

function selectDeliveryType(
  customer: CustomerProfile | null,
  basket: BasketLike,
  deliveryTypes: DeliveryType[]
): string | undefined {
  const region = basket.region ?? customer?.region;
  const primaryAddress = Array.isArray(customer?.addresses) ? customer.addresses[0] : undefined;
  const zip = String((basket.deliveryAddress as CustomerAddress | undefined)?.zip ?? primaryAddress?.zip ?? "");

  return selectLivraisonDeliveryType(
    {
      region,
      zip,
      favoriteDeliveryType: customer?.favoriteDeliveryType,
    },
    deliveryTypes
  );
}

function primaryCustomerAddress(customer: CustomerProfile | null): CustomerAddress | undefined {
  return Array.isArray(customer?.addresses) ? customer.addresses[0] : undefined;
}

function candidateBasketWithPatch(basket: BasketLike, patch: Record<string, unknown>): BasketLike {
  return {
    ...basket,
    ...patch,
  };
}

function addCustomerAddressPatch(
  basket: BasketLike,
  customer: CustomerProfile | null,
  patch: Record<string, unknown>,
  options: { copyDeliveryToBillingIfMissing?: boolean } = {}
): void {
  const primaryAddress = primaryCustomerAddress(customer);

  if (basketAddressDiffersFromCustomer(basket.deliveryAddress, primaryAddress)) {
    patch.deliveryAddress = primaryAddress;
  }

  if (basketAddressDiffersFromCustomer(basket.billingAddress, primaryAddress)) {
    patch.billingAddress = primaryAddress;
  } else if (
    options.copyDeliveryToBillingIfMissing &&
    !isAddressComplete(basket.billingAddress) &&
    isAddressComplete(basket.deliveryAddress)
  ) {
    patch.billingAddress = basket.deliveryAddress;
  }

  if (!basket.region && customer?.region) {
    patch.region = customer.region;
  }
}

async function addLivraisonDeliveryTypePatch(
  userRef: string,
  customer: CustomerProfile | null,
  basket: BasketLike,
  patch: Record<string, unknown>
): Promise<void> {
  const candidateBasket = candidateBasketWithPatch(basket, patch);
  if (!basketNeedsDeliverySlot(candidateBasket)) return;

  const deliveryTypes = await fetchDeliveryTypes(userRef);
  const deliveryType = selectDeliveryType(customer, candidateBasket, deliveryTypes);
  const currentDeliveryType = candidateBasket.deliveryType
    ? deliveryTypes.find((item) => item.id === candidateBasket.deliveryType)
    : undefined;

  if (deliveryType) {
    if (candidateBasket.deliveryType !== deliveryType) {
      patch.deliveryType = deliveryType;
    }
  } else if (currentDeliveryType && !isLivraisonDeliveryType(currentDeliveryType)) {
    patch.deliveryType = null;
  }
}

async function addNextDeliverySlotPatch(
  userRef: string,
  basket: BasketLike,
  patch: Record<string, unknown>
): Promise<void> {
  const candidateBasket = candidateBasketWithPatch(basket, patch);
  const deliverySlotNeedsRefresh =
    !candidateBasket.deliverySlotId ||
    !isBasketDeliveryDateFuture(candidateBasket.estimatedDeliveryDate);

  if (
    basketNeedsDeliverySlot(candidateBasket) &&
    candidateBasket.region &&
    candidateBasket.deliveryType
  ) {
    const slots = await ensureFutureDeliverySlots(
      userRef,
      candidateBasket.region,
      candidateBasket.deliveryType
    );
    const firstSlot = slots[0];
    if (firstSlot?.id) {
      const estimatedDeliveryDate = formatEstimatedDeliveryDate(firstSlot.date, firstSlot.timeStart);
      const deliverySlotDiffers =
        candidateBasket.deliverySlotId !== firstSlot.id ||
        candidateBasket.estimatedDeliveryDate !== estimatedDeliveryDate;

      if (deliverySlotNeedsRefresh || deliverySlotDiffers) {
        patch.deliverySlotId = firstSlot.id;
        patch.estimatedDeliveryDate = estimatedDeliveryDate;
      }
    } else if (candidateBasket.deliverySlotId || candidateBasket.estimatedDeliveryDate) {
      patch.deliverySlotId = null;
      patch.estimatedDeliveryDate = null;
    }
  }
}

async function prepareBasketDeliverySlot(userRef: string, basket: BasketLike) {
  if (!basket?.id) return basket;
  if (!basketNeedsDeliverySlot(basket)) return basket;

  const customer = await fetchCurrentCustomer(userRef);
  const patch: Record<string, unknown> = {};

  addCustomerAddressPatch(basket, customer, patch);
  await addLivraisonDeliveryTypePatch(userRef, customer, basket, patch);
  await addNextDeliverySlotPatch(userRef, basket, patch);

  if (!Object.keys(patch).length) {
    return basket;
  }

  await updateBasketProperties(userRef, basket.id, patch);
  return await getCurrentBasket(userRef);
}

async function prepareBasketForCheckout(
  userRef: string,
  basket: BasketLike,
  paymentMethod: SwissdataPaymentMethod
) {
  if (!basket?.id) return basket;

  const customer = await fetchCurrentCustomer(userRef);
  const patch: Record<string, unknown> = {};

  addCustomerAddressPatch(basket, customer, patch, {
    copyDeliveryToBillingIfMissing: true,
  });
  if (!basket.paymentMethod) {
    patch.paymentMethod = paymentMethod;
  }

  if (!basket.acceptedTermsDate) {
    patch.acceptedTermsDate = todayAsBasketDate();
  }

  await addLivraisonDeliveryTypePatch(userRef, customer, basket, patch);
  await addNextDeliverySlotPatch(userRef, basket, patch);

  if (!Object.keys(patch).length) {
    return basket;
  }

  await updateBasketProperties(userRef, basket.id, patch);
  return await getCurrentBasket(userRef);
}

export async function ensureCurrentBasketFutureDelivery(userRef: string) {
  const basket = await getCurrentBasket(userRef);
  return await prepareBasketDeliverySlot(userRef, basket);
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
      await withSwissdataReadRetry("current-basket", () =>
        api.get(`/shop/${shopId}/order/current-basket`, {
          params: { country },
        })
      )
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

export async function setProductQuantityInBasket(
  userRef: string,
  basketId: string,
  productId: string,
  qty: number,
  optionsIds: string[] = []
) {
  const api = swissdataClient(userRef);
  const shopId = env.swissdataShopId;
  const country = env.swissdataCountry;

  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  if (!country) throw new Error("Missing SWISSDATA_COUNTRY");

  const res = await timeAsync(
    "swissdata.set_product_quantity_api",
    async () =>
      await api.put(
        `/shop/${shopId}/order/basket/${basketId}/add/${productId}/${qty}`,
        { optionsIds },
        { params: { country, quantityMode: "exact" } }
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
