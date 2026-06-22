import { env } from "../../config/env.js";

type RateState = {
  attempts: number;
  resendAvailableAt: number;
  lockedUntil: number;
};

const RATE_STATES = new Map<string, RateState>();

function now() {
  return Date.now();
}

function stateFor(key: string): RateState {
  const existing = RATE_STATES.get(key);
  if (existing) return existing;
  const created: RateState = {
    attempts: 0,
    resendAvailableAt: 0,
    lockedUntil: 0,
  };
  RATE_STATES.set(key, created);
  return created;
}

export function isWhatsAppAuthLocked(key: string): boolean {
  return stateFor(key).lockedUntil > now();
}

export function canSendWhatsAppOtp(key: string): boolean {
  const state = stateFor(key);
  return state.lockedUntil <= now() && state.resendAvailableAt <= now();
}

export function markWhatsAppOtpSent(key: string): void {
  const state = stateFor(key);
  const cooldownSeconds = Number.isFinite(env.whatsappOtpResendCooldownSeconds)
    ? env.whatsappOtpResendCooldownSeconds
    : 90;
  state.resendAvailableAt = now() + cooldownSeconds * 1000;
}

export function markWhatsAppOtpFailure(key: string): { locked: boolean } {
  const state = stateFor(key);
  state.attempts += 1;
  const maxAttempts = Number.isFinite(env.whatsappOtpMaxAttempts)
    ? env.whatsappOtpMaxAttempts
    : 5;
  if (state.attempts >= maxAttempts) {
    state.lockedUntil = now() + 10 * 60 * 1000;
    return { locked: true };
  }
  return { locked: false };
}

export function resetWhatsAppAuthRateLimit(key: string): void {
  RATE_STATES.delete(key);
}
