import assert from "node:assert/strict";
import { buildDiscoverMealIdeas } from "../src/ai/discover/engine.js";
import { buildSemanticDiscoveryFrame, cleanDiscoverQuery } from "../src/ai/discover/semantic-frame.js";
import { profileCatalog } from "../src/ai/discover/catalog-profiler.js";
import { loadDiscoverTrainingArtifacts } from "../src/ai/discover/training-artifacts.js";
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
  cleaning: "5dcfdf906f4a93324a0a2b25",
};

const catalog: Product[] = [
  { id: "perche", name: "Filets de perche congelés", categories: [CATEGORIES.meatFish], price: { price: 22 } },
  { id: "boeuf", name: "Viande hachée (pur boeuf)", categories: [CATEGORIES.meatFish], price: { price: 20 } },
  { id: "lard", name: "A. Lard de Begnins", categories: [CATEGORIES.meatFish], price: { price: 12 } },
  { id: "oeuf", name: "Oeuf Bio à la pièce", categories: [CATEGORIES.dairy], price: { price: 1.2 } },
  { id: "gruyere", name: "Gruyère d'alpage", categories: [CATEGORIES.dairy], tags: ["Marché de Gland"], price: { price: 16 } },
  { id: "lait", name: "A. Lait Bio pasteurisé (Sapalet)", categories: [CATEGORIES.dairy], tags: ["Bio"], price: { price: 3.2 } },
  { id: "yaourt", name: "Yaourt nature", categories: [CATEGORIES.dairy], price: { price: 5.5 } },
  { id: "pain", name: "Pain aux noix", categories: [CATEGORIES.bakery], price: { price: 6 } },
  { id: "muesli", name: "Muesli aux fruits Bio", categories: [CATEGORIES.grain], tags: ["Bio"], price: { price: 8 } },
  { id: "riz", name: "Riz Basmati", categories: [CATEGORIES.starch], price: { price: 8 } },
  { id: "pdt", name: "Pomme de terre Agria Bio", categories: [CATEGORIES.starch, CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 7 } },
  { id: "salade", name: "A. Batavia verte Bio", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 5 } },
  { id: "carottes", name: "Carottes Bio", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 4 } },
  { id: "pommes", name: "Pommes Bio ou VV", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 6 } },
  { id: "poires", name: "Poires conférence Bio", categories: [CATEGORIES.fruitVeg], tags: ["Bio"], price: { price: 6.5 } },
  { id: "huile", name: "Huile d'Olive Bio", categories: [CATEGORIES.sauce], tags: ["Bio"], price: { price: 10 } },
  { id: "pizza", name: "Pizza Marguerite", categories: [CATEGORIES.menu], price: { price: 14 } },
  { id: "jus", name: "Jus de pomme Bio", categories: [CATEGORIES.drink], tags: ["Bio"], price: { price: 4 } },
  { id: "kefir", name: "Kéfir Menthe Citron", categories: [CATEGORIES.drink], price: { price: 5 } },
  { id: "lessive", name: "Lessive écologique", categories: [CATEGORIES.cleaning] },
].map((product) => ({ type: "sell", ...product }));

const training = await loadDiscoverTrainingArtifacts();
const profiles = profileCatalog(catalog, training);

{
  const cleaned = cleanDiscoverQuery(
    "alors salut comment ca va ? du coup moi je voudrais qui tu me propose 2 idees differentes pour aider l absence de vitamine"
  );
  assert.equal(cleaned.includes("salut"), false, `cleanup kept salut: ${cleaned}`);
  assert.equal(cleaned.includes("du coup"), false, `cleanup kept du coup: ${cleaned}`);

  const frame = buildSemanticDiscoveryFrame({
    query: "alors salut comment ca va ? du coup moi je voudrais qui tu me propose 2 idees differentes pour aider l absence de vitamine",
    needs: [{ label: "healthy", score: 0.7 }],
    budget: { kind: "none", confidence: 0 },
    profiles,
    model: training.model,
  });

  assert.equal(frame.requestCount, 2);
  assert.equal(frame.concepts.some((concept) => concept.name === "nutrition_support"), true, JSON.stringify(frame.concepts));
  assert.equal(frame.responseMode, "safe_general_with_clarification");
  assert.equal(frame.uncertainties.some((uncertainty) => uncertainty.kind === "missing_specific_target"), true, JSON.stringify(frame.uncertainties));
}

{
  const result = await buildDiscoverMealIdeas(
    "test",
    "alors salut comment ca va ? du coup moi je voudrais qui tu me propose 2 idees differentes pour aider l absence de vitamine",
    { products: catalog, training }
  );

  const ids = result.proposals.flatMap((proposal) => proposal.products.map((product) => product.productId));
  assert.equal(result.message.includes("sans promesse médicale"), true, result.message);
  assert.equal(ids.some((id) => ["pommes", "poires", "salade", "carottes"].includes(id)), true);
}

{
  const result = await buildDiscoverMealIdeas("test", "un repas pas trop protéiné", {
    products: catalog,
    training,
  });

  const firstRoles = new Set(result.proposals[0]?.products.flatMap((product) => product.roles) ?? []);
  assert.equal(firstRoles.has("meat"), false, JSON.stringify(result.proposals[0]));
  assert.equal(firstRoles.has("fish"), false, JSON.stringify(result.proposals[0]));
  assert.equal(firstRoles.has("egg"), false, JSON.stringify(result.proposals[0]));
  assert.equal(firstRoles.has("cheese"), false, JSON.stringify(result.proposals[0]));
  assert.equal(
    result.proposals[0]?.products.some((product) => ["salade", "carottes", "pommes", "poires", "riz", "pdt"].includes(product.productId)),
    true
  );
}

{
  const result = await buildDiscoverMealIdeas("test", "une boisson sympa pour ce soir", {
    products: catalog,
    training,
  });

  const products = result.proposals.flatMap((proposal) => proposal.products);
  assert.equal(products.length > 0, true, result.message);
  assert.equal(products.every((product) => product.roles.includes("drink")), true, JSON.stringify(products));
}

{
  const result = await buildDiscoverMealIdeas("test", "tu me conseilles quoi si je reçois deux amis ce soir", {
    products: catalog,
    training,
  });

  const ids = result.proposals.flatMap((proposal) => proposal.products.map((product) => product.productId));
  assert.equal(ids.some((id) => ["gruyere", "pain", "jus", "kefir"].includes(id)), true);
}

console.log("discover semantic tests passed");
