import { getAllProducts, type Product } from "../swissdata/products.js";
import { embed, cosine } from "./embeddings.js";

type CachedProduct = {
  product: Product;
  vector: number[];
  text: string;
};

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

export async function buildCatalogEmbedding(userRef: string) {
  const products = await getAllProducts(userRef);

  catalogCache = [];

  for (const p of products) {
    const text = `${p.name} ${p.shortDescription ?? ""} ${p.description ?? ""}`;
    const vector = await embed(text);

    catalogCache.push({
      product: p,
      vector,
      text,
    });
  }

  ready = true;
  console.log("✅ Catalog embeddings ready:", catalogCache.length);
}

export async function semanticProductCandidates(
  query: string,
  topK = 8
): Promise<Array<{ product: Product; score: number; semantic: number; lexical: number }>> {
  if (!ready) {
    throw new Error("Catalog embedding not ready");
  }

  const qVec = await embed(query);

  const scored = catalogCache.map((item) => {
    const semantic = cosine(qVec, item.vector);
    const lexical = lexicalScore(query, item.text);

    // hybrid score
    const score = semantic * 0.75 + lexical * 0.25;

    return {
      product: item.product,
      score,
      semantic,
      lexical,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}

export async function semanticProductMatch(query: string): Promise<{
  product: Product | null;
  score: number;
  semantic: number;
  lexical: number;
}> {
  const top = await semanticProductCandidates(query, 1);
  const best = top[0];

  console.log("[SEMANTIC MATCH]", {
    query,
    best: best?.product?.name ?? null,
    score: best?.score ?? -1,
    semantic: best?.semantic ?? -1,
    lexical: best?.lexical ?? -1,
  });

  return {
    product: best?.product ?? null,
    score: best?.score ?? -1,
    semantic: best?.semantic ?? -1,
    lexical: best?.lexical ?? -1,
  };
}