import type { Request, Response, NextFunction } from "express";

export function rawBodySaver(req: Request, _res: Response, buf: Buffer) {
  (req as any).rawBody = buf;
}

export function requireRawBody(req: Request, _res: Response, next: NextFunction) {
  if (!(req as any).rawBody) {
    return next(new Error("rawBody missing. Ensure express.json({ verify }) is configured."));
  }
  next();
}