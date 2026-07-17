import assert from "node:assert/strict";
import {
  getNextHistorySuggestions,
  resetHistorySuggestions,
} from "../src/ai/services/history-suggestions.service.js";
import { BLOCKED_ASSISTANT_CATEGORY_IDS } from "../src/ai/product-eligibility.js";

const products = [
  { id: "A", name: "Alpha" },
  { id: "B", name: "Bravo" },
  { id: "C", name: "Charlie" },
  { id: "D", name: "Delta" },
  { id: "E", name: "Echo" },
  { id: "F", name: "Foxtrot" },
  { id: "R1", name: "Random un" },
  { id: "R2", name: "Random deux" },
  { id: "R3", name: "Random trois" },
].map((product) => ({ type: "sell", ...product })) as any[];

const history = {
  A: 9,
  B: 8,
  C: 7,
  D: 6,
  E: 5,
  F: 4,
};

function dependencies(
  basket: any = { products: [] },
  historyOverride: Record<string, number> = history,
  productsOverride: any[] = products
) {
  return {
    getHistory: async () => historyOverride,
    getProducts: async () => productsOverride,
    getBasket: async () => basket,
    random: () => 0,
  };
}

{
  const userRef = "history-policy-refill-rotation";
  resetHistorySuggestions(userRef);
  const policyProducts = [
    { id: "blocked-cargo", name: "Vélo cargo", type: "sell", categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[0]] },
    { id: "blocked-container", name: "Contenant", type: "sell", categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[1]] },
    { id: "blocked-audit", name: "Audit", type: "sell", categories: [BLOCKED_ASSISTANT_CATEGORY_IDS[2]] },
    { id: "blocked-credit", name: "Crédit", type: "digital", categories: [] },
    { id: "allowed-history-1", name: "Produit historique un", type: "sell", categories: [] },
    { id: "allowed-history-2", name: "Produit historique deux", type: "sell", categories: [] },
    { id: "allowed-random-1", name: "Produit aléatoire un", type: "sell", categories: [] },
    { id: "allowed-random-2", name: "Produit aléatoire deux", type: "sell", categories: [] },
    { id: "allowed-random-3", name: "Produit aléatoire trois", type: "sell", categories: [] },
    { id: "allowed-random-4", name: "Produit aléatoire quatre", type: "sell", categories: [] },
  ];
  const policyHistory = {
    "blocked-cargo": 100,
    "blocked-container": 99,
    "blocked-audit": 98,
    "blocked-credit": 97,
    "allowed-history-1": 10,
    "allowed-history-2": 9,
  };
  const deps = dependencies({ products: [] }, policyHistory, policyProducts);
  const first = await getNextHistorySuggestions(userRef, { dependencies: deps });
  const second = await getNextHistorySuggestions(userRef, { dependencies: deps });
  const blockedIds = new Set(["blocked-cargo", "blocked-container", "blocked-audit", "blocked-credit"]);

  assert.deepEqual(first.map((item) => item.source), ["history", "history", "random"]);
  assert.equal(first.length, 3, "Filtered history must refill to the requested limit");
  assert.equal(second.length, 3, "Rotation must continue with the remaining eligible products");
  assert.equal(
    [...first, ...second].some((item) => blockedIds.has(item.productId)),
    false,
    "Blocked products must never appear in history suggestions"
  );
  assert.equal(
    first.some((firstItem) => second.some((secondItem) => secondItem.productId === firstItem.productId)),
    false,
    "Only emitted eligible products may consume the history rotation"
  );
}

function names(items: Array<{ name: string }>) {
  return items.map((item) => item.name);
}

{
  const userRef = "history-cycle";
  resetHistorySuggestions(userRef);

  const welcome = await getNextHistorySuggestions(userRef, {
    dependencies: dependencies(),
  });
  assert.deepEqual(names(welcome), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(welcome.map((item) => item.source), ["history", "history", "history"]);

  const afterAdd = await getNextHistorySuggestions(userRef, {
    dependencies: dependencies(),
  });
  assert.deepEqual(names(afterAdd), ["Delta", "Echo", "Foxtrot"]);
}

{
  const userRef = "history-excludes-basket";
  resetHistorySuggestions(userRef);

  const suggestions = await getNextHistorySuggestions(userRef, {
    dependencies: dependencies({ products: [{ productId: "A" }] }),
  });
  assert.deepEqual(names(suggestions), ["Bravo", "Charlie", "Delta"]);
}

{
  const userRef = "history-reset";
  resetHistorySuggestions(userRef);
  assert.deepEqual(names(await getNextHistorySuggestions(userRef, {
    dependencies: dependencies(),
  })), ["Alpha", "Bravo", "Charlie"]);

  resetHistorySuggestions(userRef);
  assert.deepEqual(names(await getNextHistorySuggestions(userRef, {
    dependencies: dependencies(),
  })), ["Alpha", "Bravo", "Charlie"]);
}

{
  const userRef = "history-random-fill";
  resetHistorySuggestions(userRef);

  const suggestions = await getNextHistorySuggestions(userRef, {
    dependencies: dependencies({ products: [] }, { A: 9 }),
  });
  assert.equal(suggestions.length, 3);
  assert.equal(suggestions[0].source, "history");
  assert.equal(suggestions.filter((item) => item.source === "random").length, 2);
  assert.equal(new Set(suggestions.map((item) => item.productId)).size, 3);
}

{
  const userRef = "history-random-after-exhaustion";
  resetHistorySuggestions(userRef);

  await getNextHistorySuggestions(userRef, { dependencies: dependencies() });
  await getNextHistorySuggestions(userRef, { dependencies: dependencies() });
  const suggestions = await getNextHistorySuggestions(userRef, {
    dependencies: dependencies(),
  });
  assert.equal(suggestions.length, 3);
  assert.deepEqual(suggestions.map((item) => item.source), ["random", "random", "random"]);
}

console.log("history-suggestions tests passed");
