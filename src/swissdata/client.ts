import axios from "axios";
import { env } from "../config/env.js";
import { getStoredToken } from "./auth.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientSwissdataError(error: any): boolean {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "").toLowerCase();

  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    message.includes("socket hang up") ||
    message.includes("timeout")
  );
}

export async function withSwissdataReadRetry<T>(
  label: string,
  read: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isTransientSwissdataError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = 150 * attempt;
      console.warn(`[SWISSDATA_RETRY] ${label} attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function swissdataClient(userRef?: string) {
  const token = userRef ? getStoredToken(userRef) : undefined;

  return axios.create({
    baseURL: env.swissdataBaseUrl,
    timeout: 15000,
    params: {
      apiKey: env.swissdataApiKey,
    },
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
