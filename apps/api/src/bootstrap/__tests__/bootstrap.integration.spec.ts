import { Pool } from 'pg';
import { setUpTestDatabase } from '../../test-utils/test-db';
import { attachPoolErrorHandler } from '../../db/pool';
import { InstallationService } from '../installation.service';
import { BootstrapService } from '../bootstrap.service';
import { AuditService } from '../../audit/audit.service';
import { withOrgContext } from '../../db/org-context';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Bootstrap: secure one-time setup token (P0 item 6)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 3 }));
    await setUpTestDatabase(pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('generates a token on first run, completes setup once, and permanently invalidates the token', async () => {
    const installationService = new InstallationService();
    const result = await installationService.ensureInstallation(pool);
    expect(result.plaintextBootstrapToken).toBeDefined();

    const bootstrapService = new BootstrapService(new AuditService());
    const input = {
      token: result.plaintextBootstrapToken!,
      organisationName: 'Acme Co',
      organisationDisplayName: 'Acme Co',
      defaultCurrency: 'USD',
      timezone: 'UTC',
      locale: 'en-US',
      financialYearStartMonth: 1,
      ownerEmail: 'owner@acme.test',
      ownerPassword: 'a-very-strong-password-123',
    };

    const completed = await bootstrapService.completeBootstrap(input, pool);
    expect(completed.organisationId).toBeDefined();
    expect(completed.ownerUserAccountId).toBeDefined();

    // THE required test: reusing the same token must fail.
    await expect(
      bootstrapService.completeBootstrap(
        { ...input, organisationName: 'Second Attempt', ownerEmail: 'second@acme.test' },
        pool,
      ),
    ).rejects.toThrow(/invalid, already used, or expired/i);

    // And a second organisation must NOT have been created by the reuse attempt.
    await withOrgContext(completed.organisationId, async (db) => {
      const orgs = await db.selectFrom('organisations').selectAll().execute();
      expect(orgs).toHaveLength(1);
      expect(orgs[0].name).toBe('Acme Co');
    }, pool);
  });

  it('a second ensureInstallation() call does not generate a new token (idempotent on already-bootstrapped installs)', async () => {
    const installationService = new InstallationService();
    const result = await installationService.ensureInstallation(pool);
    expect(result.plaintextBootstrapToken).toBeUndefined();
  });

  it('rejects an invalid/garbage token outright', async () => {
    const bootstrapService = new BootstrapService(new AuditService());
    await expect(
      bootstrapService.completeBootstrap(
        {
          token: 'not-a-real-token',
          organisationName: 'X',
          organisationDisplayName: 'X',
          defaultCurrency: 'USD',
          timezone: 'UTC',
          locale: 'en-US',
          financialYearStartMonth: 1,
          ownerEmail: 'x@x.test',
          ownerPassword: 'password-123456',
        },
        pool,
      ),
    ).rejects.toThrow(/invalid, already used, or expired/i);
  });
});
