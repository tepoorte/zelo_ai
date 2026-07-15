import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { redactSensitive } from "./redaction.js";

type PerfStep = {
  label: string;
  durationMs: number;
  meta?: Record<string, unknown>;
};

type PerfTrace = {
  id: string;
  name: string;
  meta?: Record<string, unknown>;
  startedAtMs: number;
  steps: PerfStep[];
};

const perfStorage = new AsyncLocalStorage<PerfTrace>();

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return ` ${JSON.stringify(redactSensitive(meta))}`;
}

function currentNowMs(): number {
  return performance.now();
}

export async function withPerfTrace<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const trace: PerfTrace = {
    id: randomUUID().slice(0, 8),
    name,
    meta: redactSensitive(meta),
    startedAtMs: currentNowMs(),
    steps: [],
  };

  return await perfStorage.run(trace, async () => {
    console.log(`[PERF][${trace.id}] START ${trace.name}${formatMeta(trace.meta)}`);

    try {
      return await fn();
    } finally {
      const totalMs = roundMs(currentNowMs() - trace.startedAtMs);
      const summary = trace.steps.map((step) => ({
        label: step.label,
        ms: step.durationMs,
        ...(step.meta ? { meta: redactSensitive(step.meta) } : {}),
      }));

      console.log(
        `[PERF][${trace.id}] END ${trace.name} total=${totalMs}ms steps=${JSON.stringify(summary)}`
      );
    }
  });
}

export async function timeAsync<T>(
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const trace = perfStorage.getStore();
  if (!trace) return await fn();

  const startedAtMs = currentNowMs();

  try {
    return await fn();
  } finally {
    const durationMs = roundMs(currentNowMs() - startedAtMs);
    trace.steps.push({ label, durationMs, meta: redactSensitive(meta) });
    console.log(`[PERF][${trace.id}] ${label} ${durationMs}ms${formatMeta(meta)}`);
  }
}

export function timeSync<T>(
  label: string,
  fn: () => T,
  meta?: Record<string, unknown>
): T {
  const trace = perfStorage.getStore();
  if (!trace) return fn();

  const startedAtMs = currentNowMs();

  try {
    return fn();
  } finally {
    const durationMs = roundMs(currentNowMs() - startedAtMs);
    trace.steps.push({ label, durationMs, meta: redactSensitive(meta) });
    console.log(`[PERF][${trace.id}] ${label} ${durationMs}ms${formatMeta(meta)}`);
  }
}

export function perfMeta(meta: Record<string, unknown>) {
  const trace = perfStorage.getStore();
  if (!trace) return;
  trace.meta = {
    ...(trace.meta ?? {}),
    ...redactSensitive(meta),
  };
}
