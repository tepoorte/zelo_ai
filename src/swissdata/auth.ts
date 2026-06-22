import { swissdataClient } from "./client.js";

export type AccessToken = { token: string; refresh?: string; expires?: string };

const TOKENS = new Map<string, AccessToken>();

export function getStoredToken(userRef: string) {
  return TOKENS.get(userRef)?.token;
}
export function storeToken(userRef: string, t: AccessToken) {
  TOKENS.set(userRef, t);
}

export function clearStoredToken(userRef: string) {
  TOKENS.delete(userRef);
}

export async function login(userRef: string, username: string, password: string) {
  const api = swissdataClient();
  const res = await api.post("/auth/token", { username, password });
  storeToken(userRef, res.data as AccessToken);
  return res.data as AccessToken;
}
