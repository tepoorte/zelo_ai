import assert from "node:assert/strict";
import { formatClearCartResponse } from "../src/ai/services/agent-response.service.js";

{
  const response = formatClearCartResponse({
    ok: true,
    mode: "all",
    basket: { products: [], fees: [] },
  });

  assert.equal(response.message.includes("J’ai vidé ton panier"), true);
  assert.equal(response.message.includes("panier vide"), false);
}

{
  const response = formatClearCartResponse({
    ok: true,
    mode: "partial",
    removedItems: [{ name: "Oeuf Bio à la pièce", quantity: 3 }],
    basket: {
      products: [{ name: "Oeuf Bio à la pièce", quantity: 3 }],
      fees: [],
    },
  });

  assert.equal(response.message.includes("J’ai retiré du panier"), true);
  assert.equal(response.message.includes("3 × Oeuf Bio à la pièce"), true);
  assert.equal(response.message.includes("je vais aller voir"), false);
}

console.log("agent-action-formatting tests passed");
