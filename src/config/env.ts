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
  ollamaPlannerModel: process.env.OLLAMA_PLANNER_MODEL ?? process.env.OLLAMA_MODEL ?? "llama3.2",
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? "nomic-embed-text",

  // Meta
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaGraphToken: process.env.META_GRAPH_TOKEN ?? "",

  // WhatsApp transport
  whatsappProvider: process.env.WHATSAPP_PROVIDER ?? "meta_cloud",
  whatsappAdminToken: process.env.WHATSAPP_ADMIN_TOKEN ?? "",
  whatsappSessionDir: process.env.WHATSAPP_SESSION_DIR ?? ".cache/whatsapp-web-session",
  whatsappTestPhone: process.env.WHATSAPP_TEST_PHONE ?? "",
  whatsappAllowedPhones: process.env.WHATSAPP_ALLOWED_PHONES ?? "",
  whatsappAuthMode: process.env.WHATSAPP_AUTH_MODE ?? "otp",
  whatsappOtpTtlMinutes: Number(process.env.WHATSAPP_OTP_TTL_MINUTES ?? 10),
  whatsappOtpMaxAttempts: Number(process.env.WHATSAPP_OTP_MAX_ATTEMPTS ?? 5),
  whatsappOtpResendCooldownSeconds: Number(process.env.WHATSAPP_OTP_RESEND_COOLDOWN_SECONDS ?? 90),
  whatsappSessionTtlHours: Number(process.env.WHATSAPP_SESSION_TTL_HOURS ?? 24 * 14),
  zeloTestUsername: process.env.ZELO_TEST_USERNAME ?? "",
  zeloTestPassword: process.env.ZELO_TEST_PASSWORD ?? "",

  // Swissdata
  swissdataBaseUrl: process.env.SWISSDATA_BASE_URL ?? "",
  swissdataApiKey: process.env.SWISSDATA_API_KEY ?? "",
  swissdataAppId: process.env.SWISSDATA_APP_ID ?? "",
  swissdataShopId: process.env.SWISSDATA_SHOP_ID ?? "",
  swissdataCountry: process.env.SWISSDATA_COUNTRY ?? "CHE",
  swissdataAdminToken: process.env.SWISSDATA_ADMIN_TOKEN ?? "",
  swissdataAdminUsername:
    process.env.SWISSDATA_ADMIN_USERNAME ??
    (process.env.NODE_ENV !== "production" ? process.env.ZELO_TEST_USERNAME ?? "" : ""),
  swissdataAdminPassword:
    process.env.SWISSDATA_ADMIN_PASSWORD ??
    (process.env.NODE_ENV !== "production" ? process.env.ZELO_TEST_PASSWORD ?? "" : ""),

  // SMTP
  smtpHost: process.env.SMTP_HOST ?? (process.env.NODE_ENV !== "production" ? "host.docker.internal" : ""),
  smtpPort: Number(process.env.SMTP_PORT ?? (process.env.NODE_ENV !== "production" ? 2025 : 587)),
  smtpSecure: /^(1|true|yes)$/i.test(process.env.SMTP_SECURE ?? ""),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFrom:
    process.env.SMTP_FROM ??
    (process.env.NODE_ENV !== "production" ? "Zelo AI <public-contact-002@example.invalid>" : ""),
};
