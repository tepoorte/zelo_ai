const MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
const SEEN_MESSAGES = new Map<string, number>();

function pruneSeenMessages(now = Date.now()) {
  for (const [messageId, seenAt] of SEEN_MESSAGES.entries()) {
    if (now - seenAt > MESSAGE_TTL_MS) {
      SEEN_MESSAGES.delete(messageId);
    }
  }
}

export function hasSeenMessage(messageId?: string): boolean {
  if (!messageId) return false;
  pruneSeenMessages();
  return SEEN_MESSAGES.has(messageId);
}

export function markMessageSeen(messageId?: string) {
  if (!messageId) return;
  pruneSeenMessages();
  SEEN_MESSAGES.set(messageId, Date.now());
}
