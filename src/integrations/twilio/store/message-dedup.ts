const MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
const SEEN_MESSAGE_SIDS = new Map<string, number>();

function prune(now = Date.now()) {
  for (const [sid, seenAt] of SEEN_MESSAGE_SIDS.entries()) {
    if (now - seenAt > MESSAGE_TTL_MS) {
      SEEN_MESSAGE_SIDS.delete(sid);
    }
  }
}

export function hasSeenTwilioMessage(messageSid?: string) {
  if (!messageSid) return false;
  prune();
  return SEEN_MESSAGE_SIDS.has(messageSid);
}

export function markTwilioMessageSeen(messageSid?: string) {
  if (!messageSid) return;
  prune();
  SEEN_MESSAGE_SIDS.set(messageSid, Date.now());
}
