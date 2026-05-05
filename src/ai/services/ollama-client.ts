import axios from "axios";
import { env } from "../../config/env.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";
const EMBEDDING_MODEL = env.ollamaEmbeddingModel || "nomic-embed-text";

type OllamaChatConfig = {
  model?: string;
  format?: "json";
  keepAlive?: string;
  numPredict?: number;
  numCtx?: number;
};

export async function ollamaChat(
  messages: any[],
  temperature = 0.2,
  config: OllamaChatConfig = {}
): Promise<string> {
  const resp = await axios.post(
    `${OLLAMA_URL}/api/chat`,
    {
      model: config.model || MODEL,
      messages,
      stream: false,
      keep_alive: config.keepAlive || "30m",
      ...(config.format ? { format: config.format } : {}),
      options: {
        temperature,
        ...(typeof config.numPredict === "number" ? { num_predict: config.numPredict } : {}),
        ...(typeof config.numCtx === "number" ? { num_ctx: config.numCtx } : {}),
      },
    },
    {
      headers: { "content-type": "application/json" },
      timeout: 10 * 60 * 1000,
      validateStatus: () => true,
    }
  );

  if (resp.status < 200 || resp.status >= 300) {
    const txt =
      typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? {});
    throw new Error(`Ollama chat failed: ${resp.status} ${txt}`);
  }

  const data = resp.data;
  return data?.message?.content ?? "";
}

export function safeJsonParse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const maybe = s.slice(start, end + 1);
      try {
        return JSON.parse(maybe) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function postEmbedding(url: string, payload: Record<string, unknown>): Promise<number[] | null> {
  const resp = await axios.post(url, payload, {
    headers: { "content-type": "application/json" },
    timeout: 2 * 60 * 1000,
    validateStatus: () => true,
  });

  if (resp.status === 404) return null;
  if (resp.status < 200 || resp.status >= 300) {
    const txt =
      typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data ?? {});
    throw new Error(`Ollama embed failed: ${resp.status} ${txt}`);
  }

  const data = resp.data ?? {};
  const vector = Array.isArray(data?.embedding)
    ? data.embedding
    : Array.isArray(data?.embeddings?.[0])
      ? data.embeddings[0]
      : null;

  return Array.isArray(vector) ? vector.map((value: unknown) => Number(value) || 0) : [];
}

export async function ollamaEmbed(
  input: string,
  config?: { model?: string }
): Promise<number[]> {
  const text = String(input || "").trim();
  if (!text) return [];

  const model = config?.model || EMBEDDING_MODEL;
  const embeddingsUrl = `${OLLAMA_URL}/api/embeddings`;
  const embedUrl = `${OLLAMA_URL}/api/embed`;

  const legacy = await postEmbedding(embeddingsUrl, {
    model,
    prompt: text,
  });
  if (legacy) return legacy;

  const modern = await postEmbedding(embedUrl, {
    model,
    input: text,
  });
  return modern || [];
}
