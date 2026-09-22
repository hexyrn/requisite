import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { ReportQueryDefinition } from './report-query.service';

/**
 * Custom Report Builder persistence. P2 item 4. Actual query execution
 * always goes through ReportQueryService - this class only owns CRUD +
 * ownership/visibility rules for saved definitions, never touches
 * business data itself.
 */
@Injectable()
export class SavedReportService {
  async registerTemplate(templateKey: string, appId: string, name: string, primaryDataset: string, definition: ReportQueryDefinition, db: Kysely<Database>): Promise<void> {
    await db
      .insertInto('report_templates')
      .values({ template_key: templateKey, app_id: appId, name, primary_dataset: primaryDataset, definition: definition as any })
      .onConflict((oc) => oc.column('template_key').doUpdateSet({ name, primary_dataset: primaryDataset, definition: definition as any }))
      .execute();
  }

  async save(db: Kysely<Database>, organisationId: string, ownerUserAccountId: string, name: string, primaryDataset: string, definition: ReportQueryDefinition, visibility: 'personal' | 'shared' = 'personal') {
    return db
      .insertInto('saved_reports')
      .values({ organisation_id: organisationId, owner_user_account_id: ownerUserAccountId, name, primary_dataset: primaryDataset, definition: definition as any, visibility })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Clones an app-registered template into an org's own editable saved report - the org's copy, never mutating the app's original. */
  async cloneTemplate(db: Kysely<Database>, organisationId: string, ownerUserAccountId: string, templateKey: string) {
    const template = await db.selectFrom('report_templates').selectAll().where('template_key', '=', templateKey).executeTakeFirst();
    if (!template) throw new NotFoundException(`Report template "${templateKey}" not found.`);
    return db
      .insertInto('saved_reports')
      .values({
        organisation_id: organisationId,
        owner_user_account_id: ownerUserAccountId,
        name: template.name,
        primary_dataset: template.primary_dataset,
        definition: template.definition as any,
        cloned_from_template_key: templateKey,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async get(db: Kysely<Database>, organisationId: string, reportId: string, requestingUserAccountId: string) {
    const report = await db.selectFrom('saved_reports').selectAll().where('id', '=', reportId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!report) throw new NotFoundException('Report not found.');
    if (report.visibility === 'personal' && report.owner_user_account_id !== requestingUserAccountId) {
      throw new ForbiddenException('This is a personal report belonging to another user.');
    }
    return report;
  }

  async listForUser(db: Kysely<Database>, organisationId: string, userAccountId: string) {
    return db
      .selectFrom('saved_reports')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where((eb) => eb.or([eb('visibility', '=', 'shared'), eb('owner_user_account_id', '=', userAccountId)]))
      .execute();
  }

  async delete(db: Kysely<Database>, organisationId: string, reportId: string, requestingUserAccountId: string): Promise<void> {
    const report = await this.get(db, organisationId, reportId, requestingUserAccountId);
    if (report.owner_user_account_id !== requestingUserAccountId) {
      throw new ForbiddenException('Only the owner may delete this report.');
    }
    await db.deleteFrom('saved_reports').where('id', '=', reportId).execute();
  }
}
