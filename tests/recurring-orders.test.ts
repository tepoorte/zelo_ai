import assert from "node:assert/strict";

import { clearPending } from "../src/ai/pending.js";
import {
  tryHandleRecurringOrders,
  type RecurringOrdersDeps,
} from "../src/ai/services/recurring-orders.service.js";
import type { CustomerRecurringOrder } from "../src/swissdata/recurring-orders.js";
import type { Product } from "../src/swissdata/products.js";
import { computeBasketQty } from "../src/ai/services/cart-quantity.service.js";
import { BLOCKED_ASSISTANT_CATEGORY_IDS } from "../src/ai/product-eligibility.js";

const products: Record<string, Product> = {
  pain: { id: "p-pain", name: "Pain Balance", type: "sell" },
  lait: { id: "p-lait", name: "Lait Bio", type: "sell" },
  oeufs: { id: "p-oeufs", name: "Oeuf Bio à la pièce", type: "sell" },
  courges: { id: "p-courges", name: "Graines de courges", type: "sell" },
  lard: {
    id: "p-lard",
    name: "A. Lard de Begnins",
    type: "sell",
    size: "100g",
    priceType: "per-weight",
    refWeight: 100,
    refWeightUnit: "g",
  },
  pizza: {
    id: "p-pizza",
    name: "Pizza Marguerite",
    type: "sell",
    optionsIds: ["opt-pizza"],
    availableOptions: [{ id: "opt-pizza", name: "Option pizza" }],
  },
  blocked: {
    id: "p-blocked",
    name: "Produit hors périmètre",
    type: "sell",
    categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]],
  },
};

function baseOrders(): CustomerRecurringOrder[] {
  return [
    {
      id: "rec-mardi",
      name: "AI TEST - Commande récurrente mardi",
      customerId: "customer-samuel",
      daysOfWeek: [2],
      deliveryTime: "08:00",
      frequencyUnit: "1/1w",
      recurringOrderStatus: "running",
      nextDates: ["07-07-2026 08:00"],
      products: [
        { productId: "p-lait", name: "Lait Bio", quantity: 2 },
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 6 },
      ],
    },
    {
      id: "rec-jeudi",
      name: "AI TEST - Commande récurrente jeudi",
      customerId: "customer-samuel",
      daysOfWeek: [4],
      deliveryTime: "09:00",
      frequencyUnit: "1/1w",
      recurringOrderStatus: "running",
      nextDates: ["09-07-2026 09:00"],
      products: [
        { productId: "p-pain", name: "Pain Balance", quantity: 1 },
        { productId: "p-lait", name: "Lait Bio", quantity: 1 },
      ],
    },
    {
      id: "rec-vendredi",
      name: "AI TEST - Commande récurrente vendredi",
      customerId: "customer-samuel",
      daysOfWeek: [5],
      deliveryTime: "10:00",
      frequencyUnit: "1/1w",
      recurringOrderStatus: "running",
      nextDates: ["10-07-2026 10:00"],
      products: [
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 4 },
      ],
    },
  ];
}

function mondayAmbiguousOrders(): CustomerRecurringOrder[] {
  return [
    {
      id: "rec-samuel",
      name: "Samuel",
      customerId: "customer-samuel",
      daysOfWeek: [1],
      deliveryTime: "17:00",
      frequencyUnit: "1/4w",
      recurringOrderStatus: "running",
      nextDates: ["06/07/2026", "27/07/2026", "17/08/2026"],
      products: [
        { productId: "p-lait", name: "Lait Bio", quantity: 1 },
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 1 },
      ],
    },
    {
      id: "rec-samuel2",
      name: "Samuel2",
      customerId: "customer-samuel",
      daysOfWeek: [1],
      deliveryTime: "17:00",
      frequencyUnit: "1/2w",
      recurringOrderStatus: "running",
      nextDates: ["13/07/2026", "27/07/2026", "10/08/2026"],
      products: [
        { productId: "p-pain", name: "Pain Balance", quantity: 1 },
      ],
    },
    {
      id: "rec-samuel3",
      name: "Samuel3",
      customerId: "customer-samuel",
      daysOfWeek: [1],
      deliveryTime: "08:00",
      frequencyUnit: "1/3w",
      recurringOrderStatus: "running",
      nextDates: ["14/09/2026", "12/10/2026", "09/11/2026"],
      products: [
        { productId: "p-lait", name: "Lait Bio", quantity: 2 },
      ],
    },
    {
      id: "rec-two-months",
      name: "Tous les 2 mois",
      customerId: "customer-samuel",
      daysOfWeek: [5],
      deliveryTime: "08:00",
      frequencyUnit: "1/8w",
      recurringOrderStatus: "running",
      nextDates: ["07/08/2026", "02/10/2026", "27/11/2026"],
      products: [
        { productId: "p-oeufs", name: "Oeuf Bio à la pièce", quantity: 2 },
      ],
    },
  ];
}

function bimensuelOrders(): CustomerRecurringOrder[] {
  return [
    {
      id: "rec-bimensuel",
      name: "Bimensuel",
      customerId: "customer-samuel",
      daysOfWeek: [5],
      deliveryTime: "17:00",
      frequencyUnit: "1/2w",
      recurringOrderStatus: "running",
      nextDates: ["10/07/2026", "24/07/2026", "07/08/2026"],
      products: [
        { productId: "p-lait", name: "Lait Bio", quantity: 1 },
      ],
    },
    {
      id: "rec-weekly",
      name: "Hebdomadaire",
      customerId: "customer-samuel",
      daysOfWeek: [1],
      deliveryTime: "08:00",
      frequencyUnit: "1/1w",
      recurringOrderStatus: "running",
      nextDates: ["06/07/2026", "13/07/2026", "20/07/2026"],
      products: [
        { productId: "p-pain", name: "Pain Balance", quantity: 1 },
      ],
    },
  ];
}

function cloneOrders(orders: CustomerRecurringOrder[]): CustomerRecurringOrder[] {
  return orders.map((order) => ({
    ...order,
    daysOfWeek: [...order.daysOfWeek],
    nextDates: [...order.nextDates],
    products: order.products.map((line) => ({ ...line })),
  }));
}

function makeDeps(initialOrders: CustomerRecurringOrder[] = baseOrders()) {
  let orders = cloneOrders(initialOrders);
  const updates: Array<{ id: string; products: Array<{ productId: string; quantity: number }> }> = [];

  const deps: RecurringOrdersDeps = {
    listCustomerRecurringOrders: async () => orders,
    updateCustomerRecurringProducts: async (_userRef, id, nextProducts) => {
      updates.push({ id, products: nextProducts });
      orders = orders.map((order) => {
        if (order.id !== id) return order;
        return {
          ...order,
          products: nextProducts.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            name: Object.values(products).find((product) => product.id === line.productId)?.name ?? line.productId,
          })),
        };
      });
      const updated = orders.find((order) => order.id === id);
      assert(updated);
      return updated;
    },
    extractAddItemsFromText: async (_userRef, text) => {
      const normalized = text.toLowerCase();
      const items = [];
      if (normalized.includes("pain")) items.push({ query: "pain", qty: 1 });
      if (normalized.includes("lait")) items.push({ query: "lait", qty: 1 });
      if (normalized.includes("courge")) items.push({ query: "graines de courges", qty: 1, productId: "p-courges" });
      if (normalized.includes("lard")) items.push({ query: "A. Lard de Begnins", qty: 2, unit: "kg", productId: "p-lard" });
      if (normalized.includes("pizza")) items.push({ query: "Pizza Marguerite", qty: 1, unit: "piece", productId: "p-pizza" });
      if (normalized.includes("hors périmètre")) items.push({ query: "Produit hors périmètre", qty: 1, productId: "p-blocked" });
      if (normalized.includes("oeuf") || normalized.includes("œuf")) items.push({ query: "oeufs", qty: 2 });
      return {
        intent: "ADD_ITEMS",
        actions: [{ type: "add_to_cart", items }],
      };
    },
    fetchFullProduct: async (_userRef, productId) =>
      Object.values(products).find((product) => product.id === productId) ?? null,
    resolveProduct: async (_userRef, rawItem) => {
      const normalized = rawItem.toLowerCase();
      if (normalized.includes("pain")) return products.pain;
      if (normalized.includes("lait")) return products.lait;
      if (normalized.includes("courge")) return products.courges;
      if (normalized.includes("lard")) return products.lard;
      if (normalized.includes("pizza")) return products.pizza;
      if (normalized.includes("hors périmètre")) return products.blocked;
      if (normalized.includes("oeuf") || normalized.includes("œuf")) return products.oeufs;
      return null;
    },
    computeBasketQty,
  };

  return { deps, updates };
}

function assertIncludes(haystack: string, needle: string): void {
  assert(
    haystack.includes(needle),
    `Expected message to include ${JSON.stringify(needle)}.\nMessage:\n${haystack}`
  );
}

async function testShowRecurringOrders(): Promise<void> {
  const userRef = "test:recurring:show";
  clearPending(userRef);
  const { deps } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "montre mes commandes récurrentes",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Commande récurrente du mardi");
  assertIncludes(response.message, "Commande récurrente du jeudi");
  assertIncludes(response.message, "Commande récurrente du vendredi");
  assert(!response.message.includes("AI TEST"), "technical fixture prefix must not be shown to customers");
  assertIncludes(response.message, "Lait Bio");
  assertIncludes(response.message, "chaque semaine");
}

async function testAmbiguousAddRequiresChoiceThenOkConfirmation(): Promise<void> {
  const userRef = "test:recurring:choice";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const first = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(first);
  assertIncludes(first.message, "Laquelle veux-tu modifier");
  assert.equal(updates.length, 0);

  const second = await tryHandleRecurringOrders(userRef, "mardi", undefined, deps);
  assert(second);
  assertIncludes(second.message, "Changements proposés");
  assertIncludes(second.message, "Ajout");
  assertIncludes(second.message, "écris « ok »");
  assert.equal(updates.length, 0);

  const ok = await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert(ok);
  assertIncludes(ok.message, "Commande récurrente mise à jour");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-pain" && line.quantity === 1));
}

async function testRemoveFromExplicitDay(): Promise<void> {
  const userRef = "test:recurring:remove";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "retire le lait de ma commande récurrente du jeudi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Retrait");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-jeudi");
  assert(!updates[0].products.some((line) => line.productId === "p-lait"));
}

async function testRecurringAddUsesFullProductForWeightUnits(): Promise<void> {
  const userRef = "test:recurring:weight";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute 2kg de lard du begnin à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Ajout : 20 × A. Lard de Begnins");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-lard" && line.quantity === 20));
}

async function testRecurringMultiAddSkipsOptionsLikeCartAdd(): Promise<void> {
  const userRef = "test:recurring:multi-options";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute 2kg de lard du begnin et une pizza marguerita à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(response);
  assertIncludes(response.message, "Ajout : 20 × A. Lard de Begnins");
  assertIncludes(response.message, "Ajout : 1 × Pizza Marguerite");
  assert(!response.message.includes("options nécessaires"), "multi-item recurring add should mirror cart add and not block all items on options");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "confirme la commande récurrente", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-mardi");
  assert(updates[0].products.some((line) => line.productId === "p-lard" && line.quantity === 20));
  assert(updates[0].products.some((line) => line.productId === "p-pizza" && line.quantity === 1));
}

async function testAmbiguousRemoveDoesNotWrite(): Promise<void> {
  const userRef = "test:recurring:ambiguous-remove";
  clearPending(userRef);
  const { deps, updates } = makeDeps();
  const originalList = deps.listCustomerRecurringOrders;
  deps.listCustomerRecurringOrders = async (...args) => {
    const orders = await originalList(...args);
    return orders.map((order) =>
      order.id === "rec-mardi"
        ? {
            ...order,
            products: [
              { productId: "p-pain", name: "Pain Balance", quantity: 1 },
              { productId: "p-pain-choc", name: "Pain au chocolat", quantity: 1 },
            ],
          }
        : order
    );
  };

  const response = await tryHandleRecurringOrders(
    userRef,
    "retire le pain de ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "plusieurs produits possibles");
  assertIncludes(response.message, "Pain Balance");
  assertIncludes(response.message, "Pain au chocolat");
  assert.equal(updates.length, 0);
}

async function testAmbiguousMondayRequiresChoice(): Promise<void> {
  const userRef = "test:recurring:ambiguous-monday";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente de lundi",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Laquelle veux-tu modifier");
  assertIncludes(response.message, "Samuel");
  assertIncludes(response.message, "Samuel3");
  assert.equal(updates.length, 0);
}

async function testFrequencyAndTimeSelectRightMonday(): Promise<void> {
  const userRef = "test:recurring:monday-three-weeks";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente de lundi à 8h toutes les 3 semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel3 »");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel3");
}

async function testFourWeekMondaySelectsRightOrder(): Promise<void> {
  const userRef = "test:recurring:monday-four-weeks";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente de lundi à 17h toutes les 4 semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel »");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel");
}

async function testBimensuelSelectsRecurringByFrequencyLabel(): Promise<void> {
  const userRef = "test:recurring:bimensuel";
  clearPending(userRef);
  const { deps, updates } = makeDeps(bimensuelOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute des graines de courge à ma commande récurrente bimensuel",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Bimensuel »");
  assertIncludes(response.message, "Graines de courges");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-bimensuel");
  assert(updates[0].products.some((line) => line.productId === "p-courges" && line.quantity === 1));
}

async function testTwoWeekFrequencyOnlySelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:two-weeks-frequency-only";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente de toutes les deux semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel2 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel2");
}

async function testThreeWeekFrequencyOnlySelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:three-weeks-frequency-only";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente de toutes les trois semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel3 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel3");
}

async function testFuzzyTwoWeekFrequencySelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:fuzzy-two-weeks-frequency";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande recurrante de toute les deu semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel2 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel2");
}

async function testFuzzyThreeWeekFrequencySelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:fuzzy-three-weeks-frequency";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande recurrente de toutes les trois semains",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel3 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel3");
}

async function testSemanticThreeWeekFrequencyWithToutTypoSelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:semantic-three-weeks-tout";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du lait à ma commande recurrante de lundi tout les trois semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel3 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel3");
}

async function testSemanticThreeWeekFrequencyWithFillerSelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:semantic-three-weeks-filler";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du lait à ma commande recurrante de lundi de tout les trois semaines",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Samuel3 »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-samuel3");
}

async function testFuzzyBimensuelSelectsRecurring(): Promise<void> {
  const userRef = "test:recurring:fuzzy-bimensuel";
  clearPending(userRef);
  const { deps, updates } = makeDeps(bimensuelOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute des graines de courge à ma commande récurrente bimensuelle",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Bimensuel »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-bimensuel");
}

async function testTwoMonthsSelectsRecurringByFrequencyLabel(): Promise<void> {
  const userRef = "test:recurring:two-months";
  clearPending(userRef);
  const { deps, updates } = makeDeps(mondayAmbiguousOrders());

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente tous les 2 mois",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Je prépare la modification de « Tous les 2 mois »");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-two-months");
}

async function testCombinedAddAndRemoveInOneRecurringRequest(): Promise<void> {
  const userRef = "test:recurring:add-remove";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "modifie ma commande récurrente de jeudi, ajoute des oeufs et supprime le lait",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Ajout : 2 × Oeuf Bio à la pièce");
  assertIncludes(response.message, "Retrait : 1 × Lait Bio");
  assert.equal(updates.length, 0);

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "rec-jeudi");
  assert(updates[0].products.some((line) => line.productId === "p-oeufs" && line.quantity === 2));
  assert(!updates[0].products.some((line) => line.productId === "p-lait"));
}

async function testAnnullCancelsRecurringPending(): Promise<void> {
  const userRef = "test:recurring:annull";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const first = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(first);
  assertIncludes(first.message, "Changements proposés");

  const canceled = await tryHandleRecurringOrders(userRef, "annull", undefined, deps);
  assert(canceled);
  assertIncludes(canceled.message, "je n’ai pas modifié");
  assert.equal(updates.length, 0);

  const okAfterCancel = await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(okAfterCancel, null);
  assert.equal(updates.length, 0);
}

async function testRecurringKeywordTypoShowsOrders(): Promise<void> {
  const userRef = "test:recurring:keyword-typo";
  clearPending(userRef);
  const { deps } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "montre mes recurrances",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "Voici tes commandes récurrentes");
}

async function testNoKeywordReturnsNullWithoutHint(): Promise<void> {
  const userRef = "test:recurring:no-keyword";
  clearPending(userRef);
  const { deps } = makeDeps();

  const response = await tryHandleRecurringOrders(userRef, "ajoute du pain", undefined, deps);
  assert.equal(response, null);
}

async function testBlockedProductCannotBePreparedForRecurringOrder(): Promise<void> {
  const userRef = "test:recurring:blocked-prepare";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const response = await tryHandleRecurringOrders(
    userRef,
    "ajoute le produit hors périmètre à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );

  assert(response);
  assertIncludes(response.message, "introuvable ou indisponible");
  assert.equal(updates.length, 0);
  const confirmation = await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(confirmation, null);
  assert.equal(updates.length, 0);
}

async function testRecurringConfirmationRechecksEligibility(): Promise<void> {
  const userRef = "test:recurring:blocked-confirmation";
  clearPending(userRef);
  const { deps, updates } = makeDeps();

  const prepared = await tryHandleRecurringOrders(
    userRef,
    "ajoute du pain à ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(prepared);
  assertIncludes(prepared.message, "Changements proposés");

  const originalFetch = deps.fetchFullProduct;
  deps.fetchFullProduct = async (ref, productId) =>
    productId === "p-pain"
      ? { ...products.pain, type: "sell", categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]] }
      : originalFetch(ref, productId);

  const confirmation = await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert(confirmation);
  assertIncludes(confirmation.message, "n’a pas été modifiée");
  assert.equal(updates.length, 0);
}

async function testExistingBlockedRecurringLineCanStillBeRemoved(): Promise<void> {
  const userRef = "test:recurring:blocked-remove";
  clearPending(userRef);
  const orders = baseOrders();
  orders[0].products.push({
    productId: "p-blocked",
    name: "Produit hors périmètre",
    quantity: 1,
  });
  const { deps, updates } = makeDeps(orders);

  const prepared = await tryHandleRecurringOrders(
    userRef,
    "retire le produit hors périmètre de ma commande récurrente du mardi",
    { actionKey: "recurring_orders" },
    deps
  );
  assert(prepared);
  assertIncludes(prepared.message, "Retrait");

  await tryHandleRecurringOrders(userRef, "ok", undefined, deps);
  assert.equal(updates.length, 1);
  assert(!updates[0].products.some((line) => line.productId === "p-blocked"));
}

async function main(): Promise<void> {
  await testShowRecurringOrders();
  await testAmbiguousAddRequiresChoiceThenOkConfirmation();
  await testRemoveFromExplicitDay();
  await testRecurringAddUsesFullProductForWeightUnits();
  await testRecurringMultiAddSkipsOptionsLikeCartAdd();
  await testAmbiguousRemoveDoesNotWrite();
  await testAmbiguousMondayRequiresChoice();
  await testFrequencyAndTimeSelectRightMonday();
  await testFourWeekMondaySelectsRightOrder();
  await testBimensuelSelectsRecurringByFrequencyLabel();
  await testTwoWeekFrequencyOnlySelectsRecurring();
  await testThreeWeekFrequencyOnlySelectsRecurring();
  await testFuzzyTwoWeekFrequencySelectsRecurring();
  await testFuzzyThreeWeekFrequencySelectsRecurring();
  await testSemanticThreeWeekFrequencyWithToutTypoSelectsRecurring();
  await testSemanticThreeWeekFrequencyWithFillerSelectsRecurring();
  await testFuzzyBimensuelSelectsRecurring();
  await testTwoMonthsSelectsRecurringByFrequencyLabel();
  await testCombinedAddAndRemoveInOneRecurringRequest();
  await testAnnullCancelsRecurringPending();
  await testRecurringKeywordTypoShowsOrders();
  await testNoKeywordReturnsNullWithoutHint();
  await testBlockedProductCannotBePreparedForRecurringOrder();
  await testRecurringConfirmationRechecksEligibility();
  await testExistingBlockedRecurringLineCanStillBeRemoved();
  console.log("[recurring-orders.test] all checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
