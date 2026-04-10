export const twilioEnv = {
  authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  sandboxNumber: process.env.TWILIO_WHATSAPP_SANDBOX_NUMBER ?? "whatsapp:+10000001001",
  webhookBaseUrl: process.env.TWILIO_WEBHOOK_BASE_URL ?? "",
};
