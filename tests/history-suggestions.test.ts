import assert from "node:assert/strict";
import {
  getNextHistorySuggestions,
  resetHistorySuggestions,
} from "../src/ai/services/history-suggestions.service.js";

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
] as any[];

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
  historyOverride: Record<string, number> = history
) {
  return {
    getHistory: async () => historyOverride,
    getProducts: async () => products,
    getBasket: async () => basket,
    random: () => 0,
  };
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
