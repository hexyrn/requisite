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
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Requisite GoodsReceiptService - partial delivery, over-receipt prevention, concurrency (items 5/39/42)',
  () => {
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
    const requisitions = new RequisitionService(onboarding);
    const purchaseOrders = new PurchaseOrderService(onboarding);
    const goodsReceipts = new GoodsReceiptService();

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
              email: `grn-${randomUUID()}@example.com`,
              password_hash: 'x',
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      return row.id;
    }

    async function makeIssuedPo(quantityOrdered = '100') {
      const requester = await makeUser(orgA);
      const approver = await makeUser(orgA);
      const req = await withOrgContext(
        orgA,
        (db) =>
          requisitions.createRequisition(
            ctx(orgA, requester, ['requisite.requisitions.submit'])(db),
            db,
            requester,
            {
              reason: 'GRN test requisition',
              lines: [
                {
                  description: 'Item A',
                  quantity: quantityOrdered,
                  estimatedUnitPriceMinor: '500',
                },
              ],
            },
          ),
        pool,
      );
      const { approval } = await withOrgContext(
        orgA,
        (db) =>
          requisitions.submitRequisition(
            ctx(orgA, requester, ['requisite.requisitions.submit'])(db),
            db,
            requester,
            req.id,
            req.version,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', approval.requestId)
            .where('status', '=', 'pending')
            .executeTakeFirstOrThrow(),
        pool,
      );
      await withOrgContext(
        orgA,
        (db) =>
          requisitions.decide(
            ctx(orgA, approver, ['requisite.requisitions.approve'])(db),
            db,
            approver,
            req.id,
            step.id,
            'approve',
          ),
        pool,
      );
      const supplier = await withOrgContext(
        orgA,
        (db) =>
          suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, {
            name: `GRN Test Supplier ${randomUUID()}`,
          }),
        pool,
      );
      const po = await withOrgContext(
        orgA,
        (db) =>
          purchaseOrders.generateFromRequisition(
            ctx(orgA, requester, ['requisite.purchase-orders.create'])(db),
            db,
            requester,
            req.id,
            {
              supplierId: supplier.id,
              lines: [{ description: 'Item A', quantityOrdered, unitPriceMinor: '500' }],
            },
          ),
        pool,
      );
      const issued = await withOrgContext(
        orgA,
        (db) =>
          purchaseOrders.issue(
            ctx(orgA, requester, ['requisite.purchase-orders.issue'])(db),
            db,
            requester,
            po.id,
            po.version,
          ),
        pool,
      );
      const poWithLines = await withOrgContext(
        orgA,
        (db) => purchaseOrders.getPurchaseOrder(db, orgA, po.id),
        pool,
      );
      return { requester, approver, req, po: issued, poLine: poWithLines.lines[0] };
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
      await setUpTestDatabase(pool);
      orgA = await createTestOrg(pool, 'Requisite GRN Org A');
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('PARTIAL DELIVERY: first receipt of 60 leaves the PO partially_received with 40 outstanding', async () => {
      const { requester, po, poLine } = await makeIssuedPo('100');
      const grn = await withOrgContext(
        orgA,
        (db) =>
          goodsReceipts.recordReceipt(
            ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
            db,
            requester,
            po.id,
            { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '60' }] },
          ),
        pool,
      );
      expect(grn.grn_number).toMatch(/^GRN-\d{6}$/);

      const updatedPo = await withOrgContext(
        orgA,
        (db) => purchaseOrders.getPurchaseOrderRaw(db, orgA, po.id),
        pool,
      );
      expect(updatedPo.status).toBe('partially_received');

      const outstanding = await withOrgContext(
        orgA,
        (db) => goodsReceipts.getOutstandingLines(db, orgA, po.id),
        pool,
      );
      expect(outstanding[0].quantityOutstanding).toBe('40');
    });

    it('MULTIPLE RECEIPTS: a second receipt of the remaining 40 completes the PO to "received" and the requisition to "received", without mutating the first receipt', async () => {
      const { requester, req, po, poLine } = await makeIssuedPo('100');
      const firstGrn = await withOrgContext(
        orgA,
        (db) =>
          goodsReceipts.recordReceipt(
            ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
            db,
            requester,
            po.id,
            { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '60' }] },
          ),
        pool,
      );
      const secondGrn = await withOrgContext(
        orgA,
        (db) =>
          goodsReceipts.recordReceipt(
            ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
            db,
            requester,
            po.id,
            { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '40' }] },
          ),
        pool,
      );

      // Both receipts remain distinct, immutable historical records - never merged.
      expect(firstGrn.id).not.toBe(secondGrn.id);
      const allReceipts = await withOrgContext(
        orgA,
        (db) => goodsReceipts.listGoodsReceiptsForPo(db, orgA, po.id),
        pool,
      );
      expect(allReceipts).toHaveLength(2);
      expect(allReceipts.find((r) => r.id === firstGrn.id)).toBeTruthy();
      expect(allReceipts.find((r) => r.id === secondGrn.id)).toBeTruthy();

      const finalPo = await withOrgContext(
        orgA,
        (db) => purchaseOrders.getPurchaseOrderRaw(db, orgA, po.id),
        pool,
      );
      expect(finalPo.status).toBe('received');

      const finalReq = await withOrgContext(
        orgA,
        (db) => requisitions.getRequisitionRaw(db, orgA, req.id),
        pool,
      );
      expect(finalReq.status).toBe('received');
    });

    it('OVER-RECEIPT PREVENTION: rejects a receipt that would exceed the ordered quantity', async () => {
      const { requester, po, poLine } = await makeIssuedPo('100');
      await withOrgContext(
        orgA,
        (db) =>
          goodsReceipts.recordReceipt(
            ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
            db,
            requester,
            po.id,
            { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '90' }] },
          ),
        pool,
      );
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            goodsReceipts.recordReceipt(
              ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
              db,
              requester,
              po.id,
              { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '20' }] },
            ),
          pool,
        ),
      ).rejects.toThrow(/only 10 is outstanding/i);
    });

    it('rejects a zero/negative receipt quantity', async () => {
      const { requester, po, poLine } = await makeIssuedPo('100');
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            goodsReceipts.recordReceipt(
              ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
              db,
              requester,
              po.id,
              { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '0' }] },
            ),
          pool,
        ),
      ).rejects.toThrow(/greater than zero/i);
    });

    it('CONCURRENCY (item 39, database-enforced): two SIMULTANEOUS receipts that together would exceed the ordered quantity - exactly one is accepted in full, the other is rejected, never a silent over-receipt', async () => {
      const { requester, po, poLine } = await makeIssuedPo('100');
      // Two concurrent receipts of 60 each against a 100-line: together they
      // would total 120 (over-receipt) - the race-safe atomic UPDATE must
      // ensure only ONE of them can succeed once the other has committed 60.
      const results = await Promise.allSettled([
        withOrgContext(
          orgA,
          (db) =>
            goodsReceipts.recordReceipt(
              ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
              db,
              requester,
              po.id,
              { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '60' }] },
            ),
          pool,
        ),
        withOrgContext(
          orgA,
          (db) =>
            goodsReceipts.recordReceipt(
              ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
              db,
              requester,
              po.id,
              { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '60' }] },
            ),
          pool,
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const finalLine = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('requisite_purchase_order_lines')
            .selectAll()
            .where('id', '=', poLine.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(Number(finalLine.quantity_received)).toBeLessThanOrEqual(100); // the DB CHECK constraint's own guarantee, verified end to end
      expect(Number(finalLine.quantity_received)).toBe(60); // exactly one of the two 60-unit receipts landed
    });

    it('cannot receive against a PO that has not been issued', async () => {
      const requester = await makeUser(orgA);
      const approver = await makeUser(orgA);
      const req = await withOrgContext(
        orgA,
        (db) =>
          requisitions.createRequisition(
            ctx(orgA, requester, ['requisite.requisitions.submit'])(db),
            db,
            requester,
            {
              reason: 'Draft PO test',
              lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }],
            },
          ),
        pool,
      );
      const { approval } = await withOrgContext(
        orgA,
        (db) =>
          requisitions.submitRequisition(
            ctx(orgA, requester, ['requisite.requisitions.submit'])(db),
            db,
            requester,
            req.id,
            req.version,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', approval.requestId)
            .where('status', '=', 'pending')
            .executeTakeFirstOrThrow(),
        pool,
      );
      await withOrgContext(
        orgA,
        (db) =>
          requisitions.decide(
            ctx(orgA, approver, ['requisite.requisitions.approve'])(db),
            db,
            approver,
            req.id,
            step.id,
            'approve',
          ),
        pool,
      );
      const supplier = await withOrgContext(
        orgA,
        (db) =>
          suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, {
            name: 'Draft PO Supplier',
          }),
        pool,
      );
      const po = await withOrgContext(
        orgA,
        (db) =>
          purchaseOrders.generateFromRequisition(
            ctx(orgA, requester, ['requisite.purchase-orders.create'])(db),
            db,
            requester,
            req.id,
            {
              supplierId: supplier.id,
              lines: [{ description: 'X', quantityOrdered: '1', unitPriceMinor: '100' }],
            },
          ),
        pool,
      );

      await expect(
        withOrgContext(
          orgA,
          (db) =>
            goodsReceipts.recordReceipt(
              ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
              db,
              requester,
              po.id,
              { lines: [{ purchaseOrderLineId: po.lines[0].id, quantityReceived: '1' }] },
            ),
          pool,
        ),
      ).rejects.toThrow(/status "draft"/i);
    });

    it('ORGANISATION ISOLATION: a goods receipt in org A is invisible from org B', async () => {
      const orgB = await createTestOrg(pool, 'Requisite GRN Isolation Org B');
      const { requester, po, poLine } = await makeIssuedPo('10');
      const grn = await withOrgContext(
        orgA,
        (db) =>
          goodsReceipts.recordReceipt(
            ctx(orgA, requester, ['requisite.goods-receipts.create'])(db),
            db,
            requester,
            po.id,
            { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '10' }] },
          ),
        pool,
      );
      await expect(
        withOrgContext(orgB, (db) => goodsReceipts.getGoodsReceipt(db, orgB, grn.id), pool),
      ).rejects.toThrow(/not found/i);
    });
  },
);
