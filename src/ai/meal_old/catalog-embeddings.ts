import { getAllProducts, type Product } from "../../swissdata/products.js";
import { embed, cosine } from "./embeddings.js";

import fs from "node:fs/promises";
import path from "node:path";

type CatalogSnapshot = {
  userRef: string;
  builtAt: string;
  products: Product[];
};

type CachedProduct = {
  product: Product;
  nameText: string;
  descriptionText: string;
  nameVector: number[];
  descriptionVector: number[];
};

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CATALOG_SNAPSHOT_FILE = path.join(CACHE_DIR, "catalog-local-dev.json");
const EMBEDDINGS_CACHE_FILE = path.join(CACHE_DIR, "catalog-embeddings-local-dev.json");

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function loadCatalogSnapshotFromDisk(): Promise<CatalogSnapshot | null> {
  try {
    const raw = await fs.readFile(CATALOG_SNAPSHOT_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed?.products) || parsed.products.length === 0) {
      return null;
    }

    return parsed as CatalogSnapshot;
  } catch {
    return null;
  }
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

async function saveCatalogSnapshotToDisk(snapshot: CatalogSnapshot) {
  await ensureCacheDir();
  await fs.writeFile(
    CATALOG_SNAPSHOT_FILE,
    JSON.stringify(snapshot, null, 2),
    "utf-8"
  );
}

async function saveEmbeddingCacheToDisk(data: CachedProduct[]) {
  const compactData = data.map((item) => ({
    ...item,
    nameVector: compactVector(item.nameVector),
    descriptionVector: compactVector(item.descriptionVector),
  }));

  await ensureCacheDir();
  await fs.writeFile(
    EMBEDDINGS_CACHE_FILE,
    JSON.stringify(compactData),
    "utf-8"
  );
}


function productToNameText(p: Product): string {
  return [p.name].filter(Boolean).join(" ");
}

function productToDescriptionText(p: Product): string {
  return [p.description].filter(Boolean).join(" ");
}

function compactVector(values: number[], decimals = 5): number[] {
  const factor = 10 ** decimals;
  return values.map((value) => Math.round(value * factor) / factor);
}

async function buildEmbeddingEntries(products: Product[]): Promise<CachedProduct[]> {
  const nextCache: CachedProduct[] = [];

  for (const p of products) {
    const nameText = productToNameText(p);
    const descriptionText = productToDescriptionText(p);

    const [nameVector, descriptionVector] = await Promise.all([
      embed(nameText),
      embed(descriptionText || nameText),
    ]);

    nextCache.push({
      product: p,
      nameText,
      descriptionText,
      nameVector,
      descriptionVector,
    });
  }

  return nextCache;
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

export async function buildCatalogEmbedding(userRef: string, forceRebuild = true) {
  if (!forceRebuild) {
    const diskCache = await loadEmbeddingCacheFromDisk();
    if (diskCache?.length) {
      catalogCache = diskCache;
      ready = true;
      console.log("✅ Catalog embeddings loaded from disk:", EMBEDDINGS_CACHE_FILE, catalogCache.length);
      return;
    }
  }

  let products: Product[] | null = null;

  if (!forceRebuild) {
    const snapshot = await loadCatalogSnapshotFromDisk();
    if (snapshot?.products?.length) {
      products = snapshot.products;
      console.log("✅ Catalog snapshot loaded from disk:", CATALOG_SNAPSHOT_FILE, products.length);
    }
  }

  if (!products) {
    products = await getAllProducts(userRef);

    await saveCatalogSnapshotToDisk({
      userRef,
      builtAt: new Date().toISOString(),
      products,
    });

    console.log("✅ Catalog snapshot saved:", CATALOG_SNAPSHOT_FILE, products.length);
  }

  catalogCache = await buildEmbeddingEntries(products);

  await saveEmbeddingCacheToDisk(catalogCache);

  ready = true;
  console.log("✅ Catalog embeddings built and saved:", EMBEDDINGS_CACHE_FILE, catalogCache.length);
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
