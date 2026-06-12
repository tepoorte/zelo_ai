import { env } from "../../config/env.js";
import { getStoredToken, login } from "../../swissdata/auth.js";
import { setSession } from "../../swissdata/session.js";

export type WhatsAppLoginCommand =
  | { kind: "missing" }
  | { kind: "invalid_format" }
  | { kind: "login"; username: string; password: string };

export type WhatsAppSessionDeps = {
  getStoredToken: typeof getStoredToken;
  login: typeof login;
  setSession: typeof setSession;
  nodeEnv: string;
  testPhone: string;
  testUsername: string;
  testPassword: string;
};

export type WhatsAppSessionResult =
  | { ok: true }
  | { ok: false; message: string };

const DEFAULT_DEPS: WhatsAppSessionDeps = {
  getStoredToken,
  login,
  setSession,
  nodeEnv: env.nodeEnv,
  testPhone: env.whatsappTestPhone,
  testUsername: env.zeloTestUsername,
  testPassword: env.zeloTestPassword,
};

export function normalizeWhatsAppPhone(input: string): string {
  const withoutJid = String(input || "").split("@")[0] || "";
  const digits = withoutJid.replace(/\D/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

export function parseWhatsAppLoginCommand(text: string): WhatsAppLoginCommand {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^login\s+(\S+)\s+(.+)$/i);
  if (!match) {
    return /^login\b/i.test(trimmed) ? { kind: "invalid_format" } : { kind: "missing" };
  }

  return {
    kind: "login",
    username: match[1].trim(),
    password: match[2].trim(),
  };
}

export function isAllowedWhatsAppPhone(phone: string, allowedPhone = env.whatsappTestPhone): boolean {
  const normalizedAllowed = normalizeWhatsAppPhone(allowedPhone);
  return !normalizedAllowed || normalizeWhatsAppPhone(phone) === normalizedAllowed;
}

function canAutoLoginTestUser(phone: string, deps: WhatsAppSessionDeps): boolean {
  return (
    deps.nodeEnv !== "production" &&
    Boolean(deps.testUsername) &&
    Boolean(deps.testPassword) &&
    Boolean(deps.testPhone) &&
    normalizeWhatsAppPhone(phone) === normalizeWhatsAppPhone(deps.testPhone)
  );
}

async function loginWhatsAppUser(
  userRef: string,
  username: string,
  password: string,
  deps: WhatsAppSessionDeps
) {
  const session = await deps.login(userRef, username, password);
  deps.setSession(userRef, {
    token: session.token,
    refresh: session.refresh,
    expires: session.expires,
  });
}

export async function ensureWhatsAppSwissdataSession(
  input: { userRef: string; phone: string; text: string },
  deps: WhatsAppSessionDeps = DEFAULT_DEPS
): Promise<WhatsAppSessionResult> {
  const loginCommand = parseWhatsAppLoginCommand(input.text);

  if (loginCommand.kind === "login") {
    await loginWhatsAppUser(input.userRef, loginCommand.username, loginCommand.password, deps);
    return {
      ok: false,
      message: "Connexion réussie. Tu peux maintenant gérer ton panier ici sur WhatsApp.",
    };
  }

  if (loginCommand.kind === "invalid_format") {
    return {
      ok: false,
      message: "Format de connexion invalide. Utilise : login login-example-001@example.invalid ton_mot_de_passe",
    };
  }

  if (deps.getStoredToken(input.userRef)) {
    return { ok: true };
  }

  if (canAutoLoginTestUser(input.phone, deps)) {
    await loginWhatsAppUser(input.userRef, deps.testUsername, deps.testPassword, deps);
    return { ok: true };
  }

  return {
    ok: false,
    message: "Avant d’utiliser le panier, connecte-toi ici avec : login login-example-001@example.invalid ton_mot_de_passe",
  };
}
