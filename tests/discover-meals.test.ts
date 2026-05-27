import assert from "node:assert/strict";
import { buildDiscoverMealIdeas } from "../src/ai/discover/engine.js";
import { extractDiscoverBudgetSignal } from "../src/ai/discover/budget-extractor.js";
import { estimateProductPriceCHF } from "../src/ai/discover/price-estimator.js";
import {
  discoverPlannerJsonSchema,
  enrichDiscoverPlannerChoicesFromQuery,
  filterDiscoverPlannerChoicesByQuery,
  normalizeDiscoverPlannerChoices,
} from "../src/ai/discover/planner-vocabulary.js";
import { loadDiscoverTrainingArtifacts } from "../src/ai/discover/training-artifacts.js";
import { buildDiscoverPlanFromPlannerChoices } from "../src/ai/services/planner.service.js";
import { clearPending, getPending } from "../src/ai/pending.js";
import type { Product } from "../src/swissdata/products.js";

const CATEGORIES = {
  dairy: "5dcfc1616f4a93324a0a2b1a",
  bakery: "5dcfddcb6f4a93324a0a2b1e",
  fruitVeg: "5dcfde1f6f4a93324a0a2b1f",
  grain: "5dcfde5d6f4a93324a0a2b20",
  starch: "5dcfdec16f4a93324a0a2b21",
  meatFish: "5dcfdf0e6f4a93324a0a2b22",
  sauce: "5dcfdf4c6f4a93324a0a2b23",
  menu: "5f00d2cda5761c0007833362",
  drink: "5dea5c3d7e6ac104dac9fde2",
  hygiene: "5dcfdf736f4a93324a0a2b24",
  cleaning: "5dcfdf906f4a93324a0a2b25",
};

const catalog: Product[] = [
  { id: "perche", name: "Filets de perche congelés", categories: [CATEGORIES.meatFish], tags: ["Sans gluten"], price: { price: 22 } },
  { id: "brochet", name: "Filet de brochet", categories: [CATEGORIES.meatFish], price: { price: 24 } },
  { id: "lard", name: "A. Lard de Begnins", categories: [CATEGORIES.meatFish], price: { price: 12 } },
  { id: "boeuf", name: "Viande hachée (pur boeuf)", categories: [CATEGORIES.meatFish], price: { price: 20 } },
  { id: "oeuf", name: "Oeuf Bio à la pièce", categories: [CATEGORIES.dairy], tags: ["Bio"], price: { price: 1.2 } },
  { id: "gruyere", name: "Gruyère d'alpage", categories: [CATEGORIES.dairy], tags: ["Marché de Gland"], price: { price: 16 } },
  { id: "lait", name: "A. Lait Bio pasteurisé (Sapalet)", categories: [CATEGORIES.dairy], tags: ["Bio"], price: { price: 3.2 } },
  { id: "yaourt", name: "Yaourt nature (Grand pot)", categories: [CATEGORIES.dairy], price: { price: 5.5 } },
  { id: "pain", name: "Pain aux noix", categories: [CATEGORIES.bakery], price: { price: 6 } },
  { id: "baguette", name: "Baguette du château", categories: [CATEGORIES.bakery], price: { price: 4.5 } },
  { id: "muesli", name: "Muesli aux fruits Bio", categories: [CATEGORIES.grain], tags: ["Bio"], price: { price: 8 } },
  { id: "riz", name: "Riz Basmati", categories: [CATEGORIES.starch], price: { price: 8 } },
  { id: "pdt", name: "Pomme de terre Agria Bio", categories: [CATEGORIES.starch, CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 7 } },
  { id: "salade", name: "A. Batavia verte Bio", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 5 } },
  { id: "pommes", name: "Pommes Bio ou VV", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 6 } },
  { id: "bananes", name: "Bananes Bio et Fairtrade", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 4.8 } },
  { id: "ananas", name: "Ananas", categories: [CATEGORIES.fruitVeg], price: { price: 7 } },
  { id: "poires", name: "Poires conférence Bio", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 6.5 } },
  { id: "chips-banane", name: "Chips de bananes", categories: [CATEGORIES.grain], price: { price: 4.5 } },
  { id: "sauce", name: "Sauce Salvis", categories: [CATEGORIES.sauce], price: { price: 7 } },
  { id: "sauce-pates", name: "Sauce Vallonnière (pour pâtes)", categories: [CATEGORIES.sauce], price: { price: 8 } },
  { id: "huile", name: "Huile d'Olive Bio", categories: [CATEGORIES.sauce], tags: ["Bio"], price: { price: 10 } },
  { id: "pizza", name: "Pizza Marguerite", categories: [CATEGORIES.menu], price: { price: 14 } },
  { id: "naan", name: "Naan au fromage", categories: [CATEGORIES.menu, CATEGORIES.bakery], price: { price: 9 } },
  { id: "pate-vaudois", name: "Pâtés vaudois par 2", categories: [CATEGORIES.meatFish, CATEGORIES.bakery], price: { price: 11 } },
  { id: "canard", name: "Brochette de canard à l'orange (France)", categories: [CATEGORIES.meatFish], price: { price: 21 } },
  { id: "jus", name: "Jus de pomme Bio", categories: [CATEGORIES.drink], tags: ["Bio"], price: { price: 4 } },
  { id: "biere", name: "Bière artisanale", categories: [CATEGORIES.drink] },
  { id: "sorbet", name: "Sorbet Fraise", categories: [CATEGORIES.menu], tags: ["Congelé"] },
  { id: "chocolat", name: "Chocolat noir", categories: [CATEGORIES.menu] },
  { id: "savon", name: "Savon artisanal", categories: [CATEGORIES.hygiene] },
  { id: "lessive", name: "Lessive écologique", categories: [CATEGORIES.cleaning] },
  { id: "coffret", name: "Coffret cadeau gourmand", categories: [CATEGORIES.menu] },
  {
    id: "panier-budget",
    name: "Panier Budget 50",
    categories: [CATEGORIES.fruitVeg],
    availableOptions: [{ id: "no", name: "Aucune" }],
  },
  { id: "offre", name: "Offre découverte", categories: [CATEGORIES.menu] },
  { id: "surprise", name: "Panier surprise", categories: [CATEGORIES.fruitVeg] },
  { id: "courses", name: "Courses pour 2", categories: [CATEGORIES.fruitVeg] },
];

function proposalProductIds(result: Awaited<ReturnType<typeof buildDiscoverMealIdeas>>): string[] {
  return result.proposals.flatMap((proposal) => proposal.products.map((product) => product.productId));
}

function assertOnlyCatalogProducts(result: Awaited<ReturnType<typeof buildDiscoverMealIdeas>>) {
  const catalogIds = new Set(catalog.map((product) => product.id));
  for (const productId of proposalProductIds(result)) {
    assert.equal(catalogIds.has(productId), true, `Unknown proposal product: ${productId}`);
  }
}

function assertNoGenericBundles(result: Awaited<ReturnType<typeof buildDiscoverMealIdeas>>) {
  const genericIds = new Set(["panier-budget", "offre", "surprise", "courses"]);
  for (const productId of proposalProductIds(result)) {
    assert.equal(genericIds.has(productId), false, `Generic bundle should not be proposed here: ${productId}`);
  }
}

function assertNoProducts(
  result: Awaited<ReturnType<typeof buildDiscoverMealIdeas>>,
  ids: string[],
  reason: string
) {
  const productIds = proposalProductIds(result);
  assert.equal(
    productIds.some((productId) => ids.includes(productId)),
    false,
    `${reason}. Got: ${productIds.join(", ")}`
  );
}

function assertSomeConcreteProduct(result: Awaited<ReturnType<typeof buildDiscoverMealIdeas>>, ids: string[]) {
  const productIds = proposalProductIds(result);
  assert.equal(
    productIds.some((productId) => ids.includes(productId)),
    true,
    `Expected one of ${ids.join(", ")} but got ${productIds.join(", ")}`
  );
}

const training = await loadDiscoverTrainingArtifacts();

{
  const target = extractDiscoverBudgetSignal("quelque chose mais j ai un budget de 100 fr", training.model?.budgetPolicy);
  assert.equal(target.kind, "target");
  assert.equal(target.targetAmountCHF, 100);

  const typoTarget = extractDiscoverBudgetSignal("quelque chose avec 100 franchs", training.model?.budgetPolicy);
  assert.equal(typoTarget.kind, "target");
  assert.equal(typoTarget.targetAmountCHF, 100);

  const chfTarget = extractDiscoverBudgetSignal("je peux mettre 50 CHF pour un repas simple", training.model?.budgetPolicy);
  assert.equal(chfTarget.kind, "target");
  assert.equal(chfTarget.targetAmountCHF, 50);

  const dashTarget = extractDiscoverBudgetSignal("un apéro local pour 60.-", training.model?.budgetPolicy);
  assert.equal(dashTarget.kind, "target");
  assert.equal(dashTarget.targetAmountCHF, 60);

  const economic = extractDiscoverBudgetSignal("des idées pas trop chères", training.model?.budgetPolicy);
  assert.equal(economic.kind, "economic");

  const premium = extractDiscoverBudgetSignal("un repas très cher", training.model?.budgetPolicy);
  assert.equal(premium.kind, "premium");

  const people = extractDiscoverBudgetSignal("repas pour 4 personnes", training.model?.budgetPolicy);
  assert.equal(people.kind, "none");

  const deliveryTime = extractDiscoverBudgetSignal("livraison vendredi à 18h", training.model?.budgetPolicy);
  assert.equal(deliveryTime.kind, "none");

  const price = estimateProductPriceCHF(catalog.find((product) => product.id === "lard")!);
  assert.equal(price.amountCHF, 12);
  assert.equal(price.reliable, true);
}

{
  const vocabulary = {
    needs: ["quick", "healthy", "sleep"] as any,
    roles: ["meat", "fish", "drink"] as any,
  };
  const schema = discoverPlannerJsonSchema(vocabulary);
  assert.deepEqual((schema.properties as any).needs.items.enum, vocabulary.needs);
  assert.deepEqual((schema.properties as any).roles.items.enum, vocabulary.roles);

  const choices = normalizeDiscoverPlannerChoices(
    { needs: ["quick", "unknown", "sleep"], roles: ["meat", "unknown"] },
    vocabulary
  );
  assert.deepEqual(choices.needs, ["quick", "sleep"]);
  assert.deepEqual(choices.roles, ["meat"]);

  const safeChoices = filterDiscoverPlannerChoicesByQuery(
    "un truc rapide avec de la viande",
    { needs: ["dinner"], roles: ["cleaning"] as any }
  );
  assert.deepEqual(safeChoices, { needs: [], roles: [] });

  const enrichedChoices = enrichDiscoverPlannerChoicesFromQuery(
    "un truc rapide avec de la viande",
    safeChoices,
    vocabulary
  );
  assert.deepEqual(enrichedChoices, { needs: ["quick"], roles: ["meat"] });

  const drinkChoices = enrichDiscoverPlannerChoicesFromQuery(
    "quelque chose a boir",
    { needs: [], roles: [] },
    vocabulary
  );
  assert.deepEqual(drinkChoices, { needs: [], roles: ["drink"] });

  const plan = buildDiscoverPlanFromPlannerChoices("un truc rapide avec de la viande", choices);
  assert.equal(plan.intent, "DISCOVER_MEALS");
  assert.deepEqual(plan.actions[0], {
    type: "discover_meal_ideas",
    query: "un truc rapide avec de la viande",
    needHints: ["quick", "sleep"],
    roleHints: ["meat"],
  });
}

assert.equal(Boolean(training.model?.anchorPolicies), true, "discover model must expose anchorPolicies");
assert.equal(
  training.model?.productRanker.featureNames.includes("anchor_allowed"),
  true,
  "discover product ranker must expose anchor features"
);

{
  const result = await buildDiscoverMealIdeas("test", "une idée avec du lard pour 40 francs", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertSomeConcreteProduct(result, ["lard"]);
  assert.equal(result.budget?.kind, "target");
  assert.equal(result.proposals[0]?.estimatedTotalCHF != null, true, "Budget proposal should expose an estimated total");
  assert.equal(result.message.includes("Total estimé"), true, "Budget response should show the estimated total");
}

{
  const result = await buildDiscoverMealIdeas("test", "un repas avec 100 francs disponible", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.budget?.kind, "target");
  assert.equal(result.proposals[0]?.estimatedTotalCHF != null, true, "Numeric budget query should produce budget-aware proposal");
  assert.equal(result.message.includes("Total estimé"), true);
}

{
  const result = await buildDiscoverMealIdeas("test", "un repas très cher", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.budget?.kind, "premium");
  assert.equal(result.needs.some((need) => need.label === "budget"), false, "Premium query must not be treated as economic budget");
}

{
  const result = await buildDiscoverMealIdeas("test", "je veux manger plus sain", {
    products: catalog,
    history: {},
    training,
  });

  assert.equal(result.ok, true);
  assert.equal(result.proposals.length > 0, true);
  assert.equal(result.message.includes("écris"), true);
  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["salade", "pommes", "oeuf", "riz", "perche"]);
  assert.equal(
    proposalProductIds(result).some((productId) => ["canard", "naan", "pate-vaudois", "sauce-pates"].includes(productId)),
    false,
    "Healthy query should not drift to heavy prepared/sauce products"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "un truc rapide avec de la pomme", {
    products: catalog,
    history: {},
    training,
    hints: {
      needHints: ["quick"],
      roleHints: ["fruit"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["pommes"]);
  assertNoProducts(result, ["riz", "huile", "pdt", "jus", "chips-banane"], "Apple query must stay in the fruit domain");
}

{
  const result = await buildDiscoverMealIdeas("test", "un truc rapide de fruits", {
    products: catalog,
    history: {},
    training,
    hints: {
      needHints: ["quick"],
      roleHints: ["fruit"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["pommes", "bananes", "ananas", "poires"]);
  assertNoProducts(result, ["riz", "huile", "pdt", "jus", "chips-banane"], "Fruit query must not add meal fillers");
}

{
  const result = await buildDiscoverMealIdeas("test", "une sélection de fruits", {
    products: catalog,
    history: {},
    training,
    hints: {
      roleHints: ["fruit"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["pommes", "bananes", "ananas", "poires"]);
  assertNoProducts(result, ["riz", "huile", "pdt", "perche", "boeuf", "chips-banane"], "Fruit selection must stay strict");
}

{
  const result = await buildDiscoverMealIdeas("test", "un dessert avec de la pomme", {
    products: catalog,
    history: {},
    training,
    hints: {
      needHints: ["dessert"],
      roleHints: ["fruit"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertSomeConcreteProduct(result, ["pommes"]);
  assertNoProducts(result, ["riz", "huile", "pdt", "perche", "boeuf"], "Apple dessert must keep an apple/fruit anchor");
}

{
  const result = await buildDiscoverMealIdeas("test", "qu'est-ce que tu me proposes aujourd'hui ?", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assert.equal(result.proposals.length >= 3, true, "Open discovery should propose several concrete ideas");
  assert.equal(new Set(proposalProductIds(result)).size >= 5, true, "Open discovery should be diverse");
}

{
  const result = await buildDiscoverMealIdeas("test", "tu me proposes quoi pour ce soir ?", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["perche", "brochet", "oeuf", "riz", "pdt", "salade"]);
}

{
  const result = await buildDiscoverMealIdeas("test", "une idée végétarienne pour ce soir", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  const vegetarian = result.proposals.find((proposal) => proposal.needs.includes("vegetarian"));
  assert(vegetarian, "Missing vegetarian proposal");
  assert.equal(
    result.proposals.flatMap((proposal) => proposal.products).some((product) => ["lard", "perche", "brochet"].includes(product.productId)),
    false,
    "Vegetarian query should not include meat or fish"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "un apéro local", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.proposals.some((proposal) => proposal.needs.includes("aperitif")), true);
  assertSomeConcreteProduct(result, ["gruyere", "pain", "sauce", "jus"]);
}

{
  const result = await buildDiscoverMealIdeas("test", "quelque chose pour le petit déjeuner", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.proposals.some((proposal) => proposal.needs.includes("breakfast")), true);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["pain", "muesli", "lait", "yaourt", "pommes"]);
  assert.equal(
    proposalProductIds(result).some((productId) => ["canard", "perche", "brochet", "naan", "pate-vaudois"].includes(productId)),
    false,
    "Breakfast query should not include meat/fish/prepared meals"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "un truc rapide avec du poisson", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assertSomeConcreteProduct(result, ["perche", "brochet"]);
  assert.equal(
    result.proposals.some((proposal) => proposal.needs.includes("vegetarian")),
    false,
    "Fish query should not be answered with a vegetarian proposal"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "un truc rapide avec de la viande", {
    products: catalog,
    history: {},
    training,
    hints: {
      needHints: ["quick"],
      roleHints: ["meat"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertSomeConcreteProduct(result, ["boeuf", "lard"]);
  assert.equal(
    proposalProductIds(result).some((productId) => ["perche", "brochet"].includes(productId)),
    false,
    "Meat-focused query should not reuse the fish proposal"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "des idées pas trop chères", {
    products: catalog,
    history: { "panier-budget": 7 },
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(
    result.proposals.length > 0,
    true,
    "Budget query should produce at least one catalog proposal"
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "une idée dessert", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assert.equal(result.proposals.some((proposal) => proposal.needs.includes("dessert")), true);
  assertSomeConcreteProduct(result, ["sorbet", "yaourt", "pommes"]);
}

{
  const result = await buildDiscoverMealIdeas("test", "des boissons pour accompagner", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assertNoGenericBundles(result);
  assert.equal(result.proposals.some((proposal) => proposal.needs.includes("drink")), true);
  assertSomeConcreteProduct(result, ["jus"]);
  assertNoProducts(result, ["pommes", "riz", "huile", "perche", "boeuf"], "Drink query must stay in drink domain");
}

{
  const result = await buildDiscoverMealIdeas("test", "quelque chose a boir", {
    products: catalog,
    history: {},
    training,
    hints: {
      roleHints: ["drink"],
    },
  });

  assertOnlyCatalogProducts(result);
  assertSomeConcreteProduct(result, ["jus"]);
  assertNoProducts(result, ["pommes", "riz", "huile", "perche", "boeuf"], "Misspelled boire query must still stay in drink domain");
}

{
  const constraintCases: Array<{
    query: string;
    forbidden: string[];
    expected?: string[];
    reason: string;
  }> = [
    {
      query: "un plat sans sucre",
      forbidden: ["sorbet", "chocolat"],
      reason: "sans sucre must block sweet products",
    },
    {
      query: "un plats sans sucre",
      forbidden: ["sorbet", "chocolat"],
      reason: "typo plural sans sucre must block sweet products",
    },
    {
      query: "un plats san s sucre",
      forbidden: ["sorbet", "chocolat"],
      reason: "split sans typo must block sweet products",
    },
    {
      query: "un plat qui a pas de sucre",
      forbidden: ["sorbet", "chocolat"],
      reason: "pas de sucre must block sweet products",
    },
    {
      query: "un petit déjeuner sans lait",
      forbidden: ["lait"],
      expected: ["pain", "muesli", "pommes", "bananes"],
      reason: "sans lait must block the milk product while keeping breakfast options",
    },
    {
      query: "une boisson sans alcool",
      forbidden: ["biere"],
      expected: ["jus"],
      reason: "sans alcool must keep non-alcoholic drinks and block alcohol",
    },
    {
      query: "quelque chose sans fromage",
      forbidden: ["gruyere", "naan"],
      reason: "sans fromage must block cheese products",
    },
    {
      query: "un truc rapide san viande",
      forbidden: ["lard", "boeuf", "canard", "pate-vaudois"],
      expected: ["perche", "oeuf", "riz", "salade", "pain"],
      reason: "san viande typo must block meat",
    },
    {
      query: "je veux éviter les plats lourds",
      forbidden: ["pizza", "naan", "pate-vaudois", "canard", "boeuf"],
      expected: ["salade", "pommes", "pain", "oeuf", "riz"],
      reason: "éviter plats lourds must block heavy prepared/meat products",
    },
    {
      query: "une idée pas trop sucrée",
      forbidden: ["sorbet", "chocolat"],
      reason: "pas trop sucrée must block sweet products",
    },
    {
      query: "un goûter sans chocolat",
      forbidden: ["chocolat"],
      expected: ["pommes", "bananes", "pain", "muesli", "yaourt"],
      reason: "sans chocolat must block chocolate only",
    },
    {
      query: "un apéro sans alcool",
      forbidden: ["biere"],
      expected: ["pain", "gruyere", "sauce", "jus"],
      reason: "apéro sans alcool must avoid alcoholic drinks",
    },
    {
      query: "quelque chose avec bananne",
      forbidden: ["riz", "huile", "perche", "boeuf"],
      expected: ["bananes"],
      reason: "bananne typo must resolve to banana products",
    },
    {
      query: "boir quelque chose frais",
      forbidden: ["pommes", "riz", "huile", "perche", "boeuf"],
      expected: ["jus"],
      reason: "boir typo must resolve to drink products",
    },
    {
      query: "produits maison sans lessive",
      forbidden: ["lessive"],
      expected: ["savon"],
      reason: "sans lessive must block the excluded cleaning product",
    },
  ];

  for (const item of constraintCases) {
    const result = await buildDiscoverMealIdeas("test", item.query, { products: catalog, history: {}, training });
    assertOnlyCatalogProducts(result);
    assertNoProducts(result, item.forbidden, item.reason);
    if (item.expected?.length) assertSomeConcreteProduct(result, item.expected);
  }
}

{
  const result = await buildDiscoverMealIdeas("test", "un truc ultra bizarre mais je veux des idées", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.message.length > 0, true, "Low-confidence fallback should answer without inventing");
}

{
  const result = await buildDiscoverMealIdeas("test", "quelque chose pour le ménage", {
    products: catalog,
    history: {},
    training,
  });

  assertOnlyCatalogProducts(result);
  assert.equal(result.proposals.some((proposal) => proposal.needs.includes("cleaning")), true, "Missing cleaning proposal");
  assert.equal(proposalProductIds(result).includes("lessive"), true, "Cleaning proposal should include lessive");
}

{
  const userRef = "discover-stateless-test";
  clearPending(userRef);
  const result = await buildDiscoverMealIdeas(userRef, "propose quelque chose de végétarien", {
    products: catalog,
    history: {},
    training,
  });
  assert.equal(Boolean(result?.message), true);
  assert.equal(getPending(userRef), undefined, "discover_meals must not create pending state");
}

{
  const goldenQueries = [
    "propose moi quelque chose pour ma santé",
    "propose quelque chose de végétarien",
    "qu'est-ce que tu me proposes aujourd'hui ?",
    "quelque chose pour le petit déjeuner",
    "un apéro local",
    "un truc rapide avec du poisson",
    "un truc rapide avec de la viande",
    "des idées pas trop chères",
    "quelque chose pour mieux dormir",
    "des produits pour les enfants",
    "une boisson pour accompagner",
  ];

  for (const query of goldenQueries) {
    const result = await buildDiscoverMealIdeas("test", query, { products: catalog, history: {}, training });
    assertOnlyCatalogProducts(result);
    assert.equal(result.message.length > 20, true, `Empty discover answer for ${query}`);
  }
}

{
  const randomClientQueries = [
    "j’ai envie d’un truc simple mais bon",
    "tu me conseilles quoi si je reçois deux amis",
    "je veux compléter mon panier pour demain matin",
    "une idée avec des produits du coin",
    "je suis fatigué, propose quelque chose de pas lourd",
    "j’aimerais une idée pour les enfants après l’école",
    "quelque chose à boire avec le repas",
    "une sélection pas trop chère pour deux jours",
    "un repas tranquille sans viande",
    "je veux une option rapide pour midi",
    "des produits pour faire un apéro",
    "un panier de base pour la semaine",
    "quelque chose de frais",
    "une idée gourmande mais simple",
    "que prendre avec du fromage",
    "un petit déjeuner équilibré",
    "une idée pour une soirée légère",
    "je veux éviter les plats lourds",
    "un truc local à partager",
    "que proposer pour un goûter",
    "une boisson sympa pour ce soir",
    "quelque chose de durable",
    "des produits pour la maison",
    "une idée avec du poisson",
    "je veux manger mieux cette semaine",
    "un repas économique",
    "une sélection de fruits et légumes",
    "une idée cadeau",
    "un dessert léger",
    "des idées concrètes pour aujourd’hui",
  ];

  for (const query of randomClientQueries) {
    const result = await buildDiscoverMealIdeas("test", query, { products: catalog, history: {}, training });
    assertOnlyCatalogProducts(result);
    assert.equal(result.message.length > 20, true, `Random discover answer is empty for ${query}`);
  }
}

console.log("[PASS] discover-meals tests");
