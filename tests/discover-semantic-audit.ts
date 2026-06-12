import fs from "node:fs/promises";
import path from "node:path";
import { buildDiscoverMealIdeas } from "../src/ai/discover/engine.js";
import { loadDiscoverTrainingArtifacts } from "../src/ai/discover/training-artifacts.js";
import type { Product } from "../src/swissdata/products.js";

const DEFAULT_QUERIES = [
  "je veux manger plus sain",
  "tu me proposes quoi pour ce soir ?",
  "un apéro local",
  "quelque chose pour le petit déjeuner",
  "un truc rapide avec du poisson",
  "un repas pas trop protéiné",
  "une boisson sympa pour ce soir",
  "tu me conseilles quoi si je reçois deux amis",
  "alors salut comment ca va ? du coup moi je voudrais qui tu me propose 2 idees differentes pour aider l absence de vitamine",
  "propose moi quelque chose avec 40 francs",
];

async function loadLocalCatalog(): Promise<Product[]> {
  const raw = await fs.readFile(path.join(process.cwd(), ".cache", "catalog-local-dev.json"), "utf-8");
  const parsed = JSON.parse(raw) as Product[] | { products?: Product[]; items?: Product[]; data?: Product[] };
  if (Array.isArray(parsed)) return parsed;
  return parsed.products ?? parsed.items ?? parsed.data ?? [];
}

const queries = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_QUERIES;
const [products, training] = await Promise.all([loadLocalCatalog(), loadDiscoverTrainingArtifacts()]);

for (const query of queries) {
  const result = await buildDiscoverMealIdeas("audit", query, {
    products,
    training,
  });

  console.log(`\n=== ${query}`);
  console.log("cleaned:", result.semanticFrame?.cleanedQuery);
  console.log("domains:", result.semanticFrame?.domains.map((item) => `${item.name}:${item.score}`).join(", ") || "-");
  console.log("concepts:", result.semanticFrame?.concepts.map((item) => `${item.name}:${item.score}`).join(", ") || "-");
  console.log(
    "roles:",
    result.semanticFrame?.roleIntents.map((item) => `${item.polarity}:${item.role}:${item.score}`).join(", ") || "-"
  );
  console.log("mode:", result.semanticFrame?.responseMode, "confidence:", result.semanticFrame?.confidence);
  for (const proposal of result.proposals) {
    console.log(`- ${proposal.title} [score=${proposal.score.toFixed(2)} semantic=${proposal.semanticScore?.toFixed(2) ?? "n/a"}]`);
    console.log(`  ${proposal.products.map((product) => product.name).join(" | ")}`);
    if (proposal.semanticViolations?.length) console.log(`  violations: ${proposal.semanticViolations.join(", ")}`);
  }
}
