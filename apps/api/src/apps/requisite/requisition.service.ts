import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';
import { RequisiteOnboardingService } from './requisite-onboarding.service';
import { multiplyMinor, sumMinor } from './money';

const ENTITY_TYPE = 'requisite_requisition';

export interface RequisitionLineInput {
  description: string;
  quantity: string;
  unit?: string;
  estimatedUnitPriceMinor: string; // bigint-as-string over the wire
  category?: string;
  preferredSupplierId?: string;
  requiredByDate?: string;
  costObjectReference?: string;
  notes?: string;
}

export interface CreateRequisitionInput {
  organisationalUnitId?: string;
  locationId?: string;
  requiredByDate?: string;
  preferredSupplierId?: string;
  reason: string;
  costObjectReference?: string;
  category?: string;
  currency?: string;
  notes?: string;
  lines: RequisitionLineInput[];
}

/**
 * Requisitions - item 4/6/35. Every write goes through `ctx` for
 * numbering/workflow/approvals/events. Editing after submission is a real
 * domain invariant, not a UI-only restriction (item 39): once a
 * requisition has left 'draft', edits are rejected server-side regardless
 * of what any client sends. Optimistic concurrency (the `version` column)
 * defends the specific race the brief names: one request editing a
 * requisition while another concurrently submits it.
 */
@Injectable()
export class RequisitionService {
  constructor(private readonly onboarding: RequisiteOnboardingService) {}

  private computeTotals(lines: RequisitionLineInput[]): { lines: { line: RequisitionLineInput; totalMinor: bigint }[]; estimatedTotalMinor: bigint } {
    if (lines.length === 0) throw new BadRequestException('A requisition must have at least one line.');
    const computed = lines.map((line) => {
      const unitPrice = BigInt(line.estimatedUnitPriceMinor || '0');
      return { line, totalMinor: multiplyMinor(unitPrice, line.quantity) };
    });
    return { lines: computed, estimatedTotalMinor: sumMinor(computed.map((c) => c.totalMinor)) };
  }

  async createRequisition(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, input: CreateRequisitionInput) {
    await this.onboarding.onboardOrganisation(db, ctx.organisationId); // idempotent
    if (!input.reason?.trim()) throw new BadRequestException('A reason / business justification is required.');

    const { lines, estimatedTotalMinor } = this.computeTotals(input.lines);
    const requisitionNumber = await ctx.numbering.next(db, 'requisition');

    const requisition = await db
      .insertInto('requisite_requisitions')
      .values({
        organisation_id: ctx.organisationId,
        requisition_number: requisitionNumber,
        requester_user_account_id: actorUserAccountId,
        organisational_unit_id: input.organisationalUnitId ?? null,
        location_id: input.locationId ?? null,
        required_by_date: input.requiredByDate ?? null,
        preferred_supplier_id: input.preferredSupplierId ?? null,
        reason: input.reason.trim(),
        cost_object_reference: input.costObjectReference ?? null,
        category: input.category ?? null,
        currency: input.currency ?? 'GBP',
        estimated_value_minor: estimatedTotalMinor.toString() as any,
        notes: input.notes ?? null,
        created_by: actorUserAccountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let lineNumber = 1;
    for (const { line, totalMinor } of lines) {
      await db
        .insertInto('requisite_requisition_lines')
        .values({
          organisation_id: ctx.organisationId,
          requisition_id: requisition.id,
          line_number: lineNumber++,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit ?? null,
          estimated_unit_price_minor: line.estimatedUnitPriceMinor,
          estimated_total_minor: totalMinor.toString() as any,
          category: line.category ?? null,
          preferred_supplier_id: line.preferredSupplierId ?? null,
          required_by_date: line.requiredByDate ?? null,
          cost_object_reference: line.costObjectReference ?? null,
          notes: line.notes ?? null,
        })
        .execute();
    }

    await ctx.workflow.start(db, 'requisition-lifecycle', ENTITY_TYPE, requisition.id, actorUserAccountId);
    await ctx.events.publish(db, 'requisite.requisition.created.v1', { requisitionId: requisition.id, requisitionNumber: requisition.requisition_number }, 1);

    return this.getRequisition(db, ctx.organisationId, requisition.id);
  }

  /**
   * Domain invariant, enforced server-side regardless of caller: a
   * requisition may only be edited while in 'draft'. `expectedVersion` is
   * required and checked with an atomic UPDATE...WHERE version=$N - a
   * concurrent submit (which also bumps version via the workflow
   * transition) makes this fail with a real ConflictException, not a
   * silently-lost edit.
   */
  async editRequisition(db: Kysely<Database>, organisationId: string, requisitionId: string, expectedVersion: number, updates: { reason?: string; notes?: string; requiredByDate?: string }) {
    const requisition = await this.getRequisitionRaw(db, organisationId, requisitionId);
    if (requisition.status !== 'draft') {
      throw new ForbiddenException(`Cannot edit a requisition in status "${requisition.status}" - only draft requisitions may be edited.`);
    }
    const result = await db
      .updateTable('requisite_requisitions')
      .set({ reason: updates.reason ?? requisition.reason, notes: updates.notes ?? requisition.notes, required_by_date: updates.requiredByDate ?? requisition.required_by_date, version: expectedVersion + 1, updated_at: new Date() as any })
      .where('id', '=', requisitionId)
      .where('organisation_id', '=', organisationId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!result) {
      throw new ConflictException('This requisition was modified by another request - reload and try again.');
    }
    return result;
  }

  async submitRequisition(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, requisitionId: string, expectedVersion: number) {
    const requisition = await this.getRequisitionRaw(db, ctx.organisationId, requisitionId);
    if (requisition.status !== 'draft') {
      throw new ForbiddenException(`Cannot submit a requisition in status "${requisition.status}".`);
    }
    const bumped = await db
      .updateTable('requisite_requisitions')
      .set({ version: expectedVersion + 1, updated_at: new Date() as any })
      .where('id', '=', requisitionId)
      .where('organisation_id', '=', ctx.organisationId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!bumped) {
      throw new ConflictException('This requisition was modified by another request - reload and try again.');
    }

    await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'submitted', actorUserAccountId);
    await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'awaiting_approval', actorUserAccountId);
    // The requisition's own `status` column is kept in sync with the Core
    // workflow instance's state at each transition point - it exists so
    // reporting/dashboards/list views can filter by status directly against
    // this table (a semantic reporting dataset per item 24) without joining
    // out to workflow_instances, while Core Workflow remains the sole
    // authority actually enforcing which transitions are valid/permitted.
    await db.updateTable('requisite_requisitions').set({ status: 'awaiting_approval' }).where('id', '=', requisitionId).execute();

    const lines = await db.selectFrom('requisite_requisition_lines').selectAll().where('requisition_id', '=', requisitionId).execute();
    const approval = await ctx.approvals.requestApproval(
      db,
      'requisition-approval',
      ENTITY_TYPE,
      requisitionId,
      {
        requesterUserAccountId: requisition.requester_user_account_id,
        organisationalUnitId: requisition.organisational_unit_id,
        locationId: requisition.location_id,
        estimatedValueMinor: requisition.estimated_value_minor,
        currency: requisition.currency,
        category: requisition.category,
        costObjectReference: requisition.cost_object_reference,
        preferredSupplierId: requisition.preferred_supplier_id,
        lineCount: lines.length,
      },
      actorUserAccountId,
    );

    await ctx.events.publish(db, 'requisite.requisition.submitted.v1', { requisitionId, requisitionNumber: requisition.requisition_number }, 1);

    return { requisition: await this.getRequisition(db, ctx.organisationId, requisitionId), approval };
  }

  async decide(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, requisitionId: string, stepId: string, decision: 'approve' | 'reject', reason?: string) {
    const requisition = await this.getRequisitionRaw(db, ctx.organisationId, requisitionId);
    if (requisition.status === 'cancelled') {
      // Item 39: approval decision after cancellation must not silently
      // "approve a cancelled requisition."
      throw new ForbiddenException('This requisition has been cancelled and can no longer be decided on.');
    }
    // Item 7/41 security review finding: Core's ApprovalService itself has
    // no concept of "requester" - it only checks that the decider holds
    // the step's approverPermission, so a requester who also happens to
    // hold the approve permission COULD otherwise approve their own
    // requisition merely by having that permission, which the brief
    // explicitly calls out as required-not-default behaviour ("no
    // self-approval merely by being able to edit the requisition unless
    // the configured policy explicitly permits it"). This is enforced at
    // the APPLICATION layer (not a Core change) since self-approval
    // policy is domain-specific, not a platform primitive - v1's default
    // is a hard rule (no exception mechanism yet; see
    // docs/decisions/REQUISITE-V1-DEVIATIONS.md).
    if (actorUserAccountId === requisition.requester_user_account_id) {
      throw new ForbiddenException('You cannot approve or reject your own requisition.');
    }
    const result = await ctx.approvals.decide(db, stepId, actorUserAccountId, decision, reason);

    if (result.requestStatus === 'approved') {
      await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'approved', actorUserAccountId);
      await db.updateTable('requisite_requisitions').set({ status: 'approved' }).where('id', '=', requisitionId).execute();
      await ctx.events.publish(db, 'requisite.requisition.approved.v1', { requisitionId, requisitionNumber: requisition.requisition_number }, 1);
    } else if (result.requestStatus === 'rejected') {
      await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'rejected', actorUserAccountId);
      await db.updateTable('requisite_requisitions').set({ status: 'rejected' }).where('id', '=', requisitionId).execute();
      await ctx.events.publish(db, 'requisite.requisition.rejected.v1', { requisitionId, requisitionNumber: requisition.requisition_number }, 1);
    }
    return result;
  }

  async cancelRequisition(ctx: HexyrnAppContext<Kysely<Database>>, db: Kysely<Database>, actorUserAccountId: string, requisitionId: string) {
    const requisition = await this.getRequisitionRaw(db, ctx.organisationId, requisitionId);
    if (!['draft', 'submitted', 'awaiting_approval'].includes(requisition.status)) {
      throw new ForbiddenException(`Cannot cancel a requisition in status "${requisition.status}".`);
    }
    await ctx.workflow.transition(db, ENTITY_TYPE, requisitionId, 'cancelled', actorUserAccountId);
    return db.updateTable('requisite_requisitions').set({ status: 'cancelled', cancelled_at: new Date() as any }).where('id', '=', requisitionId).where('organisation_id', '=', ctx.organisationId).returningAll().executeTakeFirstOrThrow();
  }

  async getRequisitionRaw(db: Kysely<Database>, organisationId: string, requisitionId: string) {
    const requisition = await db.selectFrom('requisite_requisitions').selectAll().where('id', '=', requisitionId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!requisition) throw new NotFoundException('Requisition not found.');
    return requisition;
  }

  async getRequisition(db: Kysely<Database>, organisationId: string, requisitionId: string) {
    const requisition = await this.getRequisitionRaw(db, organisationId, requisitionId);
    const lines = await db.selectFrom('requisite_requisition_lines').selectAll().where('requisition_id', '=', requisitionId).orderBy('line_number', 'asc').execute();
    return { ...requisition, lines };
  }

  async listRequisitions(db: Kysely<Database>, organisationId: string) {
    return db.selectFrom('requisite_requisitions').selectAll().where('organisation_id', '=', organisationId).orderBy('created_at', 'desc').execute();
  }
}
