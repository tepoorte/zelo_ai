import axios, { type AxiosInstance } from "axios";
import { env } from "../config/env.js";

type CachedAdminToken = {
  token: string;
  expiresAt: number;
};

const ADMIN_TOKEN_REFRESH_SKEW_MS = 60_000;
let cachedAdminToken: CachedAdminToken | null = null;

function parseExpiry(value: unknown): number {
  if (typeof value !== "string" || !value) {
    return Date.now() + 30 * 60_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now() + 30 * 60_000;
}

function baseSwissdataClient() {
  return axios.create({
    baseURL: env.swissdataBaseUrl,
    timeout: 15000,
    params: {
      apiKey: env.swissdataApiKey,
    },
  });
}

async function loginAdminToken(): Promise<CachedAdminToken> {
  if (!env.swissdataAdminUsername || !env.swissdataAdminPassword) {
    throw new Error("Missing Swissdata admin credentials");
  }

  const res = await baseSwissdataClient().post("/auth/token", {
    username: env.swissdataAdminUsername,
    password: env.swissdataAdminPassword,
  });

  const token = String(res.data?.token ?? "");
  if (!token) {
    throw new Error("Swissdata admin login returned no token");
  }

  return {
    token,
    expiresAt: parseExpiry(res.data?.expires),
  };
}

export async function getSwissdataAdminToken(): Promise<string> {
  if (env.swissdataAdminToken) {
    return env.swissdataAdminToken;
  }

  if (
    cachedAdminToken &&
    cachedAdminToken.expiresAt - ADMIN_TOKEN_REFRESH_SKEW_MS > Date.now()
  ) {
    return cachedAdminToken.token;
  }

  cachedAdminToken = await loginAdminToken();
  return cachedAdminToken.token;
}

export async function swissdataAdminClient(): Promise<AxiosInstance> {
  const token = await getSwissdataAdminToken();
  return axios.create({
    baseURL: env.swissdataBaseUrl,
    timeout: 15000,
    params: {
      apiKey: env.swissdataApiKey,
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
