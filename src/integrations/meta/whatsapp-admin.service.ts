import { env } from "../../config/env.js";
import { isAdminTokenAuthorized as isRequestAdminTokenAuthorized } from "../../utils/admin-auth.js";
import { metaEnv } from "./env.js";
import { normalizeWhatsAppPhone } from "./whatsapp-session.service.js";

export function isWhatsAppAdminAuthorized(req: any): boolean {
  if (!metaEnv.whatsappAdminToken && env.nodeEnv !== "production") {
    return true;
  }

  return isRequestAdminTokenAuthorized(req, metaEnv.whatsappAdminToken);
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
