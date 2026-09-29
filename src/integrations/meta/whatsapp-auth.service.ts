import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  getNextHistorySuggestions,
  type HistorySuggestion,
} from "../../ai/services/history-suggestions.service.js";
import { env } from "../../config/env.js";
import { clearStoredToken } from "../../swissdata/auth.js";
import { clearSession } from "../../swissdata/session.js";
import {
  clearWhatsAppCustomerSession,
  hashPhoneForAudit,
  setWhatsAppCustomerSession,
} from "../../swissdata/whatsapp-customer-session.js";
import {
  canSendWhatsAppOtp,
  isWhatsAppAuthLocked,
  markWhatsAppOtpFailure,
  markWhatsAppOtpSent,
  resetWhatsAppAuthRateLimit,
} from "./whatsapp-auth-rate-limit.service.js";
import { sendWhatsAppOtpEmail } from "./whatsapp-auth-mailer.service.js";
import { lookupWhatsAppCustomerByPhone } from "./whatsapp-auth-swissdata.service.js";
import {
  buildWhatsAppOnboardingOfferMessage,
  isWhatsAppOnboardingLinkRotationCommand,
  whatsappOnboardingService,
  type WhatsAppOnboardingOffer,
} from "./whatsapp-onboarding.service.js";

export type PasswordlessWhatsAppSessionResult =
  | { ok: true }
  | { ok: false; message: string };

type PendingChallenge = {
  userRef: string;
  phoneHash: string;
  customerId: string;
  userId: string;
  email: string;
  salt: string;
  codeHash: string;
  expiresAt: number;
};

const CHALLENGES = new Map<string, PendingChallenge>();
const AUTH_GENERATIONS = new Map<string, number>();
const MAX_AUTH_GENERATIONS = 10_000;

export type WhatsAppPasswordlessDeps = {
  lookupCustomer: typeof lookupWhatsAppCustomerByPhone;
  sendOtpEmail: typeof sendWhatsAppOtpEmail;
  issueOnboardingOffer: (input: {
    userRef: string;
    phone: string;
    rotate?: boolean;
  }) => WhatsAppOnboardingOffer;
  revokeOnboarding?: (userRef: string) => void;
};

const DEFAULT_PASSWORDLESS_DEPS: WhatsAppPasswordlessDeps = {
  lookupCustomer: lookupWhatsAppCustomerByPhone,
  sendOtpEmail: sendWhatsAppOtpEmail,
  issueOnboardingOffer: (input) => whatsappOnboardingService.issueOffer(input),
  revokeOnboarding: (userRef) => whatsappOnboardingService.revokeForUserRef(userRef),
};

function otpTtlMinutes(): number {
  return Number.isFinite(env.whatsappOtpTtlMinutes) ? env.whatsappOtpTtlMinutes : 10;
}

function challengeExpiry(): number {
  return Date.now() + otpTtlMinutes() * 60 * 1000;
}

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashOtp(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function extractOtp(text: string): string | null {
  const match = String(text || "").trim().match(/^(\d{6})$/);
  return match ? match[1] : null;
}

export function isWhatsAppLogoutCommand(text: string): boolean {
  return /^(logout|déconnexion|deconnexion|disconnect|esci|scollega)$/i.test(
    String(text || "").trim()
  );
}

export function buildWhatsAppOtpSentMessage(): string {
  return [
    "*Connexion à ton panier Zélo*",
    "",
    "Je viens de t’envoyer un code de connexion par email.",
    "Réponds ici avec les *6 chiffres* reçus pour activer ton panier WhatsApp.",
    "",
    `Le code expire dans ${otpTtlMinutes()} minutes. Si tu ne le trouves pas, vérifie aussi les courriers indésirables.`,
  ].join("\n");
}

function genericLookupFailureMessage(): string {
  return [
    "Je ne peux pas encore activer ce numéro automatiquement.",
    "Si ton compte Zélo est bien lié à ce numéro, contacte l’équipe Zélo pour vérifier la fiche client.",
  ].join("\n");
}

function unavailableMessage(): string {
  return "La connexion WhatsApp est temporairement indisponible. Réessaie dans quelques minutes.";
}

export function formatWhatsAppPostLoginMessage(suggestions: HistorySuggestion[] = []): string {
  const suggestionBlock = suggestions.length
    ? [
        "",
        "Tu prends souvent aussi :",
        ...suggestions.map((suggestion) => `• ${suggestion.name}`),
      ]
    : [];

  return [
    "*Connexion confirmée*",
    "",
    "Que veux-tu commander aujourd’hui ?",
    "Écris naturellement ce dont tu as besoin.",
    "",
    "Tu peux par exemple écrire :",
    "• « montre mon panier »",
    "• « ajoute 6 œufs et un pain »",
    "• « vide mon panier »",
    "• « une idée végétarienne avec 40 francs »",
    "• « passe la commande »",
    ...suggestionBlock,
    "",
    "Quand tout est bon, écris « ok » ou « passe la commande ».",
  ].join("\n");
}

async function buildPostLoginMessage(userRef: string): Promise<string> {
  const suggestions = await getNextHistorySuggestions(userRef, { limit: 3 }).catch(() => []);
  return formatWhatsAppPostLoginMessage(suggestions);
}

function activeChallengeFor(userRef: string): PendingChallenge | null {
  const challenge = CHALLENGES.get(userRef);
  if (!challenge) return null;
  if (challenge.expiresAt <= Date.now()) {
    CHALLENGES.delete(userRef);
    return null;
  }
  return challenge;
}

function authGeneration(userRef: string): number {
  return AUTH_GENERATIONS.get(userRef) ?? 0;
}

function advanceAuthGeneration(userRef: string): void {
  const next = authGeneration(userRef) + 1;
  AUTH_GENERATIONS.delete(userRef);
  AUTH_GENERATIONS.set(userRef, next);
  while (AUTH_GENERATIONS.size > MAX_AUTH_GENERATIONS) {
    const oldest = AUTH_GENERATIONS.keys().next().value as string | undefined;
    if (!oldest) break;
    AUTH_GENERATIONS.delete(oldest);
  }
}

function revokeOnboardingBestEffort(userRef: string, deps: WhatsAppPasswordlessDeps): void {
  try {
    deps.revokeOnboarding?.(userRef);
  } catch {
    // Authentication/session revocation must not depend on an auxiliary
    // onboarding-state write. The outstanding capability remains short-lived.
    console.error("[whatsapp-auth] onboarding revocation failed");
  }
}

async function startOrResendChallenge(input: {
  userRef: string;
  phone: string;
  text: string;
}, deps: WhatsAppPasswordlessDeps): Promise<PasswordlessWhatsAppSessionResult> {
  const generation = authGeneration(input.userRef);
  if (isWhatsAppAuthLocked(input.userRef)) {
    return { ok: false, message: unavailableMessage() };
  }

  const existing = activeChallengeFor(input.userRef);
  if (existing && !canSendWhatsAppOtp(input.userRef)) {
    return { ok: false, message: buildWhatsAppOtpSentMessage() };
  }

  const lookup = await deps.lookupCustomer(input.phone).catch(() => {
    console.error(`[whatsapp-auth] customer lookup failed phone=${hashPhoneForAudit(input.phone)}`);
    return null;
  });

  if (!lookup) {
    return { ok: false, message: unavailableMessage() };
  }
  if (authGeneration(input.userRef) !== generation) {
    return { ok: false, message: unavailableMessage() };
  }

  if (!lookup.ok && (lookup.reason === "not_found" || lookup.reason === "incomplete")) {
    try {
      const offer = deps.issueOnboardingOffer({
        userRef: input.userRef,
        phone: input.phone,
        rotate: isWhatsAppOnboardingLinkRotationCommand(input.text),
      });
      return { ok: false, message: buildWhatsAppOnboardingOfferMessage(offer) };
    } catch {
      return { ok: false, message: unavailableMessage() };
    }
  }

  if (!lookup.ok) {
    return { ok: false, message: genericLookupFailureMessage() };
  }

  const code = generateOtp();
  const salt = randomBytes(16).toString("hex");
  const challenge: PendingChallenge = {
    userRef: input.userRef,
    phoneHash: hashPhoneForAudit(input.phone),
    customerId: lookup.identity.customerId,
    userId: lookup.identity.userId,
    email: lookup.identity.email,
    salt,
    codeHash: hashOtp(code, salt),
    expiresAt: challengeExpiry(),
  };

  const mailResult = await deps.sendOtpEmail({
    to: lookup.identity.email,
    code,
    ttlMinutes: otpTtlMinutes(),
  });

  if (!mailResult.ok) {
    return { ok: false, message: unavailableMessage() };
  }
  if (authGeneration(input.userRef) !== generation) {
    return { ok: false, message: unavailableMessage() };
  }

  CHALLENGES.set(input.userRef, challenge);
  markWhatsAppOtpSent(input.userRef);
  console.info(`[whatsapp-auth] OTP challenge started phone=${challenge.phoneHash}`);
  return { ok: false, message: buildWhatsAppOtpSentMessage() };
}

function clearAllWhatsAppAuthState(
  userRef: string,
  deps: WhatsAppPasswordlessDeps
): void {
  advanceAuthGeneration(userRef);
  CHALLENGES.delete(userRef);
  clearWhatsAppCustomerSession(userRef);
  clearStoredToken(userRef);
  clearSession(userRef);
  revokeOnboardingBestEffort(userRef, deps);
}

async function validateChallenge(input: {
  userRef: string;
  phone: string;
  text: string;
  code: string;
}, deps: WhatsAppPasswordlessDeps): Promise<PasswordlessWhatsAppSessionResult> {
  const generation = authGeneration(input.userRef);
  const challenge = activeChallengeFor(input.userRef);
  if (!challenge) {
    return await startOrResendChallenge(input, deps);
  }

  const candidateHash = hashOtp(input.code, challenge.salt);
  if (!safeEquals(candidateHash, challenge.codeHash)) {
    const failure = markWhatsAppOtpFailure(input.userRef);
    if (failure.locked) {
      CHALLENGES.delete(input.userRef);
      return { ok: false, message: unavailableMessage() };
    }
    return {
      ok: false,
      message: "Code incorrect. Vérifie l’email reçu et réessaie avec les 6 chiffres.",
    };
  }

  const refreshed = await deps.lookupCustomer(input.phone).catch(() => null);
  if (
    authGeneration(input.userRef) !== generation ||
    CHALLENGES.get(input.userRef) !== challenge
  ) {
    return { ok: false, message: unavailableMessage() };
  }
  if (!refreshed) {
    return { ok: false, message: unavailableMessage() };
  }
  if (
    !refreshed.ok ||
    refreshed.identity.customerId !== challenge.customerId ||
    refreshed.identity.userId !== challenge.userId ||
    refreshed.identity.email.toLowerCase() !== challenge.email.toLowerCase()
  ) {
    CHALLENGES.delete(input.userRef);
    return { ok: false, message: genericLookupFailureMessage() };
  }

  revokeOnboardingBestEffort(input.userRef, deps);
  setWhatsAppCustomerSession({
    userRef: input.userRef,
    phone: input.phone,
    customerId: challenge.customerId,
    userId: challenge.userId,
    email: challenge.email,
  });
  CHALLENGES.delete(input.userRef);
  resetWhatsAppAuthRateLimit(input.userRef);
  console.info(`[whatsapp-auth] session verified phone=${challenge.phoneHash}`);

  return {
    ok: false,
    message: await buildPostLoginMessage(input.userRef),
  };
}

export async function ensureWhatsAppPasswordlessSession(input: {
  userRef: string;
  phone: string;
  text: string;
}, deps: WhatsAppPasswordlessDeps = DEFAULT_PASSWORDLESS_DEPS): Promise<PasswordlessWhatsAppSessionResult> {
  if (isWhatsAppLogoutCommand(input.text)) {
    clearAllWhatsAppAuthState(input.userRef, deps);
    return {
      ok: false,
      message: "Session WhatsApp fermée. Réécris-moi quand tu veux te reconnecter.",
    };
  }

  const otp = extractOtp(input.text);
  if (otp) {
    return await validateChallenge({ ...input, code: otp }, deps);
  }

  return await startOrResendChallenge(input, deps);
}
