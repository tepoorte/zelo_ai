import { runAgent } from "../../ai/agent.js";
import type { FrontendIntentHint } from "../../ai/services/planner-types.js";
import { buildServerFrontendIntentHint } from "../../ai/services/server-intent-hint.service.js";
import type { WhatsAppInboundTextMessage, WhatsAppOutboundTextMessage } from "./types.js";
import { resolveWhatsAppUserRef } from "./store/identity-map.js";
import { hasSeenMessage, markMessageSeen } from "./store/message-dedup.js";
import {
  sendWhatsAppText,
  sendWhatsAppTypingIndicator,
  splitWhatsAppText,
} from "./whatsapp.send.js";
import { isWhatsAppLogoutCommand } from "./whatsapp-auth.service.js";
import {
  clearWhatsAppNewCustomerDiscovery,
  handleWhatsAppNewCustomerDiscoveryMessage,
} from "./whatsapp-new-customer-discovery.service.js";
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
  handleNewCustomerDiscovery: typeof handleWhatsAppNewCustomerDiscoveryMessage;
  clearNewCustomerDiscovery: typeof clearWhatsAppNewCustomerDiscovery;
};

const DEFAULT_CONVERSATION_DEPS: WhatsAppConversationDeps = {
  runAgent,
  buildIntentHint: buildServerFrontendIntentHint,
  ensureSession: ensureWhatsAppSwissdataSession,
  isAllowedPhone: isAllowedWhatsAppPhone,
  handleNewCustomerDiscovery: handleWhatsAppNewCustomerDiscoveryMessage,
  clearNewCustomerDiscovery: clearWhatsAppNewCustomerDiscovery,
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
  void sendWhatsAppTypingIndicatorBestEffort(message.messageId);

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

async function sendWhatsAppTypingIndicatorBestEffort(messageId?: string) {
  if (!messageId) return;
  try {
    await sendWhatsAppTypingIndicator({ messageId });
  } catch {
    // UX-only signal: never block the actual assistant response if Meta rejects it.
    console.warn("[whatsapp] typing indicator unavailable; continuing without it");
  }
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

  const logoutRequested = isWhatsAppLogoutCommand(message.text);
  if (logoutRequested) {
    await deps.clearNewCustomerDiscovery(userRef);
  }

  const session = await deps.ensureSession({ userRef, phone, text: message.text });
  if (logoutRequested) {
    // Close a welcome that could have started while the session itself was
    // being revoked. This second pass makes logout the final state transition.
    await deps.clearNewCustomerDiscovery(userRef);
  }
  if (!session.ok) {
    return { userRef, message: "message" in session ? session.message : "" };
  }

  const discoveryMessage = await deps.handleNewCustomerDiscovery({
    userRef,
    text: message.text,
  });
  if (discoveryMessage !== null) {
    return { userRef, message: discoveryMessage };
  }

  const frontendIntentHint = await deps.buildIntentHint(message.text);
  const reply = await deps.runAgent(userRef, message.text, frontendIntentHint);

  return {
    userRef,
    message: reply.message,
    frontendIntentHint,
  };
}
