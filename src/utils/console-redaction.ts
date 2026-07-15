import { env } from "../config/env.js";
import { redactSensitive, safeError } from "./redaction.js";

let installed = false;

function sanitizeArg(arg: unknown): unknown {
  return arg instanceof Error ? safeError(arg) : redactSensitive(arg);
}

export function installProductionConsoleRedaction(): void {
  if (installed || env.nodeEnv !== "production") return;
  installed = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args.map(sanitizeArg));
    };
  }
}
