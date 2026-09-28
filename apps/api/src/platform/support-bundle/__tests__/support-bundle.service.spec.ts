import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { withOrgContext } from '../../../db/org-context';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { attachPoolErrorHandler } from '../../../db/pool';
import {
  SupportBundleService,
  redactBundleDeep,
  scrubFreeText,
  SUPPORT_BUNDLE_CATEGORIES,
} from '../support-bundle.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * "Test aggressively for secret leakage - include canary test secrets
 * (fake passwords, session tokens, API keys, webhook secrets, TOTP
 * secrets, SMTP credentials, integration credentials) and prove the
 * generated bundle contains none of them" - this file does exactly that,
 * against a real database with real rows containing real canary strings,
 * and asserts the ENTIRE serialized bundle (JSON.stringify, not just
 * individual fields) never contains any of them as a substring.
 */
describeIfDb('SupportBundleService (P3 item 21/8) - canary secret-leakage tests', () => {
  let pool: Pool;
  let organisationId: string;

  // A distinct, unmistakable canary value per secret category - grepped for
  // verbatim in the serialized bundle at the end of every test.
  const CANARIES = {
    userPassword: 'CANARY-PASSWORD-h9x2KzQ7mLpN4vRt',
    sessionToken: 'CANARY-SESSION-TOKEN-8fD3jXqW1oYbZc',
    apiKey: 'CANARY-API-KEY-hxk_5mNpQrTsUvWxYz',
    webhookSigningKey: 'CANARY-WEBHOOK-SIGNING-KEY-9pLqRxTz',
    totpSecret: 'CANARY-TOTP-SECRET-JBSWY3DPEHPK3PXP',
    smtpCredential: 'CANARY-SMTP-PASSWORD-aB3dE6fG9hJ2',
    integrationCredential: 'CANARY-INTEGRATION-SECRET-mQ7rS4tU1vW',
  };

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 5 }));
    await setUpTestDatabase(pool);
    // setUpTestDatabase() replays every migration .sql file directly (drop
    // everything, reapply) rather than going through the real CLI runner
    // (apps/api/src/db/migrate.ts), so it never creates/populates the
    // schema_migrations bookkeeping table that migrate.ts maintains in a
    // real deployment. SupportBundleService.generate() queries that table
    // for real (it exists in production) - simulate it here so this test
    // exercises the real query path rather than skipping it.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await pool.query(
      `INSERT INTO schema_migrations (filename) VALUES ('0001_test.sql'), ('0002_test.sql') ON CONFLICT DO NOTHING`,
    );
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    organisationId = randomUUID();
    await withOrgContext(
      organisationId,
      async (db) => {
        const { hashPassword } = await import('../../../security/passwords');
        await db
          .insertInto('organisations')
          .values({
            id: organisationId,
            installation_id: await ensureInstallation(db as any),
            name: `support-bundle-test-${organisationId}`,
            display_name: 'Support Bundle Test Org',
            default_currency: 'USD',
            timezone: 'UTC',
            locale: 'en-US',
            financial_year_start_month: 1,
          } as any)
          .execute();

        // A real user with a real password hash + TOTP secret + a canary
        // hidden in their password (this row is never selected by the
        // support bundle service, which is exactly the point being proven).
        await db
          .insertInto('user_accounts')
          .values({
            organisation_id: organisationId,
            email: 'canary-user@e2e.test',
            password_hash: await hashPassword(CANARIES.userPassword),
            is_active: true,
            mfa_enabled: true,
            totp_secret_encrypted: `v2.fake.fake.fake.fake.fake.${Buffer.from(CANARIES.totpSecret).toString('base64')}`,
          })
          .execute();
      },
      pool,
    );

    // Seed a connector registration (installation-level, no RLS) for the integration connection FK.
    await pool.query(
      `INSERT INTO connector_registrations (connector_id, display_name, supported_entities, supported_directions, config_schema)
       VALUES ($1, 'Canary Connector', '{}', '{outbound}', '[]')
       ON CONFLICT (connector_id) DO NOTHING`,
      ['com.hexyrn.connector.canary-test'],
    );
  });

  function serialize(bundle: unknown): string {
    return JSON.stringify(bundle);
  }

  function assertNoCanariesLeak(serialized: string) {
    for (const [name, value] of Object.entries(CANARIES)) {
      expect(serialized).not.toContain(value);
      // Sanity: also not present in any obviously-decoded form for the base64-embedded TOTP canary.
      if (name === 'totpSecret') {
        expect(serialized).not.toContain(Buffer.from(value).toString('base64'));
      }
    }
  }

  it('preview: lists every category before generation, including an honest "logs not available" entry', () => {
    const service = new SupportBundleService();
    const categories = service.previewCategories();
    expect(categories.length).toBeGreaterThan(0);
    expect(categories).toEqual(SUPPORT_BUNDLE_CATEGORIES);
    const logsCategory = categories.find((c) => c.key === 'logs');
    expect(logsCategory?.description).toMatch(/not yet available/i);
  });

  it('a bundle generated for an org with NO failures at all contains none of the seeded canaries', async () => {
    const service = new SupportBundleService();
    const bundle = await withOrgContext(
      organisationId,
      (db) => service.generate(db, pool, organisationId),
      pool,
    );
    assertNoCanariesLeak(serialize(bundle));
    expect(bundle.installedApps).toBeDefined();
    expect(bundle.health.databaseConnectivity).toBe(true);
  });

  it('a webhook signing key never appears in the bundle, even though a delivery for that endpoint failed', async () => {
    await withOrgContext(
      organisationId,
      async (db) => {
        const endpoint = await db
          .insertInto('webhook_endpoints')
          .values({
            organisation_id: organisationId,
            url: 'https://example.com/hook',
            event_types: ['requisition.approved'],
            secret_hash: 'unrelated-hash-value',
            signing_key_encrypted: CANARIES.webhookSigningKey, // simulates the encrypted-at-rest column - even "encrypted" values must never appear
            is_enabled: true,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await db
          .insertInto('webhook_deliveries')
          .values({
            organisation_id: organisationId,
            endpoint_id: endpoint.id,
            event_id: randomUUID(),
            event_type: 'requisition.approved',
            status: 'failed',
            last_error: `delivery failed: upstream rejected with 401, request had header Authorization: Bearer ${CANARIES.apiKey}`, // realistic: an error message that echoes a credential
          })
          .execute();
      },
      pool,
    );

    const service = new SupportBundleService();
    const bundle = await withOrgContext(
      organisationId,
      (db) => service.generate(db, pool, organisationId),
      pool,
    );
    const serialized = serialize(bundle);

    // The failure summary itself IS expected to be present (that's the feature)...
    expect(bundle.webhookFailures.length).toBe(1);
    expect(bundle.webhookFailures[0].failedDeliveryCount).toBe(1);
    // ...but the webhook signing key must never appear anywhere, and the
    // API-key-shaped canary embedded inside the free-text error message
    // must be caught by the second redaction layer even though it lives
    // inside a field (last_error) this module DOES legitimately include.
    assertNoCanariesLeak(serialized);
  });

  it("an integration connection's encrypted secrets never appear, even when the connection is in an error state", async () => {
    await withOrgContext(
      organisationId,
      async (db) => {
        await db
          .insertInto('integration_connections')
          .values({
            organisation_id: organisationId,
            connector_id: 'com.hexyrn.connector.canary-test',
            display_name: 'Canary Integration',
            config: { endpoint: 'https://erp.example.com' },
            config_secrets_encrypted: {
              apiSecret: CANARIES.integrationCredential,
              smtpPassword: CANARIES.smtpCredential,
            },
            status: 'error',
            last_error: 'authentication failed',
          })
          .execute();
      },
      pool,
    );

    const service = new SupportBundleService();
    const bundle = await withOrgContext(
      organisationId,
      (db) => service.generate(db, pool, organisationId),
      pool,
    );
    const serialized = serialize(bundle);

    expect(bundle.integrationFailures.length).toBe(1);
    assertNoCanariesLeak(serialized);
  });

  it('a job failure error message that echoes a session token is still safe in the final bundle', async () => {
    await withOrgContext(
      organisationId,
      async (db) => {
        await db
          .insertInto('scheduled_jobs')
          .values({
            organisation_id: organisationId,
            app_id: 'com.hexyrn.requisite',
            job_type: 'delivery-monitoring',
            status: 'failed',
            last_error: `job failed while impersonating session ${CANARIES.sessionToken}`,
          })
          .execute();
      },
      pool,
    );

    const service = new SupportBundleService();
    const bundle = await withOrgContext(
      organisationId,
      (db) => service.generate(db, pool, organisationId),
      pool,
    );
    const serialized = serialize(bundle);

    expect(bundle.jobFailures.length).toBe(1);
    assertNoCanariesLeak(serialized);
  });

  describe('redactBundleDeep - the second, independent layer, tested in isolation', () => {
    it('redacts any key matching the sensitive-key pattern at any nesting depth', () => {
      const input = {
        safe: 'this stays',
        password: 'should be gone',
        nested: {
          apiKey: 'should also be gone',
          deeplyNested: { webhookSecret: 'gone too', totp_secret: 'gone', ordinary: 'kept' },
        },
        items: [{ token: 'gone' }, { fine: 'kept' }], // key deliberately does NOT match the sensitive-key pattern itself, so this exercises per-element recursion into the array rather than the whole array being redacted at the "items" key level
      };
      const result = redactBundleDeep(input) as any;
      expect(result.safe).toBe('this stays');
      expect(result.password).toBe('[REDACTED]');
      expect(result.nested.apiKey).toBe('[REDACTED]');
      expect(result.nested.deeplyNested.webhookSecret).toBe('[REDACTED]');
      expect(result.nested.deeplyNested.totp_secret).toBe('[REDACTED]');
      expect(result.nested.deeplyNested.ordinary).toBe('kept');
      expect(result.items[0].token).toBe('[REDACTED]');
      expect(result.items[1].fine).toBe('kept');
    });

    it('redacts an entire subtree, including nested non-secret-looking fields, when the PARENT key itself matches the sensitive pattern - aggressive by design', () => {
      // A key like "webhookSecrets" containing further structure (not just
      // a string) is blanked wholesale rather than recursed into - the
      // safer failure mode for a second redaction layer is over-redaction,
      // never under-redaction.
      const input = {
        webhookSecrets: { innocuousLookingField: 'not obviously sensitive on its own' },
      };
      const result = redactBundleDeep(input) as any;
      expect(result.webhookSecrets).toBe('[REDACTED]');
    });
  });

  describe('scrubFreeText - value-based redaction for free-text error messages (real leak found and fixed via this test file)', () => {
    it('redacts a contextually-labelled credential (Authorization: Bearer <token>)', () => {
      const text = `upstream rejected with 401, request had header Authorization: Bearer ${CANARIES.apiKey}`;
      expect(scrubFreeText(text)).not.toContain(CANARIES.apiKey);
    });

    it('redacts a bare opaque token with NO contextual label at all, via the generic token-shape fallback', () => {
      const text = `job failed while impersonating session ${CANARIES.sessionToken}`;
      expect(scrubFreeText(text)).not.toContain(CANARIES.sessionToken);
    });

    it('leaves ordinary, non-secret-shaped error text untouched', () => {
      const text = 'connection timed out after 30 seconds';
      expect(scrubFreeText(text)).toBe(text);
    });
  });
});

async function ensureInstallation(db: any): Promise<string> {
  const existing = await db.selectFrom('installations').select(['id']).executeTakeFirst();
  if (existing) return existing.id;
  const inserted = await db
    .insertInto('installations')
    .values({ core_version: '0.1.0-test' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}
