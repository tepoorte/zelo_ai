const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /(authorization|bearer|token|secret|password|passwd|api[_-]?key|apikey|smtp|cookie|refresh|signature|rawbody|raw_body|phone|email|customerid|customer_id|userid|user_id|userref|user_ref|payload|basket|panier|order|products?)/i;

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g;
const QUERY_SECRET_PATTERN =
  /([?&](?:authorization|bearer|token|access[_-]?token|verify[_-]?token|api[_-]?key|apikey|secret|password|passwd|signature)=)([^&#\s]+)/gi;
const HEADER_SECRET_PATTERN =
  /\b((?:authorization|cookie|set-cookie|x-zelo-admin-token|x-whatsapp-admin-token)\s*[:=]\s*)([^\r\n]+)/gi;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9._~+/=-]{32,}\b/g;
const OBJECT_ID_PATTERN = /\b[0-9a-f]{24}\b/gi;
const PHONE_PATTERN = /(?<!\w)(?:\+|00)?\d[\d\s().-]{7,}\d(?!\w)/g;

function redactString(value: string): string {
  return value
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(HEADER_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(OBJECT_ID_PATTERN, REDACTED)
    .replace(LONG_SECRET_PATTERN, REDACTED)
    .replace(PHONE_PATTERN, REDACTED);
}

export function redactSensitive<T>(input: T, depth = 0): T {
  if (input == null) return input;

  if (typeof input === "string") return redactString(input) as T;
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") {
    return input;
  }

  if (depth > 5) return "[redacted:nested]" as T;

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitive(item, depth + 1)) as T;
  }

  if (input instanceof Error) {
    return safeError(input) as T;
  }

  if (typeof input === "object") {
    const source = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(source)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactSensitive(value, depth + 1);
    }

    return output as T;
  }

  return input;
}

export function safeError(error: unknown): Record<string, unknown> {
  const err = error as any;

  if (err?.isAxiosError) {
    return redactSensitive({
      name: err.name,
      message: err.message,
      code: err.code,
      method: err.config?.method,
      url: err.config?.url,
      baseURL: err.config?.baseURL,
      status: err.response?.status,
    });
  }

  if (error instanceof Error) {
    return redactSensitive({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }

  return redactSensitive({ error });
}
