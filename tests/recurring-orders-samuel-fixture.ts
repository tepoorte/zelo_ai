import { env } from "../src/config/env.js";
import { login } from "../src/swissdata/auth.js";
import { swissdataClient } from "../src/swissdata/client.js";
import { getAllProducts, rankProductsByQuery, type Product } from "../src/swissdata/products.js";

type Customer = {
  id?: string;
  _id?: string;
  region?: string;
  favoriteDeliveryType?: string;
  addresses?: Array<Record<string, unknown>>;
};

type Country = {
  id?: string;
  _id?: string;
  appId?: string;
  currency?: string;
};

type DeliveryType = {
  id?: string;
  _id?: string;
};

type FixtureSpec = {
  name: string;
  day: number;
  deliveryTime: string;
  queries: string[];
};

const USER_REF = "fixture:recurring:samuel";
const FIXTURE_PREFIX = "AI TEST - Commande récurrente";

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "toString" in value) return String(value);
  return "";
}

function listFromResponse(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getFullYear()}`;
}

function nextDateForDay(dayOfWeek: number): string {
  const date = new Date();
  const current = date.getDay();
  const normalizedDay = dayOfWeek === 7 ? 0 : dayOfWeek;
  const delta = (normalizedDay - current + 7) % 7 || 7;
  date.setDate(date.getDate() + delta);
  return formatDate(date);
}

function dateAfterDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

async function currentCustomer(): Promise<Customer> {
  const api = swissdataClient(USER_REF);
  const res = await api.get(`/shop/${env.swissdataShopId}/customer/current`);
  return res.data;
}

async function currentCountry(): Promise<Country> {
  const api = swissdataClient(USER_REF);
  const res = await api.get(`/shop/${env.swissdataShopId}/country`, {
    params: {
      countryCode: env.swissdataCountry,
    },
  });
  const countries = Array.isArray(res.data) ? res.data : [];
  const country = countries.find((item: any) => item?.countryCode === env.swissdataCountry) ?? countries[0];
  if (!country) throw new Error("Country not found for recurring fixture");
  return country;
}

async function deliveryType(): Promise<DeliveryType> {
  const api = swissdataClient(USER_REF);
  const res = await api.get(`/shop/${env.swissdataShopId}/delivery-type`);
  const deliveryTypes = Array.isArray(res.data) ? res.data : [];
  const first = deliveryTypes[0];
  if (!first) throw new Error("Delivery type not found for recurring fixture");
  return first;
}

function pickProduct(catalog: Product[], query: string): Product {
  const ranked = rankProductsByQuery(query, catalog, 1);
  const product = ranked[0];
  if (!product?.id) throw new Error(`Product not found for fixture query: ${query}`);
  return product;
}

async function existingFixtures(): Promise<any[]> {
  const api = swissdataClient(USER_REF);
  const res = await api.get(`/shop/${env.swissdataShopId}/recurring-order`, {
    params: {
      autoFetch: "products,nextDeliveryDates",
      limit: 100,
    },
  });
  return listFromResponse(res.data).filter((order) =>
    String(order?.name ?? "").startsWith(FIXTURE_PREFIX)
  );
}

async function ensureFixture(
  spec: FixtureSpec,
  customer: Customer,
  country: Country,
  deliveryTypeValue: DeliveryType,
  catalog: Product[]
): Promise<string> {
  const api = swissdataClient(USER_REF);
  const existing = (await existingFixtures()).find((order) => String(order?.name ?? "") === spec.name);
  const countryId = idOf(country.id ?? country._id);
  const deliveryTypeId = idOf(deliveryTypeValue.id ?? deliveryTypeValue._id);
  const customerId = idOf(customer.id ?? customer._id);
  const address = Array.isArray(customer.addresses) ? customer.addresses[0] : undefined;
  const products = spec.queries.map((query) => ({
    productId: pickProduct(catalog, query).id,
    quantity: 1,
  }));

  const payload = {
    name: spec.name,
    customerId,
    shopId: env.swissdataShopId,
    appId: country.appId || env.swissdataAppId,
    country: countryId,
    currency: country.currency || "CHF",
    region: customer.region,
    deliveryAddress: address,
    billingAddress: address,
    deliveryType: customer.favoriteDeliveryType || deliveryTypeId,
    paymentMethod: "invoice",
    start: nextDateForDay(spec.day),
    end: dateAfterDays(60),
    frequencyUnit: "1/1w",
    daysOfWeek: [spec.day],
    deliveryTime: spec.deliveryTime,
    autoValidationDelay: 2,
    autoValidationTime: "15:00",
    products,
  };

  const recurringId = existing?.id ?? existing?._id;
  if (recurringId) {
    await api.put(`/shop/${env.swissdataShopId}/recurring-order/${recurringId}`, payload);
    return idOf(recurringId);
  }

  const res = await api.post(`/shop/${env.swissdataShopId}/recurring-order`, payload);
  return idOf(res.data?.id ?? res.data?._id);
}

async function ensureOrders(recurringId: string): Promise<void> {
  const api = swissdataClient(USER_REF);
  await api.post(`/shop/${env.swissdataShopId}/recurring-order/${recurringId}/order/create`);
}

async function main(): Promise<void> {
  if (env.nodeEnv === "production") {
    throw new Error("Recurring fixture is disabled in production");
  }
  if (!env.zeloTestUsername || !env.zeloTestPassword) {
    throw new Error("Missing ZELO_TEST_USERNAME / ZELO_TEST_PASSWORD");
  }
  if (!env.swissdataShopId) {
    throw new Error("Missing SWISSDATA_SHOP_ID");
  }

  await login(USER_REF, env.zeloTestUsername, env.zeloTestPassword);

  const [customer, country, selectedDeliveryType, catalog] = await Promise.all([
    currentCustomer(),
    currentCountry(),
    deliveryType(),
    getAllProducts(USER_REF),
  ]);

  const specs: FixtureSpec[] = [
    {
      name: `${FIXTURE_PREFIX} mardi`,
      day: 2,
      deliveryTime: "08:00",
      queries: ["pain balance", "oeuf bio"],
    },
    {
      name: `${FIXTURE_PREFIX} jeudi`,
      day: 4,
      deliveryTime: "09:00",
      queries: ["riz basmati", "pommes bio"],
    },
    {
      name: `${FIXTURE_PREFIX} vendredi`,
      day: 5,
      deliveryTime: "10:00",
      queries: ["kefir", "batavia"],
    },
  ];

  const createdIds: string[] = [];
  for (const spec of specs) {
    const recurringId = await ensureFixture(spec, customer, country, selectedDeliveryType, catalog);
    createdIds.push(recurringId);
    await ensureOrders(recurringId).catch((error) => {
      const status = error?.response?.status;
      const message = error?.response?.data?.message ?? error?.message ?? "unknown";
      throw new Error(`Could not create linked orders for ${spec.name}: ${status ?? ""} ${message}`);
    });
  }

  console.log(`[recurring-orders-fixture] ensured ${createdIds.length} Samuel recurring fixtures.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
