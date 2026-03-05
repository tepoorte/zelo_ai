// src/config/env.ts
import dotenv from "dotenv";
dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3041),

  // Provider AI
  aiProvider: process.env.AI_PROVIDER ?? "openai",

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",

  // Ollama
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",

  // Meta
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaGraphToken: process.env.META_GRAPH_TOKEN ?? "",

  // Swissdata
  swissdataBaseUrl: process.env.SWISSDATA_BASE_URL ?? "",
  swissdataApiKey: process.env.SWISSDATA_API_KEY ?? "",
  swissdataAppId: process.env.SWISSDATA_APP_ID ?? "",
  swissdataShopId: process.env.SWISSDATA_SHOP_ID ?? "",
  swissdataCountry: process.env.SWISSDATA_COUNTRY ?? "CHE",
};