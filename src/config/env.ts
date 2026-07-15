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
  metaGraphVersion: process.env.META_GRAPH_VERSION ?? "v25.0",
  metaGraphBaseUrl: process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com",
  metaWhatsappPhoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? "",
  metaWhatsappBusinessAccountId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID ?? "",

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

export type AppEnv = typeof env;

function missingRequired(candidate: AppEnv, key: keyof AppEnv): string | undefined {
  const value = candidate[key];
  if (typeof value === "string" && value.trim()) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return undefined;
  if (typeof value === "boolean") return undefined;
  return String(key);
}

export function validateProductionEnv(candidate: AppEnv = env): string[] {
  if (candidate.nodeEnv !== "production") return [];

  const findings: string[] = [];

  if (candidate.whatsappProvider !== "meta_cloud") {
    findings.push("WHATSAPP_PROVIDER must be meta_cloud in production");
  }

  const required: Array<keyof AppEnv> = [
    "metaVerifyToken",
    "metaAppSecret",
    "metaGraphToken",
    "metaWhatsappPhoneNumberId",
    "whatsappAdminToken",
    "swissdataBaseUrl",
    "swissdataShopId",
    "swissdataApiKey",
    "smtpHost",
    "smtpFrom",
    "smtpUser",
    "smtpPass",
  ];

  for (const key of required) {
    const missing = missingRequired(candidate, key);
    if (missing) findings.push(`Missing production env: ${missing}`);
  }

  const hasAdminToken = Boolean(candidate.swissdataAdminToken.trim());
  const hasAdminCredentials = Boolean(
    candidate.swissdataAdminUsername.trim() && candidate.swissdataAdminPassword.trim()
  );
  if (!hasAdminToken && !hasAdminCredentials) {
    findings.push("Missing Swissdata admin auth: provide token or username/password");
  }

  if (candidate.aiProvider === "openai" && !candidate.openaiApiKey.trim()) {
    findings.push("Missing production env: openaiApiKey");
  }

  return findings;
}

export function assertProductionEnv(candidate: AppEnv = env): void {
  const findings = validateProductionEnv(candidate);
  if (findings.length === 0) return;

  throw new Error(`Invalid production configuration:\n- ${findings.join("\n- ")}`);
}
