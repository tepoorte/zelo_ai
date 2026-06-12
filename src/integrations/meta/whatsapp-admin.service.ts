import { env } from "../../config/env.js";
import { metaEnv } from "./env.js";
import { normalizeWhatsAppPhone } from "./whatsapp-session.service.js";

export function isWhatsAppAdminAuthorized(req: any): boolean {
  if (!metaEnv.whatsappAdminToken && env.nodeEnv !== "production") {
    return true;
  }

  const provided =
    typeof req.query?.token === "string"
      ? req.query.token
      : req.header("x-whatsapp-admin-token") || "";

  return Boolean(metaEnv.whatsappAdminToken && provided === metaEnv.whatsappAdminToken);
}

export function getWhatsAppCloudStatus() {
  return {
    provider: metaEnv.whatsappProvider,
    webhookPath: "/integrations/meta/whatsapp/webhook",
    testPhone: normalizeWhatsAppPhone(metaEnv.whatsappTestPhone),
    ready: Boolean(
      metaEnv.verifyToken &&
        metaEnv.appSecret &&
        metaEnv.graphToken &&
        metaEnv.whatsappPhoneNumberId
    ),
    config: {
      verifyTokenSet: Boolean(metaEnv.verifyToken),
      appSecretSet: Boolean(metaEnv.appSecret),
      graphTokenSet: Boolean(metaEnv.graphToken),
      phoneNumberIdSet: Boolean(metaEnv.whatsappPhoneNumberId),
      graphVersion: metaEnv.graphVersion,
      graphBaseUrl: metaEnv.graphBaseUrl,
    },
  };
}
