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

type BasketExpectation = {
  empty?: boolean;
  contains?: Array<{ name: string; qty: number }>;
  absent?: string[];
};

type Step = {
  name: string;
  text: string;
  hint?: FrontendIntentHint;
  expectMessageIncludes?: string[];
  basketExpectation?: BasketExpectation;
  waitForBasketMs?: number;
  autoReplyNoOptions?: boolean;
  maxAutoNoOptionsReplies?: number;
  expectNoOptionQuestion?: boolean;
};

type BasketLine = {
  name?: string;
  productName?: string;
  product?: { name?: string };
  quantity?: number;
};

type BasketResponse = {
  ok: boolean;
  basket?: {
    products?: BasketLine[];
  };
};

type ChatResponse = {
  ok: boolean;
  message?: string;
};

const DEFAULT_BASE_URL = process.env.ZELO_TEST_BASE_URL ?? "http://127.0.0.1:3041";
const DEFAULT_USER_REF = process.env.ZELO_TEST_USER_REF ?? `smoke-${Date.now()}`;
const ONLY_MODE = String(process.env.ZELO_TEST_ONLY ?? "").trim().toLowerCase();
const INCLUDE_BUILD_MEAL = process.env.ZELO_TEST_INCLUDE_BUILD_MEAL === "1";

const USERNAME = process.env.ZELO_TEST_USERNAME ?? "";
const PASSWORD = process.env.ZELO_TEST_PASSWORD ?? "";
const BASE_URL = stripTrailingSlash(DEFAULT_BASE_URL);
const USER_REF = DEFAULT_USER_REF;

const HINTS: Record<string, FrontendIntentHint> = {
  add_items: {
    actionKey: "add_items",
    confidence: 90,
    family: "add",
    planner: "planner/add_items",
  },
  build_meal: {
    actionKey: "build_meal",
    confidence: 100,
    family: "meal",
    planner: "planner/build_meal",
  },
  clear_cart: {
    actionKey: "clear_cart",
    confidence: 90,
    family: "cart",
    planner: "planner/clear_cart",
  },
  show_cart: {
    actionKey: "show_cart",
    confidence: 90,
    family: "cart",
    planner: "planner/show_cart",
  },
  noop: {
    actionKey: "noop",
    confidence: 70,
    family: "general",
    planner: "planner/general",
  },
};

const LONG_ORDER_TEXT =
  "Salut Andre, j espere que tu vas bien. Si c est possible pour ta tournee, je te prends volontiers 2 litres de lait sapalet, 8 oeufs, 250 gr de fromage aleatoire gimelan et 2kg de pommes. Si pas possible ou que c est trop, c est pas grave. Merci et bonne journee, Loraine";
const NADIA_TEXT =
  "Salut André,\nJe te prends volontiers un filet de brochet et du Gruyère d'alpage pour la fin de journée.\nMerci d'avance.\n\nBelle journée ☀️\nNadia";
const ORIANA_TEXT =
  "Bonjour André, je veux bien selon dispos :\n- 1 pain noix\n- 1 pain balance\n- 400g lard du begnin\n- 1 grand yaourt brebis nature\n- 1 grand yaourt nature\nMerci bien, Oriana";
const MILK_STRAZZIATELLA_TEXT =
  "Salut André. Je te prends volontiers 3l de lait et 2 grands yoghourt Straciatella, si tu en as. Merci!";
const LONG_MIXED_ORDER_TEXT =
  "Bonjour\nSi ce n’est pas trop tard, puis-je commander\nUn pain aux noix\n500g rhubarbs\n200g lard de begnins\nDeux pates vaudois\nDeux pizza margaritas and\nUne botte chou plume\nUn sorbet fraise\nUne sauce lulu\nUne sauce salvis\nUn grand merci";
const HOT_DOG_TEXT = "je veux de quoi faire des hot dog";
const CARBONARA_TEXT = "de quoi faire une carbonara";
const HAMBURGER_TEXT = "je veux de quoi faire des hamburgers";
const SPAGHETTI_BOLOGNESE_TEXT = "je veux de quoi faire des spaghetti bolognese";
const MACCHERONI_CARBONARA_TEXT = "je veux de quoi faire des maccheroni carbonara";
const PERCHE_POTATO_TEXT = "je veux de quoi faire filet de perche et pomme de terre";
const SALADE_CESAR_TEXT = "je veux de quoi faire une salade césar";
const SALADE_RIZ_TEXT = "je veux de quoi faire une salade de riz";

const STEPS: Step[] = [
  {
    name: "Reset basket",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add one lard",
    text: "ajoute 1 lard de begnins à mon panier",
    hint: HINTS.add_items,
    expectMessageIncludes: ["A. Lard de Begnins"],
    basketExpectation: {
      contains: [{ name: "A. Lard de Begnins", qty: 1 }],
    },
  },
  {
    name: "Show cart",
    text: "montre-moi mon panier",
    hint: HINTS.show_cart,
    expectMessageIncludes: ["Voici ton panier", "A. Lard de Begnins"],
    basketExpectation: {
      contains: [{ name: "A. Lard de Begnins", qty: 1 }],
    },
  },
  {
    name: "Remove one lard",
    text: "supprime 1 lard du begnins de mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["retiré du panier"],
    basketExpectation: {
      absent: ["A. Lard de Begnins"],
    },
  },
  {
    name: "Add long multi-product request",
    text: LONG_ORDER_TEXT,
    hint: HINTS.add_items,
    expectMessageIncludes: ["Gimelan aléatoire", "Pommes Bio ou VV"],
    expectNoOptionQuestion: true,
    basketExpectation: {
      contains: [
        { name: "A. Lait Bio pasteurisé (Sapalet)", qty: 2 },
        { name: "Oeuf Bio à la pièce", qty: 8 },
        { name: "Gimelan aléatoire", qty: 1 },
        { name: "Pommes Bio ou VV", qty: 2 },
      ],
    },
    waitForBasketMs: 1500,
  },
  {
    name: "Remove eggs only",
    text: "retire 8 Oeuf Bio à la pièce",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["Oeuf Bio à la pièce"],
    basketExpectation: {
      contains: [
        { name: "A. Lait Bio pasteurisé (Sapalet)", qty: 2 },
        { name: "Gimelan aléatoire", qty: 1 },
        { name: "Pommes Bio ou VV", qty: 2 },
      ],
      absent: ["Oeuf Bio à la pièce"],
    },
  },
  {
    name: "Reset basket before Nadia order",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add Nadia order",
    text: NADIA_TEXT,
    hint: HINTS.add_items,
    expectMessageIncludes: ["Filets de brochet", "Gruyère d'alpage"],
    basketExpectation: {
      contains: [
        { name: "Filets de brochet congelés", qty: 1 },
        { name: "Gruyère d'alpage", qty: 1 },
      ],
    },
  },
  {
    name: "Reset basket before Oriana order",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add Oriana order",
    text: ORIANA_TEXT,
    hint: HINTS.add_items,
    expectMessageIncludes: ["Pain Balance", "A. Lard de Begnins"],
    expectNoOptionQuestion: true,
    basketExpectation: {
      contains: [
        { name: "Pain aux noix", qty: 1 },
        { name: "Pain Balance", qty: 1 },
        { name: "A. Lard de Begnins", qty: 4 },
        { name: "Yaourt de brebis nature (Grand pot)", qty: 1 },
        { name: "Yaourt nature (Grand pot)", qty: 1 },
      ],
    },
  },
  {
    name: "Reset basket before milk and stracciatella order",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add milk and stracciatella order",
    text: MILK_STRAZZIATELLA_TEXT,
    hint: HINTS.add_items,
    expectMessageIncludes: ["Lait", "Yaourt stracciatella"],
    basketExpectation: {
      contains: [
        { name: "Lait", qty: 3 },
        { name: "Yaourt stracciatella (Grand pot)", qty: 2 },
      ],
    },
  },
  {
    name: "Reset basket before mixed long order",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add mixed long order",
    text: LONG_MIXED_ORDER_TEXT,
    hint: HINTS.add_items,
    expectMessageIncludes: ["Pain aux noix", "A. Lard de Begnins", "Sauce"],
    expectNoOptionQuestion: true,
    basketExpectation: {
      contains: [
        { name: "Pain aux noix", qty: 1 },
        { name: "A. Lard de Begnins", qty: 2 },
        { name: "Pâtés vaudois par 2", qty: 2 },
        { name: "Pizza Marguerite", qty: 2 },
        { name: "Sorbet Fraise", qty: 1 },
        { name: "Sauce à Lulu", qty: 1 },
        { name: "Sauce Salvis", qty: 1 },
      ],
    },
  },
  {
    name: "Reset basket before panier budget 50 case",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Add one panier budget 50",
    text: "ajoute 1 panier budget 50 à mon panier",
    hint: HINTS.add_items,
    expectMessageIncludes: ["Panier Budget 50"],
    basketExpectation: {
      contains: [{ name: "Panier Budget 50", qty: 1 }],
    },
  },
  {
    name: "Remove one panier budget 50 only",
    text: "supprime 1 panier budget 50",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["retiré du panier"],
    basketExpectation: {
      empty: true,
      absent: ["Panier Budget 50"],
    },
  },
  {
    name: "Reset basket before hot dog meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build hot dog meal",
    text: HOT_DOG_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["hot dog", "Pain hot-dog", "Ketchup Connie's"],
    basketExpectation: {
      contains: [
        { name: "Viennes par paire", qty: 1 },
        { name: "Pain hot-dog", qty: 1 },
        { name: "Ketchup Connie's", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before carbonara meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build carbonara meal",
    text: CARBONARA_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["carbonara", "Barilla Spaghetti", "Lardons"],
    basketExpectation: {
      contains: [
        { name: "A. Barilla Spaghetti", qty: 1 },
        { name: "Oeuf Bio à la pièce", qty: 4 },
        { name: "Lardons", qty: 1 },
        { name: "Gruyère d'alpage", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before hamburger meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build hamburger meal",
    text: HAMBURGER_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["hamburger", "Pain sandwich Hamburger", "Ketchup Connie's"],
    basketExpectation: {
      contains: [
        { name: "Hamburger", qty: 1 },
        { name: "Pain sandwich Hamburger", qty: 1 },
        { name: "Ketchup Connie's", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before spaghetti bolognese meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build spaghetti bolognese meal",
    text: SPAGHETTI_BOLOGNESE_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["spaghetti bolognese", "Barilla Spaghetti", "Viande hachée"],
    basketExpectation: {
      contains: [
        { name: "A. Barilla Spaghetti", qty: 1 },
        { name: "Viande hachée (pur boeuf)", qty: 1 },
        { name: "Sauce tomates (Pomodoro)", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before maccheroni carbonara meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build maccheroni carbonara meal",
    text: MACCHERONI_CARBONARA_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["maccheroni carbonara", "Barilla Maccheroni", "Lardons"],
    basketExpectation: {
      contains: [
        { name: "A. Barilla Maccheroni", qty: 1 },
        { name: "Oeuf Bio à la pièce", qty: 4 },
        { name: "Lardons", qty: 1 },
        { name: "Gruyère d'alpage", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before perche and potato meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build perche and potato meal",
    text: PERCHE_POTATO_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["filet de perche", "Pomme de terre", "Huile pimentée"],
    basketExpectation: {
      contains: [
        { name: "Filets de perche congelés", qty: 1 },
        { name: "Pomme de terre Agria Bio", qty: 1 },
        { name: "Huile pimentée", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before salade cesar meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build salade cesar meal",
    text: SALADE_CESAR_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["salade césar", "Batavia", "Sauce Salvis"],
    basketExpectation: {
      contains: [
        { name: "A. Batavia verte Bio", qty: 1 },
        { name: "Filet de poulet", qty: 1 },
        { name: "Jambon", qty: 1 },
        { name: "Oeuf Bio à la pièce", qty: 2 },
        { name: "Pain aléatoire", qty: 1 },
        { name: "Sauce Salvis", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Reset basket before salade de riz meal",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
  {
    name: "Build salade de riz meal",
    text: SALADE_RIZ_TEXT,
    hint: HINTS.build_meal,
    expectMessageIncludes: ["salade de riz", "Riz Basmati", "Mayonnaise Thomy"],
    basketExpectation: {
      contains: [
        { name: "Riz Basmati", qty: 1 },
        { name: "Jambon", qty: 1 },
        { name: "Oeuf Bio à la pièce", qty: 2 },
        { name: "A. Carottes Bio", qty: 1 },
        { name: "Olives vertes", qty: 1 },
        { name: "Mayonnaise Thomy", qty: 1 },
        { name: "Sauce Salvis", qty: 1 },
        { name: "Tomates séchées à l'huile", qty: 1 },
        { name: "Cornichon Hugo Reitzel", qty: 1 },
      ],
    },
    waitForBasketMs: 12000,
  },
  {
    name: "Final clear cart",
    text: "vide mon panier",
    hint: HINTS.clear_cart,
    expectMessageIncludes: ["vidé ton panier"],
    basketExpectation: { empty: true },
  },
];

function filteredSteps(): Step[] {
  if (!ONLY_MODE) {
    return INCLUDE_BUILD_MEAL
      ? STEPS
      : STEPS.filter((step) => step.hint?.actionKey !== "build_meal");
  }

  if (ONLY_MODE === "build_meal") {
    return STEPS.filter(
      (step) =>
        step.hint?.actionKey === "build_meal" ||
        /^reset basket before .* meal$/i.test(step.name)
    );
  }

  if (ONLY_MODE === "non_build" || ONLY_MODE === "no_build_meal") {
    return STEPS.filter((step) => step.hint?.actionKey !== "build_meal");
  }

  return STEPS.filter((step) => normalizeText(step.name).includes(normalizeText(ONLY_MODE)));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(status: "PASS" | "FAIL" | "INFO", message: string) {
  const prefix = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "INFO";
  console.log(`[${prefix}] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const maxAttempts = 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, init);
      const text = await response.text();

      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Invalid JSON from ${path}: ${text}`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on ${path}: ${JSON.stringify(data)}`);
      }

      return data as T;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await sleep(500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function login(): Promise<void> {
  assert(USERNAME, "Missing ZELO_TEST_USERNAME");
  assert(PASSWORD, "Missing ZELO_TEST_PASSWORD");

  const data = await fetchJson<{ ok: boolean; token?: string; expires?: string }>("/ai/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userRef: USER_REF,
      username: USERNAME,
      password: PASSWORD,
    }),
  });

  assert(data.ok, "Login failed");
  logStep("INFO", `Login OK for userRef=${USER_REF}`);
}

async function sendChat(step: Step): Promise<ChatResponse> {
  return await fetchJson<ChatResponse>("/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userRef: USER_REF,
      text: step.text,
      ...(step.hint ? { frontendIntentHint: step.hint } : {}),
    }),
  });
}

async function fetchBasket(): Promise<BasketResponse> {
  return await fetchJson<BasketResponse>(`/ai/basket?userRef=${encodeURIComponent(USER_REF)}`);
}

function lineName(line: BasketLine): string {
  return String(line.name ?? line.productName ?? line.product?.name ?? "");
}

function lineQty(line: BasketLine): number {
  return Number(line.quantity ?? 0);
}

function findMatchingLine(lines: BasketLine[], expectedName: string): BasketLine | undefined {
  const expected = normalizeText(expectedName);

  return lines.find((line) => {
    const current = normalizeText(lineName(line));
    return current === expected || current.includes(expected) || expected.includes(current);
  });
}

function basketMatchesExpectation(
  basket: BasketResponse["basket"],
  expectation: BasketExpectation
): { ok: true } | { ok: false; reason: string } {
  const lines = Array.isArray(basket?.products) ? basket!.products! : [];

  if (expectation.empty) {
    if (lines.length !== 0) {
      return {
        ok: false,
        reason: `Basket should be empty but has ${lines.length} product lines`,
      };
    }
  }

  for (const required of expectation.contains ?? []) {
    const line = findMatchingLine(lines, required.name);
    if (!line) {
      return { ok: false, reason: `Missing basket line: ${required.name}` };
    }
    if (lineQty(line) !== required.qty) {
      return {
        ok: false,
        reason: `Wrong qty for ${required.name}: expected ${required.qty}, got ${lineQty(line)}`,
      };
    }
  }

  for (const forbidden of expectation.absent ?? []) {
    const line = findMatchingLine(lines, forbidden);
    if (line) {
      return {
        ok: false,
        reason: `Line should be absent but is present: ${forbidden} (qty ${lineQty(line)})`,
      };
    }
  }

  return { ok: true };
}

async function assertBasketEventually(step: Step): Promise<void> {
  if (!step.basketExpectation) return;

  const deadline = Date.now() + (step.waitForBasketMs ?? 5_000);
  let lastReason = "Unknown basket mismatch";

  while (Date.now() <= deadline) {
    const basketResponse = await fetchBasket();
    const match = basketMatchesExpectation(basketResponse.basket, step.basketExpectation);
    if (match.ok) return;
    lastReason = match.reason;
    await sleep(500);
  }

  throw new Error(`${step.name}: ${lastReason}`);
}

function assertMessage(step: Step, message: string | undefined): void {
  if (!step.expectMessageIncludes?.length) return;

  const normalizedMessage = normalizeText(message ?? "");

  for (const expected of step.expectMessageIncludes) {
    const normalizedExpected = normalizeText(expected);
    if (!normalizedMessage.includes(normalizedExpected)) {
      throw new Error(
        `${step.name}: response does not include expected text "${expected}".\nResponse was:\n${message ?? "(empty)"}`
      );
    }
  }
}

function looksLikeOptionQuestion(message: string | undefined): boolean {
  const normalized = normalizeText(message ?? "");
  return (
    normalized.includes("quelles options veux tu selectionner") ||
    normalized.includes("ecris aucune si tu ne veux selectionner aucune option")
  );
}

async function sendFreeChat(text: string, hint?: FrontendIntentHint): Promise<ChatResponse> {
  return await fetchJson<ChatResponse>("/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userRef: USER_REF,
      text,
      ...(hint ? { frontendIntentHint: hint } : {}),
    }),
  });
}

async function runStep(step: Step): Promise<void> {
  const startedAt = Date.now();
  logStep("INFO", `${step.name} -> ${step.text}`);
  let response = await sendChat(step);

  assert(response.ok, `${step.name}: /ai/chat returned ok=false`);

  if (step.autoReplyNoOptions) {
    const maxReplies = step.maxAutoNoOptionsReplies ?? 5;

    for (let index = 0; index < maxReplies; index++) {
      if (!looksLikeOptionQuestion(response.message)) break;

      logStep("INFO", `${step.name} -> auto reply "aucune" (${index + 1}/${maxReplies})`);
      response = await sendFreeChat("aucune", HINTS.noop);
      assert(response.ok, `${step.name}: /ai/chat returned ok=false after auto "aucune"`);
    }

    if (looksLikeOptionQuestion(response.message)) {
      throw new Error(
        `${step.name}: option flow still pending after ${maxReplies} automatic "aucune" replies.\nLast response was:\n${response.message ?? "(empty)"}`
      );
    }
  }

  if (step.expectNoOptionQuestion && looksLikeOptionQuestion(response.message)) {
    throw new Error(
      `${step.name}: response unexpectedly opened a pending options flow.\nResponse was:\n${response.message ?? "(empty)"}`
    );
  }

  assertMessage(step, response.message);
  await assertBasketEventually(step);

  const elapsedMs = Date.now() - startedAt;
  logStep("PASS", `${step.name} (${elapsedMs} ms)`);
}

async function main(): Promise<void> {
  const stepsToRun = filteredSteps();
  console.log(`Base URL : ${BASE_URL}`);
  console.log(`User ref : ${USER_REF}`);
  console.log(`Steps    : ${stepsToRun.length}`);
  if (ONLY_MODE) {
    console.log(`Filter   : ${ONLY_MODE}`);
  }
  console.log("");
  console.log("Warning: this suite uses the real account basket, clears it at the start, and clears it again at the end.");
  console.log("");

  await login();

  const failures: Array<{ step: string; error: string }> = [];

  for (const step of stepsToRun) {
    try {
      await runStep(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ step: step.name, error: message });
      console.log("");
      logStep("FAIL", message);
      console.log("");
    }
  }

  console.log("");
  if (failures.length === 0) {
    logStep("PASS", `Smoke suite completed successfully (${stepsToRun.length} steps).`);
    return;
  }

  logStep("FAIL", `Smoke suite completed with ${failures.length} failure(s) out of ${stepsToRun.length} steps.`);
  for (const failure of failures) {
    logStep("FAIL", `${failure.step} -> ${failure.error}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("");
  logStep("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
