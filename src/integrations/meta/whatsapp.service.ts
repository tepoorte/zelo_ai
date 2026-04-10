import { runAgent } from "../../ai/agent.js";
import type { WhatsAppInboundTextMessage, WhatsAppOutboundTextMessage } from "./types.js";
import { resolveWhatsAppUserRef } from "./store/identity-map.js";
import { hasSeenMessage, markMessageSeen } from "./store/message-dedup.js";
import { sendWhatsAppText, splitWhatsAppText } from "./whatsapp.send.js";

export async function processIncomingWhatsAppTexts(messages: WhatsAppInboundTextMessage[]) {
  for (const message of messages) {
    await processIncomingWhatsAppText(message);
  }
}

export async function processIncomingWhatsAppText(message: WhatsAppInboundTextMessage) {
  if (hasSeenMessage(message.messageId)) {
    return { ok: true, deduped: true as const };
  }
  markMessageSeen(message.messageId);

  const userRef = resolveWhatsAppUserRef(message.userId);
  const reply = await runAgent(userRef, message.text);

  const parts = splitWhatsAppText(reply.message);
  for (let index = 0; index < parts.length; index++) {
    const outbound: WhatsAppOutboundTextMessage = {
      to: message.userId,
      body: parts[index],
      previewUrl: false,
      ...(index === 0 && message.messageId ? { replyToMessageId: message.messageId } : {}),
    };
    await sendWhatsAppText(outbound);
  }

  return {
    ok: true,
    userRef,
    partsSent: parts.length,
  };
}
