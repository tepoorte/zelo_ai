import type { TwilioInboundWhatsAppMessage } from "./types.js";

export function parseTwilioWhatsAppWebhook(body: any): TwilioInboundWhatsAppMessage | null {
  const text = String(body?.Body ?? "").trim();
  const from = String(body?.From ?? "").trim();
  const to = String(body?.To ?? "").trim();

  if (!text || !from || !to) {
    return null;
  }

  return {
    body: text,
    from,
    to,
    messageSid: typeof body?.MessageSid === "string" ? body.MessageSid : undefined,
    profileName: typeof body?.ProfileName === "string" ? body.ProfileName : undefined,
    numMedia: Number(body?.NumMedia ?? 0),
  };
}
