import { env } from "../../config/env.js";

const OLLAMA_URL = env.ollamaBaseUrl || "http://ollama:11434";
const MODEL = env.ollamaModel || "llama3.2";

export async function ollamaChat(messages: any[], temperature = 0.2): Promise<string> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: { temperature },
    }),
  });

  const data = await resp.json();
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
/*
export async function ollamaEmbed(input: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: input,
    }),
  });

  const data = await resp.json();
  return data?.embedding ?? [];
} */