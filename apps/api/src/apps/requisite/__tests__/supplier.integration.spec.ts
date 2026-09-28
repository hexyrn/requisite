import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { AppContextFactory } from '../../../platform/app-context.factory';
import { CapabilityResolverService } from '../../../platform/capabilities/capability-resolver.service';
import { ApplicationRegistryService } from '../../../platform/app-registry/application-registry.service';
import { EventPublisherService } from '../../../platform/events/event-publisher.service';
import { CustomFieldService } from '../../../platform/custom-fields/custom-field.service';
import { NumberingService } from '../../../platform/numbering/numbering.service';
import { WorkflowService } from '../../../platform/workflow/workflow.service';
import { ApprovalService } from '../../../platform/approval/approval.service';
import { NotificationService } from '../../../platform/notifications/notification.service';
import { FileService } from '../../../platform/files/file.service';
import { ScheduledJobService } from '../../../platform/scheduling/scheduled-job.service';
import { TerminologyService } from '../../../platform/terminology/terminology.service';
import { SupplierService } from '../supplier.service';
import { RequisiteOnboardingService } from '../requisite-onboarding.service';
import { FormService } from '../../../platform/forms/form.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Requisite SupplierService - CRUD, org isolation, deactivation (item 10, item 42)',
  () => {
    let pool: Pool;
    let orgA: string;
    let orgB: string;
    const contextFactory = new AppContextFactory(
      new CapabilityResolverService(new ApplicationRegistryService()),
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
    const onboarding = new RequisiteOnboardingService(
      new NumberingService(),
      new FormService(),
      new WorkflowService(),
      new ApprovalService(),
      new CustomFieldService(),
    );
    const suppliers = new SupplierService(onboarding);

    function ctx(organisationId: string, actorId: string, permissions: string[] = []) {
      return (db: any) =>
        contextFactory.create(
          REQUISITE_APP_MANIFEST.appId,
          organisationId,
          new Set(permissions),
          actorId,
          db,
        );
    }

    async function makeUser(organisationId: string): Promise<string> {
      const row = await withOrgContext(
        organisationId,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: `sup-${randomUUID()}@example.com`,
              password_hash: 'x',
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      return row.id;
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      orgA = await createTestOrg(pool, 'Requisite Supplier Org A');
      orgB = await createTestOrg(pool, 'Requisite Supplier Org B');
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('creates a supplier with a Core-numbered supplier number', async () => {
      const actor = await makeUser(orgA);
      const supplier = await withOrgContext(
        orgA,
        (db) =>
          suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, {
            name: 'Acme Fasteners Ltd',
            email: 'sales@acme.test',
          }),
        pool,
      );
      expect(supplier.supplier_number).toMatch(/^SUP-\d{5}$/);
      expect(supplier.status).toBe('active');
    });

    it('rejects a supplier with no name', async () => {
      const actor = await makeUser(orgA);
      await expect(
        withOrgContext(
          orgA,
          (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: '   ' }),
          pool,
        ),
      ).rejects.toThrow(/name is required/i);
    });

    it('deactivating a supplier prevents further edits until reactivated', async () => {
      const actor = await makeUser(orgA);
      const supplier = await withOrgContext(
        orgA,
        (db) =>
          suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Beta Supplies' }),
        pool,
      );
      await withOrgContext(orgA, (db) => suppliers.deactivateSupplier(db, orgA, supplier.id), pool);
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            suppliers.updateSupplier(db, orgA, supplier.id, { name: 'Beta Supplies Renamed' }),
          pool,
        ),
      ).rejects.toThrow(/inactive/i);

      await withOrgContext(orgA, (db) => suppliers.reactivateSupplier(db, orgA, supplier.id), pool);
      const updated = await withOrgContext(
        orgA,
        (db) => suppliers.updateSupplier(db, orgA, supplier.id, { name: 'Beta Supplies Renamed' }),
        pool,
      );
      expect(updated.name).toBe('Beta Supplies Renamed');
    });

    it('listSuppliers excludes inactive suppliers by default', async () => {
      const actor = await makeUser(orgA);
      const supplier = await withOrgContext(
        orgA,
        (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Gamma Co' }),
        pool,
      );
      await withOrgContext(orgA, (db) => suppliers.deactivateSupplier(db, orgA, supplier.id), pool);
      const active = await withOrgContext(
        orgA,
        (db) => suppliers.listSuppliers(db, orgA, false),
        pool,
      );
      expect(active.find((s) => s.id === supplier.id)).toBeUndefined();
      const all = await withOrgContext(orgA, (db) => suppliers.listSuppliers(db, orgA, true), pool);
      expect(all.find((s) => s.id === supplier.id)).toBeTruthy();
    });

    it('ORGANISATION ISOLATION: a supplier created in org A is invisible from org B', async () => {
      const actor = await makeUser(orgA);
      const supplier = await withOrgContext(
        orgA,
        (db) =>
          suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Isolated Supplier' }),
        pool,
      );
      await expect(
        withOrgContext(orgB, (db) => suppliers.getSupplier(db, orgB, supplier.id), pool),
      ).rejects.toThrow(/not found/i);
      const listFromB = await withOrgContext(
        orgB,
        (db) => suppliers.listSuppliers(db, orgB, true),
        pool,
      );
      expect(listFromB.find((s) => s.id === supplier.id)).toBeUndefined();
    });

    it('supplier numbering is independent per organisation (each starts its own sequence)', async () => {
      const actor = await makeUser(orgB);
      const supplierInB = await withOrgContext(
        orgB,
        (db) =>
          suppliers.createSupplier(ctx(orgB, actor)(db), db, actor, {
            name: 'Org B First Supplier',
          }),
        pool,
      );
      expect(supplierInB.supplier_number).toBe('SUP-00001');
    });
  },
);
