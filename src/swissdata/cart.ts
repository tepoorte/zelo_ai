// src/swissdata/cart.ts

export type CartItem = {
  productId: string;
  qty: number;
};

export type AddToCartInput = {
  userRef: string;
  items: CartItem[];
};

type Cart = {
  userRef: string;
  items: CartItem[];
};

const CARTS = new Map<string, Cart>();

export async function getCart(userRef: string) {
  const cart = CARTS.get(userRef) ?? { userRef, items: [] };
  return { ok: true, cart };
}

export async function addToCart(input: AddToCartInput) {
  const current = CARTS.get(input.userRef) ?? { userRef: input.userRef, items: [] };

  for (const it of input.items) {
    const idx = current.items.findIndex(x => x.productId === it.productId);
    if (idx >= 0) current.items[idx].qty += it.qty;
    else current.items.push({ productId: it.productId, qty: it.qty });
  }

  CARTS.set(input.userRef, current);
  return { ok: true, cart: current };
}