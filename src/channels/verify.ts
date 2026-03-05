import crypto from "crypto";
import { env } from "../config/env.js";

export function verifyMetaSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  // Meta uses: X-Hub-Signature-256: sha256=...
  if (!signatureHeader) return false;
  const [algo, their] = signatureHeader.split("=");
  if (algo !== "sha256" || !their) return false;

  const hmac = crypto.createHmac("sha256", env.metaAppSecret);
  hmac.update(rawBody);
  const ours = hmac.digest("hex");

  // timing safe compare
  const a = Buffer.from(ours, "hex");
  const b = Buffer.from(their, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}