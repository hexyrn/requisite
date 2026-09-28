import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';
import { ImportHandlerRegistryService } from './import-row-handler';
import { toJsonbParam } from '../../db/jsonb-param';

export interface ImportFieldDefinition {
  key: string;
  label: string;
  required?: boolean;
  fieldType: 'string' | 'number' | 'boolean';
}

/**
 * Import Framework, P2 item 10. Mirrors the Export Framework's shape:
 * apps declare WHAT can be imported (registerEntityType, required
 * permission + field allowlist) and register a row handler
 * (ImportHandlerRegistryService, same in-process map pattern as
 * EventHandlerRegistryService/JobHandlerRegistryService) that actually
 * writes their own table - Core never touches app-owned tables directly,
 * same boundary the rest of the SDK enforces.
 */
@Injectable()
export class ImportService {
  constructor(private readonly handlers: ImportHandlerRegistryService) {}

  async registerEntityType(
    db: Kysely<Database>,
    entityType: string,
    appId: string,
    requiredPermission: string,
    fields: ImportFieldDefinition[],
  ): Promise<void> {
    await db
      .insertInto('import_definitions')
      .values({
        entity_type: entityType,
        app_id: appId,
        required_permission: requiredPermission,
        fields: toJsonbParam(fields) as any,
      })
      .onConflict((oc) =>
        oc.column('entity_type').doUpdateSet({
          required_permission: requiredPermission,
          fields: toJsonbParam(fields) as any,
        }),
      )
      .execute();
  }

  /**
   * Runs an import synchronously, one row at a time. PERMISSION SAFETY:
   * requires the entity type's required_permission before touching any
   * row. A per-row failure (e.g. a registered handler throwing on bad
   * data) is caught and recorded in row_errors, not a hard stop - one bad
   * row in a 500-row import must not silently discard the other 499.
   */
  async runImport(
    db: Kysely<Database>,
    subject: PermissionCheckSubject,
    entityType: string,
    rows: Record<string, string>[],
    columnMapping: Record<string, string>,
  ): Promise<{ jobId: string; successCount: number; errorCount: number }> {
    const definition = await db
      .selectFrom('import_definitions')
      .selectAll()
      .where('entity_type', '=', entityType)
      .executeTakeFirst();
    if (!definition)
      throw new NotFoundException(`Import entity type "${entityType}" is not registered.`);
    if (!subject.grantedPermissions.has(definition.required_permission)) {
      throw new ForbiddenException(
        `Missing required permission "${definition.required_permission}" to import "${entityType}".`,
      );
    }

    const handler = this.handlers.get(entityType);
    if (!handler)
      throw new BadRequestException(`No import handler registered for "${entityType}".`);

    const fields = definition.fields as unknown as ImportFieldDefinition[];
    const declaredKeys = new Set(fields.map((f) => f.key));

    const job = await db
      .insertInto('import_jobs')
      .values({
        organisation_id: subject.organisationId,
        entity_type: entityType,
        requested_by: subject.userAccountId,
        column_mapping: columnMapping as any,
        status: 'processing',
        total_rows: rows.length,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let successCount = 0;
    const rowErrors: { row: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const sourceRow = rows[i];
      const mappedRow: Record<string, unknown> = {};
      for (const field of fields) {
        const sourceColumn = columnMapping[field.key];
        if (!sourceColumn) {
          if (field.required)
            rowErrors.push({
              row: i,
              error: `Missing column mapping for required field "${field.key}"`,
            });
          continue;
        }
        const raw = sourceRow[sourceColumn];
        if (field.required && (raw === undefined || raw === '')) {
          rowErrors.push({ row: i, error: `Missing required value for "${field.key}"` });
          continue;
        }
        mappedRow[field.key] = this.coerce(raw, field.fieldType);
      }
      if (rowErrors.length > 0 && rowErrors[rowErrors.length - 1].row === i) continue; // this row already failed a required-field check above

      // Only allowlisted keys are ever handed to the app's handler - a
      // caller-supplied column_mapping cannot smuggle an undeclared field
      // through, same "only declared keys reachable" rule as the report
      // query engine.
      const safeRow: Record<string, unknown> = {};
      for (const key of Object.keys(mappedRow)) {
        if (declaredKeys.has(key)) safeRow[key] = mappedRow[key];
      }

      try {
        await handler(db, subject.organisationId, safeRow);
        successCount++;
      } catch (err) {
        rowErrors.push({ row: i, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const status =
      rowErrors.length === 0 ? 'completed' : successCount > 0 ? 'completed_with_errors' : 'failed';
    await db
      .updateTable('import_jobs')
      .set({
        status,
        success_count: successCount,
        error_count: rowErrors.length,
        row_errors: toJsonbParam(rowErrors) as any,
        completed_at: new Date() as any,
      })
      .where('id', '=', job.id)
      .execute();

    return { jobId: job.id, successCount, errorCount: rowErrors.length };
  }

  private coerce(value: unknown, type: 'string' | 'number' | 'boolean'): unknown {
    if (value === undefined || value === null) return value;
    if (type === 'number') return Number(value);
    if (type === 'boolean') return String(value).toLowerCase() === 'true' || value === '1';
    return String(value);
  }
}
