import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "zelo_ai_sid";

export type Session = {
  token: string;
  refresh?: string;
  expires?: string;
  username?: string;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
};

const SESSIONS = new Map<string, Session>();
const WEB_SESSION_TO_USERREF = new Map<string, string>();

function isExpired(session: Session): boolean {
  if (!session.expires) return false;
  const expiresAt = Date.parse(session.expires);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now();
}

export function createWebSessionIdentity() {
  const sessionId = randomBytes(32).toString("base64url");
  return {
    sessionId,
    userRef: `web:${sessionId}`,
  };
}

export function setSession(userRef: string, s: Session) {
  const now = new Date().toISOString();
  const existing = SESSIONS.get(userRef);
  const session: Session = {
    ...s,
    createdAt: s.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
  };

  SESSIONS.set(userRef, session);

  if (session.sessionId) {
    WEB_SESSION_TO_USERREF.set(session.sessionId, userRef);
  }
}

export function getSession(userRef: string): Session | undefined {
  return SESSIONS.get(userRef);
}

export function clearSession(userRef: string) {
  const session = SESSIONS.get(userRef);
  if (session?.sessionId) {
    WEB_SESSION_TO_USERREF.delete(session.sessionId);
  }
  SESSIONS.delete(userRef);
}

export function getSessionById(sessionId: string | undefined): { userRef: string; session: Session } | undefined {
  if (!sessionId) return undefined;
  const userRef = WEB_SESSION_TO_USERREF.get(sessionId);
  if (!userRef) return undefined;

  const session = SESSIONS.get(userRef);
  if (!session) {
    WEB_SESSION_TO_USERREF.delete(sessionId);
    return undefined;
  }

  if (isExpired(session)) {
    clearSession(userRef);
    return undefined;
  }

  return { userRef, session };
}

export function clearSessionById(sessionId: string | undefined): boolean {
  const resolved = getSessionById(sessionId);
  if (!resolved) return false;
  clearSession(resolved.userRef);
  return true;
}

export function maskPrincipal(value: string | undefined): string {
  if (!value) return "anonymous";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
