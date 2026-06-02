const SENSITIVE_KEY_RE = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password/i;
const SECRET_VALUE_RE = /^(sk-|sk_)[A-Za-z0-9_-]{8,}/;

const redactSensitiveValue = (value: unknown, force = false): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (force) return '[REDACTED]';

  const tokenMatch = /^(Bearer|token)\s+(.+)$/i.exec(trimmed);
  if (tokenMatch?.[1]) {
    return `${tokenMatch[1]} [REDACTED]`;
  }
  if (SECRET_VALUE_RE.test(trimmed)) {
    return '[REDACTED]';
  }
  return value;
};

export const sanitizeApiFetchLogValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeApiFetchLogValue(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_RE.test(key)
        ? redactSensitiveValue(nestedValue, true)
        : sanitizeApiFetchLogValue(nestedValue);
    }
    return output;
  }
  return redactSensitiveValue(value);
};

export const formatApiFetchLogPayload = (value: unknown, maxLength = 1000): string => {
  let raw: string;
  if (typeof value === 'string') {
    try {
      raw = JSON.stringify(sanitizeApiFetchLogValue(JSON.parse(value)));
    } catch {
      raw = String(sanitizeApiFetchLogValue(value));
    }
  } else {
    raw = JSON.stringify(sanitizeApiFetchLogValue(value));
  }

  return raw.length > maxLength ? `${raw.slice(0, maxLength)}... [truncated]` : raw;
};
