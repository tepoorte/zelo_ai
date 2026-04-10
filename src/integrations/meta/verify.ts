import crypto from "crypto";
import { metaEnv } from "./env.js";

export function verifyMetaSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  if (!signatureHeader || !metaEnv.appSecret) return false;

  const [algo, theirDigest] = signatureHeader.split("=");
  if (algo !== "sha256" || !theirDigest) return false;

  const hmac = crypto.createHmac("sha256", metaEnv.appSecret);
  hmac.update(rawBody);
  const ourDigest = hmac.digest("hex");

  const theirs = Buffer.from(theirDigest, "hex");
  const ours = Buffer.from(ourDigest, "hex");

  return ours.length === theirs.length && crypto.timingSafeEqual(ours, theirs);
}
