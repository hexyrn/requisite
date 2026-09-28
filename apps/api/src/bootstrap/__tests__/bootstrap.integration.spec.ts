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
    await withOrgContext(
      completed.organisationId,
      async (db) => {
        const orgs = await db.selectFrom('organisations').selectAll().execute();
        expect(orgs).toHaveLength(1);
        expect(orgs[0].name).toBe('Acme Co');
      },
      pool,
    );
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

describeIfDb('Bootstrap: the setup token survives a restart before setup is completed', () => {
  let pool: Pool;
  const baseInput = {
    organisationName: 'Reboot Co',
    organisationDisplayName: 'Reboot Co',
    defaultCurrency: 'GBP',
    timezone: 'UTC',
    locale: 'en-GB',
    financialYearStartMonth: 1,
    ownerEmail: 'owner@reboot.test',
    ownerPassword: 'a-very-strong-password-123',
  };

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 3 }));
    await setUpTestDatabase(pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('a reboot before setup issues a fresh working token and invalidates the lost one; after setup nothing is re-issued', async () => {
    const svc = new InstallationService();
    const bootstrap = new BootstrapService(new AuditService());

    const first = await svc.ensureInstallation(pool);
    // Operator never saw the first token (container recreated / log lost) and restarts the API.
    const second = await svc.ensureInstallation(pool);
    expect(second.installationId).toBe(first.installationId);
    expect(second.plaintextBootstrapToken).toBeDefined();
    expect(second.plaintextBootstrapToken).not.toBe(first.plaintextBootstrapToken);

    // The old token no longer works - a re-issue must not leave two valid tokens around.
    await expect(
      bootstrap.completeBootstrap({ ...baseInput, token: first.plaintextBootstrapToken! }, pool),
    ).rejects.toThrow(/invalid, already used, or expired/i);

    // The new one completes setup.
    const done = await bootstrap.completeBootstrap(
      { ...baseInput, token: second.plaintextBootstrapToken! },
      pool,
    );
    expect(done.organisationId).toBeDefined();

    // Setup is complete: further boots issue nothing.
    expect((await svc.ensureInstallation(pool)).plaintextBootstrapToken).toBeUndefined();
  });
});
