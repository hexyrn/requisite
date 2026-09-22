import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { getPool } from '../../db/pool';
import { withOrgContext } from '../../db/org-context';
import { Database } from '../../db/types';
import { AppContextFactory } from '../../platform/app-context.factory';
import { SupplierService } from './supplier.service';
import { RequisitionService } from './requisition.service';
import { PurchaseOrderService } from './purchase-order.service';
import { GoodsReceiptService } from './goods-receipt.service';
import { REQUISITE_APP_MANIFEST } from './requisite.manifest';

const APP_ID = REQUISITE_APP_MANIFEST.appId;

/**
 * Item 43 - optional dev/demo seed data for a FICTIONAL company only.
 * NEVER auto-installed in production - this function is only ever called
 * from an explicit dev/demo script (see scripts/seed-requisite-demo.ts),
 * never from main.ts's boot sequence.
 *
 * "Northstar Engineering Ltd" - a fictional SME with two fictional sites
 * (Coventry Works, Birmingham Service Centre), fictional suppliers, and a
 * full purchasing lifecycle including a genuinely partial delivery, so the
 * seeded data demonstrates every state the domain model supports.
 */
export async function seedRequisiteDemoData(
  organisationId: string,
  requesterUserAccountId: string,
  approverUserAccountId: string,
  contextFactory: AppContextFactory,
  suppliers: SupplierService,
  requisitions: RequisitionService,
  purchaseOrders: PurchaseOrderService,
  goodsReceipts: GoodsReceiptService,
  pool: Pool = getPool(),
): Promise<void> {
  const allPerms = new Set(REQUISITE_APP_MANIFEST.permissions?.map((p) => p.key) ?? []);
  const ctx = (db: Kysely<Database>, actorId: string) => contextFactory.create(APP_ID, organisationId, allPerms, actorId, db);

  await withOrgContext(
    organisationId,
    async (db) => {
      const midlandsSteel = await suppliers.createSupplier(ctx(db, requesterUserAccountId), db, requesterUserAccountId, { name: 'Midlands Steel Supplies Ltd', email: 'sales@midlandssteel.example', phone: '024 7000 1234', paymentTerms: 'Net 30' });
      await suppliers.createSupplier(ctx(db, requesterUserAccountId), db, requesterUserAccountId, { name: 'Coventry Safety Equipment Co', email: 'orders@coventrysafety.example', paymentTerms: 'Net 14' });

      // A fully completed purchase: requisition -> approval -> PO -> single full receipt.
      const completedReq = await requisitions.createRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, {
        reason: 'Replacement stock for Coventry Works production line',
        category: 'Materials',
        currency: 'GBP',
        lines: [{ description: 'Galvanised Steel Brackets (Grade A)', quantity: '200', unit: 'each', estimatedUnitPriceMinor: '350' }],
      });
      let { approval } = await requisitions.submitRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, completedReq.id, completedReq.version);
      let step = await db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow();
      await requisitions.decide(ctx(db, approverUserAccountId), db, approverUserAccountId, completedReq.id, step.id, 'approve');
      const completedPo = await purchaseOrders.generateFromRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, completedReq.id, { supplierId: midlandsSteel.id, lines: [{ description: 'Galvanised Steel Brackets (Grade A)', quantityOrdered: '200', unitPriceMinor: '350', taxRateBp: 2000 }] });
      const issuedCompletedPo = await purchaseOrders.issue(ctx(db, requesterUserAccountId), db, requesterUserAccountId, completedPo.id, completedPo.version);
      await goodsReceipts.recordReceipt(ctx(db, requesterUserAccountId), db, requesterUserAccountId, issuedCompletedPo.id, { lines: [{ purchaseOrderLineId: completedPo.lines[0].id, quantityReceived: '200' }], deliveryNoteReference: 'DN-88213' });

      // A genuinely PARTIALLY delivered order - demonstrates item 5's first-class partial delivery.
      const partialReq = await requisitions.createRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, {
        reason: 'PPE restock for Birmingham Service Centre',
        category: 'PPE',
        currency: 'GBP',
        lines: [{ description: 'Hi-Vis Jackets (Large)', quantity: '100', unit: 'each', estimatedUnitPriceMinor: '1200' }],
      });
      ({ approval } = await requisitions.submitRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, partialReq.id, partialReq.version));
      step = await db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow();
      await requisitions.decide(ctx(db, approverUserAccountId), db, approverUserAccountId, partialReq.id, step.id, 'approve');
      const partialPo = await purchaseOrders.generateFromRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, partialReq.id, { supplierId: midlandsSteel.id, lines: [{ description: 'Hi-Vis Jackets (Large)', quantityOrdered: '100', unitPriceMinor: '1200' }] });
      const issuedPartialPo = await purchaseOrders.issue(ctx(db, requesterUserAccountId), db, requesterUserAccountId, partialPo.id, partialPo.version);
      await goodsReceipts.recordReceipt(ctx(db, requesterUserAccountId), db, requesterUserAccountId, issuedPartialPo.id, { lines: [{ purchaseOrderLineId: partialPo.lines[0].id, quantityReceived: '60' }], deliveryNoteReference: 'DN-88301' }); // only 60 of 100 delivered so far - deliberately left partial

      // A draft requisition, awaiting the requester's own next action.
      await requisitions.createRequisition(ctx(db, requesterUserAccountId), db, requesterUserAccountId, {
        reason: 'New site signage for Coventry Works',
        category: 'Services',
        lines: [{ description: 'External signage design and installation', quantity: '1', estimatedUnitPriceMinor: '85000' }],
      });
    },
    pool,
  );
}
