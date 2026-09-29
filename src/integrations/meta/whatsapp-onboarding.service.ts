import { createHash, randomBytes } from "node:crypto";

import { env } from "../../config/env.js";
import {
  setWhatsAppCustomerSession,
  type WhatsAppCustomerSession,
} from "../../swissdata/whatsapp-customer-session.js";
import {
  authenticateSwissdataAccount,
  authenticateSwissdataPhoneAccount,
  bindSwissdataCurrentCustomerPhone,
  createSwissdataWhatsAppAccount,
  ensureSwissdataCurrentCustomer,
  getSwissdataCurrentUser,
  isSameSwissdataPhone,
  listSwissdataOnboardingRegions,
  recordSwissdataWhatsAppOnboarding,
  resendSwissdataWhatsAppEmailCode,
  resolveSwissdataAccountForEmail,
  resolveSwissdataAccountForPhone,
  swissdataAccountExists,
  validateSwissdataWhatsAppAccount,
  SwissdataOnboardingGatewayError,
  type SwissdataOnboardingCustomer,
  type SwissdataOnboardingRegion,
  type SwissdataOnboardingUser,
  type SwissdataAccountIdResolution,
  type SwissdataPhoneAccountResolution,
} from "../../swissdata/whatsapp-onboarding.js";
import {
  lookupWhatsAppCustomerByPhone,
  type WhatsAppCustomerLookupResult,
} from "./whatsapp-auth-swissdata.service.js";
import {
  sendWhatsAppNewCustomerDiscoveryWelcome,
  type SendNewCustomerDiscoveryWelcomeInput,
  type SendNewCustomerDiscoveryWelcomeResult,
} from "./whatsapp-new-customer-discovery.service.js";
import { normalizeMetaWhatsAppPhone } from "./whatsapp-phone.js";
import { sendWhatsAppText } from "./whatsapp.send.js";
import {
  InMemoryWhatsAppOnboardingStateStore,
  PersistentWhatsAppOnboardingStateStore,
  generateWhatsAppOnboardingStateKey,
  type WhatsAppOnboardingPendingAccount,
  type WhatsAppOnboardingRateBucket,
  type WhatsAppOnboardingState,
  type WhatsAppOnboardingStateStore,
  type WhatsAppOnboardingStoredTicket,
} from "./store/whatsapp-onboarding.store.js";

export type WhatsAppOnboardingMode = "new_account" | "existing_account";
export type WhatsAppOnboardingStage =
  | "offered"
  | "account_pending"
  | "account_validated"
  | "completed";

export type WhatsAppOnboardingStatus = {
  ok: true;
  mode: WhatsAppOnboardingMode;
  stage: WhatsAppOnboardingStage;
  expiresAt: string;
  requiresEmail?: true;
};

export type WhatsAppOnboardingRegions = {
  ok: true;
  regions: SwissdataOnboardingRegion[];
};

export type WhatsAppOnboardingOffer =
  | { kind: "issued"; url: string; expiresInMinutes: number }
  | { kind: "active"; expiresInMinutes: number };

export class WhatsAppOnboardingError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "WhatsAppOnboardingError";
  }
}

export type WhatsAppOnboardingDeps = {
  now: () => number;
  randomToken: () => string;
  resolveAccountForEmail: (email: string) => Promise<SwissdataAccountIdResolution>;
  resolveAccountForPhone: (phone: string) => Promise<SwissdataPhoneAccountResolution>;
  lookupCustomer: (phone: string) => Promise<WhatsAppCustomerLookupResult>;
  accountExists: typeof swissdataAccountExists;
  createAccount: typeof createSwissdataWhatsAppAccount;
  resendEmailCode: typeof resendSwissdataWhatsAppEmailCode;
  validateAccount: typeof validateSwissdataWhatsAppAccount;
  authenticateAccount: typeof authenticateSwissdataAccount;
  authenticatePhoneAccount: typeof authenticateSwissdataPhoneAccount;
  currentUser: typeof getSwissdataCurrentUser;
  ensureCustomer: typeof ensureSwissdataCurrentCustomer;
  bindCustomerPhone: typeof bindSwissdataCurrentCustomerPhone;
  listRegions: typeof listSwissdataOnboardingRegions;
  recordOnboarding: typeof recordSwissdataWhatsAppOnboarding;
  phonesMatch: typeof isSameSwissdataPhone;
  stateStore: WhatsAppOnboardingStateStore;
  setCustomerSession: (input: {
    userRef: string;
    phone: string;
    customerId: string;
    userId: string;
    email: string;
  }) => WhatsAppCustomerSession;
  sendText: typeof sendWhatsAppText;
  sendNewCustomerDiscoveryWelcome: (
    input: SendNewCustomerDiscoveryWelcomeInput
  ) => Promise<SendNewCustomerDiscoveryWelcomeResult>;
};

const TERMS_VERSION = "zelo-conditions-generales-2026-09-21";
const TERMS_URL = "https://zelo-epicerie.ch/terms-conditions.html";
const OFFER_WINDOW_MS = 60 * 60_000;
const MAX_OFFERS_PER_WINDOW = 3;
const ROTATION_COOLDOWN_MS = 90_000;
const START_WINDOW_MS = 15 * 60_000;
const MAX_STARTS_PER_WINDOW = 5;
const RESEND_WINDOW_MS = 60 * 60_000;
const MAX_RESENDS_PER_WINDOW = 3;
const RESEND_COOLDOWN_MS = 90_000;
const MAX_REVOCATIONS = 10_000;
const DEV_STATE_KEY = generateWhatsAppOnboardingStateKey();

function defaultStateStore(): WhatsAppOnboardingStateStore {
  const configuredKey = env.whatsappOnboardingStateKey.trim();
  if (configuredKey) {
    return new PersistentWhatsAppOnboardingStateStore({ encryptionKey: configuredKey });
  }
  // Production configuration rejects a missing key. Development stays
  // ephemeral rather than writing data that could not be decrypted later.
  return new InMemoryWhatsAppOnboardingStateStore({ encryptionKey: DEV_STATE_KEY });
}

const DEFAULT_DEPS: WhatsAppOnboardingDeps = {
  now: () => Date.now(),
  randomToken: () => randomBytes(32).toString("base64url"),
  resolveAccountForEmail: resolveSwissdataAccountForEmail,
  resolveAccountForPhone: resolveSwissdataAccountForPhone,
  lookupCustomer: lookupWhatsAppCustomerByPhone,
  accountExists: swissdataAccountExists,
  createAccount: createSwissdataWhatsAppAccount,
  resendEmailCode: resendSwissdataWhatsAppEmailCode,
  validateAccount: validateSwissdataWhatsAppAccount,
  authenticateAccount: authenticateSwissdataAccount,
  authenticatePhoneAccount: authenticateSwissdataPhoneAccount,
  currentUser: getSwissdataCurrentUser,
  ensureCustomer: ensureSwissdataCurrentCustomer,
  bindCustomerPhone: bindSwissdataCurrentCustomerPhone,
  listRegions: listSwissdataOnboardingRegions,
  recordOnboarding: recordSwissdataWhatsAppOnboarding,
  phonesMatch: isSameSwissdataPhone,
  stateStore: defaultStateStore(),
  setCustomerSession: setWhatsAppCustomerSession,
  sendText: sendWhatsAppText,
  sendNewCustomerDiscoveryWelcome: sendWhatsAppNewCustomerDiscoveryWelcome,
};

function onboardingTtlMinutes(): number {
  const value = env.whatsappOnboardingTtlMinutes;
  return Number.isFinite(value) && value >= 5 ? Math.floor(value) : 30;
}

function maxAttempts(): number {
  const value = env.whatsappOnboardingMaxAttempts;
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 5;
}

function lockDurationMs(): number {
  const value = env.whatsappOnboardingLockMinutes;
  const minutes = Number.isFinite(value) && value >= 1 ? Math.floor(value) : 15;
  return minutes * 60_000;
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function normalizeName(value: string): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeAddress(
  input: WhatsAppOnboardingPendingAccount["address"]
): WhatsAppOnboardingPendingAccount["address"] {
  return {
    street: String(input?.street || "").trim().replace(/\s+/g, " "),
    zip: String(input?.zip || "").trim().replace(/\s+/g, " "),
    city: String(input?.city || "").trim().replace(/\s+/g, " "),
    country: String(input?.country || "").trim().replace(/\s+/g, " "),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateName(value: string, field: string): void {
  if (value.length < 1 || value.length > 80) {
    throw new WhatsAppOnboardingError(
      "invalid_profile",
      400,
      `${field} doit contenir entre 1 et 80 caractères.`
    );
  }
}

function validateEmail(email: string): void {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new WhatsAppOnboardingError(
      "invalid_email",
      400,
      "Saisis une adresse email valide."
    );
  }
}

function normalizeNewPassword(password: string): string {
  const normalized = typeof password === "string" ? password.trim() : "";
  if (normalized.length < 10 || normalized.length > 128) {
    throw new WhatsAppOnboardingError(
      "invalid_password",
      400,
      "Le mot de passe doit contenir entre 10 et 128 caractères."
    );
  }
  return normalized;
}

function validateExistingPassword(password: string): void {
  if (typeof password !== "string" || password.trim().length < 1 || password.length > 128) {
    throw new WhatsAppOnboardingError("invalid_password", 400, "Saisis ton mot de passe Zélo.");
  }
}

function validateEmailCode(code: string): string {
  const normalized = String(code || "").trim().toLowerCase();
  if (!/^[a-f0-9]{6}$/.test(normalized)) {
    throw new WhatsAppOnboardingError(
      "invalid_code",
      400,
      "Le code email doit contenir 6 caractères."
    );
  }
  return normalized;
}

function validateAddress(address: WhatsAppOnboardingPendingAccount["address"]): void {
  if (address.street.length < 3 || address.street.length > 160) {
    throw new WhatsAppOnboardingError("invalid_address", 400, "Saisis une rue et un numéro valides.");
  }
  if (address.zip.length < 3 || address.zip.length > 32) {
    throw new WhatsAppOnboardingError("invalid_address", 400, "Saisis un NPA valide.");
  }
  if (address.city.length < 2 || address.city.length > 120) {
    throw new WhatsAppOnboardingError("invalid_address", 400, "Saisis une localité valide.");
  }
  if (address.country.length < 2 || address.country.length > 80) {
    throw new WhatsAppOnboardingError("invalid_address", 400, "Saisis un pays valide.");
  }
}

function emptyRateBucket(): WhatsAppOnboardingRateBucket {
  return { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
}

function publicStage(stage: WhatsAppOnboardingStoredTicket["stage"]): WhatsAppOnboardingStage {
  return stage;
}

function canCreateAccountForLookup(result: WhatsAppCustomerLookupResult): boolean {
  return !result.ok && (result.reason === "not_found" || result.reason === "incomplete");
}

function sameAddress(
  actual: WhatsAppOnboardingPendingAccount["address"] | undefined,
  expected: WhatsAppOnboardingPendingAccount["address"]
): boolean {
  if (!actual) return false;
  return (
    actual.street === expected.street &&
    actual.zip === expected.zip &&
    actual.city === expected.city &&
    actual.country === expected.country
  );
}

function hasConsentEvent(
  customer: SwissdataOnboardingCustomer,
  consent: NonNullable<WhatsAppOnboardingStoredTicket["consent"]>
): boolean {
  const entry = customer.metadata.find(
    (candidate) => candidate?.key === "zeloAiWhatsAppOnboardingConsents"
  );
  return (
    Array.isArray(entry?.value) &&
    entry.value.some(
      (event) =>
        Boolean(event) &&
        typeof event === "object" &&
        "id" in event &&
        event.id === consent.id &&
        "source" in event &&
        event.source === "whatsapp" &&
        "acceptedAt" in event &&
        event.acceptedAt === consent.acceptedAt &&
        "termsVersion" in event &&
        event.termsVersion === consent.termsVersion &&
        "termsUrl" in event &&
        event.termsUrl === consent.termsUrl
    )
  );
}

export function isWhatsAppOnboardingLinkRotationCommand(text: string): boolean {
  return /^(nouveau lien|renvoie(?:-moi)? le lien|recommence(?:r)?(?: l['’]inscription)?|new link)$/i.test(
    String(text || "").trim()
  );
}

export class WhatsAppOnboardingService {
  private readonly busyTokenHashes = new Set<string>();

  constructor(private readonly deps: WhatsAppOnboardingDeps = DEFAULT_DEPS) {}

  private pushRevocation(
    state: WhatsAppOnboardingState,
    ticket: WhatsAppOnboardingStoredTicket,
    reason: WhatsAppOnboardingState["revocations"][number]["reason"]
  ): void {
    state.revocations.push({
      tokenHash: ticket.tokenHash,
      userRef: ticket.userRef,
      revokedAt: this.deps.now(),
      expiresAt: Math.max(ticket.expiresAt, this.deps.now() + 60_000),
      reason,
    });
    if (state.revocations.length > MAX_REVOCATIONS) {
      state.revocations.splice(0, state.revocations.length - MAX_REVOCATIONS);
    }
  }

  private revokeTicketInState(
    state: WhatsAppOnboardingState,
    ticket: WhatsAppOnboardingStoredTicket,
    reason: WhatsAppOnboardingState["revocations"][number]["reason"]
  ): void {
    state.tickets = state.tickets.filter((candidate) => candidate.tokenHash !== ticket.tokenHash);
    if (state.activeTokenHashByUserRef[ticket.userRef] === ticket.tokenHash) {
      delete state.activeTokenHashByUserRef[ticket.userRef];
    }
    state.revokedGenerationByUserRef[ticket.userRef] = Math.max(
      state.revokedGenerationByUserRef[ticket.userRef] ?? 0,
      ticket.generation
    );
    this.pushRevocation(state, ticket, reason);
  }

  private readState(): WhatsAppOnboardingState {
    const state = this.deps.stateStore.read();
    const now = this.deps.now();
    let changed = false;

    for (const ticket of [...state.tickets]) {
      if (ticket.expiresAt > now) continue;
      this.revokeTicketInState(state, ticket, "expired");
      changed = true;
    }

    const revocations = state.revocations.filter((entry) => entry.expiresAt > now);
    if (revocations.length !== state.revocations.length) {
      state.revocations = revocations;
      changed = true;
    }

    const retainedPrincipals = new Set<string>([
      ...state.tickets.map((ticket) => ticket.userRef),
      ...state.revocations.map((entry) => entry.userRef),
      ...Object.keys(state.activeTokenHashByUserRef),
      ...Object.keys(state.rateBucketsByUserRef),
    ]);
    for (const userRef of Object.keys(state.generationsByUserRef)) {
      if (!retainedPrincipals.has(userRef)) {
        delete state.generationsByUserRef[userRef];
        changed = true;
      }
    }
    for (const userRef of Object.keys(state.revokedGenerationByUserRef)) {
      if (!retainedPrincipals.has(userRef)) {
        delete state.revokedGenerationByUserRef[userRef];
        changed = true;
      }
    }

    for (const [userRef, bucket] of Object.entries(state.rateBucketsByUserRef)) {
      const lastActivity = Math.max(
        bucket.lastFailureAt,
        bucket.offerWindowStartedAt ?? 0,
        bucket.startWindowStartedAt ?? 0,
        bucket.codeResendWindowStartedAt ?? 0,
        bucket.lastRotationAt ?? 0,
        bucket.lastCodeResendAt ?? 0
      );
      if (bucket.lockedUntil <= now && lastActivity > 0 && now - lastActivity > 24 * 60 * 60_000) {
        delete state.rateBucketsByUserRef[userRef];
        changed = true;
      }
    }

    if (changed) this.deps.stateStore.write(state);
    return state;
  }

  private invalidLink(): never {
    throw new WhatsAppOnboardingError(
      "invalid_or_expired_link",
      404,
      "Ce lien est invalide ou a expiré. Redemande un lien dans WhatsApp."
    );
  }

  private requireTicketByHash(tokenHash: string): {
    state: WhatsAppOnboardingState;
    ticket: WhatsAppOnboardingStoredTicket;
  } {
    const state = this.readState();
    const ticket = state.tickets.find((candidate) => candidate.tokenHash === tokenHash);
    if (
      !ticket ||
      ticket.expiresAt <= this.deps.now() ||
      state.activeTokenHashByUserRef[ticket.userRef] !== tokenHash ||
      ticket.generation <= (state.revokedGenerationByUserRef[ticket.userRef] ?? 0)
    ) {
      return this.invalidLink();
    }
    return { state, ticket };
  }

  private requireTicket(token: string): {
    state: WhatsAppOnboardingState;
    ticket: WhatsAppOnboardingStoredTicket;
    tokenHash: string;
  } {
    const normalized = String(token || "");
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(normalized)) return this.invalidLink();
    const tokenHash = hashToken(normalized);
    return { ...this.requireTicketByHash(tokenHash), tokenHash };
  }

  private assertNotLocked(state: WhatsAppOnboardingState, userRef: string): void {
    const bucket = state.rateBucketsByUserRef[userRef];
    const now = this.deps.now();
    if (!bucket) return;
    if (bucket.lockedUntil > 0 && bucket.lockedUntil <= now) {
      bucket.failures = 0;
      bucket.lockedUntil = 0;
      bucket.lastFailureAt = now;
      this.deps.stateStore.write(state);
      return;
    }
    if (bucket.lockedUntil <= now) return;
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000));
    throw new WhatsAppOnboardingError(
      "too_many_attempts",
      429,
      "Trop de tentatives. Réessaie plus tard depuis WhatsApp.",
      retryAfterSeconds
    );
  }

  private statusFor(ticket: WhatsAppOnboardingStoredTicket): WhatsAppOnboardingStatus {
    if (!ticket.mode) {
      throw new WhatsAppOnboardingError(
        "invalid_stage",
        409,
        "Le parcours d’inscription n’est pas initialisé."
      );
    }
    return {
      ok: true,
      mode: ticket.mode,
      stage: publicStage(ticket.stage),
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      ...(ticket.mode === "existing_account" && !ticket.expectedLogin
        ? { requiresEmail: true as const }
        : {}),
    };
  }

  private onboardingUrl(token: string): string {
    let url: URL;
    try {
      url = new URL(env.whatsappOnboardingUrl);
    } catch {
      throw new WhatsAppOnboardingError(
        "onboarding_unavailable",
        503,
        "La création de compte est temporairement indisponible."
      );
    }
    url.hash = `token=${encodeURIComponent(token)}`;
    return url.toString();
  }

  private async runExclusive<T>(tokenHash: string, operation: () => Promise<T>): Promise<T> {
    this.requireTicketByHash(tokenHash);
    if (this.busyTokenHashes.has(tokenHash)) {
      throw new WhatsAppOnboardingError(
        "request_in_progress",
        409,
        "Une demande est déjà en cours. Attends quelques secondes avant de réessayer."
      );
    }
    this.busyTokenHashes.add(tokenHash);
    try {
      return await operation();
    } finally {
      this.busyTokenHashes.delete(tokenHash);
    }
  }

  private revokeByHash(
    tokenHash: string,
    reason: WhatsAppOnboardingState["revocations"][number]["reason"]
  ): void {
    const state = this.readState();
    const ticket = state.tickets.find((candidate) => candidate.tokenHash === tokenHash);
    if (!ticket) return;
    this.revokeTicketInState(state, ticket, reason);
    this.deps.stateStore.write(state);
  }

  private identityMismatch(tokenHash: string, message: string): never {
    this.revokeByHash(tokenHash, "identity_mismatch");
    throw new WhatsAppOnboardingError("identity_mismatch", 409, message);
  }

  private failAttempt(tokenHash: string, code: string, message: string): never {
    const { state, ticket } = this.requireTicketByHash(tokenHash);
    const bucket = state.rateBucketsByUserRef[ticket.userRef] ?? emptyRateBucket();
    bucket.failures += 1;
    bucket.lastFailureAt = this.deps.now();
    state.rateBucketsByUserRef[ticket.userRef] = bucket;
    if (bucket.failures >= maxAttempts()) {
      bucket.lockedUntil = this.deps.now() + lockDurationMs();
      const recoverableNewAccount =
        ticket.mode === "new_account" &&
        (ticket.stage === "account_pending" || ticket.stage === "account_validated");
      if (recoverableNewAccount) {
        ticket.expiresAt = Math.max(
          ticket.expiresAt,
          bucket.lockedUntil + onboardingTtlMinutes() * 60_000
        );
      } else {
        this.revokeTicketInState(state, ticket, "locked");
      }
      this.deps.stateStore.write(state);
      throw new WhatsAppOnboardingError(
        "too_many_attempts",
        429,
        recoverableNewAccount
          ? "Trop de tentatives. Attends le délai indiqué avant de reprendre cette inscription."
          : "Trop de tentatives. Redemande un nouveau lien dans WhatsApp.",
        Math.ceil(lockDurationMs() / 1000)
      );
    }
    this.deps.stateStore.write(state);
    throw new WhatsAppOnboardingError(code, 400, message);
  }

  private clearCredentialFailures(userRef: string): void {
    const state = this.readState();
    const bucket = state.rateBucketsByUserRef[userRef];
    if (!bucket) return;
    bucket.failures = 0;
    bucket.lockedUntil = 0;
    bucket.lastFailureAt = this.deps.now();
    this.deps.stateStore.write(state);
  }

  private consumeStartAttempt(tokenHash: string): void {
    const { state, ticket } = this.requireTicketByHash(tokenHash);
    const bucket = state.rateBucketsByUserRef[ticket.userRef] ?? emptyRateBucket();
    const now = this.deps.now();
    if (!bucket.startWindowStartedAt || now - bucket.startWindowStartedAt >= START_WINDOW_MS) {
      bucket.startWindowStartedAt = now;
      bucket.starts = 0;
    }
    if ((bucket.starts ?? 0) >= MAX_STARTS_PER_WINDOW) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.startWindowStartedAt + START_WINDOW_MS - now) / 1000)
      );
      throw new WhatsAppOnboardingError(
        "too_many_requests",
        429,
        "Trop de demandes d’inscription. Réessaie dans quelques minutes.",
        retryAfterSeconds
      );
    }
    bucket.starts = (bucket.starts ?? 0) + 1;
    state.rateBucketsByUserRef[ticket.userRef] = bucket;
    this.deps.stateStore.write(state);
  }

  private consumeCodeResend(tokenHash: string): void {
    const { state, ticket } = this.requireTicketByHash(tokenHash);
    const bucket = state.rateBucketsByUserRef[ticket.userRef] ?? emptyRateBucket();
    const now = this.deps.now();
    if (bucket.lastCodeResendAt && now - bucket.lastCodeResendAt < RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.lastCodeResendAt + RESEND_COOLDOWN_MS - now) / 1000)
      );
      throw new WhatsAppOnboardingError(
        "resend_cooldown",
        429,
        "Un code vient déjà d’être envoyé. Attends un instant avant de recommencer.",
        retryAfterSeconds
      );
    }
    if (
      !bucket.codeResendWindowStartedAt ||
      now - bucket.codeResendWindowStartedAt >= RESEND_WINDOW_MS
    ) {
      bucket.codeResendWindowStartedAt = now;
      bucket.codeResends = 0;
    }
    if ((bucket.codeResends ?? 0) >= MAX_RESENDS_PER_WINDOW) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.codeResendWindowStartedAt + RESEND_WINDOW_MS - now) / 1000)
      );
      throw new WhatsAppOnboardingError(
        "too_many_requests",
        429,
        "Trop de codes ont été demandés. Réessaie plus tard.",
        retryAfterSeconds
      );
    }
    bucket.codeResends = (bucket.codeResends ?? 0) + 1;
    bucket.lastCodeResendAt = now;
    state.rateBucketsByUserRef[ticket.userRef] = bucket;
    this.deps.stateStore.write(state);
  }

  issueOffer(input: {
    userRef: string;
    phone: string;
    rotate?: boolean;
  }): WhatsAppOnboardingOffer {
    const phone = normalizeMetaWhatsAppPhone(input.phone);
    if (!phone || input.userRef !== `wa:${phone}`) {
      throw new WhatsAppOnboardingError(
        "invalid_principal",
        400,
        "Impossible de lier ce numéro WhatsApp."
      );
    }

    const state = this.readState();
    this.assertNotLocked(state, input.userRef);
    const activeHash = state.activeTokenHashByUserRef[input.userRef];
    const active = activeHash
      ? state.tickets.find((ticket) => ticket.tokenHash === activeHash)
      : undefined;
    if (active && !input.rotate) {
      return {
        kind: "active",
        expiresInMinutes: Math.max(1, Math.ceil((active.expiresAt - this.deps.now()) / 60_000)),
      };
    }
    if (active && input.rotate && this.busyTokenHashes.has(active.tokenHash)) {
      return {
        kind: "active",
        expiresInMinutes: Math.max(1, Math.ceil((active.expiresAt - this.deps.now()) / 60_000)),
      };
    }

    const now = this.deps.now();
    const bucket = state.rateBucketsByUserRef[input.userRef] ?? emptyRateBucket();
    if (!bucket.offerWindowStartedAt || now - bucket.offerWindowStartedAt >= OFFER_WINDOW_MS) {
      bucket.offerWindowStartedAt = now;
      bucket.offers = 0;
    }
    if (input.rotate && bucket.lastRotationAt && now - bucket.lastRotationAt < ROTATION_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.lastRotationAt + ROTATION_COOLDOWN_MS - now) / 1000)
      );
      throw new WhatsAppOnboardingError(
        "rotation_cooldown",
        429,
        "Un lien est déjà actif. Attends un instant avant d’en demander un nouveau.",
        retryAfterSeconds
      );
    }
    if ((bucket.offers ?? 0) >= MAX_OFFERS_PER_WINDOW) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.offerWindowStartedAt + OFFER_WINDOW_MS - now) / 1000)
      );
      throw new WhatsAppOnboardingError(
        "too_many_requests",
        429,
        "Trop de liens ont été demandés. Réessaie plus tard.",
        retryAfterSeconds
      );
    }

    const resumedNewAccount =
      active?.mode === "new_account" &&
      (active.stage === "account_pending" || active.stage === "account_validated")
        ? active
        : undefined;
    if (active) this.revokeTicketInState(state, active, "replaced");
    bucket.offers = (bucket.offers ?? 0) + 1;
    if (input.rotate) bucket.lastRotationAt = now;
    state.rateBucketsByUserRef[input.userRef] = bucket;

    const token = this.deps.randomToken();
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw new Error("The onboarding token generator returned an invalid token");
    }
    const tokenHash = hashToken(token);
    const generation = (state.generationsByUserRef[input.userRef] ?? 0) + 1;
    const ttl = onboardingTtlMinutes();
    const ticket: WhatsAppOnboardingStoredTicket = {
      tokenHash,
      userRef: input.userRef,
      canonicalPhone: phone,
      createdAt: now,
      expiresAt: now + ttl * 60_000,
      generation,
      stage: resumedNewAccount?.stage ?? "offered",
      ...(resumedNewAccount
        ? {
            mode: resumedNewAccount.mode,
            expectedUserId: resumedNewAccount.expectedUserId,
            expectedLogin: resumedNewAccount.expectedLogin,
            pendingAccount: resumedNewAccount.pendingAccount,
            consent: resumedNewAccount.consent,
          }
        : {}),
    };
    state.tickets.push(ticket);
    state.activeTokenHashByUserRef[input.userRef] = tokenHash;
    state.generationsByUserRef[input.userRef] = generation;
    this.deps.stateStore.write(state);
    return { kind: "issued", url: this.onboardingUrl(token), expiresInMinutes: ttl };
  }

  revokeForUserRef(userRef: string, reason: "logout" | "completed" = "logout"): void {
    const state = this.readState();
    const activeHash = state.activeTokenHashByUserRef[userRef];
    const active = activeHash
      ? state.tickets.find((ticket) => ticket.tokenHash === activeHash)
      : undefined;
    if (active) {
      this.revokeTicketInState(state, active, reason);
      this.deps.stateStore.write(state);
    }
  }

  async status(token: string): Promise<WhatsAppOnboardingStatus> {
    const { state, ticket, tokenHash } = this.requireTicket(token);
    this.assertNotLocked(state, ticket.userRef);
    if (ticket.mode === "existing_account") {
      // Tickets issued by an older deployment may have selected this mode
      // from a standalone User phone match. Re-evaluate every persisted ticket
      // against the complete Customer identity before keeping password login.
      let liveLookup: WhatsAppCustomerLookupResult;
      try {
        liveLookup = await this.deps.lookupCustomer(ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification du compte est temporairement indisponible."
        );
      }
      const current = this.requireTicketByHash(tokenHash);
      if (!liveLookup.ok) {
        if (canCreateAccountForLookup(liveLookup)) {
          current.ticket.mode = "new_account";
          delete current.ticket.expectedUserId;
          delete current.ticket.expectedLogin;
          this.deps.stateStore.write(current.state);
          return this.statusFor(current.ticket);
        }
        if (liveLookup.reason === "config") {
          throw new WhatsAppOnboardingError(
            "temporarily_unavailable",
            503,
            "La vérification du compte est temporairement indisponible."
          );
        }
        throw new WhatsAppOnboardingError(
          "account_ambiguous",
          409,
          "Ce numéro correspond à plusieurs fiches utilisables. Contacte l’équipe Zélo."
        );
      }
      if (
        current.ticket.expectedUserId &&
        current.ticket.expectedUserId !== liveLookup.identity.userId
      ) {
        throw new WhatsAppOnboardingError(
          "account_ambiguous",
          409,
          "Ce numéro ne correspond plus au compte initialement retrouvé. Contacte l’équipe Zélo."
        );
      }
      current.ticket.expectedUserId = liveLookup.identity.userId;
      current.ticket.expectedLogin = liveLookup.identity.email;
      this.deps.stateStore.write(current.state);
      return this.statusFor(current.ticket);
    }
    if (ticket.mode) {
      return this.statusFor(ticket);
    }

    let mode: WhatsAppOnboardingMode;
    let expectedUserId: string | undefined;
    let expectedLogin: string | undefined;
    let customerLookup: WhatsAppCustomerLookupResult;
    try {
      customerLookup = await this.deps.lookupCustomer(ticket.canonicalPhone);
    } catch {
      throw new WhatsAppOnboardingError(
        "temporarily_unavailable",
        503,
        "La vérification du compte est temporairement indisponible."
      );
    }

    if (!customerLookup.ok && !canCreateAccountForLookup(customerLookup)) {
      if (customerLookup.reason === "config") {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification du compte est temporairement indisponible."
        );
      }
      throw new WhatsAppOnboardingError(
        "account_ambiguous",
        409,
        "Ce numéro correspond à plusieurs fiches utilisables. Contacte l’équipe Zélo."
      );
    }

    if (customerLookup.ok) {
      mode = "existing_account";
      expectedUserId = customerLookup.identity.userId;
      expectedLogin = customerLookup.identity.email;
    } else {
      // A User found only by its phone is not sufficient proof that a usable
      // Zélo customer account exists. This notably covers old records without
      // an email address: they remain untouched while the caller is allowed to
      // create a fresh, complete account.
      mode = "new_account";
    }

    const current = this.requireTicketByHash(tokenHash);
    current.ticket.mode = mode;
    if (expectedUserId) current.ticket.expectedUserId = expectedUserId;
    if (expectedLogin) current.ticket.expectedLogin = expectedLogin;
    this.deps.stateStore.write(current.state);
    return this.statusFor(current.ticket);
  }

  async regions(token: string): Promise<WhatsAppOnboardingRegions> {
    const status = await this.status(token);
    if (status.mode !== "new_account") {
      throw new WhatsAppOnboardingError(
        "account_already_exists",
        409,
        "Un compte existe déjà pour ce numéro."
      );
    }
    let regions: SwissdataOnboardingRegion[];
    try {
      regions = await this.deps.listRegions();
    } catch {
      throw new WhatsAppOnboardingError(
        "temporarily_unavailable",
        503,
        "Les régions de livraison sont temporairement indisponibles."
      );
    }
    this.requireTicket(token);
    const unique = new Map(
      regions
        .filter((region) => Boolean(region.id && region.name))
        .map((region) => [region.id, { id: region.id, name: region.name }])
    );
    if (unique.size === 0) {
      throw new WhatsAppOnboardingError(
        "temporarily_unavailable",
        503,
        "Aucune région Zélo n’est disponible actuellement."
      );
    }
    return { ok: true, regions: [...unique.values()] };
  }

  async start(input: {
    token: string;
    firstname: string;
    lastname: string;
    email: string;
    address: WhatsAppOnboardingPendingAccount["address"];
    regionId: string;
    password: string;
    termsAccepted: boolean;
  }): Promise<WhatsAppOnboardingStatus> {
    const { tokenHash } = this.requireTicket(input.token);
    return await this.runExclusive(tokenHash, async () => {
      const status = await this.status(input.token);
      const currentAtStart = this.requireTicketByHash(tokenHash);
      if (status.mode !== "new_account") {
        throw new WhatsAppOnboardingError(
          "account_already_exists",
          409,
          "Un compte existe déjà pour ce numéro. Retourne dans WhatsApp pour recevoir le code de connexion."
        );
      }
      if (currentAtStart.ticket.stage !== "offered") return this.statusFor(currentAtStart.ticket);

      const firstname = normalizeName(input.firstname);
      const lastname = normalizeName(input.lastname);
      const email = normalizeEmail(input.email);
      const address = normalizeAddress(input.address);
      const regionId = String(input.regionId || "").trim();
      validateName(firstname, "Le prénom");
      validateName(lastname, "Le nom");
      validateEmail(email);
      validateAddress(address);
      const password = normalizeNewPassword(input.password);
      if (input.termsAccepted !== true) {
        throw new WhatsAppOnboardingError(
          "terms_required",
          400,
          "Tu dois accepter les conditions pour créer le compte."
        );
      }

      let regions: SwissdataOnboardingRegion[];
      try {
        regions = await this.deps.listRegions();
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "Les régions de livraison sont temporairement indisponibles."
        );
      }
      if (!regionId || !regions.some((region) => region.id === regionId)) {
        throw new WhatsAppOnboardingError(
          "invalid_region",
          400,
          "Choisis une région Zélo valide."
        );
      }

      this.consumeStartAttempt(tokenHash);

      let phoneLookup: WhatsAppCustomerLookupResult;
      try {
        phoneLookup = await this.deps.lookupCustomer(currentAtStart.ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification du compte est temporairement indisponible."
        );
      }
      if (phoneLookup.ok) {
        throw new WhatsAppOnboardingError(
          "account_already_exists",
          409,
          "Un compte vient d’être retrouvé pour ce numéro. Retourne dans WhatsApp pour te connecter."
        );
      }
      if (!canCreateAccountForLookup(phoneLookup)) {
        if (phoneLookup.reason === "config") {
          throw new WhatsAppOnboardingError(
            "temporarily_unavailable",
            503,
            "La vérification du compte est temporairement indisponible."
          );
        }
        throw new WhatsAppOnboardingError(
          "account_ambiguous",
          409,
          "Ce numéro correspond à une fiche ambiguë. Contacte l’équipe Zélo."
        );
      }

      try {
        if (await this.deps.accountExists("email", email)) {
          throw new WhatsAppOnboardingError(
            "email_already_exists",
            409,
            "Cette adresse email est déjà utilisée. Connecte-toi à ton compte Zélo existant ou utilise une autre adresse."
          );
        }
      } catch (error) {
        if (error instanceof WhatsAppOnboardingError) throw error;
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification de l’adresse email est temporairement indisponible."
        );
      }
      this.requireTicketByHash(tokenHash);

      const acceptedAt = new Date(this.deps.now()).toISOString();
      const consentId = createHash("sha256")
        .update(`${currentAtStart.ticket.userRef}\0${acceptedAt}\0${TERMS_VERSION}`)
        .digest("hex");
      const pending: WhatsAppOnboardingPendingAccount = {
        firstname,
        lastname,
        email,
        address,
        regionId,
      };
      const beforeCreate = this.requireTicketByHash(tokenHash);
      beforeCreate.ticket.consent = {
        id: consentId,
        acceptedAt,
        termsVersion: TERMS_VERSION,
        termsUrl: TERMS_URL,
      };
      beforeCreate.ticket.pendingAccount = this.deps.stateStore.sealPendingAccount(pending);
      beforeCreate.ticket.expiresAt = Math.max(
        beforeCreate.ticket.expiresAt,
        this.deps.now() + onboardingTtlMinutes() * 60_000
      );
      this.deps.stateStore.write(beforeCreate.state);

      let validationToken: string;
      try {
        const creation = await this.deps.createAccount({
          firstname,
          lastname,
          email,
          password,
          clientUrl: env.whatsappOnboardingUrl,
        });
        validationToken = creation.token;
      } catch (error) {
        if (error instanceof SwissdataOnboardingGatewayError && error.kind === "conflict") {
          throw new WhatsAppOnboardingError(
            "account_already_exists",
            409,
            "Un compte utilise déjà ces coordonnées. Connecte-toi au compte existant."
          );
        }
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La création du compte est temporairement indisponible. Réessaie plus tard."
        );
      }

      const afterCreate = this.requireTicketByHash(tokenHash);
      const persistedPending = this.deps.stateStore.openPendingAccount(
        afterCreate.ticket.pendingAccount!
      );
      persistedPending.swissdataValidationToken = validationToken;
      afterCreate.ticket.pendingAccount = this.deps.stateStore.sealPendingAccount(persistedPending);
      afterCreate.ticket.stage = "account_pending";
      this.deps.stateStore.write(afterCreate.state);
      return this.statusFor(afterCreate.ticket);
    });
  }

  async resend(token: string): Promise<WhatsAppOnboardingStatus> {
    const { tokenHash } = this.requireTicket(token);
    return await this.runExclusive(tokenHash, async () => {
      const status = await this.status(token);
      const { ticket } = this.requireTicketByHash(tokenHash);
      if (status.mode !== "new_account" || ticket.stage !== "account_pending" || !ticket.pendingAccount) {
        throw new WhatsAppOnboardingError(
          "invalid_stage",
          409,
          "Aucun code ne peut être renvoyé pour cette demande."
        );
      }
      const pending = this.deps.stateStore.openPendingAccount(ticket.pendingAccount);
      if (!pending.swissdataValidationToken) {
        throw new WhatsAppOnboardingError(
          "invalid_stage",
          409,
          "La demande de validation n’est plus disponible."
        );
      }
      this.consumeCodeResend(tokenHash);
      try {
        await this.deps.resendEmailCode({ token: pending.swissdataValidationToken });
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "Le code n’a pas pu être renvoyé. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      return this.statusFor(this.requireTicketByHash(tokenHash).ticket);
    });
  }

  async complete(input: {
    token: string;
    emailCode: string;
    password: string;
  }): Promise<WhatsAppOnboardingStatus> {
    const { tokenHash } = this.requireTicket(input.token);
    return await this.runExclusive(tokenHash, async () => {
      const status = await this.status(input.token);
      let { ticket } = this.requireTicketByHash(tokenHash);
      if (status.mode !== "new_account" || ticket.stage === "offered" || !ticket.pendingAccount) {
        throw new WhatsAppOnboardingError(
          "invalid_stage",
          409,
          "Commence d’abord la création du compte."
        );
      }
      const password = normalizeNewPassword(input.password);
      let pending = this.deps.stateStore.openPendingAccount(ticket.pendingAccount);

      if (ticket.stage === "account_pending") {
        const emailCode = validateEmailCode(input.emailCode);
        if (!pending.swissdataValidationToken) {
          throw new WhatsAppOnboardingError(
            "invalid_stage",
            409,
            "La demande de création n’est plus disponible."
          );
        }
        const beforeValidation = this.requireTicketByHash(tokenHash);
        beforeValidation.ticket.expiresAt = Math.max(
          beforeValidation.ticket.expiresAt,
          this.deps.now() + onboardingTtlMinutes() * 60_000
        );
        this.deps.stateStore.write(beforeValidation.state);
        let validatedUser: SwissdataOnboardingUser;
        try {
          validatedUser = await this.deps.validateAccount({
            token: pending.swissdataValidationToken,
            emailCode,
          });
        } catch (error) {
          if (error instanceof SwissdataOnboardingGatewayError && error.kind === "invalid_code") {
            return this.failAttempt(
              tokenHash,
              "invalid_code",
              "Le code email est incorrect ou a expiré."
            );
          }
          throw new WhatsAppOnboardingError(
            "temporarily_unavailable",
            503,
            "La validation est temporairement indisponible. Réessaie plus tard."
          );
        }
        if (!validatedUser.id || normalizeEmail(validatedUser.email) !== pending.email) {
          return this.identityMismatch(
            tokenHash,
            "Le compte créé ne correspond pas à cette demande WhatsApp."
          );
        }
        const afterValidation = this.requireTicketByHash(tokenHash);
        pending.swissdataValidationToken = undefined;
        afterValidation.ticket.pendingAccount = this.deps.stateStore.sealPendingAccount(pending);
        afterValidation.ticket.expectedUserId = validatedUser.id;
        afterValidation.ticket.stage = "account_validated";
        afterValidation.ticket.expiresAt = Math.max(
          afterValidation.ticket.expiresAt,
          this.deps.now() + onboardingTtlMinutes() * 60_000
        );
        this.deps.stateStore.write(afterValidation.state);
        ticket = afterValidation.ticket;
      }

      if (!ticket.expectedUserId || !ticket.consent) {
        return this.identityMismatch(
          tokenHash,
          "La preuve d’identité ou de consentement est incomplète."
        );
      }

      let accessToken: string;
      try {
        accessToken = await this.deps.authenticateAccount(pending.email, password);
      } catch (error) {
        if (error instanceof SwissdataOnboardingGatewayError && error.kind === "credentials") {
          return this.failAttempt(
            tokenHash,
            "completion_failed",
            "Le mot de passe ne correspond pas."
          );
        }
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La connexion est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);

      let user: SwissdataOnboardingUser;
      try {
        user = await this.deps.currentUser(accessToken);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification du compte est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (user.id !== ticket.expectedUserId || normalizeEmail(user.email) !== pending.email) {
        return this.identityMismatch(
          tokenHash,
          "Le compte authentifié ne correspond pas à cette demande WhatsApp."
        );
      }

      let customer: SwissdataOnboardingCustomer;
      try {
        customer = await this.deps.ensureCustomer(accessToken);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La création du profil client est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (
        customer.userId !== user.id
      ) {
        return this.identityMismatch(
          tokenHash,
          "Le compte authentifié ne correspond pas à cette demande WhatsApp."
        );
      }

      let preBind: WhatsAppCustomerLookupResult;
      try {
        preBind = await this.deps.lookupCustomer(ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La liaison WhatsApp est temporairement indisponible."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (!preBind.ok && preBind.reason === "config") {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La liaison WhatsApp est temporairement indisponible."
        );
      }
      if (
        (!preBind.ok && !canCreateAccountForLookup(preBind)) ||
        (preBind.ok &&
          (preBind.identity.customerId !== customer.id || preBind.identity.userId !== user.id))
      ) {
        return this.identityMismatch(
          tokenHash,
          "Ce numéro WhatsApp est déjà lié à une autre fiche client."
        );
      }

      let updatedCustomer: SwissdataOnboardingCustomer;
      try {
        updatedCustomer = await this.deps.recordOnboarding({
          accessToken,
          customer,
          phone: ticket.canonicalPhone,
          firstname: pending.firstname,
          lastname: pending.lastname,
          email: pending.email,
          address: pending.address,
          regionId: pending.regionId,
          consentId: ticket.consent.id,
          acceptedAt: ticket.consent.acceptedAt,
          termsVersion: ticket.consent.termsVersion,
          termsUrl: ticket.consent.termsUrl,
        });
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La finalisation du compte est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (
        updatedCustomer.id !== customer.id ||
        updatedCustomer.userId !== user.id ||
        updatedCustomer.firstname !== pending.firstname ||
        updatedCustomer.lastname !== pending.lastname ||
        normalizeEmail(updatedCustomer.email) !== pending.email ||
        !this.deps.phonesMatch(updatedCustomer.mobile, ticket.canonicalPhone) ||
        updatedCustomer.region !== pending.regionId ||
        !updatedCustomer.addresses.some((address) => sameAddress(address, pending.address)) ||
        !hasConsentEvent(updatedCustomer, ticket.consent)
      ) {
        return this.identityMismatch(
          tokenHash,
          "Swissdata n’a pas confirmé correctement la fiche client créée."
        );
      }

      let postBind: WhatsAppCustomerLookupResult;
      try {
        postBind = await this.deps.lookupCustomer(ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification finale est temporairement indisponible."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (!postBind.ok && postBind.reason === "config") {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification finale est temporairement indisponible."
        );
      }
      if (
        !postBind.ok ||
        postBind.identity.customerId !== updatedCustomer.id ||
        postBind.identity.userId !== user.id
      ) {
        return this.identityMismatch(
          tokenHash,
          "La liaison du numéro WhatsApp n’est pas unique. Contacte l’équipe Zélo."
        );
      }

      const finalTicket = this.requireTicketByHash(tokenHash).ticket;
      const completed: WhatsAppOnboardingStatus = {
        ok: true,
        mode: "new_account",
        stage: "completed",
        expiresAt: new Date(finalTicket.expiresAt).toISOString(),
      };
      this.clearCredentialFailures(finalTicket.userRef);
      this.revokeByHash(tokenHash, "completed");
      this.deps.setCustomerSession({
        userRef: finalTicket.userRef,
        phone: finalTicket.canonicalPhone,
        customerId: updatedCustomer.id,
        userId: user.id,
        email: user.email,
      });
      void this.notifyConnected({
        phone: finalTicket.canonicalPhone,
        created: true,
        userRef: finalTicket.userRef,
        regionId: pending.regionId,
      }).catch(() => undefined);
      return completed;
    });
  }

  async connect(input: {
    token: string;
    email?: string;
    password: string;
  }): Promise<WhatsAppOnboardingStatus> {
    const { tokenHash } = this.requireTicket(input.token);
    return await this.runExclusive(tokenHash, async () => {
      const status = await this.status(input.token);
      const { ticket } = this.requireTicketByHash(tokenHash);
      if (status.mode !== "existing_account" || !ticket.expectedUserId) {
        throw new WhatsAppOnboardingError(
          "account_not_found",
          409,
          "Aucun compte existant ne correspond à ce numéro."
        );
      }
      validateExistingPassword(input.password);

      let login = ticket.expectedLogin;
      const requiresEmail = !login;
      if (!login) {
        const email = normalizeEmail(input.email ?? "");
        validateEmail(email);
        let emailResolution: SwissdataAccountIdResolution;
        try {
          emailResolution = await this.deps.resolveAccountForEmail(email);
        } catch {
          throw new WhatsAppOnboardingError(
            "temporarily_unavailable",
            503,
            "La vérification de l’adresse électronique est temporairement indisponible."
          );
        }
        this.requireTicketByHash(tokenHash);
        if (
          emailResolution.kind !== "unique" ||
          emailResolution.userId !== ticket.expectedUserId
        ) {
          return this.failAttempt(
            tokenHash,
            "login_failed",
            "Adresse électronique ou mot de passe incorrect."
          );
        }
        login = email;
      }

      let accessToken: string;
      try {
        accessToken = await this.deps.authenticateAccount(login, input.password);
      } catch (error) {
        if (error instanceof SwissdataOnboardingGatewayError && error.kind === "credentials") {
          return this.failAttempt(
            tokenHash,
            "login_failed",
            requiresEmail
              ? "Adresse électronique ou mot de passe incorrect."
              : "Mot de passe incorrect."
          );
        }
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La connexion est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);

      let user: SwissdataOnboardingUser;
      try {
        user = await this.deps.currentUser(accessToken);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification du compte est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (
        user.id !== ticket.expectedUserId ||
        !user.email.includes("@")
      ) {
        return this.identityMismatch(
          tokenHash,
          "Le compte authentifié ne correspond pas à ce numéro WhatsApp."
        );
      }

      let customer: SwissdataOnboardingCustomer;
      try {
        customer = await this.deps.ensureCustomer(accessToken);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "Le profil client est temporairement indisponible. Réessaie plus tard."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (customer.userId !== user.id) {
        return this.identityMismatch(
          tokenHash,
          "Le profil client ne correspond pas au compte authentifié."
        );
      }

      let preBind: WhatsAppCustomerLookupResult;
      try {
        preBind = await this.deps.lookupCustomer(ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La liaison WhatsApp est temporairement indisponible."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (
        (!preBind.ok && preBind.reason !== "not_found") ||
        (preBind.ok &&
          (preBind.identity.customerId !== customer.id || preBind.identity.userId !== user.id))
      ) {
        return this.identityMismatch(
          tokenHash,
          "Ce numéro WhatsApp est déjà lié à une autre fiche client."
        );
      }

      if (customer.mobile && !this.deps.phonesMatch(customer.mobile, ticket.canonicalPhone)) {
        return this.identityMismatch(
          tokenHash,
          "Le profil client possède déjà un autre numéro. Contacte l’équipe Zélo."
        );
      }

      if (!this.deps.phonesMatch(customer.mobile, ticket.canonicalPhone)) {
        try {
          customer = await this.deps.bindCustomerPhone({
            accessToken,
            phone: ticket.canonicalPhone,
          });
        } catch {
          throw new WhatsAppOnboardingError(
            "temporarily_unavailable",
            503,
            "La liaison WhatsApp est temporairement indisponible. Réessaie plus tard."
          );
        }
        this.requireTicketByHash(tokenHash);
        if (
          customer.userId !== user.id ||
          !this.deps.phonesMatch(customer.mobile, ticket.canonicalPhone)
        ) {
          return this.identityMismatch(
            tokenHash,
            "Swissdata n’a pas confirmé la liaison du numéro WhatsApp."
          );
        }
      }

      let lookup: WhatsAppCustomerLookupResult;
      try {
        lookup = await this.deps.lookupCustomer(ticket.canonicalPhone);
      } catch {
        throw new WhatsAppOnboardingError(
          "temporarily_unavailable",
          503,
          "La vérification finale est temporairement indisponible."
        );
      }
      this.requireTicketByHash(tokenHash);
      if (
        !lookup.ok ||
        lookup.identity.customerId !== customer.id ||
        lookup.identity.userId !== user.id
      ) {
        return this.identityMismatch(
          tokenHash,
          "Le numéro WhatsApp ne correspond pas de manière unique à cette fiche client."
        );
      }

      const finalTicket = this.requireTicketByHash(tokenHash).ticket;
      const completed: WhatsAppOnboardingStatus = {
        ok: true,
        mode: "existing_account",
        stage: "completed",
        expiresAt: new Date(finalTicket.expiresAt).toISOString(),
      };
      this.clearCredentialFailures(finalTicket.userRef);
      this.revokeByHash(tokenHash, "completed");
      this.deps.setCustomerSession({
        userRef: finalTicket.userRef,
        phone: finalTicket.canonicalPhone,
        customerId: customer.id,
        userId: user.id,
        email: user.email,
      });
      void this.notifyConnected({
        phone: finalTicket.canonicalPhone,
        created: false,
      }).catch(() => undefined);
      return completed;
    });
  }

  private async notifyConnected(input: {
    phone: string;
    created: boolean;
    userRef?: string;
    regionId?: string;
  }): Promise<void> {
    if (input.created && input.userRef && input.regionId) {
      await this.deps.sendNewCustomerDiscoveryWelcome({
        userRef: input.userRef,
        phone: input.phone,
        regionId: input.regionId,
      }).catch(() => {
        // The HTTPS page already confirms success; a Meta delivery failure must not roll it back.
      });
      return;
    }

    const message = [
      "✅ *Compte Zélo connecté*",
      "",
      "Tu peux revenir ici et utiliser l’assistant normalement.",
    ].join("\n");
    await this.deps.sendText({ to: input.phone, body: message, previewUrl: false }).catch(() => {
      // The HTTPS page already confirms success; a Meta delivery failure must not roll it back.
    });
  }
}

export const whatsappOnboardingService = new WhatsAppOnboardingService();

export function buildWhatsAppOnboardingOfferMessage(offer: WhatsAppOnboardingOffer): string {
  if (offer.kind === "active") {
    return [
      "*Création de ton compte Zélo*",
      "",
      "Un lien sécurisé est déjà actif pour ce numéro.",
      "Utilise le lien envoyé plus haut dans cette conversation.",
      "",
      `Il reste valide environ ${offer.expiresInMinutes} minute(s).`,
      "Écris « nouveau lien » uniquement si tu souhaites le remplacer.",
    ].join("\n");
  }
  return [
    "*Création de ton compte Zélo*",
    "",
    "Aucun compte Zélo utilisable n’est actuellement lié à ce numéro WhatsApp.",
    "Tu peux créer ton compte de manière sécurisée avec ce lien :",
    offer.url,
    "",
    `Le lien expire dans ${offer.expiresInMinutes} minutes et reste lié à ce numéro WhatsApp.`,
    "Ne m’envoie jamais ton mot de passe dans cette conversation.",
  ].join("\n");
}
