import assert from "node:assert/strict";
import {
  formatAddItemsResponse,
  formatClearCartResponse,
} from "../src/ai/services/agent-response.service.js";

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

{
  const response = formatAddItemsResponse({
    resolvedItems: [
      {
        ok: true,
        requestedQty: 1,
        requestedUnit: "piece",
        basketQty: 1,
        product: { id: "lard", name: "A. Lard de Begnins" },
      },
    ],
    basket: {
      products: [{ name: "A. Lard de Begnins", quantity: 1 }],
      fees: [],
    },
    historySuggestions: [
      { productId: "oeufs", name: "Oeuf Bio à la pièce", source: "history" },
      { productId: "beurre", name: "Beurre frais", source: "history" },
    ],
  });

  assert.equal(response.message.includes("J’ai traité ta demande"), true);
  assert.equal(response.message.includes("Tu prends souvent aussi"), true);
  assert.equal(response.message.includes("• Oeuf Bio à la pièce"), true);
  assert.equal(response.message.includes("Si tu veux, écris « ajoute ... », ou « ok » pour passer la commande."), true);
}

console.log("agent-action-formatting tests passed");
