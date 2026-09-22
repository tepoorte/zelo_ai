import { env } from "../../config/env.js";
import { swissdataAdminClient } from "../../swissdata/admin-client.js";
import {
  isSameWhatsAppPhone,
  normalizeMetaWhatsAppPhone,
  swissdataPhoneSearchPattern,
} from "./whatsapp-phone.js";

export type WhatsAppCustomerIdentity = {
  customerId: string;
  userId: string;
  email: string;
  mobile?: string;
  displayName?: string;
};

export type WhatsAppCustomerLookupResult =
  | { ok: true; identity: WhatsAppCustomerIdentity }
  | { ok: false; reason: "not_found" | "ambiguous" | "missing_user" | "missing_email" | "config" };

type SwissdataCustomerLike = {
  id?: string;
  _id?: string;
  userId?: string;
  email?: string;
  mobile?: string;
  firstname?: string;
  lastname?: string;
  companyName?: string;
  user?: {
    id?: string;
    _id?: string;
    email?: string;
    mobile?: string;
    firstname?: string;
    lastname?: string;
  };
};

function idOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "toString" in value) {
    return String(value);
  }
  return "";
}

function customerPhoneMatches(customer: SwissdataCustomerLike, phone: string): boolean {
  return (
    isSameWhatsAppPhone(customer.mobile ?? "", phone) ||
    isSameWhatsAppPhone(customer.user?.mobile ?? "", phone)
  );
}

function displayName(customer: SwissdataCustomerLike): string | undefined {
  const parts = [
    customer.firstname || customer.user?.firstname,
    customer.lastname || customer.user?.lastname,
  ].filter(Boolean);
  return String(customer.companyName || parts.join(" ") || "").trim() || undefined;
}

function toIdentity(customer: SwissdataCustomerLike): WhatsAppCustomerLookupResult {
  const customerId = idOf(customer.id ?? customer._id);
  const directUserId = idOf(customer.userId);
  const populatedUserId = idOf(customer.user?.id ?? customer.user?._id);
  if (directUserId && populatedUserId && directUserId !== populatedUserId) {
    return { ok: false, reason: "ambiguous" };
  }
  const userId = populatedUserId || directUserId;
  if (!customerId || !userId) {
    return { ok: false, reason: "missing_user" };
  }

  const email = String(customer.user?.email || customer.email || "").trim();
  if (!email || !email.includes("@")) {
    return { ok: false, reason: "missing_email" };
  }

  return {
    ok: true,
    identity: {
      customerId,
      userId,
      email,
      mobile: customer.user?.mobile || customer.mobile,
      displayName: displayName(customer),
    },
  };
}

export async function lookupWhatsAppCustomerByPhone(
  phone: string
): Promise<WhatsAppCustomerLookupResult> {
  if (!env.swissdataShopId) return { ok: false, reason: "config" };

  const normalizedPhone = normalizeMetaWhatsAppPhone(phone);
  if (!normalizedPhone) return { ok: false, reason: "not_found" };

  const api = await swissdataAdminClient();
  const searchPattern = swissdataPhoneSearchPattern(normalizedPhone);
  if (!searchPattern) return { ok: false, reason: "not_found" };
  const candidates: SwissdataCustomerLike[] = [];
  const pageSize = 100;
  const maxCandidates = 1_000;
  for (let skip = 0; skip < maxCandidates; skip += pageSize) {
    const res = await api.get(`/shop/admin/${env.swissdataShopId}/customer`, {
      params: {
        q: searchPattern,
        autoFetch: "user",
        limit: pageSize,
        skip,
      },
    });
    const page = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.items)
        ? res.data.items
        : [];
    candidates.push(...(page as SwissdataCustomerLike[]));
    if (page.length < pageSize) break;
    if (skip + pageSize >= maxCandidates) return { ok: false, reason: "ambiguous" };
  }
  const matchesByCustomer = new Map<string, SwissdataCustomerLike>();
  for (const customer of candidates) {
    if (!customerPhoneMatches(customer, normalizedPhone)) continue;
    const customerId = idOf(customer.id ?? customer._id);
    const userId = idOf(customer.userId ?? customer.user?.id ?? customer.user?._id);
    const key = customerId || `missing:${userId}:${customer.mobile ?? ""}:${customer.user?.mobile ?? ""}`;
    if (!matchesByCustomer.has(key)) matchesByCustomer.set(key, customer);
  }
  const matches = [...matchesByCustomer.values()];

  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return toIdentity(matches[0]);
}
