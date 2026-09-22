import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export interface ChecklistQuestionDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'yes_no' | 'pass_fail' | 'select' | 'measurement' | 'comment' | 'attachment' | 'photo' | 'signature';
  required?: boolean;
  options?: string[];
  conditional?: { dependsOn: string; equals: unknown };
  /** Whether a 'fail'/'no' response on this question should be flagged as a resulting issue. */
  flagsIssueOnFail?: boolean;
  scoreWeight?: number;
}

export interface ChecklistSectionDefinition {
  key: string;
  label: string;
  questions: ChecklistQuestionDefinition[];
}

export interface ChecklistDefinitionShape {
  sections: ChecklistSectionDefinition[];
}

/**
 * Checklist engine. Architecture-required, P1 item 11. Core owns the
 * mechanism (templates/sections/questions/responses/scoring); applications
 * own what a checklist MEANS - `resulting_issue_ref` is a free-text pointer
 * an app can set to link a failed question to its OWN issue/ticket entity,
 * without Core needing to know that entity's shape.
 */
@Injectable()
export class ChecklistService {
  async createTemplate(db: Kysely<Database>, organisationId: string, appId: string, templateKey: string, label: string, definition: ChecklistDefinitionShape) {
    return db
      .insertInto('checklist_templates')
      .values({ organisation_id: organisationId, app_id: appId, template_key: templateKey, label, definition: definition as any })
      .onConflict((oc) => oc.columns(['organisation_id', 'app_id', 'template_key']).doUpdateSet({ definition: definition as any, label, updated_at: new Date() as any }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async startInstance(db: Kysely<Database>, organisationId: string, templateId: string, entityType: string, entityId: string, startedBy: string) {
    return db
      .insertInto('checklist_instances')
      .values({ organisation_id: organisationId, template_id: templateId, entity_type: entityType, entity_id: entityId, started_by: startedBy })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async answer(db: Kysely<Database>, organisationId: string, instanceId: string, questionKey: string, value: unknown, answeredBy: string, resultingIssueRef?: string): Promise<void> {
    const instance = await db.selectFrom('checklist_instances').selectAll().where('id', '=', instanceId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!instance) throw new NotFoundException('Checklist instance not found.');
    if (instance.status === 'completed') throw new BadRequestException('This checklist has already been completed.');

    await db
      .insertInto('checklist_responses')
      .values({ organisation_id: organisationId, instance_id: instanceId, question_key: questionKey, value: value as any, answered_by: answeredBy, resulting_issue_ref: resultingIssueRef ?? null })
      .onConflict((oc) => oc.columns(['instance_id', 'question_key']).doUpdateSet({ value: value as any, answered_by: answeredBy, resulting_issue_ref: resultingIssueRef ?? null, answered_at: new Date() as any }))
      .execute();
  }

  async complete(db: Kysely<Database>, organisationId: string, instanceId: string): Promise<{ score: number | null }> {
    const instance = await db.selectFrom('checklist_instances').selectAll().where('id', '=', instanceId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!instance) throw new NotFoundException('Checklist instance not found.');

    const template = await db.selectFrom('checklist_templates').selectAll().where('id', '=', instance.template_id).executeTakeFirstOrThrow();
    const definition = template.definition as unknown as ChecklistDefinitionShape;
    const responses = await db.selectFrom('checklist_responses').selectAll().where('instance_id', '=', instanceId).execute();
    const responseByKey = new Map(responses.map((r) => [r.question_key, r.value]));

    for (const section of definition.sections) {
      for (const q of section.questions) {
        const visible = !q.conditional || responseByKey.get(q.conditional.dependsOn) === q.conditional.equals;
        if (visible && q.required && !responseByKey.has(q.key)) {
          throw new BadRequestException(`Question "${q.label}" is required.`);
        }
      }
    }

    let totalWeight = 0;
    let earnedWeight = 0;
    for (const section of definition.sections) {
      for (const q of section.questions) {
        if (!q.scoreWeight) continue;
        totalWeight += q.scoreWeight;
        const val = responseByKey.get(q.key);
        if (val === true || val === 'pass' || val === 'yes') earnedWeight += q.scoreWeight;
      }
    }
    const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : null;

    await db.updateTable('checklist_instances').set({ status: 'completed', completed_at: new Date() as any, score: score as any }).where('id', '=', instanceId).execute();
    return { score };
  }
}
