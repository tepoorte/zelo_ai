import type { WhatsAppInboundTextMessage } from "./types.js";

export function parseWhatsAppWebhook(body: any): WhatsAppInboundTextMessage[] {
  const out: WhatsAppInboundTextMessage[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages = Array.isArray(value?.messages) ? value.messages : [];

      for (const message of messages) {
        const from = message?.from;
        const text = message?.text?.body;
        if (!from || !text) continue;

        const contact = contacts.find((c: any) => String(c?.wa_id ?? "") === String(from));
        out.push({
          channel: "whatsapp",
          userId: String(from),
          text: String(text),
          messageId: typeof message?.id === "string" ? message.id : undefined,
          fromName:
            typeof contact?.profile?.name === "string" ? contact.profile.name : undefined,
        });
      }
    }
  }

  return out;
}
