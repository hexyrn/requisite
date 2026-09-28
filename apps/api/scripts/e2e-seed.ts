/**
 * Seeds a clean Postgres database for the Playwright E2E run (item 29):
 * drops+reapplies every migration, bootstraps a fresh organisation with
 * a real owner login, creates a distinct approver user (self-approval is
 * blocked server-side - the E2E scenario needs a genuinely different
 * account to approve with), registers/enables/licenses com.hexyrn.requisite
 * with a real Ed25519 test licence, grants both users every Requisite
 * permission, and seeds one supplier. Writes the resulting credentials to
 * e2e/fixtures/seed-output.json for the Playwright test to read.
 *
 * Run against DATABASE_URL (the real dev Postgres instance, NOT an
 * in-memory/mocked one) - this is genuine Postgres, matching every other
 * phase's testing discipline.
 */
import 'reflect-metadata';
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { setUpTestDatabase, createTestLicense } from '../src/test-utils/test-db';
import { withOrgContext } from '../src/db/org-context';
import { setPool } from '../src/db/pool';
import { BootstrapService } from '../src/bootstrap/bootstrap.service';
import { AuditService } from '../src/audit/audit.service';
import { InstallationService } from '../src/bootstrap/installation.service';
import { ApplicationRegistryService } from '../src/platform/app-registry/application-registry.service';
import { REQUISITE_APP_MANIFEST } from '../src/apps/requisite/requisite.manifest';
import { SupplierService } from '../src/apps/requisite/supplier.service';
import { RequisiteOnboardingService } from '../src/apps/requisite/requisite-onboarding.service';
import { NumberingService } from '../src/platform/numbering/numbering.service';
import { FormService } from '../src/platform/forms/form.service';
import { WorkflowService } from '../src/platform/workflow/workflow.service';
import { ApprovalService } from '../src/platform/approval/approval.service';
import { CustomFieldService } from '../src/platform/custom-fields/custom-field.service';
import { AppContextFactory } from '../src/platform/app-context.factory';
import { CapabilityResolverService } from '../src/platform/capabilities/capability-resolver.service';
import { EventPublisherService } from '../src/platform/events/event-publisher.service';
import { NotificationService } from '../src/platform/notifications/notification.service';
import { FileService } from '../src/platform/files/file.service';
import { ScheduledJobService } from '../src/platform/scheduling/scheduled-job.service';
import { TerminologyService } from '../src/platform/terminology/terminology.service';
import { hashPassword } from '../src/security/passwords';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const pool = new Pool({ connectionString, max: 10 });
  setPool(pool);
  await setUpTestDatabase(pool);

  const installationService = new InstallationService();
  const bootstrapService = new BootstrapService(new AuditService());
  const registry = new ApplicationRegistryService();
  const onboarding = new RequisiteOnboardingService(
    new NumberingService(),
    new FormService(),
    new WorkflowService(),
    new ApprovalService(),
    new CustomFieldService(),
  );
  const suppliers = new SupplierService(onboarding);
  const contextFactory = new AppContextFactory(
    new CapabilityResolverService(registry),
    new EventPublisherService(),
    new CustomFieldService(),
    new NumberingService(),
    new WorkflowService(),
    new ApprovalService(),
    new NotificationService(),
    new FileService(),
    new ScheduledJobService(),
    new TerminologyService(),
  );

  const bootstrap = await installationService.ensureInstallation(pool);
  const ownerEmail = 'owner@e2e.hexyrn.test';
  const ownerPassword = 'e2e-owner-password-123!';
  const result = await bootstrapService.completeBootstrap(
    {
      token: bootstrap.plaintextBootstrapToken!,
      organisationName: 'Northstar Engineering Ltd',
      organisationDisplayName: 'Northstar Engineering Ltd',
      defaultCurrency: 'GBP',
      timezone: 'Europe/London',
      locale: 'en-GB',
      financialYearStartMonth: 4,
      ownerEmail,
      ownerPassword,
    },
    pool,
  );
  const organisationId = result.organisationId;

  await registry.registerApp(REQUISITE_APP_MANIFEST, pool);
  await withOrgContext(
    organisationId,
    (db) => registry.enableApp(db, organisationId, REQUISITE_APP_MANIFEST.appId),
    pool,
  );
  const license = await createTestLicense(
    REQUISITE_APP_MANIFEST.appId,
    organisationId,
    REQUISITE_APP_MANIFEST.majorVersion,
  );
  await withOrgContext(
    organisationId,
    (db) =>
      registry.grantLicense(
        db,
        organisationId,
        REQUISITE_APP_MANIFEST.appId,
        REQUISITE_APP_MANIFEST.majorVersion,
        license as any,
      ),
    pool,
  );

  const approverEmail = 'approver@e2e.hexyrn.test';
  const approverPassword = 'e2e-approver-password-123!';

  await withOrgContext(
    organisationId,
    async (db) => {
      const ownerRole = await db
        .selectFrom('roles')
        .selectAll()
        .where('organisation_id', '=', organisationId)
        .where('name', '=', 'Owner')
        .executeTakeFirstOrThrow();
      for (const perm of REQUISITE_APP_MANIFEST.permissions ?? []) {
        await db
          .insertInto('role_permissions')
          .values({
            organisation_id: organisationId,
            role_id: ownerRole.id,
            permission_key: perm.key,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      const approverUser = await db
        .insertInto('user_accounts')
        .values({
          organisation_id: organisationId,
          email: approverEmail,
          password_hash: await hashPassword(approverPassword),
          is_active: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .insertInto('user_roles')
        .values({
          organisation_id: organisationId,
          user_account_id: approverUser.id,
          role_id: ownerRole.id,
        })
        .execute();
    },
    pool,
  );

  const ownerUser = await withOrgContext(
    organisationId,
    (db) =>
      db
        .selectFrom('user_accounts')
        .selectAll()
        .where('email', '=', ownerEmail)
        .executeTakeFirstOrThrow(),
    pool,
  );
  const allPerms = new Set((REQUISITE_APP_MANIFEST.permissions ?? []).map((p) => p.key));
  const supplier = await withOrgContext(
    organisationId,
    (db) =>
      suppliers.createSupplier(
        contextFactory.create(
          REQUISITE_APP_MANIFEST.appId,
          organisationId,
          allPerms,
          ownerUser.id,
          db,
        ),
        db,
        ownerUser.id,
        { name: 'Midlands Steel Supplies Ltd', email: 'sales@midlandssteel.example' },
      ),
    pool,
  );

  const output = {
    organisationId,
    ownerEmail,
    ownerPassword,
    approverEmail,
    approverPassword,
    supplierId: supplier.id,
    supplierName: supplier.name,
  };
  // fixtures/ is gitignored, so it does not exist in a fresh checkout / CI job.
  const fixturesDir = join(__dirname, '..', '..', '..', 'e2e', 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, 'seed-output.json'), JSON.stringify(output, null, 2));
  // eslint-disable-next-line no-console
  console.log('E2E seed complete:', output);

  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('E2E seed failed:', err);
  process.exit(1);
});
