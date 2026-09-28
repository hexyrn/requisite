import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { applyTaxRateBp, sumMinor } from './money';

const ENTITY_TYPE = 'requisite_requisition';

export interface PoLineInput {
  description: string;
  quantityOrdered: string;
  unit?: string;
  unitPriceMinor: string;
  taxRateBp?: number;
  category?: string;
  costObjectReference?: string;
  expectedDeliveryDate?: string;
  sourceRequisitionLineId?: string;
}

export interface GeneratePoInput {
  supplierId: string;
  deliveryLocationId?: string;
  deliveryAddress?: string;
  supplierReference?: string;
  currency?: string;
  paymentTerms?: string;
  expectedDeliveryDate?: string;
  carriageMinor?: string;
  notes?: string;
  lines: PoLineInput[];
}

/**
 * Purchase Order generation, item 8. A requisition may only be converted
 * once it holds a real, current 'approved' status (never bypassable by
 * calling this service directly with an unapproved id - the check is
 * server-side, not a UI gate). Traceability (item 8's "drillable both
 * directions") is maintained via source_requisition_id on the PO and
 * source_requisition_line_id on each PO line.
 */
@Injectable()
export class PurchaseOrderService {
  constructor(private readonly onboarding: RequisiteOnboardingService) {}

  private computeTotals(
    lines: PoLineInput[],
    carriageMinor: bigint,
  ): {
    lines: { line: PoLineInput; lineTotalMinor: bigint }[];
    subtotalMinor: bigint;
    taxMinor: bigint;
    totalMinor: bigint;
  } {
    if (lines.length === 0)
      throw new BadRequestException('A purchase order must have at least one line.');
    const computed = lines.map((line) => {
      const unitPrice = BigInt(line.unitPriceMinor || '0');
      const qty = line.quantityOrdered;
      const [whole, frac = ''] = qty.split('.');
      const fracPadded = (frac + '0000').slice(0, 4);
      const scaledQty = BigInt(whole || '0') * 10000n + BigInt(fracPadded || '0');
      const lineTotalMinor = (unitPrice * scaledQty) / 10000n;
      return { line, lineTotalMinor };
    });
    const subtotalMinor = sumMinor(computed.map((c) => c.lineTotalMinor));
    const taxMinor = sumMinor(
      computed.map((c) => applyTaxRateBp(c.lineTotalMinor, c.line.taxRateBp ?? 0)),
    );
    return {
      lines: computed,
      subtotalMinor,
      taxMinor,
      totalMinor: subtotalMinor + taxMinor + carriageMinor,
    };
  }

  /**
   * Generates ONE purchase order from ONE approved requisition, for a
   * single supplier (item 8's baseline case - one req -> one supplier ->
   * one PO). Multiple suppliers for one requisition, or consolidating
   * several requisitions into one PO, is supported by calling this
   * multiple times / by omitting requisitionId - deliberately not
   * over-built into a single "smart" consolidation call for v1.
   */
  async generateFromRequisition(
    ctx: HexyrnAppContext<Kysely<Database>>,
    db: Kysely<Database>,
    actorUserAccountId: string,
    requisitionId: string,
    input: GeneratePoInput,
  ) {
    await this.onboarding.onboardOrganisation(db, ctx.organisationId);

    const requisition = await db
      .selectFrom('requisite_requisitions')
      .selectAll()
      .where('id', '=', requisitionId)
      .where('organisation_id', '=', ctx.organisationId)
      .executeTakeFirst();
    if (!requisition) throw new NotFoundException('Requisition not found.');
    if (requisition.status !== 'approved') {
      // PO generation without approval - item 41 security review concern,
      // enforced here server-side regardless of caller.
      throw new ForbiddenException(
        `Cannot generate a purchase order from a requisition in status "${requisition.status}" - it must be "approved".`,
      );
    }

    // Item 39 - duplicate PO generation race: atomically CLAIM the
    // requisition (approved -> ordered) BEFORE creating any PO rows. A
    // concurrent second call that reads status='approved' before this
    // commits will still fail here, because the UPDATE...WHERE
    // status='approved' can only ever succeed for exactly one of the two
    // racing transactions (Postgres row-level locking serialises the two
    // UPDATEs) - this is the same "atomic claim" pattern the requisition
    // service's own version-based concurrency uses, just keyed on status
    // instead of an explicit version counter since there is no
    // legitimate concurrent EDIT of an already-approved requisition to
    // defend against here, only duplicate PO generation.
    const claimed = await db
      .updateTable('requisite_requisitions')
      .set({ status: 'ordered' })
      .where('id', '=', requisitionId)
      .where('organisation_id', '=', ctx.organisationId)
      .where('status', '=', 'approved')
      .returningAll()
      .executeTakeFirst();
    if (!claimed) {
      throw new ConflictException(
        'A purchase order has already been generated from this requisition (or its status changed concurrently).',
      );
    }

    const supplier = await db
      .selectFrom('requisite_suppliers')
      .selectAll()
      .where('id', '=', input.supplierId)
      .where('organisation_id', '=', ctx.organisationId)
      .executeTakeFirst();
    if (!supplier) throw new NotFoundException('Supplier not found.');
    if (supplier.status !== 'active')
      throw new BadRequestException('Cannot issue a purchase order to an inactive supplier.');

    const carriageMinor = BigInt(input.carriageMinor || '0');
    const { lines, subtotalMinor, taxMinor, totalMinor } = this.computeTotals(
      input.lines,
      carriageMinor,
    );

    const poNumber = await ctx.numbering.next(db, 'purchase-order');
    const po = await db
      .insertInto('requisite_purchase_orders')
      .values({
        organisation_id: ctx.organisationId,
        po_number: poNumber,
        supplier_id: input.supplierId,
        source_requisition_id: requisitionId,
        buyer_user_account_id: actorUserAccountId,
        organisational_unit_id: requisition.organisational_unit_id,
        delivery_location_id: input.deliveryLocationId ?? requisition.location_id,
        delivery_address: input.deliveryAddress ?? null,
        supplier_reference: input.supplierReference ?? null,
        currency: input.currency ?? requisition.currency,
        payment_terms: input.paymentTerms ?? supplier.payment_terms,
        expected_delivery_date: input.expectedDeliveryDate ?? null,
        subtotal_minor: subtotalMinor.toString() as any,
        tax_minor: taxMinor.toString() as any,
        carriage_minor: carriageMinor.toString() as any,
        total_minor: totalMinor.toString() as any,
        notes: input.notes ?? null,
        created_by: actorUserAccountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let lineNumber = 1;
    for (const { line, lineTotalMinor } of lines) {
      await db
        .insertInto('requisite_purchase_order_lines')
        .values({
          organisation_id: ctx.organisationId,
          purchase_order_id: po.id,
          line_number: lineNumber++,
          source_requisition_line_id: line.sourceRequisitionLineId ?? null,
          description: line.description,
          quantity_ordered: line.quantityOrdered,
          unit: line.unit ?? null,
          unit_price_minor: line.unitPriceMinor,
          tax_rate_bp: line.taxRateBp ?? 0,
          line_total_minor: lineTotalMinor.toString() as any,
          category: line.category ?? null,
          cost_object_reference: line.costObjectReference ?? null,
          expected_delivery_date: line.expectedDeliveryDate ?? null,
        })
        .execute();
    }

    await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'ordered', actorUserAccountId);
    await ctx.events.publish(
      db,
      'requisite.purchase-order.created.v1',
      {
        purchaseOrderId: po.id,
        poNumber: po.po_number,
        requisitionId,
        supplierId: input.supplierId,
      },
      1,
    );
    await ctx.notifications.send(
      db,
      requisition.requester_user_account_id,
      'requisite.purchase_order_created',
      `PO created: ${po.po_number}`,
      `A purchase order has been generated from your requisition "${requisition.reason}".`,
      { type: 'requisite_purchase_order', id: po.id },
    );

    return this.getPurchaseOrder(db, ctx.organisationId, po.id);
  }

  /**
   * Issues a PO to its supplier (draft -> issued). Optimistic concurrency
   * (`version`) defends the exact race the brief names: two users issuing
   * the same PO simultaneously - only one atomic UPDATE...WHERE version=$N
   * can succeed.
   */
  async issue(
    ctx: HexyrnAppContext<Kysely<Database>>,
    db: Kysely<Database>,
    actorUserAccountId: string,
    purchaseOrderId: string,
    expectedVersion: number,
  ) {
    const po = await this.getPurchaseOrderRaw(db, ctx.organisationId, purchaseOrderId);
    if (po.status !== 'draft') {
      throw new ForbiddenException(
        `Cannot issue a purchase order in status "${po.status}" - only draft purchase orders may be issued.`,
      );
    }
    const result = await db
      .updateTable('requisite_purchase_orders')
      .set({ status: 'issued', version: expectedVersion + 1, updated_at: new Date() as any })
      .where('id', '=', purchaseOrderId)
      .where('organisation_id', '=', ctx.organisationId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!result) {
      throw new ConflictException(
        'This purchase order was already modified (e.g. issued by another request) - reload and try again.',
      );
    }
    await ctx.events.publish(
      db,
      'requisite.purchase-order.issued.v1',
      { purchaseOrderId, poNumber: po.po_number, supplierId: po.supplier_id },
      1,
    );
    return result;
  }

  async cancel(db: Kysely<Database>, organisationId: string, purchaseOrderId: string) {
    const po = await this.getPurchaseOrderRaw(db, organisationId, purchaseOrderId);
    if (!['draft', 'issued'].includes(po.status)) {
      throw new ForbiddenException(`Cannot cancel a purchase order in status "${po.status}".`);
    }
    return db
      .updateTable('requisite_purchase_orders')
      .set({ status: 'cancelled', updated_at: new Date() as any })
      .where('id', '=', purchaseOrderId)
      .where('organisation_id', '=', organisationId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getPurchaseOrderRaw(db: Kysely<Database>, organisationId: string, purchaseOrderId: string) {
    const po = await db
      .selectFrom('requisite_purchase_orders')
      .selectAll()
      .where('id', '=', purchaseOrderId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!po) throw new NotFoundException('Purchase order not found.');
    return po;
  }

  async getPurchaseOrder(db: Kysely<Database>, organisationId: string, purchaseOrderId: string) {
    const po = await this.getPurchaseOrderRaw(db, organisationId, purchaseOrderId);
    const lines = await db
      .selectFrom('requisite_purchase_order_lines')
      .selectAll()
      .where('purchase_order_id', '=', purchaseOrderId)
      .orderBy('line_number', 'asc')
      .execute();
    return { ...po, lines };
  }

  async listPurchaseOrders(db: Kysely<Database>, organisationId: string) {
    return db
      .selectFrom('requisite_purchase_orders')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .orderBy('created_at', 'desc')
      .execute();
  }
}
