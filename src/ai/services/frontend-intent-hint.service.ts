import type { FrontendIntentHint } from "./planner-types.js";

export function parseFrontendIntentHint(value: unknown): FrontendIntentHint | undefined {
  if (!value || typeof value !== "object") return undefined;

  const payload = value as Record<string, unknown>;
  const actionKey = payload.actionKey != null ? String(payload.actionKey) : "";
  if (!actionKey) return undefined;

  return {
    actionKey: actionKey as FrontendIntentHint["actionKey"],
    confidence:
      payload.confidence != null && Number.isFinite(Number(payload.confidence))
        ? Number(payload.confidence)
        : undefined,
    family: payload.family != null ? String(payload.family) : undefined,
    planner: payload.planner != null ? String(payload.planner) : undefined,
  };
}
