import { env } from "../config/env.js";
import { sendSafeMail } from "../services/mail.service.js";
import { getAllProducts } from "./products.js";
import { swissdataAdminClient } from "./admin-client.js";
import { requireWhatsAppCustomerSession } from "./whatsapp-customer-session.js";
import {
  formatEstimatedDeliveryDate,
  isBasketDeliveryDateFuture,
  sortSelectableDeliverySlots,
} from "./delivery-date.js";
import {
  type DeliveryType,
  selectLivraisonDeliveryType,
} from "./delivery-type.js";
import type { SwissdataPaymentMethod } from "./cart.js";
import { withAssistantOrderMetadata } from "./order-source-metadata.js";

export type BasketLike = {
  id?: string;
  _id?: string;
  region?: string;
  deliveryType?: string | null;
  deliverySlotId?: string | null;
  estimatedDeliveryDate?: string | null;
  deliveryAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  paymentMethod?: string;
  acceptedTermsDate?: string | null;
  products?: Array<any>;
  status?: string;
  customerId?: string;
  recurringId?: unknown;
  country?: string;
  currency?: string;
  totalPriceTTC?: number;
  _updatedAt?: string;
  updatedAt?: string;
  metadata?: Array<{ key?: string; value?: unknown }>;
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
  id?: string;
  region?: string;
  favoriteDeliveryType?: string;
  addresses?: CustomerAddress[];
  user?: {
    email?: string;
  };
  email?: string;
};

type Country = {
  id?: string;
  _id?: string;
  countryCode?: string;
  currency?: string;
  appId?: string;
  shopId?: string;
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

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "toString" in value) return String(value);
  return "";
}

function basketId(basket: BasketLike): string {
  return idOf(basket.id ?? basket._id);
}

function sameId(left: unknown, right: unknown): boolean {
  return Boolean(idOf(left) && idOf(left) === idOf(right));
}

function basketUpdatedAtMs(basket: BasketLike): number {
  const value = basket._updatedAt ?? basket.updatedAt;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function selectDirectCustomerBaskets(
  baskets: BasketLike[],
  customerId: string
): BasketLike[] {
  return baskets
    .filter((basket) => basket.status === "basket")
    .filter((basket) => sameId(basket.customerId, customerId))
    .filter((basket) => basket.recurringId == null || basket.recurringId === "")
    .sort((left, right) => basketUpdatedAtMs(right) - basketUpdatedAtMs(left));
}

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
    if (line?.name || line?.productName || line?.product?.name) return line;
    const resolvedName = namesById.get(String(line?.productId ?? ""));
    return resolvedName
      ? {
          ...line,
          name: resolvedName,
          productName: resolvedName,
        }
      : line;
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

function primaryCustomerAddress(customer: CustomerProfile | null): CustomerAddress | undefined {
  return Array.isArray(customer?.addresses) ? customer.addresses[0] : undefined;
}

function todayAsBasketDate(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear());
  return `${day}-${month}-${year}`;
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

async function fetchCountry() {
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.get(`/shop/${shopId}/country`, {
    params: {
      countryCode: env.swissdataCountry,
    },
  });
  const countries: Country[] = Array.isArray(res.data) ? res.data : [];
  const country = countries.find((item) => item.countryCode === env.swissdataCountry) ?? countries[0];
  if (!country) throw new Error("Swissdata country not found");
  return country;
}

async function fetchCustomerProfile(userRef: string): Promise<CustomerProfile | null> {
  const session = requireWhatsAppCustomerSession(userRef);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.get(`/shop/admin/${shopId}/customer/${session.customerId}`, {
    params: { autoFetch: "user" },
  });
  return res.data ?? null;
}

async function fetchDeliveryTypes(): Promise<DeliveryType[]> {
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.get(`/shop/${shopId}/delivery-type`);
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchFutureDeliverySlots(region: string, deliveryTypeId: string): Promise<DeliverySlot[]> {
  const api = await swissdataAdminClient();
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

function selectDeliveryType(
  customer: CustomerProfile | null,
  basket: BasketLike,
  deliveryTypes: DeliveryType[]
): string | undefined {
  const region = basket.region ?? customer?.region;
  const primaryAddress = primaryCustomerAddress(customer);
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

async function addLivraisonDeliveryTypePatch(
  customer: CustomerProfile | null,
  basket: BasketLike,
  patch: Record<string, unknown>
): Promise<void> {
  const candidateBasket = candidateBasketWithPatch(basket, patch);
  if (!basketNeedsDeliverySlot(candidateBasket)) return;
  const deliveryTypes = await fetchDeliveryTypes();
  const deliveryType = selectDeliveryType(customer, candidateBasket, deliveryTypes);
  if (deliveryType && candidateBasket.deliveryType !== deliveryType) {
    patch.deliveryType = deliveryType;
  }
}

async function addNextDeliverySlotPatch(
  basket: BasketLike,
  patch: Record<string, unknown>
): Promise<void> {
  const candidateBasket = candidateBasketWithPatch(basket, patch);
  const needsRefresh =
    !candidateBasket.deliverySlotId ||
    !isBasketDeliveryDateFuture(candidateBasket.estimatedDeliveryDate);

  if (
    basketNeedsDeliverySlot(candidateBasket) &&
    candidateBasket.region &&
    candidateBasket.deliveryType
  ) {
    const slots = await fetchFutureDeliverySlots(
      String(candidateBasket.region),
      String(candidateBasket.deliveryType)
    );
    const firstSlot = slots[0];
    if (firstSlot?.id) {
      const estimatedDeliveryDate = formatEstimatedDeliveryDate(firstSlot.date, firstSlot.timeStart);
      const differs =
        candidateBasket.deliverySlotId !== firstSlot.id ||
        candidateBasket.estimatedDeliveryDate !== estimatedDeliveryDate;
      if (needsRefresh || differs) {
        patch.deliverySlotId = firstSlot.id;
        patch.estimatedDeliveryDate = estimatedDeliveryDate;
      }
    } else if (candidateBasket.deliverySlotId || candidateBasket.estimatedDeliveryDate) {
      patch.deliverySlotId = null;
      patch.estimatedDeliveryDate = null;
    }
  }
}

async function updateBasketProperties(basketIdValue: string, body: Record<string, unknown>) {
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.put(`/shop/admin/${shopId}/order/${basketIdValue}`, body);
  return res.data;
}

async function fetchCustomerBaskets(userRef: string): Promise<BasketLike[]> {
  const session = requireWhatsAppCustomerSession(userRef);
  const country = await fetchCountry();
  const countryId = idOf(country.id ?? country._id);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const res = await api.get(`/shop/admin/${shopId}/order`, {
    params: {
      customerId: session.customerId,
      status: "basket",
      country: countryId,
      sort: "-_updatedAt",
      limit: 20,
    },
  });

  const baskets: BasketLike[] = Array.isArray(res.data)
    ? res.data
    : Array.isArray(res.data?.items)
      ? res.data.items
      : [];

  return selectDirectCustomerBaskets(baskets, session.customerId);
}

async function createCustomerBasket(userRef: string): Promise<BasketLike> {
  const session = requireWhatsAppCustomerSession(userRef);
  const country = await fetchCountry();
  const countryId = idOf(country.id ?? country._id);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const body: Record<string, unknown> = {
    status: "basket",
    customerId: session.customerId,
    country: countryId,
    currency: country.currency || "CHF",
    shopId,
  };
  if (country.appId || env.swissdataAppId) {
    body.appId = country.appId || env.swissdataAppId;
  }

  const res = await api.post(`/shop/admin/${shopId}/order`, body);
  return res.data;
}

async function rawCurrentBasket(userRef: string): Promise<BasketLike> {
  const baskets = await fetchCustomerBaskets(userRef);
  return baskets[0] ?? await createCustomerBasket(userRef);
}

async function fetchCustomerBasketById(userRef: string, basketIdValue: string): Promise<BasketLike | null> {
  if (!basketIdValue) return null;
  const baskets = await fetchCustomerBaskets(userRef);
  return baskets.find((basket) => sameId(basketId(basket), basketIdValue)) ?? null;
}

async function enrichWhatsAppBasket(userRef: string, basket: BasketLike): Promise<BasketLike> {
  const catalog = await getAllProducts(userRef);
  return enrichBasketProductsWithNames(basket, catalog);
}

async function prepareBasketDeliverySlot(userRef: string, basket: BasketLike) {
  const id = basketId(basket);
  if (!id || !basketNeedsDeliverySlot(basket)) return basket;

  const customer = await fetchCustomerProfile(userRef);
  const patch: Record<string, unknown> = {};
  addCustomerAddressPatch(basket, customer, patch);
  await addLivraisonDeliveryTypePatch(customer, basket, patch);
  await addNextDeliverySlotPatch(basket, patch);

  if (!Object.keys(patch).length) return basket;
  await updateBasketProperties(id, patch);
  return await whatsappGetCurrentBasket(userRef);
}

async function prepareBasketForCheckout(
  userRef: string,
  basket: BasketLike,
  paymentMethod: SwissdataPaymentMethod
) {
  const id = basketId(basket);
  if (!id) return basket;

  const customer = await fetchCustomerProfile(userRef);
  const patch: Record<string, unknown> = {};
  addCustomerAddressPatch(basket, customer, patch, {
    copyDeliveryToBillingIfMissing: true,
  });

  if (!basket.paymentMethod) patch.paymentMethod = paymentMethod;
  if (!basket.acceptedTermsDate) patch.acceptedTermsDate = todayAsBasketDate();

  await addLivraisonDeliveryTypePatch(customer, basket, patch);
  await addNextDeliverySlotPatch(basket, patch);

  if (!Object.keys(patch).length) return basket;
  await updateBasketProperties(id, patch);
  return await whatsappGetCurrentBasket(userRef);
}

export async function whatsappEnsureCurrentBasketFutureDelivery(userRef: string) {
  const basket = await whatsappGetCurrentBasket(userRef);
  return await prepareBasketDeliverySlot(userRef, basket);
}

export async function whatsappGetCurrentBasket(userRef: string) {
  const basket = await rawCurrentBasket(userRef);
  return await enrichWhatsAppBasket(userRef, basket);
}

export async function whatsappAddProductToBasket(
  userRef: string,
  basketIdValue: string,
  productId: string,
  qty: number,
  optionsIds: string[] = []
) {
  requireWhatsAppCustomerSession(userRef);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.put(
    `/shop/admin/${shopId}/order/${basketIdValue}/add/${productId}/${qty}`,
    { optionsIds }
  );
  return res.data;
}

export async function whatsappSetProductQuantityInBasket(
  userRef: string,
  basketIdValue: string,
  productId: string,
  qty: number,
  optionsIds: string[] = []
) {
  requireWhatsAppCustomerSession(userRef);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.put(
    `/shop/admin/${shopId}/order/${basketIdValue}/add/${productId}/${qty}`,
    { optionsIds },
    { params: { quantityMode: "exact" } }
  );
  return res.data;
}

export async function whatsappRemoveProductFromBasket(
  userRef: string,
  basketIdValue: string,
  productId: string,
  optionsIds: string[] = []
) {
  requireWhatsAppCustomerSession(userRef);
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");
  const res = await api.put(
    `/shop/admin/${shopId}/order/${basketIdValue}/remove/${productId}`,
    { options: optionsIds }
  );
  return res.data;
}

export async function whatsappClearCurrentBasket(userRef: string) {
  const basket = await whatsappGetCurrentBasket(userRef);
  const currentBasketId = basketId(basket);
  const products = Array.isArray(basket.products) ? basket.products : [];

  for (const product of products) {
    const productId = String(product.productId ?? "");
    if (!productId) continue;
    await whatsappRemoveProductFromBasket(
      userRef,
      currentBasketId,
      productId,
      Array.isArray(product.optionsIds) ? product.optionsIds : []
    );
  }

  const refreshedBasket = await fetchCustomerBasketById(userRef, currentBasketId);
  return await enrichWhatsAppBasket(userRef, refreshedBasket ?? { ...basket, products: [] });
}

async function sendOrderConfirmationEmail(userRef: string, order: BasketLike) {
  const session = requireWhatsAppCustomerSession(userRef);
  const products = Array.isArray(order.products) ? order.products : [];
  const lines = products.map((product: any) => {
    const name = product.name || product.productName || product.product?.name || product.productId;
    return `- ${product.quantity ?? 1} x ${name}`;
  });
  const orderRef = basketId(order) || "commande";
  const total =
    typeof order.totalPriceTTC === "number"
      ? `\nTotal TTC : ${order.totalPriceTTC.toFixed(2)} CHF`
      : "";
  const delivery = order.estimatedDeliveryDate
    ? `\nLivraison estimée : ${order.estimatedDeliveryDate}`
    : "";

  await sendSafeMail({
    to: session.email,
    subject: "Confirmation de commande Zelo",
    text: [
      "Bonjour,",
      "",
      "Ta commande Zelo a bien été passée depuis WhatsApp.",
      `Référence : ${orderRef}`,
      "",
      ...lines,
      total,
      delivery,
      "",
      "Merci pour ta commande.",
    ].join("\n"),
  });
}

export async function whatsappPlaceCurrentBasketOrder(
  userRef: string,
  paymentMethod: SwissdataPaymentMethod = "invoice"
) {
  const api = await swissdataAdminClient();
  const shopId = env.swissdataShopId;
  if (!shopId) throw new Error("Missing env SWISSDATA_SHOP_ID");

  const currentBasket = await whatsappGetCurrentBasket(userRef);
  const preparedBasket = await prepareBasketForCheckout(userRef, currentBasket, paymentMethod);
  const id = basketId(preparedBasket);
  if (!id) throw new Error("Basket not found");

  await updateBasketProperties(id, {
    paymentMethod,
    metadata: withAssistantOrderMetadata(preparedBasket.metadata ?? currentBasket.metadata, "whatsapp"),
  });
  const res = await api.put(`/shop/admin/${shopId}/order/${id}/validate`, {
    validationDate: todayAsBasketDate(),
  });

  const order = enrichBasketProductsWithNames(res.data, await getAllProducts(userRef));
  await sendOrderConfirmationEmail(userRef, order);
  return order;
}
