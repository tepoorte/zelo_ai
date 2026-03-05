export type InboundMessage = {
  channel: "whatsapp";
  userId: string;        // phone number (wa_id)
  text: string;
  messageId?: string;
};

export function parseWhatsAppWebhook(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = body?.entry ?? [];
  for (const e of entries) {
    const changes = e?.changes ?? [];
    for (const c of changes) {
      const value = c?.value;
      const messages = value?.messages ?? [];
      for (const m of messages) {
        const from = m?.from; // wa_id
        const text = m?.text?.body;
        if (from && text) {
          out.push({
            channel: "whatsapp",
            userId: String(from),
            text: String(text),
            messageId: m?.id
          });
        }
      }
    }
  }
  return out;
}