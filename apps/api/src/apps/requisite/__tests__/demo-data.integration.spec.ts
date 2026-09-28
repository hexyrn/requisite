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
import { RequisitionService } from '../requisition.service';
import { PurchaseOrderService } from '../purchase-order.service';
import { GoodsReceiptService } from '../goods-receipt.service';
import { seedRequisiteDemoData } from '../demo-data';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite demo data seed (item 43) - fictional company, never auto-installed', () => {
  let pool: Pool;
  let orgA: string;

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Northstar Engineering Ltd (Demo)');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('seeds a fictional company with suppliers, a completed purchase, a genuinely partial delivery, and a draft requisition', async () => {
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
    const requisitions = new RequisitionService(onboarding);
    const purchaseOrders = new PurchaseOrderService(onboarding);
    const goodsReceipts = new GoodsReceiptService();

    const requester = await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgA,
            email: `demo-requester-${randomUUID()}@example.com`,
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );
    const approver = await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgA,
            email: `demo-approver-${randomUUID()}@example.com`,
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );

    await seedRequisiteDemoData(
      orgA,
      requester.id,
      approver.id,
      contextFactory,
      suppliers,
      requisitions,
      purchaseOrders,
      goodsReceipts,
      pool,
    );

    const allSuppliers = await withOrgContext(
      orgA,
      (db) => suppliers.listSuppliers(db, orgA),
      pool,
    );
    expect(allSuppliers.length).toBeGreaterThanOrEqual(2);
    expect(allSuppliers.some((s) => s.name.includes('Midlands Steel'))).toBe(true);

    const allReqs = await withOrgContext(
      orgA,
      (db) => requisitions.listRequisitions(db, orgA),
      pool,
    );
    expect(allReqs).toHaveLength(3); // completed, partial, draft

    const draftReq = allReqs.find((r) => r.status === 'draft');
    expect(draftReq).toBeTruthy();

    const completedReq = allReqs.find((r) => r.status === 'received');
    expect(completedReq).toBeTruthy();

    const partiallyReceivedReq = allReqs.find((r) => r.status === 'partially_received');
    expect(partiallyReceivedReq).toBeTruthy();

    // Verify the partial delivery is genuinely partial, not silently completed.
    const partialPos = await withOrgContext(
      orgA,
      (db) => purchaseOrders.listPurchaseOrders(db, orgA),
      pool,
    );
    const partialPo = partialPos.find((p) => p.status === 'partially_received');
    expect(partialPo).toBeTruthy();
    const outstanding = await withOrgContext(
      orgA,
      (db) => goodsReceipts.getOutstandingLines(db, orgA, partialPo!.id),
      pool,
    );
    expect(outstanding[0].quantityOutstanding).toBe('40'); // 100 ordered, 60 received
  });
});
