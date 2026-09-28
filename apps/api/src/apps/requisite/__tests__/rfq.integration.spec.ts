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
import { FormService } from '../../../platform/forms/form.service';
import { RequisiteOnboardingService } from '../requisite-onboarding.service';
import { SupplierService } from '../supplier.service';
import { RfqService } from '../rfq.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite RfqService - quote comparison and selection (item 9)', () => {
  let pool: Pool;
  let orgA: string;
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
  const rfqs = new RfqService(onboarding);

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
            email: `rfq-${randomUUID()}@example.com`,
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
    orgA = await createTestOrg(pool, 'Requisite RFQ Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('records quotes from multiple suppliers and lists them sorted by total for comparison', async () => {
    const actor = await makeUser(orgA);
    const rfq = await withOrgContext(
      orgA,
      (db) => rfqs.createRfq(ctx(orgA, actor)(db), db, actor),
      pool,
    );
    const supplierCheap = await withOrgContext(
      orgA,
      (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Cheap Co' }),
      pool,
    );
    const supplierExpensive = await withOrgContext(
      orgA,
      (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Premium Co' }),
      pool,
    );

    await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplierExpensive.id,
          lines: [{ description: 'Item', quantity: '10', unitPriceMinor: '1000' }],
        }),
      pool,
    ); // £100
    await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplierCheap.id,
          lines: [{ description: 'Item', quantity: '10', unitPriceMinor: '500' }],
        }),
      pool,
    ); // £50

    const comparison = await withOrgContext(
      orgA,
      (db) => rfqs.listQuotesForRfq(db, orgA, rfq.id),
      pool,
    );
    expect(comparison).toHaveLength(2);
    expect(comparison[0].total_minor).toBe('5000'); // cheapest first
    expect(comparison[1].total_minor).toBe('10000');
  });

  it('selecting a quote records the reason, closes the RFQ, and demotes a previously-selected quote', async () => {
    const actor = await makeUser(orgA);
    const rfq = await withOrgContext(
      orgA,
      (db) => rfqs.createRfq(ctx(orgA, actor)(db), db, actor),
      pool,
    );
    const supplierA = await withOrgContext(
      orgA,
      (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Supplier A' }),
      pool,
    );
    const supplierB = await withOrgContext(
      orgA,
      (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Supplier B' }),
      pool,
    );
    const quoteA = await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplierA.id,
          lines: [{ description: 'X', quantity: '1', unitPriceMinor: '100' }],
        }),
      pool,
    );
    const quoteB = await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplierB.id,
          lines: [{ description: 'X', quantity: '1', unitPriceMinor: '200' }],
        }),
      pool,
    );

    await withOrgContext(
      orgA,
      (db) => rfqs.selectQuote(db, orgA, rfq.id, quoteA.id, 'Cheapest and fastest delivery'),
      pool,
    );
    let selected = await withOrgContext(
      orgA,
      (db) => rfqs.listQuotesForRfq(db, orgA, rfq.id),
      pool,
    );
    expect(selected.find((q) => q.id === quoteA.id)!.status).toBe('selected');
    expect(selected.find((q) => q.id === quoteA.id)!.selection_reason).toBe(
      'Cheapest and fastest delivery',
    );

    const closedRfq = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('requisite_rfqs')
          .selectAll()
          .where('id', '=', rfq.id)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(closedRfq.status).toBe('closed');

    // Human changes their mind and selects B instead - A is demoted, only one 'selected' at a time.
    await withOrgContext(
      orgA,
      (db) =>
        db.updateTable('requisite_rfqs').set({ status: 'open' }).where('id', '=', rfq.id).execute(),
      pool,
    );
    await withOrgContext(orgA, (db) => rfqs.selectQuote(db, orgA, rfq.id, quoteB.id), pool);
    selected = await withOrgContext(orgA, (db) => rfqs.listQuotesForRfq(db, orgA, rfq.id), pool);
    expect(selected.find((q) => q.id === quoteB.id)!.status).toBe('selected');
    expect(selected.find((q) => q.id === quoteA.id)!.status).toBe('received');
    expect(selected.filter((q) => q.status === 'selected')).toHaveLength(1);
  });

  it('rejects a quote against a closed RFQ', async () => {
    const actor = await makeUser(orgA);
    const rfq = await withOrgContext(
      orgA,
      (db) => rfqs.createRfq(ctx(orgA, actor)(db), db, actor),
      pool,
    );
    const supplier = await withOrgContext(
      orgA,
      (db) => suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Late Supplier' }),
      pool,
    );
    const quote = await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplier.id,
          lines: [{ description: 'X', quantity: '1', unitPriceMinor: '100' }],
        }),
      pool,
    );
    await withOrgContext(orgA, (db) => rfqs.selectQuote(db, orgA, rfq.id, quote.id), pool); // closes the RFQ

    const lateSupplier = await withOrgContext(
      orgA,
      (db) =>
        suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Too Late Supplier' }),
      pool,
    );
    await expect(
      withOrgContext(
        orgA,
        (db) =>
          rfqs.recordQuote(db, orgA, rfq.id, {
            supplierId: lateSupplier.id,
            lines: [{ description: 'X', quantity: '1', unitPriceMinor: '50' }],
          }),
        pool,
      ),
    ).rejects.toThrow(/closed/i);
  });

  it('rejectQuote marks a quote rejected without affecting others', async () => {
    const actor = await makeUser(orgA);
    const rfq = await withOrgContext(
      orgA,
      (db) => rfqs.createRfq(ctx(orgA, actor)(db), db, actor),
      pool,
    );
    const supplier = await withOrgContext(
      orgA,
      (db) =>
        suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Rejected Supplier' }),
      pool,
    );
    const quote = await withOrgContext(
      orgA,
      (db) =>
        rfqs.recordQuote(db, orgA, rfq.id, {
          supplierId: supplier.id,
          lines: [{ description: 'X', quantity: '1', unitPriceMinor: '999' }],
        }),
      pool,
    );
    const rejected = await withOrgContext(orgA, (db) => rfqs.rejectQuote(db, orgA, quote.id), pool);
    expect(rejected.status).toBe('rejected');
  });

  it('ORGANISATION ISOLATION: an RFQ in org A is invisible from org B', async () => {
    const orgB = await createTestOrg(pool, 'Requisite RFQ Isolation Org B');
    const actor = await makeUser(orgA);
    const rfq = await withOrgContext(
      orgA,
      (db) => rfqs.createRfq(ctx(orgA, actor)(db), db, actor),
      pool,
    );
    const supplier = await withOrgContext(
      orgA,
      (db) =>
        suppliers.createSupplier(ctx(orgA, actor)(db), db, actor, { name: 'Isolation Supplier' }),
      pool,
    );
    await expect(
      withOrgContext(
        orgB,
        (db) =>
          rfqs.recordQuote(db, orgB, rfq.id, {
            supplierId: supplier.id,
            lines: [{ description: 'X', quantity: '1', unitPriceMinor: '1' }],
          }),
        pool,
      ),
    ).rejects.toThrow(/not found/i);
  });
});
