import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { NumberingService } from '../../platform/numbering/numbering.service';
import { FormService } from '../../platform/forms/form.service';
import { WorkflowService } from '../../platform/workflow/workflow.service';
import { ApprovalService } from '../../platform/approval/approval.service';
import { REQUISITE_APP_MANIFEST } from './requisite.manifest';

const APP_ID = REQUISITE_APP_MANIFEST.appId;

/**
 * Idempotent per-organisation seeding of Requisite's declared defaults -
 * same pattern as the reference app's onboardOrganisation (P1 item 17):
 * numbering sequences, default forms, default workflow, and a default
 * approval configuration (item 7's example SME thresholds - genuinely
 * configurable afterwards through Core's own approval/permission
 * mechanisms, never re-hardcoded at runtime).
 */
@Injectable()
export class RequisiteOnboardingService {
  constructor(
    private readonly numbering: NumberingService,
    private readonly forms: FormService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalService,
  ) {}

  async onboardOrganisation(db: Kysely<Database>, organisationId: string): Promise<void> {
    for (const seq of REQUISITE_APP_MANIFEST.numberingSequences ?? []) {
      await this.numbering.registerSequence(db, organisationId, { appId: APP_ID, sequenceKey: seq.sequenceKey, prefix: seq.prefix, padLength: seq.padLength, yearReset: seq.yearReset });
    }
    for (const form of REQUISITE_APP_MANIFEST.defaultForms ?? []) {
      await this.forms.seedDefault(db, organisationId, APP_ID, form.formKey, form.label, form.definition as any);
    }
    for (const wf of REQUISITE_APP_MANIFEST.defaultWorkflows ?? []) {
      await this.workflow.registerDefinition(db, organisationId, APP_ID, wf.workflowKey, wf.definition as any);
    }
    // Item 7's example default: a single-step approval by anyone holding
    // requisite.requisitions.approve. A real SME rollout is expected to
    // reconfigure this (multi-step by value threshold) through Core
    // Approval's own supported configuration surface - this default exists
    // so Requisite is usable out of the box, not as a permanent policy.
    await this.approvals.registerDefinition(db, organisationId, APP_ID, 'requisition-approval', {
      mode: 'sequential',
      steps: [{ approverPermission: 'requisite.requisitions.approve', decisionRule: 'any_one_of' }],
    });
  }
}
