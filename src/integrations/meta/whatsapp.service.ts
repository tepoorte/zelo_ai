import { runAgent } from "../../ai/agent.js";
import type { FrontendIntentHint } from "../../ai/services/planner-types.js";
import { buildServerFrontendIntentHint } from "../../ai/services/server-intent-hint.service.js";
import type { WhatsAppInboundTextMessage, WhatsAppOutboundTextMessage } from "./types.js";
import { resolveWhatsAppUserRef } from "./store/identity-map.js";
import { hasSeenMessage, markMessageSeen } from "./store/message-dedup.js";
import { sendWhatsAppText, splitWhatsAppText } from "./whatsapp.send.js";
import {
  ensureWhatsAppSwissdataSession,
  isAllowedWhatsAppPhone,
  normalizeWhatsAppPhone,
} from "./whatsapp-session.service.js";

export type WhatsAppConversationDeps = {
  runAgent: typeof runAgent;
  buildIntentHint: typeof buildServerFrontendIntentHint;
  ensureSession: typeof ensureWhatsAppSwissdataSession;
  isAllowedPhone: typeof isAllowedWhatsAppPhone;
};

const DEFAULT_CONVERSATION_DEPS: WhatsAppConversationDeps = {
  runAgent,
  buildIntentHint: buildServerFrontendIntentHint,
  ensureSession: ensureWhatsAppSwissdataSession,
  isAllowedPhone: isAllowedWhatsAppPhone,
};

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

  const reply = await buildWhatsAppConversationReply(message);

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
    userRef: reply.userRef,
    partsSent: parts.length,
  };
}

export async function buildWhatsAppConversationReply(
  message: WhatsAppInboundTextMessage,
  deps: WhatsAppConversationDeps = DEFAULT_CONVERSATION_DEPS
): Promise<{ userRef: string; message: string; frontendIntentHint?: FrontendIntentHint }> {
  const phone = normalizeWhatsAppPhone(message.userId);
  const userRef = resolveWhatsAppUserRef(phone);

  if (!deps.isAllowedPhone(phone)) {
    return {
      userRef,
      message: "Ce numéro WhatsApp n’est pas encore autorisé pour tester l’assistant Zélo.",
    };
  }

  const session = await deps.ensureSession({ userRef, phone, text: message.text });
  if (!session.ok) {
    return { userRef, message: session.message };
  }

  const frontendIntentHint = await deps.buildIntentHint(message.text);
  const reply = await deps.runAgent(userRef, message.text, frontendIntentHint);

  return {
    userRef,
    message: reply.message,
    frontendIntentHint,
  };
}
