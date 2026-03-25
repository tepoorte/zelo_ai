/** 
import { env } from "../config/env.js";
import type { ProductIndexDocV2 } from "./meal-types.v2.js";
import {
  filterCatalogForMealV2,
  getAllProductsNormalizedV2,
} from "../swissdata/products-normalized.v2.js";

type CatalogIndexCacheV2 = {
  userRef: string;
  builtAt: number;
  docs: ProductIndexDocV2[];
};

const cache = new Map<string, CatalogIndexCacheV2>();

async function ollamaEmbed(input: string): Promise<number[]> {
  const text = input.trim();
  if (!text) return [];

  const resp = await fetch(`${env.ollamaBaseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Ollama embeddings failed: ${resp.status} ${errText}`);
  }

  const data = (await resp.json()) as { embedding?: number[] };
  return data.embedding ?? [];
}

export function dot(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function norm(a: number[]): number {
  if (!a.length) return 0;
  return Math.sqrt(a.reduce((acc, x) => acc + x * x, 0));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

export async function embedQueryV2(query: string, extraText?: string) {
  const q = query.trim();
  const full = [query, extraText].filter(Boolean).join(" ").trim();

  return {
    queryVector: await ollamaEmbed(q),
    textVector: await ollamaEmbed(full || q),
  };
}

export async function buildCatalogIndexV2(
  userRef: string,
  forceRebuild = false
): Promise<ProductIndexDocV2[]> {
  const existing = cache.get(userRef);
  if (existing && !forceRebuild) return existing.docs;

  const rawDocs = await getAllProductsNormalizedV2(userRef);
  const docs = filterCatalogForMealV2(rawDocs);

  for (const doc of docs) {
    doc.vectors = {
      name: await ollamaEmbed(doc.normalizedName),
      text: await ollamaEmbed(doc.searchableText),
    };
  }

  cache.set(userRef, {
    userRef,
    builtAt: Date.now(),
    docs,
  });

  console.log("✅ Catalog index v2 ready:", docs.length);
  return docs;
}

export async function ensureCatalogIndexV2(
  userRef: string
): Promise<ProductIndexDocV2[]> {
  const existing = cache.get(userRef);
  if (existing?.docs?.length) return existing.docs;
  return buildCatalogIndexV2(userRef, false);
}

export function getCatalogIndexV2(userRef: string): ProductIndexDocV2[] {
  return cache.get(userRef)?.docs || [];
}

export function clearCatalogIndexV2(userRef?: string) {
  if (userRef) {
    cache.delete(userRef);
    return;
  }
  cache.clear();
}

export function getCatalogIndexStatsV2(userRef: string) {
  const docs = getCatalogIndexV2(userRef);

  const stats = {
    total: docs.length,
    prepared: 0,
    highIngredientness: 0,
    highContainerness: 0,
  };

  for (const doc of docs) {
    if (doc.facets.preparedness >= 0.8) stats.prepared++;
    if (doc.facets.ingredientness >= 0.8) stats.highIngredientness++;
    if (doc.facets.containerness >= 0.8) stats.highContainerness++;
  }

  return stats;
}*/