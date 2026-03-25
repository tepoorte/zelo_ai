import { getAllProducts, type Product } from "../swissdata/products.js";
import { embed, cosine } from "./embeddings.js";

import fs from "node:fs/promises";
import path from "node:path";

type CachedProduct = {
  product: Product;
  nameText: string;
  descriptionText: string;
  nameVector: number[];
  descriptionVector: number[];
};

const CACHE_DIR = path.join(process.cwd(), ".cache");
const EMBEDDINGS_CACHE_FILE = path.join(CACHE_DIR, "catalog-embeddings-local-dev.json");

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function loadEmbeddingCacheFromDisk(): Promise<CachedProduct[] | null> {
  try {
    const raw = await fs.readFile(EMBEDDINGS_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed as CachedProduct[];
  } catch {
    return null;
  }
}

async function saveEmbeddingCacheToDisk(data: CachedProduct[]) {
  await ensureCacheDir();
  await fs.writeFile(
    EMBEDDINGS_CACHE_FILE,
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}


function productToNameText(p: Product): string {
  return [p.name].filter(Boolean).join(" ");
}

function productToDescriptionText(p: Product): string {
  return [p.description].filter(Boolean).join(" ");
}

let catalogCache: CachedProduct[] = [];
let ready = false;

function normalizeLoose(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/*
function lexicalScore(query: string, productText: string): number {
  const q = normalizeLoose(query);
  const p = normalizeLoose(productText);

  if (!q || !p) return 0;

  if (p === q) return 1;
  if (p.includes(q)) return 0.9;

  const qWords = q.split(" ").filter(Boolean);
  const pWords = new Set(p.split(" ").filter(Boolean));

  let overlap = 0;
  for (const w of qWords) {
    if (pWords.has(w)) overlap++;
  }

  return overlap / Math.max(qWords.length, 1);
}
*/

export async function buildCatalogEmbedding(userRef: string, forceRebuild = false) {
  if (!forceRebuild) {
    const diskCache = await loadEmbeddingCacheFromDisk();
    if (diskCache?.length) {
      catalogCache = diskCache;
      ready = true;
      console.log("✅ Catalog embeddings loaded from disk:", catalogCache.length);
      return;
    }
  }

  const products = await getAllProducts(userRef);
  catalogCache = [];

  for (const p of products) {
    const nameText = productToNameText(p);
    const descriptionText = productToDescriptionText(p);

    const [nameVector, descriptionVector] = await Promise.all([
      embed(nameText),
      embed(descriptionText || nameText),
    ]);

    catalogCache.push({
      product: p,
      nameText,
      descriptionText,
      nameVector,
      descriptionVector,
    });
  }

  await saveEmbeddingCacheToDisk(catalogCache);

  ready = true;
  console.log("✅ Catalog embeddings built and saved:", catalogCache.length);
}

export async function semanticProductCandidates(
  input: {
    query: string;
    description?: string;
    usageContext?: string;
    constraints?: string;
  },
  topK = 8
): Promise<Array<{
  product: Product;
  finalScore: number;
  nameScore: number;
  descriptionScore: number;
  constraintPenalty: number;
}>> {
  if (!ready) {
    throw new Error("Catalog embedding not ready");
  }

  const queryVec = await embed(input.query);
  const descriptionVec = await embed(input.description || input.query);
  const constraintsVec = input.constraints ? await embed(input.constraints) : null;

  // phase 1: retrieve by NAME only
  const topByName = catalogCache
    .map((item) => {
      const nameScore = cosine(queryVec, item.nameVector);
      return { item, nameScore };
    })
    .sort((a, b) => b.nameScore - a.nameScore)
    .slice(0, 20);

  // phase 2: rerank by DESCRIPTION
  const scored = topByName.map(({ item, nameScore }) => {
    const descriptionScore = cosine(descriptionVec, item.descriptionVector);

    const constraintSimilarity =
      constraintsVec && item.descriptionText
        ? cosine(constraintsVec, item.descriptionVector)
        : 0;

    const constraintPenalty = constraintSimilarity * 0.25;

    const finalScore =
      nameScore * 0.72 +
      descriptionScore * 0.28 -
      constraintPenalty;

    return {
      product: item.product,
      finalScore,
      nameScore,
      descriptionScore,
      constraintPenalty,
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);

  const top = scored.slice(0, topK);

const best = top[0];

if (best) {
  console.log("\n🎯 MEAL MATCH CHOSEN ----------------");

  console.log("INGREDIENT QUERY:", input.query);
  console.log("OLLAMA DESCRIPTION:", input.description);
  console.log("OLLAMA CONSTRAINTS:", input.constraints);

  console.log("➡️ CHOSEN PRODUCT:", best.product.name);
  console.log("CATALOG DESCRIPTION:", best.product.description);

  console.log("SCORES:", {
    final: best.finalScore,
    nameScore: best.nameScore,
    descriptionScore: best.descriptionScore,
    constraintPenalty: best.constraintPenalty,
  });

  console.log("-------------------------------------\n");
}

  return top;
}

export async function semanticProductMatch(input: {
  query: string;
  description?: string;
  usageContext?: string;
  constraints?: string;
}) {
  const top = await semanticProductCandidates(input, 1);
  return top[0] ?? null;
}