type Session = { token: string; refresh?: string; expires?: string };

const SESSIONS = new Map<string, Session>();

export function setSession(userRef: string, s: Session) {
  SESSIONS.set(userRef, s);
}

export function getSession(userRef: string): Session | undefined {
  return SESSIONS.get(userRef);
}

export function clearSession(userRef: string) {
  SESSIONS.delete(userRef);
}
