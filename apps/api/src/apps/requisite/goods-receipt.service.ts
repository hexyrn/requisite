import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';

const ENTITY_TYPE = 'requisite_requisition';

export interface GoodsReceiptLineInput {
  purchaseOrderLineId: string;
  quantityReceived: string;
  condition?: string;
  notes?: string;
}

export interface CreateGoodsReceiptInput {
  locationId?: string;
  deliveryNoteReference?: string;
  notes?: string;
  lines: GoodsReceiptLineInput[];
}

/**
 * Goods Receipt, item 5 - first-class partial delivery. Each receipt is
 * an IMMUTABLE historical record (never mutated/merged to fake a single
 * final receipt - a PO ordered 100, received 60 then 40, keeps BOTH
 * receipt rows forever). Over-receipt is rejected at TWO layers: the
 * application check here (clear error message) AND the database CHECK
 * constraint on requisite_purchase_order_lines.quantity_received <=
 * quantity_ordered (migration 0033) - so even a hypothetical bug in this
 * service's own arithmetic cannot silently over-receive, matching item 39's
 * "use database constraints/transactions, not just disabled frontend
 * buttons."
 */
@Injectable()
export class GoodsReceiptService {
  async recordReceipt(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, purchaseOrderId: string, input: CreateGoodsReceiptInput) {
    if (input.lines.length === 0) throw new BadRequestException('A goods receipt must have at least one line.');

    const po = await db.selectFrom('requisite_purchase_orders').selectAll().where('id', '=', purchaseOrderId).where('organisation_id', '=', ctx.organisationId).executeTakeFirst();
    if (!po) throw new NotFoundException('Purchase order not found.');
    if (!['issued', 'partially_received'].includes(po.status)) {
      throw new ForbiddenException(`Cannot record a goods receipt against a purchase order in status "${po.status}".`);
    }

    const grnNumber = await ctx.numbering.next(db, 'goods-receipt');
    const grn = await db
      .insertInto('requisite_goods_receipts')
      .values({
        organisation_id: ctx.organisationId,
        grn_number: grnNumber,
        purchase_order_id: purchaseOrderId,
        received_by_user_account_id: actorUserAccountId,
        location_id: input.locationId ?? po.delivery_location_id,
        delivery_note_reference: input.deliveryNoteReference ?? null,
        notes: input.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (const line of input.lines) {
      const poLine = await db.selectFrom('requisite_purchase_order_lines').selectAll().where('id', '=', line.purchaseOrderLineId).where('purchase_order_id', '=', purchaseOrderId).executeTakeFirst();
      if (!poLine) throw new NotFoundException(`Purchase order line "${line.purchaseOrderLineId}" not found on this order.`);

      const quantity = Number(line.quantityReceived);
      if (!(quantity > 0)) throw new BadRequestException('Quantity received must be greater than zero.');

      // Atomic, race-safe over-receipt check: the UPDATE's WHERE clause
      // re-verifies (quantity_received + $new <= quantity_ordered) as part
      // of the SAME statement that increments it - under Postgres's
      // per-row locking this makes two simultaneous receipts against the
      // same line strictly serialise (the second sees the first's
      // committed increment before its own WHERE is evaluated), so there
      // is no read-then-write window for two concurrent over-receipts to
      // both slip through. The CHECK constraint is the final backstop if
      // this arithmetic were ever wrong.
      const updated = await db
        .updateTable('requisite_purchase_order_lines')
        .set({ quantity_received: sql<string>`quantity_received + ${line.quantityReceived}::numeric` })
        .where('id', '=', line.purchaseOrderLineId)
        .where(sql<boolean>`quantity_received + ${line.quantityReceived}::numeric <= quantity_ordered`)
        .returningAll()
        .executeTakeFirst();

      if (!updated) {
        const outstanding = Number(poLine.quantity_ordered) - Number(poLine.quantity_received);
        throw new BadRequestException(`Cannot receive ${line.quantityReceived} of "${poLine.description}" - only ${outstanding} is outstanding (ordered ${poLine.quantity_ordered}, already received ${poLine.quantity_received}).`);
      }

      await db
        .insertInto('requisite_goods_receipt_lines')
        .values({
          organisation_id: ctx.organisationId,
          goods_receipt_id: grn.id,
          purchase_order_line_id: line.purchaseOrderLineId,
          quantity_received: line.quantityReceived,
          condition: line.condition ?? null,
          notes: line.notes ?? null,
        })
        .execute();
    }

    // Recompute PO-level status from the now-updated line quantities -
    // partially_received vs received (item 5), never inferred from THIS
    // receipt alone (a later receipt might complete a PO another receipt
    // only partially advanced).
    const allLines = await db.selectFrom('requisite_purchase_order_lines').selectAll().where('purchase_order_id', '=', purchaseOrderId).execute();
    const fullyReceived = allLines.every((l) => Number(l.quantity_received) >= Number(l.quantity_ordered));
    const anyReceived = allLines.some((l) => Number(l.quantity_received) > 0);
    const newStatus = fullyReceived ? 'received' : anyReceived ? 'partially_received' : po.status;

    await db.updateTable('requisite_purchase_orders').set({ status: newStatus, updated_at: new Date() as any }).where('id', '=', purchaseOrderId).execute();

    await ctx.events.publish(db, 'requisite.goods-receipt.created.v1', { goodsReceiptId: grn.id, grnNumber: grn.grn_number, purchaseOrderId }, 1);
    await ctx.events.publish(db, 'requisite.goods-received.v1', { purchaseOrderId, goodsReceiptId: grn.id, fullyReceived }, 1);

    if (po.source_requisition_id) {
      const sourceRequisition = await db.selectFrom('requisite_requisitions').select('requester_user_account_id').where('id', '=', po.source_requisition_id).executeTakeFirst();
      if (sourceRequisition) {
        await ctx.notifications.send(db, sourceRequisition.requester_user_account_id, 'requisite.receipt_recorded', `Receipt recorded: ${po.po_number}`, `Goods receipt ${grn.grn_number} was recorded against your purchase order (${fullyReceived ? 'fully received' : 'partially received'}).`, { type: 'requisite_goods_receipt', id: grn.id });
      }
    }

    if (fullyReceived && po.source_requisition_id) {
      await ctx.workflow.transition(db, ENTITY_TYPE, po.source_requisition_id, 'received', actorUserAccountId);
      await db.updateTable('requisite_requisitions').set({ status: 'received' }).where('id', '=', po.source_requisition_id).execute();
      await ctx.events.publish(db, 'requisite.purchase-order.completed.v1', { purchaseOrderId, poNumber: po.po_number }, 1);
    } else if (anyReceived && po.source_requisition_id) {
      await ctx.workflow.transition(db, ENTITY_TYPE, po.source_requisition_id, 'partially_received', actorUserAccountId);
      await db.updateTable('requisite_requisitions').set({ status: 'partially_received' }).where('id', '=', po.source_requisition_id).execute();
    }

    return this.getGoodsReceipt(db, ctx.organisationId, grn.id);
  }

  async getGoodsReceipt(db: Kysely<Database>, organisationId: string, goodsReceiptId: string) {
    const grn = await db.selectFrom('requisite_goods_receipts').selectAll().where('id', '=', goodsReceiptId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!grn) throw new NotFoundException('Goods receipt not found.');
    const lines = await db.selectFrom('requisite_goods_receipt_lines').selectAll().where('goods_receipt_id', '=', goodsReceiptId).execute();
    return { ...grn, lines };
  }

  async listGoodsReceiptsForPo(db: Kysely<Database>, organisationId: string, purchaseOrderId: string) {
    return db.selectFrom('requisite_goods_receipts').selectAll().where('organisation_id', '=', organisationId).where('purchase_order_id', '=', purchaseOrderId).orderBy('received_at', 'asc').execute();
  }

  /** Outstanding (ordered - received) quantity per PO line - drives delivery-monitoring reminders (item 18). */
  async getOutstandingLines(db: Kysely<Database>, organisationId: string, purchaseOrderId: string) {
    const lines = await db.selectFrom('requisite_purchase_order_lines').selectAll().where('organisation_id', '=', organisationId).where('purchase_order_id', '=', purchaseOrderId).execute();
    return lines.map((l) => ({ ...l, quantityOutstanding: (Number(l.quantity_ordered) - Number(l.quantity_received)).toString() }));
  }
}
