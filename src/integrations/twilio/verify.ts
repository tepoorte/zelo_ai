import crypto from "crypto";
import type { Request } from "express";
import { twilioEnv } from "./env.js";

function buildExpectedSignature(url: string, params: Record<string, string>) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => `${acc}${key}${params[key]}`, url);

  return crypto.createHmac("sha1", twilioEnv.authToken).update(data).digest("base64");
}

function getRequestUrl(req: Request) {
  if (twilioEnv.webhookBaseUrl) {
    return `${twilioEnv.webhookBaseUrl}${req.originalUrl}`;
  }

  const proto =
    (req.header("x-forwarded-proto") || "").split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  const host =
    (req.header("x-forwarded-host") || "").split(",")[0]?.trim() ||
    req.header("host") ||
    "";
  return `${proto}://${host}${req.originalUrl}`;
}

export function verifyTwilioSignature(req: Request): boolean {
  if (!twilioEnv.authToken) return true;

  const theirSignature = req.header("x-twilio-signature");
  if (!theirSignature) return false;

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value == null) continue;
    params[key] = String(value);
  }

  const expected = buildExpectedSignature(getRequestUrl(req), params);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(theirSignature));
}
