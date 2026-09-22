import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export type ApprovalDecisionRule = 'any_one_of' | 'unanimous';

export interface ApprovalStepDefinition {
  approverPermission: string;
  decisionRule: ApprovalDecisionRule;
  /** Only meaningful when decisionRule === 'unanimous'. Minimum distinct approvals required. Defaults to 2. */
  requiredApproverCount?: number;
}

export interface ApprovalDefinitionShape {
  /** 'sequential': step N+1 is only decidable once step N is fully approved. 'parallel': all steps are decidable immediately. */
  mode: 'sequential' | 'parallel';
  steps: ApprovalStepDefinition[];
}

/**
 * Approval engine. Architecture-required, P1 item 10. Safe declarative
 * rules only (a request carries a fixed `context` object - amount, org
 * unit, etc - and a definition's steps reference a required permission,
 * never an executable expression). Every decision is an INSERT-only,
 * immutable row (`approval_decisions` has no UPDATE path in this service)
 * so the full history is always auditable. A decider must hold the step's
 * required permission (checked by the caller passing in the resolved
 * permission set actually authorised to decide - either the decider's own,
 * or a delegator's when deciding via an active delegation).
 */
@Injectable()
export class ApprovalService {
  async registerDefinition(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    definitionKey: string,
    definition: ApprovalDefinitionShape,
  ): Promise<void> {
    this.validateShape(definition);
    await db
      .insertInto('approval_definitions')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        definition_key: definitionKey,
        definition: definition as any,
      })
      .onConflict((oc) =>
        oc
          .columns(['organisation_id', 'app_id', 'definition_key'])
          .doUpdateSet({ definition: definition as any, updated_at: new Date() }),
      )
      .execute();
  }

  private validateShape(definition: unknown): asserts definition is ApprovalDefinitionShape {
    const d = definition as any;
    if (
      !d ||
      (d.mode !== 'sequential' && d.mode !== 'parallel') ||
      !Array.isArray(d.steps) ||
      d.steps.length === 0
    ) {
      throw new BadRequestException(
        'Approval definition must have mode (sequential|parallel) and a non-empty steps array.',
      );
    }
    for (const s of d.steps) {
      if (
        typeof s.approverPermission !== 'string' ||
        (s.decisionRule !== 'any_one_of' && s.decisionRule !== 'unanimous')
      ) {
        throw new BadRequestException(
          'Each approval step needs approverPermission and decisionRule (any_one_of|unanimous).',
        );
      }
    }
  }

  async requestApproval(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    definitionKey: string,
    entityType: string,
    entityId: string,
    context: Record<string, unknown>,
    requestedBy: string,
  ) {
    const definitionRow = await db
      .selectFrom('approval_definitions')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .where('definition_key', '=', definitionKey)
      .executeTakeFirst();
    if (!definitionRow)
      throw new NotFoundException(`Approval definition "${definitionKey}" is not registered.`);
    const definition = definitionRow.definition as unknown as ApprovalDefinitionShape;

    const request = await db
      .insertInto('approval_requests')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        definition_key: definitionKey,
        entity_type: entityType,
        entity_id: entityId,
        context: context as any,
        requested_by: requestedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    for (let i = 0; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      await db
        .insertInto('approval_steps')
        .values({
          organisation_id: organisationId,
          request_id: request.id,
          step_index: i,
          mode: step.decisionRule,
          approver_permission: step.approverPermission,
        })
        .execute();
    }

    return request;
  }

  async decide(
    db: Kysely<Database>,
    organisationId: string,
    stepId: string,
    deciderUserAccountId: string,
    effectivePermissions: ReadonlySet<string>,
    decision: 'approve' | 'reject',
    comment?: string,
    onBehalfOf?: string,
  ): Promise<{ requestStatus: string; stepStatus: string }> {
    const step = await db
      .selectFrom('approval_steps')
      .selectAll()
      .where('id', '=', stepId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!step) throw new NotFoundException('Approval step not found.');

    const request = await db
      .selectFrom('approval_requests')
      .selectAll()
      .where('id', '=', step.request_id)
      .executeTakeFirstOrThrow();
    if (request.status !== 'pending')
      throw new BadRequestException('This approval request has already been completed.');
    if (step.status !== 'pending')
      throw new BadRequestException('This approval step has already been decided.');

    if (!effectivePermissions.has(step.approver_permission)) {
      throw new ForbiddenException(
        `Missing required permission "${step.approver_permission}" to decide this approval step.`,
      );
    }

    const definitionRow = await db
      .selectFrom('approval_definitions')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', request.app_id)
      .where('definition_key', '=', request.definition_key)
      .executeTakeFirstOrThrow();
    const definition = definitionRow.definition as unknown as ApprovalDefinitionShape;

    if (definition.mode === 'sequential') {
      const priorSteps = await db
        .selectFrom('approval_steps')
        .selectAll()
        .where('request_id', '=', request.id)
        .where('step_index', '<', step.step_index)
        .execute();
      if (priorSteps.some((s) => s.status !== 'approved')) {
        throw new ForbiddenException(
          'Earlier approval steps must be completed first (sequential approval).',
        );
      }
    }

    await db
      .insertInto('approval_decisions')
      .values({
        organisation_id: organisationId,
        step_id: stepId,
        decided_by: deciderUserAccountId,
        decision,
        comment: comment ?? null,
        on_behalf_of: onBehalfOf ?? null,
      })
      .execute();

    if (decision === 'reject') {
      await db
        .updateTable('approval_steps')
        .set({ status: 'rejected' })
        .where('id', '=', stepId)
        .execute();
      await db
        .updateTable('approval_requests')
        .set({ status: 'rejected', completed_at: new Date() })
        .where('id', '=', request.id)
        .execute();
      return { requestStatus: 'rejected', stepStatus: 'rejected' };
    }

    const stepDefinition = definition.steps[step.step_index];
    const approvingDecisions = await db
      .selectFrom('approval_decisions')
      .select('decided_by')
      .where('step_id', '=', stepId)
      .where('decision', '=', 'approve')
      .execute();
    const distinctApprovers = new Set(approvingDecisions.map((d) => d.decided_by));
    const requiredCount =
      stepDefinition.decisionRule === 'unanimous' ? (stepDefinition.requiredApproverCount ?? 2) : 1;

    let stepStatus = step.status;
    if (distinctApprovers.size >= requiredCount) {
      stepStatus = 'approved';
      await db
        .updateTable('approval_steps')
        .set({ status: 'approved' })
        .where('id', '=', stepId)
        .execute();
    }

    let requestStatus = request.status;
    if (stepStatus === 'approved') {
      const allSteps = await db
        .selectFrom('approval_steps')
        .selectAll()
        .where('request_id', '=', request.id)
        .execute();
      if (allSteps.every((s) => s.status === 'approved' || s.id === stepId)) {
        requestStatus = 'approved';
        await db
          .updateTable('approval_requests')
          .set({ status: 'approved', completed_at: new Date() })
          .where('id', '=', request.id)
          .execute();
      }
    }

    return { requestStatus, stepStatus };
  }

  async createDelegation(
    db: Kysely<Database>,
    organisationId: string,
    delegatorUserId: string,
    delegateUserId: string,
    startsAt: Date,
    endsAt?: Date,
  ): Promise<void> {
    await db
      .insertInto('approval_delegations')
      .values({
        organisation_id: organisationId,
        delegator_user_id: delegatorUserId,
        delegate_user_id: delegateUserId,
        starts_at: startsAt as any,
        ends_at: (endsAt ?? null) as any,
      })
      .execute();
  }

  /** Active delegators for whom `delegateUserId` may currently decide on their behalf. */
  async getActiveDelegators(
    db: Kysely<Database>,
    organisationId: string,
    delegateUserId: string,
    at: Date = new Date(),
  ): Promise<string[]> {
    const rows = await db
      .selectFrom('approval_delegations')
      .select('delegator_user_id')
      .where('organisation_id', '=', organisationId)
      .where('delegate_user_id', '=', delegateUserId)
      .where('starts_at', '<=', at as any)
      .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', at as any)]))
      .execute();
    return rows.map((r) => r.delegator_user_id);
  }
}
