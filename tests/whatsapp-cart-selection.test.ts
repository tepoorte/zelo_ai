import assert from "node:assert/strict";
import {
  selectDirectCustomerBaskets,
  type BasketLike,
} from "../src/swissdata/whatsapp-cart.js";

const baskets: BasketLike[] = [
  {
    id: "direct-old",
    status: "basket",
    customerId: "customer-a",
    products: [{ productId: "pain" }],
    _updatedAt: "2026-07-15T09:00:00.000Z",
  },
  {
    id: "recurring-new",
    status: "basket",
    customerId: "customer-a",
    recurringId: "recurring-1",
    products: [{ productId: "riz-jasmin" }],
    _updatedAt: "2026-07-15T11:00:00.000Z",
  },
  {
    id: "direct-new-empty",
    status: "basket",
    customerId: "customer-a",
    recurringId: null,
    products: [],
    _updatedAt: "2026-07-15T10:00:00.000Z",
  },
  {
    id: "foreign",
    status: "basket",
    customerId: "customer-b",
    products: [{ productId: "foreign-product" }],
    _updatedAt: "2026-07-15T12:00:00.000Z",
  },
  {
    id: "ownerless",
    status: "basket",
    products: [{ productId: "ownerless-product" }],
    _updatedAt: "2026-07-15T13:00:00.000Z",
  },
  {
    id: "ordered",
    status: "ordered",
    customerId: "customer-a",
    products: [{ productId: "ordered-product" }],
    _updatedAt: "2026-07-15T14:00:00.000Z",
  },
];

const selected = selectDirectCustomerBaskets(baskets, "customer-a");

assert.deepEqual(
  selected.map((basket) => basket.id),
  ["direct-new-empty", "direct-old"],
  "WhatsApp must keep the newest direct basket even when it is empty"
);

console.log("whatsapp cart selection test passed");
