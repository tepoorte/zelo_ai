import { createHash } from "node:crypto";
import { env } from "../config/env.js";

export type WhatsAppCustomerSession = {
  userRef: string;
  customerId: string;
  userId: string;
  email: string;
  phoneHash: string;
  createdAt: number;
  expiresAt: number;
};

const WHATSAPP_CUSTOMER_SESSIONS = new Map<string, WhatsAppCustomerSession>();

export function isWhatsAppUserRef(userRef: string): boolean {
  return /^wa:\d+$/.test(String(userRef || ""));
}

export function hashPhoneForAudit(phone: string): string {
  return createHash("sha256")
    .update(String(phone || ""))
    .digest("hex")
    .slice(0, 12);
}

export function setWhatsAppCustomerSession(input: {
  userRef: string;
  phone: string;
  customerId: string;
  userId: string;
  email: string;
}): WhatsAppCustomerSession {
  const now = Date.now();
  const ttlHours = Number.isFinite(env.whatsappSessionTtlHours)
    ? env.whatsappSessionTtlHours
    : 24 * 14;
  const session: WhatsAppCustomerSession = {
    userRef: input.userRef,
    customerId: input.customerId,
    userId: input.userId,
    email: input.email,
    phoneHash: hashPhoneForAudit(input.phone),
    createdAt: now,
    expiresAt: now + ttlHours * 60 * 60 * 1000,
  };
  WHATSAPP_CUSTOMER_SESSIONS.set(input.userRef, session);
  return session;
}

export function getWhatsAppCustomerSession(userRef: string): WhatsAppCustomerSession | null {
  const session = WHATSAPP_CUSTOMER_SESSIONS.get(userRef);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    WHATSAPP_CUSTOMER_SESSIONS.delete(userRef);
    return null;
  }
  return session;
}

export function clearWhatsAppCustomerSession(userRef: string): void {
  WHATSAPP_CUSTOMER_SESSIONS.delete(userRef);
}

export function requireWhatsAppCustomerSession(userRef: string): WhatsAppCustomerSession {
  const session = getWhatsAppCustomerSession(userRef);
  if (!session) {
    throw new Error("Missing WhatsApp customer session");
  }
  return session;
}
