import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { HexyrnAppContext } from '@hexyrn/app-sdk';
import { Database } from '../../db/types';
import { REFERENCE_APP_MANIFEST } from './reference.manifest';
import { FormService } from '../../platform/forms/form.service';
import { WorkflowService } from '../../platform/workflow/workflow.service';
import { ApprovalService } from '../../platform/approval/approval.service';
import { NumberingService } from '../../platform/numbering/numbering.service';
import { CustomFieldService } from '../../platform/custom-fields/custom-field.service';

const APP_ID = REFERENCE_APP_MANIFEST.appId;
const ENTITY_TYPE = 'reference_widget';

/**
 * Reference app business logic. P1 item 17. EVERY interaction with Core
 * happens through `ctx: HexyrnAppContext` (built by Core's
 * AppContextFactory and handed to this service by the controller) - this
 * class never imports a platform service directly for any org-scoped
 * operation, which is the property this whole app exists to demonstrate.
 * The one exception is onboarding (registering this app's own default
 * forms/workflow/numbering sequence into a fresh organisation), which by
 * nature has to call the registration-side APIs directly since those
 * aren't part of the runtime SDK context (a manifest's declared defaults
 * are Core's own job to seed, not something an app "uses" at runtime) -
 * see `onboardOrganisation`.
 */
@Injectable()
export class ReferenceService {
  constructor(
    private readonly forms: FormService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalService,
    private readonly numbering: NumberingService,
    private readonly customFields: CustomFieldService,
  ) {}

  /** Idempotent - seeds this org with the app's declared defaults if not already present. */
  async onboardOrganisation(db: Kysely<Database>, organisationId: string): Promise<void> {
    for (const seq of REFERENCE_APP_MANIFEST.numberingSequences ?? []) {
      await this.numbering.registerSequence(db, organisationId, {
        appId: APP_ID,
        sequenceKey: seq.sequenceKey,
        prefix: seq.prefix,
        padLength: seq.padLength,
        yearReset: seq.yearReset,
      });
    }
    for (const form of REFERENCE_APP_MANIFEST.defaultForms ?? []) {
      await this.forms.seedDefault(
        db,
        organisationId,
        APP_ID,
        form.formKey,
        form.label,
        form.definition as any,
      );
    }
    for (const wf of REFERENCE_APP_MANIFEST.defaultWorkflows ?? []) {
      await this.workflow.registerDefinition(
        db,
        organisationId,
        APP_ID,
        wf.workflowKey,
        wf.definition as any,
      );
    }
    await this.customFields.defineField(db, organisationId, {
      appId: APP_ID,
      entityType: ENTITY_TYPE,
      key: 'warranty_status',
      label: 'Warranty Status',
      fieldType: 'select',
      selectOptions: ['active', 'expired'],
    });
    await this.approvals.registerDefinition(db, organisationId, APP_ID, 'widget-approval', {
      mode: 'sequential',
      steps: [{ approverPermission: 'reference.widget.approve', decisionRule: 'any_one_of' }],
    });
  }

  async createWidget(
    ctx: HexyrnAppContext<Kysely<Database>>,
    db: Kysely<Database>,
    actorUserAccountId: string,
    title: string,
    warrantyStatus?: string,
  ) {
    await this.onboardOrganisation(db, ctx.organisationId); // idempotent

    const formDef = await this.forms.getDefinition(db, ctx.organisationId, APP_ID, 'widget.create');
    this.forms.validateSubmission(formDef.definition as any, {
      title,
      warranty_status: warrantyStatus,
    });

    const widgetNumber = await ctx.numbering.next(db, 'widget');

    const row = await db
      .insertInto('reference_widgets')
      .values({
        organisation_id: ctx.organisationId,
        widget_number: widgetNumber,
        title,
        created_by: actorUserAccountId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (warrantyStatus) {
      await ctx.customFields.setValues(db, ENTITY_TYPE, row.id, {
        warranty_status: warrantyStatus,
      });
    }

    await ctx.workflow.start(db, 'widget-approval', ENTITY_TYPE, row.id, actorUserAccountId);

    return this.getWidget(db, ctx.organisationId, row.id);
  }

  async submitWidget(
    ctx: HexyrnAppContext<Kysely<Database>>,
    db: Kysely<Database>,
    actorUserAccountId: string,
    widgetId: string,
  ) {
    await ctx.workflow.transition(db, ENTITY_TYPE, widgetId, 'submitted', actorUserAccountId);
    const approval = await ctx.approvals.requestApproval(
      db,
      'widget-approval',
      ENTITY_TYPE,
      widgetId,
      { widgetId },
      actorUserAccountId,
    );
    return approval;
  }

  async decide(
    ctx: HexyrnAppContext<Kysely<Database>>,
    db: Kysely<Database>,
    actorUserAccountId: string,
    widgetId: string,
    stepId: string,
    decision: 'approve' | 'reject',
  ) {
    const result = await ctx.approvals.decide(db, stepId, actorUserAccountId, decision);
    if (result.requestStatus === 'approved') {
      await ctx.workflow.transition(db, ENTITY_TYPE, widgetId, 'approved', actorUserAccountId);
      await ctx.events.publish(db, 'reference.widget.approved', { widgetId }, 1);
    } else if (result.requestStatus === 'rejected') {
      await ctx.workflow.transition(db, ENTITY_TYPE, widgetId, 'rejected', actorUserAccountId);
    }
    return this.getWidget(db, ctx.organisationId, widgetId);
  }

  async getWidget(db: Kysely<Database>, organisationId: string, widgetId: string) {
    const widget = await db
      .selectFrom('reference_widgets')
      .selectAll()
      .where('id', '=', widgetId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!widget) throw new NotFoundException('Widget not found.');

    const workflowInstance = await this.workflow
      .getInstance(db, organisationId, ENTITY_TYPE, widgetId)
      .catch(() => null);
    const customFieldValues = await this.customFields.getValues(
      db,
      organisationId,
      ENTITY_TYPE,
      widgetId,
    );

    return {
      id: widget.id,
      widgetNumber: widget.widget_number,
      title: widget.title,
      state: workflowInstance?.current_state ?? null,
      customFields: customFieldValues,
    };
  }
}
