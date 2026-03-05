export type InboundMessage = {
  channel: "messenger";
  userId: string;      // PSID
  text: string;
  messageId?: string;
};

export function parseMessengerWebhook(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = body?.entry ?? [];
  for (const e of entries) {
    const messaging = e?.messaging ?? [];
    for (const evt of messaging) {
      const senderId = evt?.sender?.id;
      const text = evt?.message?.text;
      if (senderId && text) {
        out.push({
          channel: "messenger",
          userId: String(senderId),
          text: String(text),
          messageId: evt?.message?.mid
        });
      }
    }
  }
  return out;
}