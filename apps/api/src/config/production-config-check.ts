/**
 * P3 item 39: "secure production defaults; dev conveniences must not
 * silently carry into production... Production fails safely if critical
 * config is missing."
 *
 * Before this existed, every critical secret in this codebase failed lazily
 * - at first use, deep inside a request handler - rather than at boot:
 *   - TOTP_MASTER_KEY: throws from getMasterKey() the first time a TOTP
 *     secret is encrypted/decrypted (security/totp-encryption.ts) - the app
 *     boots fine and serves traffic for hours before an MFA enrolment
 *     attempt suddenly 500s.
 *   - HEXYRN_LICENSE_PUBLIC_KEY: silently falls back to the PUBLICLY
 *     COMMITTED test keypair (platform/licensing/keys.ts) if unset, logging
 *     a structured warning that is easy to miss in production log volume -
 *     a production deployment that forgot to set this would accept a
 *     licence "signed" with a key anyone can find in this repository,
 *     defeating the entire licensing system (P3 item 40's concern,
 *     applied concretely).
 *   - COOKIE_SECURE=false (the local-http-dev default) silently carrying
 *     into a production deployment served over plain HTTP would ship
 *     session cookies without the Secure flag.
 *
 * This module runs ONE explicit, fail-fast check at boot, only when
 * NODE_ENV=production, so a misconfigured production deployment refuses to
 * start with an actionable list of exactly what's wrong - never partially
 * boots into a state where some requests work and others fail confusingly
 * hours or days later. Development/test are unaffected (NODE_ENV defaults
 * to unset/'development' in every existing script and test setup) -
 * this is deliberately opt-in-by-environment, not a change to dev ergonomics.
 */

export interface ProductionConfigIssue {
  variable: string;
  message: string;
}

/** Pure function - returns issues rather than throwing, so it's independently testable. */
export function checkProductionConfig(env: NodeJS.ProcessEnv): ProductionConfigIssue[] {
  const issues: ProductionConfigIssue[] = [];

  if (env.NODE_ENV !== 'production') {
    return issues; // dev/test convenience defaults are intentional outside production
  }

  // P3 item 7 (docs/decisions/0008-totp-envelope-encryption.md) renamed the
  // primary TOTP master key var to TOTP_MASTER_KEY_CURRENT, keeping bare
  // TOTP_MASTER_KEY only as a legacy fallback - checked here in the same
  // order totp-encryption.ts itself resolves it, so this check can never
  // drift out of sync with what the app actually uses at runtime.
  const totpKey = env.TOTP_MASTER_KEY_CURRENT ?? env.TOTP_MASTER_KEY;
  if (!totpKey) {
    issues.push({
      variable: 'TOTP_MASTER_KEY_CURRENT',
      message:
        'must be set in production (generate with: openssl rand -base64 32). The legacy TOTP_MASTER_KEY var is also accepted as a fallback.',
    });
  } else if (Buffer.from(totpKey, 'base64').length !== 32) {
    issues.push({
      variable: 'TOTP_MASTER_KEY_CURRENT',
      message: 'must decode to exactly 32 bytes (base64-encoded).',
    });
  }

  if (!env.HEXYRN_LICENSE_PUBLIC_KEY) {
    issues.push({
      variable: 'HEXYRN_LICENSE_PUBLIC_KEY',
      message:
        'must be set in production - without it, licence verification silently falls back to the PUBLICLY COMMITTED test keypair (platform/licensing/keys.ts), which anyone can forge a valid-looking licence against.',
    });
  }

  if (env.COOKIE_SECURE === 'false') {
    issues.push({
      variable: 'COOKIE_SECURE',
      message:
        "must not be 'false' in production - session cookies would be sent without the Secure flag over what is expected to be a TLS-terminated deployment (Architecture §6 / P3 item 8).",
    });
  }

  if (!env.DATABASE_URL) {
    issues.push({ variable: 'DATABASE_URL', message: 'must be set in production.' });
  }

  return issues;
}

/** Throws with a single, readable, multi-line message if any issue is found. Call once, early in bootstrap(). */
export function assertProductionConfigOrThrow(env: NodeJS.ProcessEnv = process.env): void {
  const issues = checkProductionConfig(env);
  if (issues.length === 0) return;
  const lines = issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n');
  throw new Error(
    `Refusing to start with NODE_ENV=production due to ${issues.length} configuration issue(s):\n${lines}\n\nSet these environment variables and restart. See .env.example for guidance.`,
  );
}
