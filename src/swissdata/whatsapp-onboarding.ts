import axios, { type AxiosInstance } from "axios";

import { env } from "../config/env.js";
import {
  isSameWhatsAppPhone,
  normalizeMetaWhatsAppPhone,
  swissdataPhoneLookupVariants,
  swissdataPhoneSearchPattern,
} from "../integrations/meta/whatsapp-phone.js";

export type SwissdataOnboardingUser = {
  id: string;
  email: string;
  mobile: string;
};

export type SwissdataOnboardingCustomer = {
  id: string;
  userId: string;
  firstname: string;
  lastname: string;
  email: string;
  mobile: string;
  region?: string;
  addresses: SwissdataOnboardingAddress[];
  metadata: Array<{ key: string; value: unknown; type?: string }>;
};

export type SwissdataOnboardingAddress = {
  [key: string]: unknown;
  street: string;
  zip: string;
  city: string;
  country: string;
  description?: string;
  accessInformation?: string;
};

export type SwissdataOnboardingRegion = {
  id: string;
  name: string;
};

export type SwissdataPhoneAccountResolution =
  | { kind: "none" }
  | { kind: "unique"; userId: string; login?: string }
  | { kind: "ambiguous" };

export type SwissdataAccountIdResolution =
  | { kind: "none" }
  | { kind: "unique"; userId: string }
  | { kind: "ambiguous" };

export type SwissdataAccountCreation = {
  token: string;
  validation: string;
  expires?: string;
};

export class SwissdataOnboardingGatewayError extends Error {
  constructor(public readonly kind: "credentials" | "invalid_code" | "conflict" | "upstream") {
    super(`Swissdata onboarding failure: ${kind}`);
    this.name = "SwissdataOnboardingGatewayError";
  }
}

function remoteErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) return "";
  return String(error.response?.data?.error ?? "").trim().toLowerCase();
}

function publicClient(accessToken?: string): AxiosInstance {
  return axios.create({
    baseURL: env.swissdataBaseUrl,
    timeout: 15_000,
    params: { apiKey: env.swissdataApiKey },
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function idValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return "";
}

export function swissdataPhoneVariants(phone: string): string[] {
  return swissdataPhoneLookupVariants(phone);
}

export function isSameSwissdataPhone(left: string, right: string): boolean {
  return isSameWhatsAppPhone(left, right);
}

async function swissdataAccountLookup(
  type: "email" | "mobile",
  value: string
): Promise<{ exists: boolean; id?: string }> {
  const res = await publicClient().get(
    `/user/exists/${type}/${encodeURIComponent(value)}`
  );
  const id = idValue(res.data?.id ?? res.data?._id);
  return res.data?.exists === true && id
    ? { exists: true, id }
    : { exists: res.data?.exists === true };
}

export async function swissdataAccountExists(
  type: "email" | "mobile",
  value: string
): Promise<boolean> {
  return (await swissdataAccountLookup(type, value)).exists;
}

export async function resolveSwissdataAccountForEmail(
  email: string
): Promise<SwissdataAccountIdResolution> {
  const normalizedEmail = stringValue(email).toLowerCase();
  if (!normalizedEmail) return { kind: "none" };
  const match = await swissdataAccountLookup("email", normalizedEmail);
  if (!match.exists) return { kind: "none" };
  if (!match.id) return { kind: "ambiguous" };
  return { kind: "unique", userId: match.id };
}

async function searchSwissdataUserIdsForPhone(phone: string): Promise<Set<string>> {
  const controlledPattern = swissdataPhoneSearchPattern(phone);
  if (!controlledPattern) return new Set();
  const res = await publicClient().get("/search-user", {
    params: {
      q: controlledPattern,
      limit: 2,
    },
  });
  if (!Array.isArray(res.data)) {
    throw new Error("Swissdata user search returned an invalid response");
  }
  const userIds = new Set<string>();
  for (const candidate of res.data) {
    const id = idValue(candidate?.id ?? candidate?._id);
    if (!id) throw new Error("Swissdata user search returned an invalid identity");
    userIds.add(id);
  }
  return userIds;
}

export async function resolveSwissdataAccountForPhone(
  phone: string
): Promise<SwissdataPhoneAccountResolution> {
  const userIds = new Set<string>();
  const loginsByUserId = new Map<string, string>();
  for (const variant of swissdataPhoneVariants(phone)) {
    const match = await swissdataAccountLookup("mobile", variant);
    if (match.exists && !match.id) return { kind: "ambiguous" };
    if (match.id) {
      userIds.add(match.id);
      if (!loginsByUserId.has(match.id)) loginsByUserId.set(match.id, variant);
    }
  }
  const searchedUserIds = await searchSwissdataUserIdsForPhone(phone);
  for (const userId of searchedUserIds) userIds.add(userId);
  if (userIds.size === 0) return { kind: "none" };
  if (userIds.size > 1) return { kind: "ambiguous" };
  const userId = [...userIds][0];
  const login = loginsByUserId.get(userId);
  return login ? { kind: "unique", userId, login } : { kind: "unique", userId };
}

export async function swissdataAccountExistsForPhone(phone: string): Promise<boolean> {
  return (await resolveSwissdataAccountForPhone(phone)).kind !== "none";
}

export async function createSwissdataWhatsAppAccount(input: {
  firstname: string;
  lastname: string;
  email: string;
  password: string;
  clientUrl: string;
}): Promise<SwissdataAccountCreation> {
  let res;
  try {
    res = await publicClient().post("/user/create-account", {
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      password: input.password,
      locale: "fr",
      clientUrl: input.clientUrl,
    });
  } catch (error) {
    const message = remoteErrorMessage(error);
    if (message.includes("unique") || message.includes("already")) {
      throw new SwissdataOnboardingGatewayError("conflict");
    }
    throw new SwissdataOnboardingGatewayError("upstream");
  }

  const token = stringValue(res.data?.token);
  const validation = stringValue(res.data?.createAccountValidation);
  if (!token || !validation) {
    throw new Error("Swissdata account creation returned no validation token");
  }
  if (validation !== "emailOnly" && validation !== "emailOrMobile") {
    throw new Error("Swissdata account policy does not support email validation");
  }

  return {
    token,
    validation,
    expires: stringValue(res.data?.expires) || undefined,
  };
}

export async function validateSwissdataWhatsAppAccount(input: {
  token: string;
  emailCode: string;
}): Promise<SwissdataOnboardingUser> {
  let res;
  try {
    res = await publicClient().put("/user/create-account", {
      token: input.token,
      emailCode: input.emailCode,
    });
  } catch (error) {
    const message = remoteErrorMessage(error);
    if (message.includes("token not found") || message.includes("invalid")) {
      throw new SwissdataOnboardingGatewayError("invalid_code");
    }
    throw new SwissdataOnboardingGatewayError("upstream");
  }
  return userFromResponse(res.data);
}

export async function resendSwissdataWhatsAppEmailCode(input: {
  token: string;
}): Promise<void> {
  try {
    await publicClient().put("/user/resend-code", {
      token: input.token,
      method: "email",
      locale: "fr",
    });
  } catch (error) {
    const message = remoteErrorMessage(error);
    if (message.includes("token not found") || message.includes("invalid")) {
      throw new SwissdataOnboardingGatewayError("invalid_code");
    }
    throw new SwissdataOnboardingGatewayError("upstream");
  }
}

function userFromResponse(data: any): SwissdataOnboardingUser {
  const id = idValue(data?.id ?? data?._id);
  if (!id || data?.token) {
    throw new Error("Swissdata email validation did not create the user");
  }
  return {
    id,
    email: stringValue(data?.email).toLowerCase(),
    mobile: stringValue(data?.mobile),
  };
}

function customerFromResponse(data: any): SwissdataOnboardingCustomer {
  const id = idValue(data?.id ?? data?._id);
  const userId = idValue(data?.userId);
  if (!id || !userId) {
    throw new Error("Swissdata customer response is missing its owner");
  }
  return {
    id,
    userId,
    firstname: stringValue(data?.firstname),
    lastname: stringValue(data?.lastname),
    email: stringValue(data?.email).toLowerCase(),
    mobile: stringValue(data?.mobile),
    region: idValue(data?.region) || undefined,
    addresses: Array.isArray(data?.addresses)
      ? data.addresses
          .map((address: any) => ({
            ...address,
            street: stringValue(address?.street),
            zip: stringValue(address?.zip),
            city: stringValue(address?.city),
            country: stringValue(address?.country),
            ...(stringValue(address?.description)
              ? { description: stringValue(address.description) }
              : {}),
            ...(stringValue(address?.accessInformation)
              ? { accessInformation: stringValue(address.accessInformation) }
              : {}),
          }))
          .filter(
            (address: SwissdataOnboardingAddress) =>
              Boolean(address.street && address.zip && address.city && address.country)
          )
      : [],
    metadata: Array.isArray(data?.metadata) ? data.metadata : [],
  };
}

export async function authenticateSwissdataAccount(
  username: string,
  password: string
): Promise<string> {
  let res;
  try {
    res = await publicClient().post("/auth/token", { username, password });
  } catch (error) {
    if (remoteErrorMessage(error) === "invalid username or password") {
      throw new SwissdataOnboardingGatewayError("credentials");
    }
    throw new SwissdataOnboardingGatewayError("upstream");
  }
  const token = stringValue(res.data?.token);
  if (!token) throw new Error("Swissdata authentication returned no access token");
  return token;
}

export async function authenticateSwissdataPhoneAccount(
  phone: string,
  password: string
): Promise<string> {
  let lastError: unknown;
  for (const variant of swissdataPhoneVariants(phone)) {
    try {
      return await authenticateSwissdataAccount(variant, password);
    } catch (error) {
      lastError = error;
      const credentialFailure =
        error instanceof SwissdataOnboardingGatewayError && error.kind === "credentials";
      if (!credentialFailure) throw error;
    }
  }
  throw lastError ?? new Error("Swissdata authentication failed");
}

export async function getSwissdataCurrentUser(
  accessToken: string
): Promise<SwissdataOnboardingUser> {
  const res = await publicClient(accessToken).get("/user/current");
  return userFromResponse(res.data);
}

export async function ensureSwissdataCurrentCustomer(
  accessToken: string
): Promise<SwissdataOnboardingCustomer> {
  const res = await publicClient(accessToken).get(
    `/shop/${env.swissdataShopId}/customer/current`
  );
  return customerFromResponse(res.data);
}

export async function bindSwissdataCurrentCustomerPhone(input: {
  accessToken: string;
  phone: string;
}): Promise<SwissdataOnboardingCustomer> {
  const canonicalPhone = normalizeMetaWhatsAppPhone(input.phone);
  if (!canonicalPhone) throw new Error("Invalid Meta phone");
  const res = await publicClient(input.accessToken).put(
    `/shop/${env.swissdataShopId}/customer/current`,
    { mobile: `+${canonicalPhone}` }
  );
  return customerFromResponse(res.data);
}

export async function listSwissdataOnboardingRegions(): Promise<SwissdataOnboardingRegion[]> {
  const res = await publicClient().get(`/shop/${env.swissdataShopId}/region`, {
    params: { sort: "order" },
  });
  const regions = Array.isArray(res.data) ? res.data : [];
  return regions
    .map((region: any) => ({
      id: idValue(region?.id ?? region?._id),
      name: stringValue(region?.name),
    }))
    .filter((region: SwissdataOnboardingRegion) => Boolean(region.id && region.name));
}

export async function recordSwissdataWhatsAppOnboarding(input: {
  accessToken: string;
  customer: SwissdataOnboardingCustomer;
  phone: string;
  firstname: string;
  lastname: string;
  email: string;
  address: SwissdataOnboardingAddress;
  regionId: string;
  consentId: string;
  acceptedAt: string;
  termsVersion: string;
  termsUrl: string;
}): Promise<SwissdataOnboardingCustomer> {
  const canonicalPhone = normalizeMetaWhatsAppPhone(input.phone);
  if (!canonicalPhone) throw new Error("Invalid Meta phone");

  const key = "zeloAiWhatsAppOnboardingConsents";
  const previousEntry = input.customer.metadata.find((entry) => entry?.key === key);
  const previousEvents = Array.isArray(previousEntry?.value) ? previousEntry.value : [];
  const consentEvent = {
    id: input.consentId,
    source: "whatsapp",
    acceptedAt: input.acceptedAt,
    termsVersion: input.termsVersion,
    termsUrl: input.termsUrl,
  };
  const consentEvents = previousEvents.some(
    (event: any) => event && typeof event === "object" && event.id === input.consentId
  )
    ? previousEvents
    : [...previousEvents, consentEvent];
  const metadata = [
    ...input.customer.metadata.filter((entry) => entry?.key !== key),
    {
      key,
      value: consentEvents,
    },
  ];
  const alreadyStored = input.customer.addresses.some(
    (address) =>
      address.street === input.address.street &&
      address.zip === input.address.zip &&
      address.city === input.address.city &&
      address.country === input.address.country
  );
  const addresses = alreadyStored
    ? input.customer.addresses
    : [input.address, ...input.customer.addresses];
  const res = await publicClient(input.accessToken).put(
    `/shop/${env.swissdataShopId}/customer/current`,
    {
      firstname: input.firstname,
      lastname: input.lastname,
      email: input.email,
      mobile: `+${canonicalPhone}`,
      addresses,
      region: input.regionId,
      metadata,
    }
  );
  return customerFromResponse(res.data);
}
