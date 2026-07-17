import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const catalogPath = path.join(root, ".cache", "catalog-local-dev.json");

const BLOCKED_CATEGORY_IDS = new Set([
  "60ee03d44287bd00089fbb40", // Vélos cargos, casques
  "5f718b85d9f31d00075c9899", // Contenants
  "60238e4d92d477000754db98", // Formules, Soutien, Audit
]);
const BLOCKED_PRODUCT_IDS = new Set([
  // Operational container recovery article: upstream currently has no category.
  "60e67c431c068c000984cfe8",
]);

const DIRECT_ADD_CANDIDATES = [
  { id: "60e67c431c068c000984cfe8", name: "Récupération contenants" },
  { id: "6212910832cab8746630ff50", name: "Casque Lumos Ultra Noir" },
  { id: "5f5b2fa69abcd50007e10564", name: "Crédit de 1.-" },
  { id: "661f7d9b245f000026bd9ec1", name: "Audit Bilan Carbone" },
];

const FUZZY_BLOCKED_ADD_CANDIDATES = [
  {
    id: "5f80acacf5a3fc00066be43b",
    name: "GlassLock Moyen",
    requestText: "ajoute un glasslok moyen",
  },
  {
    id: "5f80ad1df5a3fc00066be43c",
    name: "Bouteille de lait",
    requestText: "ajoute une bouteil de lait",
  },
];

const CONTEXTUAL_ALLOWED_CANDIDATE = {
  id: "5dea2b847e6ac104dac9fdb1",
  name: "Pain Saint-Abbondio",
  requestText: "ajoute Pain Saint-Abbondio en soutien aux producteurs locaux",
};

const RENDERED_BLOCKED_SIGNATURES = [
  "abo formule premium",
  "abo formule vip",
  "audit bilan carbone",
  "audit zero dechet",
  "babboe curve mountain",
  "babboe pro trike",
  "bouteille de lait",
  "casque lumos ultra",
  "credit de 1",
  "credits zelo",
  "glasslock moyen",
  "location curve mountain",
  "location velo",
  "panier en jute",
  "recuperation contenants",
  "sponsor velo zelo",
];

function parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function productCategories(product) {
  return Array.isArray(product?.categories)
    ? product.categories.map((category) => String(category?.id ?? category))
    : [];
}

function isBlockedCatalogProduct(product) {
  const id = String(product?.id ?? product?._id ?? "").trim();
  const type = String(product?.type ?? "").trim().toLowerCase();
  if (!id || type !== "sell" || BLOCKED_PRODUCT_IDS.has(id)) return true;
  return productCategories(product).some((categoryId) => BLOCKED_CATEGORY_IDS.has(categoryId));
}

const env = parseEnv(await fs.readFile(envPath, "utf8").catch(() => ""));
const baseUrl = String(
  process.env.ZELO_TEST_BASE_URL || env.ZELO_TEST_BASE_URL || "http://127.0.0.1:3041"
).replace(/\/+$/, "");
const username = process.env.ZELO_TEST_USERNAME || env.ZELO_TEST_USERNAME;
const password = process.env.ZELO_TEST_PASSWORD || env.ZELO_TEST_PASSWORD;
assert(username && password, "Missing ZELO_TEST_USERNAME or ZELO_TEST_PASSWORD");

const cachedCatalogDocument = await readJson(catalogPath, {});
const cachedCatalog = Array.isArray(cachedCatalogDocument)
  ? cachedCatalogDocument
  : Array.isArray(cachedCatalogDocument?.products)
    ? cachedCatalogDocument.products
    : [];
const blockedIds = new Set(BLOCKED_PRODUCT_IDS);
const blockedNames = new Set();
for (const product of cachedCatalog) {
  if (!isBlockedCatalogProduct(product)) continue;
  const id = String(product?.id ?? product?._id ?? "").trim();
  const name = normalizeText(product?.name);
  if (id) blockedIds.add(id);
  if (name) blockedNames.add(name);
}
for (const candidate of DIRECT_ADD_CANDIDATES) {
  blockedIds.add(candidate.id);
  blockedNames.add(normalizeText(candidate.name));
}
for (const candidate of FUZZY_BLOCKED_ADD_CANDIDATES) {
  blockedIds.add(candidate.id);
  blockedNames.add(normalizeText(candidate.name));
}

let sessionCookie = "";

async function requestJson(route, init = {}) {
  const headers = new Headers(init.headers);
  if (sessionCookie) headers.set("Cookie", sessionCookie);

  const response = await fetch(`${baseUrl}${route}`, { ...init, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";", 1)[0];
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${route} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(`${route} failed with HTTP ${response.status}: ${String(data?.error ?? "unknown error")}`);
  }
  return data;
}

async function postJson(route, body) {
  return requestJson(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const discoverHint = {
  actionKey: "discover_meals",
  confidence: 100,
  family: "meal",
  planner: "planner/discover_meals",
};
const addHint = {
  actionKey: "add_items",
  confidence: 100,
  family: "add",
  planner: "planner/add_items",
};
const removeHint = {
  actionKey: "clear_cart",
  confidence: 100,
  family: "cart",
  planner: "planner/clear_cart",
};

function proposalProducts(data) {
  const proposals = Array.isArray(data?.discover?.proposals) ? data.discover.proposals : [];
  return proposals.flatMap((proposal) =>
    Array.isArray(proposal?.products) ? proposal.products : []
  );
}

function assertNoBlockedRenderedProduct(data, label) {
  const proposed = proposalProducts(data);
  for (const product of proposed) {
    const id = String(product?.productId ?? product?.id ?? "").trim();
    const name = normalizeText(product?.name);
    assert(!blockedIds.has(id), `${label}: blocked product id rendered: ${id}`);
    assert(!blockedNames.has(name), `${label}: blocked product name rendered: ${product?.name}`);
  }

  const message = normalizeText(data?.message);
  for (const signature of RENDERED_BLOCKED_SIGNATURES) {
    assert(
      !message.includes(signature),
      `${label}: rendered message contains blocked product signature: ${signature}`
    );
  }
}

function hasEstimatedTotal(data) {
  if (/total estim[eé]\s*:/i.test(String(data?.message ?? ""))) return true;
  return (Array.isArray(data?.discover?.proposals) ? data.discover.proposals : []).some(
    (proposal) => Number.isFinite(Number(proposal?.estimatedTotalCHF))
  );
}

function lineProductId(line) {
  return String(line?.productId ?? line?.product?.id ?? line?.id ?? "").trim();
}

function lineQuantity(line) {
  return Number(line?.quantity ?? line?.qty ?? line?.count ?? 0);
}

function optionIds(line) {
  const values = line?.optionsIds ?? line?.optionIds ?? line?.options ?? [];
  return (Array.isArray(values) ? values : [])
    .map((option) => String(option?.id ?? option))
    .filter(Boolean)
    .sort();
}

function basketLineSignature(basketResponse) {
  const products = Array.isArray(basketResponse?.basket?.products)
    ? basketResponse.basket.products
    : [];
  return products
    .map((line) => ({
      productId: lineProductId(line),
      name: normalizeText(line?.name ?? line?.productName ?? line?.product?.name),
      quantity: lineQuantity(line),
      options: optionIds(line),
    }))
    .sort((left, right) =>
      `${left.productId}:${left.options.join(",")}`.localeCompare(
        `${right.productId}:${right.options.join(",")}`
      )
    );
}

function basketContainsProduct(basketResponse, productId) {
  const products = Array.isArray(basketResponse?.basket?.products)
    ? basketResponse.basket.products
    : [];
  return products.some((line) => lineProductId(line) === productId);
}

function basketLines(basketResponse) {
  return Array.isArray(basketResponse?.basket?.products)
    ? basketResponse.basket.products
    : [];
}

async function fetchBasket() {
  const data = await requestJson("/ai/basket");
  assert(data?.ok === true, "Basket endpoint did not return ok=true");
  return data;
}

async function sendChat(text, frontendIntentHint) {
  const data = await postJson("/ai/chat", { text, frontendIntentHint });
  assert(data?.ok === true, `Chat did not return ok=true for: ${text}`);
  return data;
}

async function cleanupUnexpectedIncreases(before, after) {
  const beforeQuantities = new Map(
    basketLines(before).map((line) => [lineProductId(line), lineQuantity(line)])
  );

  for (const line of basketLines(after)) {
    const productId = lineProductId(line);
    const beforeQuantity = beforeQuantities.get(productId) ?? 0;
    const increase = Math.max(0, lineQuantity(line) - beforeQuantity);
    if (!productId || increase <= 0) continue;

    const name = String(line?.name ?? line?.productName ?? line?.product?.name ?? "").trim();
    if (!name) continue;
    await sendChat(`retire ${increase} ${name} de mon panier`, removeHint).catch(() => null);
  }
}

async function assertDirectAddDoesNotMutate(candidate, requestText, label) {
  const before = await fetchBasket();
  assert(
    !basketContainsProduct(before, candidate.id),
    `${label}: test candidate already exists in basket; choose another candidate`
  );
  const beforeSignature = JSON.stringify(basketLineSignature(before));
  const response = await sendChat(requestText, addHint);
  const after = await fetchBasket();
  const afterSignature = JSON.stringify(basketLineSignature(after));

  if (beforeSignature !== afterSignature) {
    await cleanupUnexpectedIncreases(before, after);
    const restored = await fetchBasket();
    const restoredSignature = JSON.stringify(basketLineSignature(restored));
    throw new Error(
      `${label}: blocked add changed basket contents; targeted cleanup ` +
      (restoredSignature === beforeSignature ? "restored the snapshot" : "could not fully restore the snapshot")
    );
  }

  return {
    label,
    ok: true,
    response: String(response?.message ?? ""),
  };
}

async function assertAllowedContextAddAndRestore(candidate, label) {
  const before = await fetchBasket();
  const beforeSignature = JSON.stringify(basketLineSignature(before));
  const beforeQuantity = basketLines(before)
    .filter((line) => lineProductId(line) === candidate.id)
    .reduce((sum, line) => sum + lineQuantity(line), 0);

  const response = await sendChat(candidate.requestText, addHint);
  const after = await fetchBasket();
  const afterQuantity = basketLines(after)
    .filter((line) => lineProductId(line) === candidate.id)
    .reduce((sum, line) => sum + lineQuantity(line), 0);

  assert(
    afterQuantity > beforeQuantity,
    `${label}: contextual wording incorrectly prevented the allowed product from being added`
  );

  await sendChat(
    `retire ${afterQuantity - beforeQuantity} ${candidate.name} de mon panier`,
    removeHint
  );
  const restored = await fetchBasket();
  const restoredSignature = JSON.stringify(basketLineSignature(restored));
  assert(restoredSignature === beforeSignature, `${label}: targeted cleanup did not restore basket`);

  return {
    label,
    ok: true,
    response: String(response?.message ?? ""),
  };
}

await postJson("/ai/login", { username, password });
assert(sessionCookie, "Login did not establish a server-side cookie session");

const discoverCases = [
  {
    label: "vegetarian budget remains functional",
    text: "propose-moi quelque chose de végétarien avec 40 francs",
    requireProducts: true,
    requireBudget: true,
  },
  {
    label: "credits are never proposed",
    text: "propose-moi des crédits Zélo pour environ 100 francs",
  },
  {
    label: "cargo bikes and helmets are never proposed",
    text: "propose-moi un casque ou un vélo cargo",
  },
  {
    label: "formulas and audits are never proposed",
    text: "propose-moi une formule, un soutien ou un audit",
  },
  {
    label: "containers are never proposed",
    text: "propose-moi des contenants, bouteilles et bocaux réutilisables",
  },
];

const results = [];
for (const testCase of discoverCases) {
  const data = await sendChat(testCase.text, discoverHint);
  assertNoBlockedRenderedProduct(data, testCase.label);
  if (testCase.requireProducts) {
    assert(proposalProducts(data).length > 0, `${testCase.label}: no products proposed`);
  }
  if (testCase.requireBudget) {
    assert(hasEstimatedTotal(data), `${testCase.label}: estimated budget total is missing`);
  }
  results.push({
    label: testCase.label,
    ok: true,
    proposedProductIds: proposalProducts(data).map((product) => String(product?.productId ?? "")),
  });
  console.log(`[PASS] ${testCase.label}`);
}

const history = await requestJson("/ai/history-suggestions");
assert(history?.ok === true, "History Suggestions endpoint did not return ok=true");
for (const suggestion of Array.isArray(history?.suggestions) ? history.suggestions : []) {
  const id = String(suggestion?.productId ?? "").trim();
  const name = normalizeText(suggestion?.name);
  assert(!blockedIds.has(id), `History Suggestions rendered blocked product id: ${id}`);
  assert(!blockedNames.has(name), `History Suggestions rendered blocked product name: ${suggestion?.name}`);
}
results.push({ label: "History Suggestions contains only eligible products", ok: true });
console.log("[PASS] History Suggestions contains only eligible products");

const currentBasket = await fetchBasket();
const availableCandidates = DIRECT_ADD_CANDIDATES.filter(
  (candidate) => !basketContainsProduct(currentBasket, candidate.id)
);
assert(availableCandidates.length >= 2, "Not enough absent blocked candidates for safe add checks");

results.push(
  await assertDirectAddDoesNotMutate(
    availableCandidates[0],
    `ajoute le produit ${availableCandidates[0].id}`,
    "direct add by product id is blocked"
  )
);
console.log("[PASS] direct add by product id is blocked");

results.push(
  await assertDirectAddDoesNotMutate(
    availableCandidates[1],
    `ajoute ${availableCandidates[1].name}`,
    "direct add by product name is blocked"
  )
);
console.log("[PASS] direct add by product name is blocked");

for (const candidate of FUZZY_BLOCKED_ADD_CANDIDATES) {
  assert(
    !basketContainsProduct(await fetchBasket(), candidate.id),
    `Fuzzy blocked candidate already exists in basket: ${candidate.name}`
  );
  const label = `fuzzy blocked name is not substituted: ${candidate.name}`;
  results.push(
    await assertDirectAddDoesNotMutate(candidate, candidate.requestText, label)
  );
  console.log(`[PASS] ${label}`);
}

results.push(
  await assertAllowedContextAddAndRestore(
    CONTEXTUAL_ALLOWED_CANDIDATE,
    "context words do not block an allowed product"
  )
);
console.log("[PASS] context words do not block an allowed product");

const output = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  catalogSnapshotCount: cachedCatalog.length,
  blockedSnapshotProductCount: blockedIds.size,
  summary: { total: results.length, passed: results.filter((result) => result.ok).length },
  results,
};
const outputPath = path.join(root, ".cache", "product-eligibility-ui-audit-results.json");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log(`[product-eligibility-ui-audit] ${output.summary.passed}/${output.summary.total} PASS`);
console.log(`[product-eligibility-ui-audit] wrote ${outputPath}`);
