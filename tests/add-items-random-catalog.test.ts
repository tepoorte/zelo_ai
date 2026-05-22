import assert from "node:assert/strict";
import type { Product } from "../src/swissdata/products.js";

type FrontendIntentHint = {
  actionKey:
    | "add_items"
    | "clear_cart"
    | "show_cart"
    | "exec_cart"
    | "build_meal"
    | "discover_meals"
    | "noop";
  confidence: number;
  family: string;
  planner: string;
};

type ChatResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
};

type BasketLine = {
  productId?: string;
  quantity?: number;
  qty?: number;
  name?: string;
  productName?: string;
  product?: { name?: string };
};

type BasketResponse = {
  ok?: boolean;
  basket?: {
    products?: BasketLine[];
  };
};

type RequestedProduct = {
  product: Product;
  qty: number;
};

type RenderedRequestedProduct = RequestedProduct & {
  renderedName: string;
};

type CaseResult = {
  name: string;
  text: string;
  ok: boolean;
  error?: string;
  message?: string;
  expected: Array<{ id: string; name: string; qty: number }>;
  basket: Array<{ id?: string; name: string; qty: number }>;
};

const BASE_URL = stripTrailingSlash(process.env.ZELO_TEST_BASE_URL ?? "http://127.0.0.1:3041");
const USER_REF = process.env.ZELO_TEST_USER_REF ?? `random-add-items-${Date.now()}`;
const USERNAME = process.env.ZELO_TEST_USERNAME ?? "public-contact-003@example.invalid";
const PASSWORD = process.env.ZELO_TEST_PASSWORD ?? "";
const CASE_COUNT = positiveInt(process.env.ZELO_RANDOM_ADD_ITEMS_CASES, 20);
const MIN_PRODUCTS = positiveInt(process.env.ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS, 3);
const MAX_PRODUCTS = positiveInt(process.env.ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS, 6);
const SEED = process.env.ZELO_RANDOM_ADD_ITEMS_SEED ?? "zelo-add-items-random-ci";
const MUTATE_NAMES = process.env.ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES !== "0";

const HINTS: Record<string, FrontendIntentHint> = {
  add_items: {
    actionKey: "add_items",
    confidence: 100,
    family: "add",
    planner: "planner/add_items",
  },
  clear_cart: {
    actionKey: "clear_cart",
    confidence: 100,
    family: "cart",
    planner: "planner/clear_cart",
  },
  noop: {
    actionKey: "noop",
    confidence: 100,
    family: "general",
    planner: "planner/general",
  },
};

const REQUEST_TEMPLATES: Array<(items: RenderedRequestedProduct[]) => string> = [
  (items) => `ajoute: ${formatItems(items, ", ")}`,
  (items) => `besoin de ${formatItems(items, " puis ")}`,
  (items) => `il manque:\n- ${formatItems(items, "\n- ")}`,
  (items) => `bonjur Andre j ai besion de ${formatItems(items, " et puis ")} stp merci`,
  (items) => `quand tu peux mets dans mon panier ${formatItems(items, " ensuite ")}`,
  (items) => `pour cette semaine il me faudrait ${formatItems(items, " puis apres ")}`,
  (items) => `Salut André. Je te prends volontiers ${formatItems(items, " et ")} si tu en as. Merci!`,
  (items) => `Bonjour André, je veux bien selon dispos :\n- ${formatItems(items, "\n- ")}\nMerci bien, Oriana`,
  (items) => `Bonjour\nSi ce n’est pas trop tard, puis-je commander\n${formatItems(items, "\n")}\nUn grand merci`,
  (items) => `Bonjour André, est-ce que je pourrais commander ${formatItems(items, " ? Et ")} ? Sinon ce n’est pas grave, merci beaucoup d’avance`,
  (items) => `Salut, pour la fin de journée tu peux me préparer ${formatItems(items, ", ")}. Belle journée`,
];

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function prepareLocalSwissdataBaseUrl(): void {
  if (process.env.ZELO_TEST_SWISSDATA_BASE_URL) {
    process.env.SWISSDATA_BASE_URL = process.env.ZELO_TEST_SWISSDATA_BASE_URL;
    return;
  }

  if (!process.env.SWISSDATA_BASE_URL || process.env.SWISSDATA_BASE_URL.includes("host.docker.internal")) {
    process.env.SWISSDATA_BASE_URL = "http://127.0.0.1:3040";
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isSafeRandomProduct(product: Product): boolean {
  const name = String(product?.name ?? "").trim();
  if (!product?.id || !name) return false;
  if (product.type && product.type !== "sell") return false;
  if (name.length < 3 || name.length > 80) return false;
  if (/[,;|\n\r]/.test(name)) return false;
  if (MUTATE_NAMES && !/[A-Za-zÀ-ÖØ-öø-ÿ].*[A-Za-zÀ-ÖØ-öø-ÿ].*[A-Za-zÀ-ÖØ-öø-ÿ].*[A-Za-zÀ-ÖØ-öø-ÿ]/.test(name)) return false;
  if (/^(frais|rabais|livraison|nettoyage)\b/i.test(name)) return false;
  if (Array.isArray(product.availableOptions) && product.availableOptions.length > 8) return false;
  return true;
}

function mutateOneLetter(value: string, rng: () => number): string {
  const chars = [...value];
  const indexes = chars
    .map((char, index) => ({ char, index }))
    .filter(({ char }) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(char));

  if (!indexes.length) return value;

  const { char, index } = indexes[randomInt(rng, 0, indexes.length - 1)];
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const lower = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const currentIndex = alphabet.indexOf(lower);
  const replacementIndex = currentIndex >= 0
    ? (currentIndex + randomInt(rng, 1, alphabet.length - 1)) % alphabet.length
    : randomInt(rng, 0, alphabet.length - 1);
  const replacement = alphabet[replacementIndex];
  chars[index] = char === char.toUpperCase() ? replacement.toUpperCase() : replacement;

  return chars.join("");
}

function renderItems(items: RequestedProduct[], rng: () => number): RenderedRequestedProduct[] {
  return items.map((item) => ({
    ...item,
    renderedName: MUTATE_NAMES
      ? mutateOneLetter(item.product.name, rng)
      : item.product.name,
  }));
}

function formatItems(items: RenderedRequestedProduct[], separator: string): string {
  return items.map(({ renderedName, qty }) => {
    if (qty <= 1) return renderedName;
    return `${qty} ${renderedName}`;
  }).join(separator);
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { ok: false, error: text } as T;
  }
  return { status: res.status, data };
}

async function get<T>(path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { ok: false, error: text } as T;
  }
  return { status: res.status, data };
}

async function chat(text: string, hint: FrontendIntentHint): Promise<{ status: number; data: ChatResponse }> {
  return await post<ChatResponse>("/ai/chat", {
    userRef: USER_REF,
    text,
    frontendIntentHint: hint,
  });
}

async function clearBasket(): Promise<void> {
  const response = await chat("vide mon panier", HINTS.clear_cart);
  assert.equal(response.status, 200, `clear cart failed: ${JSON.stringify(response.data)}`);
}

async function getBasket(): Promise<BasketResponse["basket"]> {
  const response = await get<BasketResponse>(`/ai/basket?userRef=${encodeURIComponent(USER_REF)}`);
  assert.equal(response.status, 200, `basket read failed: ${JSON.stringify(response.data)}`);
  return response.data.basket;
}

function asksForOptions(message = ""): boolean {
  return /Quelles options veux-tu sélectionner|Écris « aucune »|Il y a plusieurs options disponibles/i.test(message);
}

async function answerNoOptionsUntilDone(initial: { status: number; data: ChatResponse }): Promise<{ status: number; data: ChatResponse }> {
  let current = initial;

  for (let i = 0; i < 12 && asksForOptions(current.data.message); i++) {
    current = await chat("aucune", HINTS.add_items);
  }

  return current;
}

function basketLines(basket: BasketResponse["basket"]): Array<{ id?: string; name: string; qty: number }> {
  return (basket?.products ?? []).map((line) => ({
    id: line.productId,
    name: String(line.name ?? line.productName ?? line.product?.name ?? line.productId ?? "Produit"),
    qty: Number(line.quantity ?? line.qty ?? 1),
  }));
}

function assertBasketContainsExpected(
  basket: BasketResponse["basket"],
  expected: RequestedProduct[]
): Array<{ id?: string; name: string; qty: number }> {
  const lines = basketLines(basket);

  for (const item of expected) {
    const line = lines.find((candidate) => candidate.id === item.product.id);
    assert.ok(
      line,
      `missing product ${item.product.name} (${item.product.id}) in basket: ${JSON.stringify(lines)}`
    );
    assert.equal(
      line.qty,
      item.qty,
      `wrong qty for ${item.product.name}: expected ${item.qty}, got ${line.qty}`
    );
  }

  return lines;
}

function buildCases(products: Product[]): RequestedProduct[][] {
  const rng = seededRandom(SEED);
  const safeProducts = products.filter(isSafeRandomProduct);
  const optionProducts = safeProducts.filter((product) => (product.availableOptions?.length ?? 0) > 0);
  const cases: RequestedProduct[][] = [];

  assert.ok(
    safeProducts.length >= MAX_PRODUCTS,
    `not enough safe catalog products: ${safeProducts.length}`
  );

  for (let caseIndex = 0; caseIndex < CASE_COUNT; caseIndex++) {
    const count = randomInt(rng, MIN_PRODUCTS, MAX_PRODUCTS);
    const selected = shuffle(safeProducts, rng).slice(0, count);

    if (optionProducts.length > 0 && caseIndex % 5 === 0) {
      selected[0] = optionProducts[randomInt(rng, 0, optionProducts.length - 1)];
    }

    const unique = new Map<string, Product>();
    for (const product of selected) {
      unique.set(product.id, product);
    }

    while (unique.size < count) {
      const product = safeProducts[randomInt(rng, 0, safeProducts.length - 1)];
      unique.set(product.id, product);
    }

    cases.push([...unique.values()].map((product) => ({
      product,
      qty: randomInt(rng, 1, 3),
    })));
  }

  return cases;
}

async function runCase(index: number, items: RequestedProduct[]): Promise<CaseResult> {
  const template = REQUEST_TEMPLATES[index % REQUEST_TEMPLATES.length];
  const renderRng = seededRandom(`${SEED}:render:${index}`);
  const renderedItems = renderItems(items, renderRng);
  const text = template(renderedItems);
  const name = `random catalog noisy add_items #${index + 1}`;

  await clearBasket();
  const initial = await chat(text, HINTS.add_items);
  const final = await answerNoOptionsUntilDone(initial);
  const basket = await getBasket();
  const lines = basketLines(basket);
  const expected = items.map((item) => ({
    id: item.product.id,
    name: item.product.name,
    qty: item.qty,
  }));

  try {
    assert.equal(final.status, 200, `chat failed: ${JSON.stringify(final.data)}`);
    assert.equal(final.data.ok, true, `chat returned ok=false: ${JSON.stringify(final.data)}`);
    assertBasketContainsExpected(basket, items);
    return { name, text, ok: true, message: final.data.message, expected, basket: lines };
  } catch (error) {
    return {
      name,
      text,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      message: final.data.message ?? final.data.error,
      expected,
      basket: lines,
    };
  }
}

async function main() {
  assert.ok(USERNAME, "Missing ZELO_TEST_USERNAME");
  assert.ok(PASSWORD, "Missing ZELO_TEST_PASSWORD");

  prepareLocalSwissdataBaseUrl();
  const [{ login }, { getAllProducts }] = await Promise.all([
    import("../src/swissdata/auth.js"),
    import("../src/swissdata/products.js"),
  ]);

  await login(USER_REF, USERNAME, PASSWORD);

  const apiLogin = await post<ChatResponse>("/ai/login", {
    userRef: USER_REF,
    username: USERNAME,
    password: PASSWORD,
  });
  assert.equal(apiLogin.status, 200, `API login failed: ${JSON.stringify(apiLogin.data)}`);

  const catalog = await getAllProducts(USER_REF);
  const cases = buildCases(catalog);
  const results: CaseResult[] = [];

  console.log(`[ADD_ITEMS_RANDOM] seed=${SEED} cases=${cases.length} catalog=${catalog.length} mutateNames=${MUTATE_NAMES}`);

  for (let i = 0; i < cases.length; i++) {
    const result = await runCase(i, cases[i]);
    results.push(result);
    const marker = result.ok ? "PASS" : "FAIL";
    console.log(`[ADD_ITEMS_RANDOM] ${marker} ${result.name}`);
    console.log(`  text: ${result.text}`);
    if (!result.ok) {
      console.log(`  error: ${result.error}`);
      console.log(`  message: ${result.message ?? ""}`);
      console.log(`  expected: ${JSON.stringify(result.expected)}`);
      console.log(`  basket: ${JSON.stringify(result.basket)}`);
    }
  }

  await clearBasket();

  const failed = results.filter((result) => !result.ok);
  console.log(`[ADD_ITEMS_RANDOM] completed pass=${results.length - failed.length} fail=${failed.length}`);

  if (failed.length) {
    throw new Error(`${failed.length}/${results.length} random add_items catalog cases failed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
