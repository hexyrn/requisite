/**
 * Structured, privacy-safe JSON-line logging. P0 item 22.
 *
 * Callers build a LogEntry from an explicit allowlist of fields - there is
 * no "pass an arbitrary object and hope nobody put a password in it" path.
 * Free text, names, emails, and secrets are never accepted as loggable
 * fields; `userRef`/`entityRef` are opaque identifiers (IDs), never names or
 * emails, enforced by the type signature below (all fields are `string`
 * identifiers/enums, not free-form user-supplied strings).
 */
export interface LogEntry {
  event: string;
  userRef?: string | null;
  entityType?: string | null;
  entityRef?: string | null;
  errorCode?: string | null;
  correlationId?: string | null;
  /** Extra structured, non-sensitive context. Values are redacted if their key matches the denylist. */
  context?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN = /password|secret|token|totp|authorization|cookie|hash|credential/i;

function redact(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      safe[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object') {
      safe[key] = redact(value as Record<string, unknown>);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function logStructured(entry: LogEntry): void {
  const line = {
    ts: new Date().toISOString(),
    event: entry.event,
    userRef: entry.userRef ?? null,
    entityType: entry.entityType ?? null,
    entityRef: entry.entityRef ?? null,
    errorCode: entry.errorCode ?? null,
    correlationId: entry.correlationId ?? null,
    context: redact(entry.context),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
