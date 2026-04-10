import type { WhatsAppLinkRecord } from "../types.js";

const WA_TO_USERREF = new Map<string, WhatsAppLinkRecord>();

export function linkWhatsAppUser(waId: string, userRef: string): WhatsAppLinkRecord {
  const record: WhatsAppLinkRecord = {
    waId,
    userRef,
    linkedAt: new Date().toISOString(),
  };
  WA_TO_USERREF.set(waId, record);
  return record;
}

export function getWhatsAppLink(waId: string): WhatsAppLinkRecord | undefined {
  return WA_TO_USERREF.get(waId);
}

export function resolveWhatsAppUserRef(waId: string): string {
  return getWhatsAppLink(waId)?.userRef ?? `wa:${waId}`;
}
