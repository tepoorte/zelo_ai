import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";
import { safeError } from "../utils/redaction.js";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const correlationId = randomUUID();
  console.error("[ERROR]", { correlationId, error: safeError(err) });

  if (env.nodeEnv === "production") {
    return res.status(500).json({ error: "Internal error", correlationId });
  }

  return res.status(500).json({ error: err?.message ?? "Internal error", correlationId });
}
