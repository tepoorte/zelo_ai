import assert from "node:assert/strict";
import {
  extractClearCartPartialFromBasket,
  isExplicitClearAllRequest,
} from "../src/ai/services/clear-cart-extractor.service.js";

const basket = {
  id: "basket-test",
  products: [
    { productId: "lard", name: "Lard fumé", quantity: 4 },
    { productId: "pommes", name: "Pommes Bio ou VV", quantity: 3 },
    { productId: "lait", name: "Lait cru", quantity: 1 },
    { productId: "fromage", name: "Fromage bleu de Pomy", quantity: 1 },
    { productId: "salade", name: "Salade mêlée", quantity: 1 },
    { productId: "panier-budget", name: "Panier Budget 50", quantity: 1 },
  ],
};

function extract(text: string, queries: string[] = []) {
  return extractClearCartPartialFromBasket(text, basket, queries).items;
}

{
  const items = extract("enfin, je veux pas non plus le lard");

  assert.equal(items.length, 1);
  assert.equal(items[0]?.line.productId, "lard");
  assert.equal(items[0]?.operation, "remove_all");
  assert.equal(items.some((item) => item.line.productId === "pommes"), false);
}

{
  const items = extract("non attends, enlève 2 pommes");

  assert.equal(items.length, 1);
  assert.equal(items[0]?.line.productId, "pommes");
  assert.equal(items[0]?.operation, "decrease");
  assert.equal(items[0]?.quantity, 2);
}

{
  const items = extract("garde seulement 2 pommes");

  assert.equal(items.length, 1);
  assert.equal(items[0]?.line.productId, "pommes");
  assert.equal(items[0]?.operation, "set_exact");
  assert.equal(items[0]?.targetQuantity, 2);
}

{
  const items = extract("retire le panier budget 50 de mon panier");

  assert.equal(items.length, 1);
  assert.equal(items[0]?.line.productId, "panier-budget");
  assert.equal(items[0]?.operation, "remove_all");
}

{
  const items = extract("non attends, 2 pommes sont trop");

  assert.equal(items.length, 0);
}

{
  const items = extract("le planner a halluciné", ["pommes"]);

  assert.equal(items.length, 0);
}

{
  const items = extract("supprime le fromage et la salade");

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.line.productId).sort(), ["fromage", "salade"]);
}

{
  assert.equal(isExplicitClearAllRequest("vide mon panier"), true);
  assert.equal(isExplicitClearAllRequest("supprime tout de mon panier"), true);
  assert.equal(isExplicitClearAllRequest("je ne veux plus rien"), true);
  assert.equal(isExplicitClearAllRequest("retire le panier budget 50 de mon panier"), false);
}

console.log("clear-cart-extractor tests passed");
