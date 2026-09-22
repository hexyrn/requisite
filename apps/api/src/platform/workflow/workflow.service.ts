import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export interface WorkflowCondition {
  field: string; // looked up in the `context` object passed to transition()
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=';
  value: unknown;
}

export interface WorkflowTransitionDefinition {
  from: string;
  to: string;
  permission: string;
  conditions?: WorkflowCondition[];
  requiredFields?: string[];
  /** Declarative only - a fixed vocabulary of action kinds, never executable code. */
  actions?: { kind: 'publish_event'; eventType: string }[];
}

export interface WorkflowDefinitionShape {
  states: string[];
  initialState: string;
  transitions: WorkflowTransitionDefinition[];
}

/**
 * Workflow engine. Architecture-required, P1 item 9. Declarative state
 * machine: `definition` is checked against a fixed shape (states,
 * transitions with a required permission, optional simple field-comparison
 * conditions, optional required fields, and actions drawn from a small
 * fixed vocabulary) - never executable code.
 *
 * Concurrency: every transition is a single `UPDATE ... WHERE id = $1 AND
 * version = $2 RETURNING *`. If a concurrent transition already changed the
 * row (and therefore its version) between this call's read and its update,
 * zero rows match and a ConflictException is thrown - the caller must
 * re-read and retry, never silently overwrite. This is the deliberate
 * optimistic-concurrency design the architecture requires; verified with a
 * genuine concurrent-transition test against real Postgres.
 */
@Injectable()
export class WorkflowService {
  async registerDefinition(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    workflowKey: string,
    definition: WorkflowDefinitionShape,
  ): Promise<void> {
    this.validateDefinitionShape(definition);
    await db
      .insertInto('workflow_definitions')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        workflow_key: workflowKey,
        definition: definition as any,
      })
      .onConflict((oc) =>
        oc
          .columns(['organisation_id', 'app_id', 'workflow_key'])
          .doUpdateSet({ definition: definition as any, updated_at: new Date() as any }),
      )
      .execute();
  }

  private validateDefinitionShape(
    definition: unknown,
  ): asserts definition is WorkflowDefinitionShape {
    const d = definition as any;
    if (
      !d ||
      !Array.isArray(d.states) ||
      typeof d.initialState !== 'string' ||
      !Array.isArray(d.transitions)
    ) {
      throw new BadRequestException(
        'Workflow definition must have states[], initialState, and transitions[].',
      );
    }
    for (const t of d.transitions) {
      if (
        typeof t.from !== 'string' ||
        typeof t.to !== 'string' ||
        typeof t.permission !== 'string'
      ) {
        throw new BadRequestException(
          'Each workflow transition must have from, to, and permission.',
        );
      }
      if (t.actions) {
        for (const a of t.actions) {
          if (a.kind !== 'publish_event') {
            throw new BadRequestException(
              `Unsupported workflow action kind "${a.kind}" - only a fixed, declarative vocabulary is allowed.`,
            );
          }
        }
      }
    }
  }

  async startInstance(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    workflowKey: string,
    entityType: string,
    entityId: string,
    actorUserAccountId?: string,
  ) {
    const definition = await this.getDefinition(db, organisationId, appId, workflowKey);
    const instance = await db
      .insertInto('workflow_instances')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        workflow_key: workflowKey,
        entity_type: entityType,
        entity_id: entityId,
        current_state: definition.initialState,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await db
      .insertInto('workflow_history')
      .values({
        organisation_id: organisationId,
        instance_id: instance.id,
        from_state: null,
        to_state: definition.initialState,
        actor_user_account_id: actorUserAccountId ?? null,
      })
      .execute();

    return instance;
  }

  async getDefinition(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    workflowKey: string,
  ): Promise<WorkflowDefinitionShape> {
    const row = await db
      .selectFrom('workflow_definitions')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .where('workflow_key', '=', workflowKey)
      .executeTakeFirst();
    if (!row)
      throw new NotFoundException(
        `Workflow "${workflowKey}" is not registered for this organisation.`,
      );
    return row.definition as unknown as WorkflowDefinitionShape;
  }

  async getInstance(
    db: Kysely<Database>,
    organisationId: string,
    entityType: string,
    entityId: string,
  ) {
    const row = await db
      .selectFrom('workflow_instances')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`No workflow instance for ${entityType}/${entityId}.`);
    return row;
  }

  async transition(
    db: Kysely<Database>,
    organisationId: string,
    entityType: string,
    entityId: string,
    toState: string,
    grantedPermissions: ReadonlySet<string>,
    actorUserAccountId: string,
    fieldContext: Record<string, unknown> = {},
  ): Promise<{ state: string; version: number }> {
    const instance = await this.getInstance(db, organisationId, entityType, entityId);
    const definition = await this.getDefinition(
      db,
      organisationId,
      instance.app_id,
      instance.workflow_key,
    );

    const transitionDef = definition.transitions.find(
      (t) => t.from === instance.current_state && t.to === toState,
    );
    if (!transitionDef) {
      throw new BadRequestException(
        `Invalid transition: no path from "${instance.current_state}" to "${toState}".`,
      );
    }
    if (!grantedPermissions.has(transitionDef.permission)) {
      throw new ForbiddenException(
        `Missing required permission "${transitionDef.permission}" for this transition.`,
      );
    }
    if (transitionDef.requiredFields) {
      for (const f of transitionDef.requiredFields) {
        if (fieldContext[f] === undefined || fieldContext[f] === null) {
          throw new BadRequestException(`Field "${f}" is required for this transition.`);
        }
      }
    }
    if (transitionDef.conditions) {
      for (const cond of transitionDef.conditions) {
        if (!this.evaluateCondition(cond, fieldContext)) {
          throw new BadRequestException(
            `Condition not met for this transition: ${cond.field} ${cond.operator} ${String(cond.value)}.`,
          );
        }
      }
    }

    const updated = await db
      .updateTable('workflow_instances')
      .set({ current_state: toState, version: instance.version + 1, updated_at: new Date() as any })
      .where('id', '=', instance.id)
      .where('version', '=', instance.version)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      throw new ConflictException(
        'This record was modified by another transition concurrently. Please refresh and try again.',
      );
    }

    await db
      .insertInto('workflow_history')
      .values({
        organisation_id: organisationId,
        instance_id: instance.id,
        from_state: instance.current_state,
        to_state: toState,
        actor_user_account_id: actorUserAccountId,
      })
      .execute();

    return { state: updated.current_state, version: updated.version };
  }

  private evaluateCondition(cond: WorkflowCondition, context: Record<string, unknown>): boolean {
    const actual = context[cond.field];
    switch (cond.operator) {
      case '=':
        return actual === cond.value;
      case '!=':
        return actual !== cond.value;
      case '>':
        return (actual as number) > (cond.value as number);
      case '<':
        return (actual as number) < (cond.value as number);
      case '>=':
        return (actual as number) >= (cond.value as number);
      case '<=':
        return (actual as number) <= (cond.value as number);
    }
  }
}
