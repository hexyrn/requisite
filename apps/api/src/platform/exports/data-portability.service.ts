import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';
import { ExportService } from './export.service';

/**
 * Data Portability, P2 item 22. "Export everything this organisation owns
 * that this caller can see" - built entirely out of the same
 * permission-safe primitives the rest of reporting/export already
 * enforces (ExportService -> ReportQueryService), never a raw table dump.
 * A dataset the caller lacks permission for, or that isn't marked
 * exportable, is silently OMITTED from the bundle rather than causing the
 * whole export to fail - the caller gets everything they're entitled to,
 * not an all-or-nothing error.
 */
@Injectable()
export class DataPortabilityService {
  constructor(private readonly exportsService: ExportService) {}

  async exportOrganisationData(db: Kysely<Database>, subject: PermissionCheckSubject): Promise<Record<string, { rowCount: number; csv: Buffer }>> {
    const datasets = await db.selectFrom('dataset_definitions').selectAll().where('is_exportable', '=', true).execute();
    const bundle: Record<string, { rowCount: number; csv: Buffer }> = {};

    for (const dataset of datasets) {
      if (!subject.grantedPermissions.has(dataset.required_permission)) continue;
      try {
        const fields = (dataset.fields as any[]).map((f) => f.key);
        const { rows } = await this.exportsService.runQueryForExport(db, subject, { datasetKey: dataset.dataset_key, fields });
        bundle[dataset.dataset_key] = { rowCount: rows.length, csv: this.exportsService.toCsvBuffer(rows, fields) };
      } catch {
        // A dataset that fails to export (e.g. a transient issue) is
        // omitted, not fatal to the whole portability bundle - the caller
        // still gets everything else.
        continue;
      }
    }

    return bundle;
  }
}
