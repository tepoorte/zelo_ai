import { env } from "../config/env.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text
    })
  });

  const json = await res.json();
  return json.embedding;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}