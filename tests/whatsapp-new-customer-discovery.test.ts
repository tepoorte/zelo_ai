import assert from "node:assert/strict";

import type { Product } from "../src/swissdata/products.js";
import {
  LARGE_DISCOVERY_BASKET_PRODUCT_ID,
  STANDARD_DISCOVERY_BASKET_PRODUCT_ID,
  WhatsAppNewCustomerDiscoveryService,
  type WhatsAppNewCustomerDiscoveryDeps,
} from "../src/integrations/meta/whatsapp-new-customer-discovery.service.js";

const userRef = "wa:41760000001";
const otherUserRef = "wa:41760000002";
const regionId = "region-gland";

function product(
  id: string,
  overrides: Partial<Product> = {}
): Product {
  const standard = id === STANDARD_DISCOVERY_BASKET_PRODUCT_ID;
  return {
    id,
    name: standard ? "A. Panier découverte" : "A. Grand panier découverte",
    description: standard
      ? "Fruits, légumes et produits frais de saison."
      : "Une sélection familiale de produits frais.",
    shortDescription: "Pas les lundis.",
    type: "sell",
    categories: ["food"],
    availableRegions: [{ id: regionId }],
    optionsIds: [],
    availableOptions: [],
    price: standard
      ? { price: 92.59, vat: 0.026 }
      : { price: 165.69, vat: 0.026 },
    ...overrides,
  };
}

type Harness = {
  service: WhatsAppNewCustomerDiscoveryService;
  products: Map<string, Product | null>;
  sent: Array<{ to: string; body: string; previewUrl?: boolean }>;
  quantities: Array<{ userRef: string; basketId: string; productId: string; quantity: number }>;
  basketByUser: Map<string, any>;
  regionByUser: Map<string, string | null>;
  now: { value: number };
  failSend: { value: boolean };
  failSet: { value: boolean };
  fetchErrors: Map<string, number>;
  sendControl: { wait: Promise<void> | null; onEnter: (() => void) | null };
};

function makeHarness(ttlMs = 24 * 60 * 60 * 1000): Harness {
  const products = new Map<string, Product | null>([
    [STANDARD_DISCOVERY_BASKET_PRODUCT_ID, product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID)],
    [LARGE_DISCOVERY_BASKET_PRODUCT_ID, product(LARGE_DISCOVERY_BASKET_PRODUCT_ID)],
  ]);
  const sent: Harness["sent"] = [];
  const quantities: Harness["quantities"] = [];
  const basketByUser = new Map<string, any>();
  const regionByUser = new Map<string, string | null>();
  const now = { value: Date.parse("2026-09-29T12:00:00.000Z") };
  const failSend = { value: false };
  const failSet = { value: false };
  const fetchErrors = new Map<string, number>();
  const sendControl = {
    wait: null as Promise<void> | null,
    onEnter: null as (() => void) | null,
  };

  function currentBasket(ref: string) {
    const existing = basketByUser.get(ref);
    if (existing) return existing;
    const created = {
      id: `basket-${ref}`,
      currency: "CHF",
      products: [],
      totalPriceTTC: 0,
    };
    basketByUser.set(ref, created);
    return created;
  }

  const deps: WhatsAppNewCustomerDiscoveryDeps = {
    now: () => now.value,
    fetchProduct: async (_ref, productId) => {
      const errorsLeft = fetchErrors.get(productId) ?? 0;
      if (errorsLeft > 0) {
        fetchErrors.set(productId, errorsLeft - 1);
        throw new Error("temporary catalog error");
      }
      return products.get(productId) ?? null;
    },
    getCustomerRegion: async (ref) =>
      regionByUser.has(ref) ? regionByUser.get(ref) ?? null : regionId,
    getBasket: async (ref) => structuredClone(currentBasket(ref)),
    setProductQuantity: async (ref, basketId, productId, quantity) => {
      if (failSet.value) {
        failSet.value = false;
        throw new Error("temporary write error");
      }
      quantities.push({ userRef: ref, basketId, productId, quantity });
      const basket = currentBasket(ref);
      const resolvedProduct = products.get(productId);
      basket.products = [
        ...basket.products.filter((line: any) => line.productId !== productId),
        {
          productId,
          name: resolvedProduct?.name ?? productId,
          quantity,
        },
      ];
      basket.totalPriceTTC = idPriceTtc(productId);
      return structuredClone(basket);
    },
    sendText: async (message) => {
      sendControl.onEnter?.();
      if (sendControl.wait) await sendControl.wait;
      if (failSend.value) throw new Error("Meta unavailable");
      sent.push(message);
      return {};
    },
  };

  return {
    service: new WhatsAppNewCustomerDiscoveryService(deps, ttlMs),
    products,
    sent,
    quantities,
    basketByUser,
    regionByUser,
    now,
    failSend,
    failSet,
    fetchErrors,
    sendControl,
  };
}

function idPriceTtc(productId: string): number {
  return productId === STANDARD_DISCOVERY_BASKET_PRODUCT_ID ? 95 : 170;
}

async function arm(harness: Harness, ref = userRef) {
  return await harness.service.sendWelcomeAndArm({
    userRef: ref,
    phone: ref.slice(3),
    regionId,
  });
}

// The two live-catalog products are offered with their current TTC prices.
{
  const harness = makeHarness();
  const result = await arm(harness);
  assert.equal(result.offered, true);
  assert.equal(harness.sent.length, 1);
  assert.match(result.message, /Panier découverte.*95\.00 CHF TTC/);
  assert.match(result.message, /Grand panier découverte.*170\.00 CHF TTC/);
  assert.match(result.message, /Rien ne sera commandé automatiquement/);
  assert.equal(harness.service.hasActiveState(userRef), true);
}

// State is armed only after Meta confirms that the welcome message was sent.
{
  const harness = makeHarness();
  harness.failSend.value = true;
  await assert.rejects(() => arm(harness), /Meta unavailable/);
  assert.equal(harness.service.hasActiveState(userRef), false);
}

// If only one product is valid for the customer's region, only that product is proposed.
{
  const harness = makeHarness();
  harness.products.set(
    STANDARD_DISCOVERY_BASKET_PRODUCT_ID,
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, {
      availableRegions: [{ id: "another-region" }],
    })
  );
  const result = await arm(harness);
  assert.equal(result.offered, true);
  assert.doesNotMatch(result.message, /95\.00 CHF TTC/);
  assert.match(result.message, /170\.00 CHF TTC/);
  const confirmation = await harness.service.handleMessage({ userRef, text: "2" });
  assert.match(confirmation ?? "", /Prix actuel : 170\.00 CHF TTC/);
}

// Selection is revalidated, explicitly confirmed and sets an exact quantity of one.
{
  const harness = makeHarness();
  await arm(harness);
  const confirmation = await harness.service.handleMessage({ userRef, text: "1" });
  assert.match(confirmation ?? "", /Composition actuelle : Fruits, légumes/);
  assert.match(confirmation ?? "", /elle ne passe aucune commande/);

  const [first, duplicate] = await Promise.all([
    harness.service.handleMessage({ userRef, text: "oui" }),
    harness.service.handleMessage({ userRef, text: "oui" }),
  ]);
  assert.equal(harness.quantities.length, 1);
  assert.deepEqual(harness.quantities[0], {
    userRef,
    basketId: `basket-${userRef}`,
    productId: STANDARD_DISCOVERY_BASKET_PRODUCT_ID,
    quantity: 1,
  });
  assert.match(first ?? "", /Aucune commande n’a été passée/);
  assert.equal(duplicate, first);
  assert.equal(harness.service.hasActiveState(userRef), false);
  // « ok » is intentionally left to the normal assistant (checkout flow).
  assert.equal(
    await harness.service.handleMessage({ userRef, text: "ok" }),
    null
  );
}

// A later repetition of the same explicit confirmation reuses the completed
// result and cannot add another unit or fall through to the normal assistant.
{
  const harness = makeHarness();
  await arm(harness);
  await harness.service.handleMessage({ userRef, text: "1" });
  const first = await harness.service.handleMessage({ userRef, text: "oui" });
  const repeated = await harness.service.handleMessage({ userRef, text: "oui" });
  assert.equal(repeated, first);
  assert.equal(harness.quantities.length, 1);
  assert.equal(harness.quantities[0].quantity, 1);
}

// A normal assistant request closes the mini-flow and is returned to the caller untouched.
{
  const harness = makeHarness();
  await arm(harness);
  assert.equal(
    await harness.service.handleMessage({ userRef, text: "ajoute deux pains" }),
    null
  );
  assert.equal(harness.service.hasActiveState(userRef), false);
}

// Refusal, explicit clearing and expiry never mutate the basket.
{
  const harness = makeHarness(1_000);
  await arm(harness);
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "non merci" })) ?? "",
    /aucun panier découverte n’a été ajouté/
  );
  assert.equal(harness.quantities.length, 0);

  await arm(harness);
  await harness.service.clear(userRef);
  assert.equal(await harness.service.handleMessage({ userRef, text: "1" }), null);

  await arm(harness);
  harness.now.value += 1_001;
  assert.equal(await harness.service.handleMessage({ userRef, text: "1" }), null);
}

// Logging out while the WhatsApp welcome is still in flight prevents the
// asynchronous completion from re-arming the promotional state afterwards.
{
  const harness = makeHarness();
  let releaseSend!: () => void;
  let markSendEntered!: () => void;
  harness.sendControl.wait = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const sendEntered = new Promise<void>((resolve) => {
    markSendEntered = resolve;
  });
  harness.sendControl.onEnter = markSendEntered;

  const welcome = arm(harness);
  await sendEntered;
  const cleared = harness.service.clear(userRef);
  releaseSend();
  const [result] = await Promise.all([welcome, cleared]);
  assert.equal(result.offered, false);
  assert.equal(harness.service.hasActiveState(userRef), false);
}

// A temporary read/write outage leaves the relevant state available for a safe retry.
{
  const harness = makeHarness();
  await arm(harness);
  harness.fetchErrors.set(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, 1);
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "1" })) ?? "",
    /Réessaie dans un instant/
  );
  assert.equal(harness.service.hasActiveState(userRef), true);
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "1" })) ?? "",
    /Réponds « oui » ou « non »/
  );

  harness.failSet.value = true;
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "oui" })) ?? "",
    /Réessaie dans un instant/
  );
  assert.equal(harness.service.hasActiveState(userRef), true);
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "oui" })) ?? "",
    /Aucune commande n’a été passée/
  );
  assert.equal(harness.quantities.length, 1);
}

// Deleted, non-sell, option-bearing, badly priced and out-of-region products are not offered.
{
  const invalidProducts: Array<Product | null> = [
    null,
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, { type: "digital" }),
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, { optionsIds: ["required-option"] }),
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, { price: { price: 92.59 } }),
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, {
      availableRegions: [{ id: "another-region" }],
    }),
  ];

  for (const invalid of invalidProducts) {
    const harness = makeHarness();
    harness.products.set(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, invalid);
    harness.products.set(LARGE_DISCOVERY_BASKET_PRODUCT_ID, null);
    const result = await arm(harness);
    assert.equal(result.offered, false);
    assert.match(result.message, /utiliser l’assistant/);
    assert.equal(harness.service.hasActiveState(userRef), false);
  }
}

// A product that becomes unsafe between selection and confirmation is not added.
{
  const harness = makeHarness();
  await arm(harness);
  await harness.service.handleMessage({ userRef, text: "1" });
  harness.products.set(
    STANDARD_DISCOVERY_BASKET_PRODUCT_ID,
    product(STANDARD_DISCOVERY_BASKET_PRODUCT_ID, { availableOptions: [{ id: "new-option" }] })
  );
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "oui" })) ?? "",
    /Rien n’a été ajouté/
  );
  assert.equal(harness.quantities.length, 0);
}

// The customer's current region is re-read at confirmation time.
{
  const harness = makeHarness();
  await arm(harness);
  await harness.service.handleMessage({ userRef, text: "1" });
  harness.regionByUser.set(userRef, "another-region");
  assert.match(
    (await harness.service.handleMessage({ userRef, text: "oui" })) ?? "",
    /n’est plus disponible/
  );
  assert.equal(harness.quantities.length, 0);
}

// State is isolated per authenticated WhatsApp principal.
{
  const harness = makeHarness();
  await arm(harness, userRef);
  await arm(harness, otherUserRef);
  await harness.service.handleMessage({ userRef, text: "non" });
  assert.equal(harness.service.hasActiveState(userRef), false);
  assert.equal(harness.service.hasActiveState(otherUserRef), true);
}

console.log("WhatsApp new-customer discovery tests: OK");
