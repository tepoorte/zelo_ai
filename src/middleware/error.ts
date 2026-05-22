import type { Request, Response, NextFunction } from "express";

function sanitizeError(err: any) {
  if (err?.isAxiosError) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      method: err.config?.method,
      url: err.config?.url,
      baseURL: err.config?.baseURL,
      status: err.response?.status,
    };
  }

  return err;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error(sanitizeError(err));
  res.status(500).json({ error: err?.message ?? "Internal error" });
}
