import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import path from "node:path";

/**
 * Persistent, non-secret metadata for a WhatsApp account-onboarding link.
 * The raw link is never stored: callers must use its SHA-256 hash as tokenHash.
 */
export type WhatsAppOnboardingStoredTicket = {
  tokenHash: string;
  userRef: string;
  canonicalPhone: string;
  createdAt: number;
  expiresAt: number;
  /** Monotonic per-principal generation; the service rejects stale links. */
  generation: number;
  stage: "offered" | "account_pending" | "account_validated" | "completed";
  mode?: "new_account" | "existing_account";
  /** Set only after Swissdata has validated the account. */
  expectedUserId?: string;
  /** Trusted exact Swissdata username for legacy formatted mobile values. */
  expectedLogin?: string;
  /** AES-256-GCM protected payload; see sealPendingAccount/openPendingAccount. */
  pendingAccount?: WhatsAppOnboardingEncryptedValue;
  /** Evidence of the explicit acceptance made in the onboarding form. */
  consent?: {
    id: string;
    acceptedAt: string;
    termsVersion: string;
    termsUrl: string;
  };
};

/**
 * Values that are necessary to resume the Swissdata validation after a restart.
 * They are only held in memory while in use and are always encrypted in the file.
 */
export type WhatsAppOnboardingPendingAccount = {
  email: string;
  firstname: string;
  lastname: string;
  address: {
    street: string;
    zip: string;
    city: string;
    country: string;
    description?: string;
    accessInformation?: string;
  };
  regionId: string;
  swissdataValidationToken?: string;
};

export type WhatsAppOnboardingEncryptedValue = {
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type WhatsAppOnboardingRateBucket = {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
  /** Optional independent issuance window for offer/start abuse protection. */
  offers?: number;
  offerWindowStartedAt?: number;
  starts?: number;
  startWindowStartedAt?: number;
  lastRotationAt?: number;
  codeResends?: number;
  codeResendWindowStartedAt?: number;
  lastCodeResendAt?: number;
};

export type WhatsAppOnboardingRevocation = {
  tokenHash: string;
  userRef: string;
  revokedAt: number;
  expiresAt: number;
  reason: "replaced" | "completed" | "locked" | "logout" | "identity_mismatch" | "expired";
};

export type WhatsAppOnboardingState = {
  version: 1;
  tickets: WhatsAppOnboardingStoredTicket[];
  activeTokenHashByUserRef: Record<string, string>;
  generationsByUserRef: Record<string, number>;
  revokedGenerationByUserRef: Record<string, number>;
  rateBucketsByUserRef: Record<string, WhatsAppOnboardingRateBucket>;
  revocations: WhatsAppOnboardingRevocation[];
};

export type WhatsAppOnboardingStateStore = {
  read(): WhatsAppOnboardingState;
  write(next: WhatsAppOnboardingState): void;
  sealPendingAccount(input: WhatsAppOnboardingPendingAccount): WhatsAppOnboardingEncryptedValue;
  openPendingAccount(value: WhatsAppOnboardingEncryptedValue): WhatsAppOnboardingPendingAccount;
};

export class WhatsAppOnboardingStateStoreError extends Error {
  constructor(
    public readonly code: "invalid_key" | "state_corrupt" | "state_insecure" | "decryption_failed" | "persistence_failed",
    message: string
  ) {
    super(message);
    this.name = "WhatsAppOnboardingStateStoreError";
  }
}

const EMPTY_STATE = (): WhatsAppOnboardingState => ({
  version: 1,
  tickets: [],
  activeTokenHashByUserRef: {},
  generationsByUserRef: {},
  revokedGenerationByUserRef: {},
  rateBucketsByUserRef: {},
  revocations: [],
});

const AAD = Buffer.from("zelo-ai:whatsapp-onboarding-state:v1", "utf8");
const MAX_RECORDS = 10_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, max = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid onboarding state field: ${field}`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid onboarding state field: ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, max);
}

function normalizeEncryptedValue(value: unknown, field: string): WhatsAppOnboardingEncryptedValue {
  if (!isPlainObject(value) || value.version !== 1) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid encrypted onboarding value: ${field}`);
  }
  return {
    version: 1,
    iv: requireString(value.iv, `${field}.iv`, 128),
    ciphertext: requireString(value.ciphertext, `${field}.ciphertext`, 8_192),
    authTag: requireString(value.authTag, `${field}.authTag`, 128),
  };
}

function normalizeTicket(value: unknown): WhatsAppOnboardingStoredTicket {
  if (!isPlainObject(value)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding ticket");
  }
  const stage = requireString(value.stage, "ticket.stage", 64);
  if (!(["offered", "account_pending", "account_validated", "completed"] as const).includes(stage as any)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding ticket stage");
  }
  const mode = optionalString(value.mode, "ticket.mode", 64);
  if (mode !== undefined && mode !== "new_account" && mode !== "existing_account") {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding ticket mode");
  }
  const consentValue = value.consent;
  let consent: WhatsAppOnboardingStoredTicket["consent"];
  if (consentValue !== undefined) {
    if (!isPlainObject(consentValue)) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding consent");
    }
    consent = {
      id: requireString(consentValue.id, "ticket.consent.id", 256),
      acceptedAt: requireString(consentValue.acceptedAt, "ticket.consent.acceptedAt", 128),
      termsVersion: requireString(consentValue.termsVersion, "ticket.consent.termsVersion", 256),
      termsUrl: requireString(consentValue.termsUrl, "ticket.consent.termsUrl", 2_048),
    };
  }

  const normalized: WhatsAppOnboardingStoredTicket = {
    tokenHash: requireString(value.tokenHash, "ticket.tokenHash", 128),
    userRef: requireString(value.userRef, "ticket.userRef", 256),
    canonicalPhone: requireString(value.canonicalPhone, "ticket.canonicalPhone", 32),
    createdAt: requireFiniteNumber(value.createdAt, "ticket.createdAt"),
    expiresAt: requireFiniteNumber(value.expiresAt, "ticket.expiresAt"),
    generation: requireFiniteNumber(value.generation, "ticket.generation", 1),
    stage: stage as WhatsAppOnboardingStoredTicket["stage"],
  };
  if (normalized.expiresAt < normalized.createdAt) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding ticket lifetime");
  }
  if (mode) normalized.mode = mode as WhatsAppOnboardingStoredTicket["mode"];
  const expectedUserId = optionalString(value.expectedUserId, "ticket.expectedUserId", 256);
  if (expectedUserId) normalized.expectedUserId = expectedUserId;
  const expectedLogin = optionalString(value.expectedLogin, "ticket.expectedLogin", 256);
  if (expectedLogin) normalized.expectedLogin = expectedLogin;
  if (value.pendingAccount !== undefined) {
    normalized.pendingAccount = normalizeEncryptedValue(value.pendingAccount, "ticket.pendingAccount");
  }
  if (consent) normalized.consent = consent;
  return normalized;
}

function normalizeRateBucket(value: unknown): WhatsAppOnboardingRateBucket {
  if (!isPlainObject(value)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding rate bucket");
  }
  const normalized: WhatsAppOnboardingRateBucket = {
    failures: requireFiniteNumber(value.failures, "rate.failures"),
    lockedUntil: requireFiniteNumber(value.lockedUntil, "rate.lockedUntil"),
    lastFailureAt: requireFiniteNumber(value.lastFailureAt, "rate.lastFailureAt"),
  };
  if (!Number.isInteger(normalized.failures) || normalized.failures > 1_000_000) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding rate failures");
  }
  if (value.offers !== undefined) {
    const offers = requireFiniteNumber(value.offers, "rate.offers");
    if (!Number.isInteger(offers) || offers > 1_000_000) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding offer count");
    }
    normalized.offers = offers;
  }
  if (value.offerWindowStartedAt !== undefined) {
    normalized.offerWindowStartedAt = requireFiniteNumber(
      value.offerWindowStartedAt,
      "rate.offerWindowStartedAt"
    );
  }
  if (value.starts !== undefined) {
    const starts = requireFiniteNumber(value.starts, "rate.starts");
    if (!Number.isInteger(starts) || starts > 1_000_000) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding start count");
    }
    normalized.starts = starts;
  }
  if (value.startWindowStartedAt !== undefined) {
    normalized.startWindowStartedAt = requireFiniteNumber(
      value.startWindowStartedAt,
      "rate.startWindowStartedAt"
    );
  }
  if (value.lastRotationAt !== undefined) {
    normalized.lastRotationAt = requireFiniteNumber(value.lastRotationAt, "rate.lastRotationAt");
  }
  if (value.codeResends !== undefined) {
    const codeResends = requireFiniteNumber(value.codeResends, "rate.codeResends");
    if (!Number.isInteger(codeResends) || codeResends > 1_000_000) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding code resend count");
    }
    normalized.codeResends = codeResends;
  }
  if (value.codeResendWindowStartedAt !== undefined) {
    normalized.codeResendWindowStartedAt = requireFiniteNumber(
      value.codeResendWindowStartedAt,
      "rate.codeResendWindowStartedAt"
    );
  }
  if (value.lastCodeResendAt !== undefined) {
    normalized.lastCodeResendAt = requireFiniteNumber(
      value.lastCodeResendAt,
      "rate.lastCodeResendAt"
    );
  }
  return normalized;
}

function normalizeRevocation(value: unknown): WhatsAppOnboardingRevocation {
  if (!isPlainObject(value)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding revocation");
  }
  const reason = requireString(value.reason, "revocation.reason", 64);
  if (!(["replaced", "completed", "locked", "logout", "identity_mismatch", "expired"] as const).includes(reason as any)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding revocation reason");
  }
  const normalized: WhatsAppOnboardingRevocation = {
    tokenHash: requireString(value.tokenHash, "revocation.tokenHash", 128),
    userRef: requireString(value.userRef, "revocation.userRef", 256),
    revokedAt: requireFiniteNumber(value.revokedAt, "revocation.revokedAt"),
    expiresAt: requireFiniteNumber(value.expiresAt, "revocation.expiresAt"),
    reason: reason as WhatsAppOnboardingRevocation["reason"],
  };
  if (normalized.expiresAt < normalized.revokedAt) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding revocation lifetime");
  }
  return normalized;
}

function normalizeNumberIndex(value: unknown, field: string): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid onboarding ${field} index`);
  }
  const normalized: Record<string, number> = {};
  for (const [userRef, generation] of Object.entries(value)) {
    const parsed = requireFiniteNumber(generation, `${field}.generation`, 0);
    if (!Number.isInteger(parsed)) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid onboarding ${field} generation`);
    }
    normalized[requireString(userRef, `${field}.userRef`, 256)] = parsed;
  }
  return normalized;
}

/** Strictly validates and strips unrecognised properties before any write. */
export function normalizeWhatsAppOnboardingState(value: unknown): WhatsAppOnboardingState {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.tickets) || !Array.isArray(value.revocations)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding state document");
  }
  if (
    !isPlainObject(value.activeTokenHashByUserRef) ||
    !isPlainObject(value.generationsByUserRef) ||
    !isPlainObject(value.revokedGenerationByUserRef) ||
    !isPlainObject(value.rateBucketsByUserRef)
  ) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Invalid onboarding state indexes");
  }
  if (value.tickets.length > MAX_RECORDS || value.revocations.length > MAX_RECORDS) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Onboarding state exceeds its safe size");
  }

  const tickets = value.tickets.map(normalizeTicket);
  const tokenHashes = new Set<string>();
  for (const ticket of tickets) {
    if (tokenHashes.has(ticket.tokenHash)) {
      throw new WhatsAppOnboardingStateStoreError("state_corrupt", "Duplicate onboarding ticket hash");
    }
    tokenHashes.add(ticket.tokenHash);
  }

  const activeTokenHashByUserRef: Record<string, string> = {};
  for (const [userRef, tokenHash] of Object.entries(value.activeTokenHashByUserRef)) {
    activeTokenHashByUserRef[requireString(userRef, "active.userRef", 256)] = requireString(
      tokenHash,
      "active.tokenHash",
      128
    );
  }
  const rateBucketsByUserRef: Record<string, WhatsAppOnboardingRateBucket> = {};
  for (const [userRef, bucket] of Object.entries(value.rateBucketsByUserRef)) {
    rateBucketsByUserRef[requireString(userRef, "rate.userRef", 256)] = normalizeRateBucket(bucket);
  }
  const revocations = value.revocations.map(normalizeRevocation);

  return {
    version: 1,
    tickets,
    activeTokenHashByUserRef,
    generationsByUserRef: normalizeNumberIndex(value.generationsByUserRef, "generations"),
    revokedGenerationByUserRef: normalizeNumberIndex(value.revokedGenerationByUserRef, "revocations"),
    rateBucketsByUserRef,
    revocations,
  };
}

function decodeKey(value: string): Buffer {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new WhatsAppOnboardingStateStoreError(
      "invalid_key",
      "WHATSAPP_ONBOARDING_STATE_KEY must be a base64-encoded 32-byte key"
    );
  }
  const key = Buffer.from(normalized, "base64");
  const canonical = key.toString("base64").replace(/=+$/, "");
  const supplied = normalized.replace(/=+$/, "");
  if (key.length !== 32 || canonical.length !== supplied.length || !timingSafeEqual(Buffer.from(canonical), Buffer.from(supplied))) {
    throw new WhatsAppOnboardingStateStoreError(
      "invalid_key",
      "WHATSAPP_ONBOARDING_STATE_KEY must be a base64-encoded 32-byte key"
    );
  }
  return key;
}

function decodeBase64url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WhatsAppOnboardingStateStoreError("state_corrupt", `Invalid encrypted onboarding ${field}`);
  }
  return Buffer.from(value, "base64url");
}

function assertPendingAccount(value: unknown): WhatsAppOnboardingPendingAccount {
  if (!isPlainObject(value)) {
    throw new WhatsAppOnboardingStateStoreError("decryption_failed", "Invalid encrypted onboarding payload");
  }
  const email = requireString(value.email, "pending.email", 254);
  const firstname = requireString(value.firstname, "pending.firstname", 80);
  const lastname = requireString(value.lastname, "pending.lastname", 80);
  const regionId = requireString(value.regionId, "pending.regionId", 256);
  if (!isPlainObject(value.address)) {
    throw new WhatsAppOnboardingStateStoreError("decryption_failed", "Invalid encrypted onboarding address");
  }
  const address: WhatsAppOnboardingPendingAccount["address"] = {
    street: requireString(value.address.street, "pending.address.street", 160),
    zip: requireString(value.address.zip, "pending.address.zip", 32),
    city: requireString(value.address.city, "pending.address.city", 120),
    country: requireString(value.address.country, "pending.address.country", 80),
  };
  const description = optionalString(value.address.description, "pending.address.description", 500);
  const accessInformation = optionalString(
    value.address.accessInformation,
    "pending.address.accessInformation",
    500
  );
  if (description) address.description = description;
  if (accessInformation) address.accessInformation = accessInformation;
  const swissdataValidationToken = optionalString(
    value.swissdataValidationToken,
    "pending.swissdataValidationToken",
    4_096
  );
  const result: WhatsAppOnboardingPendingAccount = {
    email,
    firstname,
    lastname,
    address,
    regionId,
  };
  if (swissdataValidationToken) result.swissdataValidationToken = swissdataValidationToken;
  return result;
}

abstract class BaseWhatsAppOnboardingStateStore implements WhatsAppOnboardingStateStore {
  protected readonly key: Buffer;

  constructor(key: string) {
    this.key = decodeKey(key);
  }

  sealPendingAccount(input: WhatsAppOnboardingPendingAccount): WhatsAppOnboardingEncryptedValue {
    const payload = Buffer.from(JSON.stringify(assertPendingAccount(input)), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return {
      version: 1,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }

  openPendingAccount(value: WhatsAppOnboardingEncryptedValue): WhatsAppOnboardingPendingAccount {
    try {
      const encrypted = normalizeEncryptedValue(value, "pendingAccount");
      const decipher = createDecipheriv("aes-256-gcm", this.key, decodeBase64url(encrypted.iv, "iv"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(decodeBase64url(encrypted.authTag, "authTag"));
      const plain = Buffer.concat([
        decipher.update(decodeBase64url(encrypted.ciphertext, "ciphertext")),
        decipher.final(),
      ]);
      return assertPendingAccount(JSON.parse(plain.toString("utf8")));
    } catch (error) {
      if (error instanceof WhatsAppOnboardingStateStoreError) throw error;
      throw new WhatsAppOnboardingStateStoreError(
        "decryption_failed",
        "Unable to decrypt the onboarding state; issue a new WhatsApp link."
      );
    }
  }

  abstract read(): WhatsAppOnboardingState;
  abstract write(next: WhatsAppOnboardingState): void;
}

/** An isolated ephemeral store for unit tests and development-only dependency injection. */
export class InMemoryWhatsAppOnboardingStateStore extends BaseWhatsAppOnboardingStateStore {
  private state: WhatsAppOnboardingState;

  constructor(options: { encryptionKey: string; initialState?: WhatsAppOnboardingState } = { encryptionKey: generateWhatsAppOnboardingStateKey() }) {
    super(options.encryptionKey);
    this.state = options.initialState
      ? normalizeWhatsAppOnboardingState(options.initialState)
      : EMPTY_STATE();
  }

  read(): WhatsAppOnboardingState {
    return clone(this.state);
  }

  write(next: WhatsAppOnboardingState): void {
    this.state = normalizeWhatsAppOnboardingState(next);
  }
}

export class PersistentWhatsAppOnboardingStateStore extends BaseWhatsAppOnboardingStateStore {
  private state: WhatsAppOnboardingState;

  constructor(
    private readonly options: {
      statePath?: string;
      encryptionKey: string;
    }
  ) {
    super(options.encryptionKey);
    const statePath = this.path;
    if (!existsSync(statePath)) {
      this.state = EMPTY_STATE();
      return;
    }
    this.assertSafePermissions(statePath);
    try {
      this.state = normalizeWhatsAppOnboardingState(JSON.parse(readFileSync(statePath, "utf8")));
    } catch (error) {
      if (error instanceof WhatsAppOnboardingStateStoreError) throw error;
      throw new WhatsAppOnboardingStateStoreError(
        "state_corrupt",
        "WhatsApp onboarding state is malformed; refusing to continue."
      );
    }
  }

  private get path(): string {
    return this.options.statePath ?? path.join(process.cwd(), ".cache", "whatsapp-onboarding-state.json");
  }

  read(): WhatsAppOnboardingState {
    return clone(this.state);
  }

  write(next: WhatsAppOnboardingState): void {
    const normalized = normalizeWhatsAppOnboardingState(next);
    const statePath = this.path;
    const directory = path.dirname(statePath);
    const temporary = path.join(
      directory,
      `.${path.basename(statePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(temporary, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Synchronous writes serialize all mutations within the single Node process.
      renameSync(temporary, statePath);
      chmodSync(statePath, 0o600);
      this.state = normalized;
    } catch (error) {
      throw new WhatsAppOnboardingStateStoreError(
        "persistence_failed",
        `Unable to persist WhatsApp onboarding state: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  private assertSafePermissions(statePath: string): void {
    const stat = lstatSync(statePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new WhatsAppOnboardingStateStoreError(
        "state_insecure",
        "WhatsApp onboarding state must be a regular file with mode 0600."
      );
    }
  }
}

/** Generate a valid value for WHATSAPP_ONBOARDING_STATE_KEY. Never log this value. */
export function generateWhatsAppOnboardingStateKey(): string {
  return randomBytes(32).toString("base64");
}
