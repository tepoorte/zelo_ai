import { ensureCurrentBasketFutureDelivery } from "../../swissdata/cart.js";
import { getPurchaseHistory, type PurchaseHistory } from "../../swissdata/history.js";
import { getAllProducts, type Product } from "../../swissdata/products.js";
import { isAssistantProductEligible } from "../product-eligibility.js";

export type HistorySuggestionSource = "history" | "random";

export type HistorySuggestion = {
  productId: string;
  name: string;
  source: HistorySuggestionSource;
};

type HistorySuggestionState = {
  shownProductIds: Set<string>;
};

type HistorySuggestionDependencies = {
  getHistory?: (userRef: string) => Promise<PurchaseHistory>;
  getProducts?: (userRef: string) => Promise<Product[]>;
  getBasket?: (userRef: string) => Promise<any>;
  random?: () => number;
};

export type HistorySuggestionOptions = {
  limit?: number;
  excludeProductIds?: Iterable<string>;
  basket?: any;
  dependencies?: HistorySuggestionDependencies;
};

const DEFAULT_LIMIT = 3;
const states = new Map<string, HistorySuggestionState>();

function getState(userRef: string): HistorySuggestionState {
  const key = userRef || "__anonymous__";
  const existing = states.get(key);
  if (existing) return existing;

  const created = { shownProductIds: new Set<string>() };
  states.set(key, created);
  return created;
}

export function resetHistorySuggestions(userRef?: string): void {
  if (userRef) {
    states.delete(userRef || "__anonymous__");
    return;
  }

  states.clear();
}

function productIdFromLine(line: any): string | null {
  const value = line?.productId ?? line?.product?.id ?? line?.id;
  const id = String(value ?? "").trim();
  return id || null;
}

function productIdsFromBasket(basket: any): Set<string> {
  const ids = new Set<string>();
  const lines = Array.isArray(basket?.products) ? basket.products : [];

  for (const line of lines) {
    const id = productIdFromLine(line);
    if (id) ids.add(id);
  }

  return ids;
}

function normalizeProduct(product: Product | null | undefined): Product | null {
  const id = String(product?.id ?? "").trim();
  const name = String(product?.name ?? "").trim();
  return id && name ? ({ ...product, id, name } as Product) : null;
}

function rankHistoryProducts(history: PurchaseHistory, products: Product[]): Product[] {
  const productsById = new Map<string, Product>();
  for (const product of products) {
    const normalized = normalizeProduct(product);
    if (normalized) productsById.set(String(normalized.id), normalized);
  }

  return Object.entries(history)
    .map(([productId, quantity]) => ({
      product: productsById.get(String(productId)),
      quantity: Number(quantity ?? 0),
    }))
    .filter((entry): entry is { product: Product; quantity: number } =>
      Boolean(entry.product?.id && entry.product?.name && Number.isFinite(entry.quantity) && entry.quantity > 0)
    )
    .sort((left, right) =>
      (right.quantity - left.quantity) ||
      String(left.product.name).localeCompare(String(right.product.name), "fr")
    )
    .map((entry) => entry.product);
}

function shuffledProducts(products: Product[], random: () => number): Product[] {
  const copy = [...products];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function toSuggestion(product: Product, source: HistorySuggestionSource): HistorySuggestion {
  return {
    productId: String(product.id),
    name: String(product.name),
    source,
  };
}

async function readBasketIds(
  userRef: string,
  basket: any,
  getBasket: (userRef: string) => Promise<any>
): Promise<Set<string>> {
  if (basket) return productIdsFromBasket(basket);

  try {
    return productIdsFromBasket(await getBasket(userRef));
  } catch {
    return new Set();
  }
}

export async function getNextHistorySuggestions(
  userRef: string,
  options: HistorySuggestionOptions = {}
): Promise<HistorySuggestion[]> {
  const limit = Math.max(1, Math.min(10, Number(options.limit ?? DEFAULT_LIMIT)));
  const dependencies = options.dependencies ?? {};
  const readHistory = dependencies.getHistory ?? getPurchaseHistory;
  const readProducts = dependencies.getProducts ?? getAllProducts;
  const readBasket = dependencies.getBasket ?? ensureCurrentBasketFutureDelivery;
  const random = dependencies.random ?? Math.random;

  const [history, products] = await Promise.all([
    readHistory(userRef).catch(() => ({} as PurchaseHistory)),
    readProducts(userRef).catch(() => [] as Product[]),
  ]);

  const normalizedProducts = products
    .map(normalizeProduct)
    .filter((product): product is Product => Boolean(product))
    .filter(isAssistantProductEligible);
  if (!normalizedProducts.length) return [];

  const excludedIds = new Set<string>([
    ...(await readBasketIds(userRef, options.basket, readBasket)),
    ...Array.from(options.excludeProductIds ?? []).map((id) => String(id)),
  ]);

  const state = getState(userRef);
  const suggestions: HistorySuggestion[] = [];
  const selectedIds = new Set<string>();
  const pushSuggestion = (product: Product, source: HistorySuggestionSource): void => {
    const id = String(product.id);
    if (
      suggestions.length >= limit ||
      excludedIds.has(id) ||
      selectedIds.has(id) ||
      state.shownProductIds.has(id)
    ) {
      return;
    }

    suggestions.push(toSuggestion(product, source));
    selectedIds.add(id);
  };

  for (const product of rankHistoryProducts(history, normalizedProducts)) {
    pushSuggestion(product, "history");
    if (suggestions.length >= limit) break;
  }

  if (suggestions.length < limit) {
    const randomCandidates = normalizedProducts.filter((product) => {
      const id = String(product.id);
      return !excludedIds.has(id) && !selectedIds.has(id) && !state.shownProductIds.has(id);
    });

    for (const product of shuffledProducts(randomCandidates, random)) {
      pushSuggestion(product, "random");
      if (suggestions.length >= limit) break;
    }
  }

  for (const suggestion of suggestions) {
    state.shownProductIds.add(suggestion.productId);
  }

  return suggestions;
}
