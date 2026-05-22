import type { Request, Response } from "express";

export function rawBodySaver(req: Request, _res: Response, buf: Buffer) {
  (req as any).rawBody = buf;
}
