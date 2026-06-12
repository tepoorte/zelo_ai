export const metaEnv = {
  verifyToken: process.env.META_VERIFY_TOKEN ?? "",
  appSecret: process.env.META_APP_SECRET ?? "",
  graphToken: process.env.META_GRAPH_TOKEN ?? "",
  graphVersion: process.env.META_GRAPH_VERSION ?? "v23.0",
  whatsappPhoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID ?? "",
  graphBaseUrl: process.env.META_GRAPH_BASE_URL ?? "https://graph.facebook.com",
  whatsappProvider: process.env.WHATSAPP_PROVIDER ?? "meta_cloud",
  whatsappAdminToken: process.env.WHATSAPP_ADMIN_TOKEN ?? "",
  whatsappSessionDir: process.env.WHATSAPP_SESSION_DIR ?? ".cache/whatsapp-web-session",
  whatsappTestPhone: process.env.WHATSAPP_TEST_PHONE ?? "",
};

export function assertWhatsAppSendConfig() {
  if (!metaEnv.graphToken) {
    throw new Error("Missing META_GRAPH_TOKEN");
  }
  if (!metaEnv.whatsappPhoneNumberId) {
    throw new Error("Missing META_WHATSAPP_PHONE_NUMBER_ID");
  }
}
