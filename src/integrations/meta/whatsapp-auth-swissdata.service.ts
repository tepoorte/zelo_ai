import { env } from "../../config/env.js";
import { swissdataAdminClient } from "../../swissdata/admin-client.js";

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

function normalizePhone(input: string): string {
  const withoutJid = String(input || "").split("@")[0] || "";
  const digits = withoutJid.replace(/\D/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

function phoneVariants(value: string): Set<string> {
  const normalized = normalizePhone(value);
  const variants = new Set<string>();
  if (!normalized) return variants;
  variants.add(normalized);
  if (normalized.startsWith("41") && normalized.length > 9) {
    variants.add(`0${normalized.slice(2)}`);
    variants.add(normalized.slice(2));
  }
  if (normalized.startsWith("0") && normalized.length > 8) {
    variants.add(`41${normalized.slice(1)}`);
    variants.add(normalized.slice(1));
  }
  return variants;
}

function phonesMatch(left: string | undefined, right: string): boolean {
  if (!left || !right) return false;
  const leftVariants = phoneVariants(left);
  const rightVariants = phoneVariants(right);
  for (const variant of leftVariants) {
    if (rightVariants.has(variant)) return true;
  }
  return false;
}

function customerPhoneMatches(customer: SwissdataCustomerLike, phone: string): boolean {
  return phonesMatch(customer.mobile, phone) || phonesMatch(customer.user?.mobile, phone);
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
  const userId = idOf(customer.userId ?? customer.user?.id ?? customer.user?._id);
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

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return { ok: false, reason: "not_found" };

  const api = await swissdataAdminClient();
  const res = await api.get(`/shop/admin/${env.swissdataShopId}/customer`, {
    params: {
      q: normalizedPhone,
      autoFetch: "user",
      limit: 20,
    },
  });

  const candidates = Array.isArray(res.data)
    ? res.data
    : Array.isArray(res.data?.items)
      ? res.data.items
      : [];

  const matches = candidates.filter((customer: SwissdataCustomerLike) =>
    customerPhoneMatches(customer, normalizedPhone)
  );

  if (matches.length === 0) return { ok: false, reason: "not_found" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return toIdentity(matches[0]);
}
