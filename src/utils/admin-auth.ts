import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import { env } from "../config/env.js";

function headerValue(req: Request, name: string): string {
  const value = req.header(name);
  return typeof value === "string" ? value.trim() : "";
}

export function readAdminToken(req: Request): string {
  const queryToken = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  if (queryToken) return queryToken;

  const zeloHeader = headerValue(req, "x-zelo-admin-token");
  if (zeloHeader) return zeloHeader;

  const whatsappHeader = headerValue(req, "x-whatsapp-admin-token");
  if (whatsappHeader) return whatsappHeader;

  const authorization = headerValue(req, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return bearer?.[1]?.trim() ?? "";
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function constantTimeTokenEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(digestToken(provided), digestToken(expected));
}

export function isAdminTokenAuthorized(req: Request, expected = env.whatsappAdminToken): boolean {
  const provided = readAdminToken(req);
  return constantTimeTokenEquals(provided, expected);
}
