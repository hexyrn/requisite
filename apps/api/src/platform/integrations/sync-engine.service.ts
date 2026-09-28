import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { toJsonbParam } from '../../db/jsonb-param';
import { IntegrationConnectionService } from './integration-connection.service';
import { SyncAdapterRegistryService } from './sync-adapter-registry.service';
import { SyncHandlerRegistryService } from './sync-row-handler';

/**
 * Sync Engine Foundations, P2 item 20. Deliberately reuses the Import
 * Framework's row-handler seam (ImportHandlerRegistryService) to actually
 * apply an external record to a Hexyrn table - "external_to_hexyrn" sync
 * is, at the point a record is applied, indistinguishable from an import
 * row: an app-owned handler receives an allowlisted set of mapped fields
 * and decides how to persist them. Core never writes an app's table
 * directly, same boundary as every other extension point.
 *
 * Idempotency: sync_external_ids (connection_id, entity_type, external_id)
 * is the dedup backbone - a record already seen is matched to its existing
 * hexyrn_entity_id rather than re-created, and re-running a sync is always
 * safe (no duplicate rows from re-processing the same external record).
 */
@Injectable()
export class SyncEngineService {
  constructor(
    private readonly connections: IntegrationConnectionService,
    private readonly adapters: SyncAdapterRegistryService,
    private readonly syncHandlers: SyncHandlerRegistryService,
  ) {}

  async runSync(
    db: Kysely<Database>,
    organisationId: string,
    connectionId: string,
    entityType: string,
  ): Promise<{
    runId: string;
    processedCount: number;
    successCount: number;
    failureCount: number;
  }> {
    const connection = await db
      .selectFrom('integration_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!connection) throw new NotFoundException('Integration connection not found.');

    const ownership = await db
      .selectFrom('sync_ownership')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('entity_type', '=', entityType)
      .executeTakeFirst();
    if (!ownership)
      throw new NotFoundException(
        `No sync ownership configured for entity type "${entityType}" on this connection.`,
      );

    const adapter = this.adapters.get(connection.connector_id);
    if (!adapter)
      throw new NotFoundException(
        `No sync adapter registered for connector "${connection.connector_id}".`,
      );

    const fieldMappings = await db
      .selectFrom('field_mappings')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('entity_type', '=', entityType)
      .execute();
    const handler = this.syncHandlers.get(entityType);

    const run = await db
      .insertInto('sync_runs')
      .values({
        organisation_id: organisationId,
        connection_id: connectionId,
        entity_type: entityType,
        direction: ownership.direction,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    let processedCount = 0;
    let successCount = 0;
    const errors: { externalId: string; error: string }[] = [];

    try {
      const secrets = await this.connections.getDecryptedSecrets(db, organisationId, connectionId);
      const externalRecords = await adapter.fetchExternalRecords(
        connection.config as Record<string, unknown>,
        secrets,
        entityType,
      );

      for (const record of externalRecords) {
        processedCount++;
        try {
          const existing = await db
            .selectFrom('sync_external_ids')
            .selectAll()
            .where('connection_id', '=', connectionId)
            .where('entity_type', '=', entityType)
            .where('external_id', '=', record.externalId)
            .executeTakeFirst();

          const mappedFields: Record<string, unknown> = {};
          for (const mapping of fieldMappings) {
            const raw = record.fields[mapping.external_field];
            if (mapping.is_required && (raw === undefined || raw === null)) {
              throw new Error(
                `Missing required external field "${mapping.external_field}" (maps to "${mapping.hexyrn_field}")`,
              );
            }
            mappedFields[mapping.hexyrn_field] = this.connections.applyTransform(
              raw,
              mapping.transform,
            );
          }

          if (!handler)
            throw new Error(`No sync handler registered for entity type "${entityType}"`);

          const resolvedId = await handler(
            db,
            organisationId,
            mappedFields,
            existing?.hexyrn_entity_id,
          );
          if (resolvedId) {
            await db
              .insertInto('sync_external_ids')
              .values({
                organisation_id: organisationId,
                connection_id: connectionId,
                entity_type: entityType,
                external_id: record.externalId,
                hexyrn_entity_id: resolvedId,
              })
              .onConflict((oc) =>
                oc
                  .columns(['connection_id', 'entity_type', 'external_id'])
                  .doUpdateSet({ hexyrn_entity_id: resolvedId, last_synced_at: new Date() as any }),
              )
              .execute();
          }
          successCount++;
        } catch (err) {
          errors.push({
            externalId: record.externalId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await db
        .updateTable('sync_runs')
        .set({
          status: errors.length === 0 ? 'completed' : successCount > 0 ? 'completed' : 'failed',
          processed_count: processedCount,
          success_count: successCount,
          failure_count: errors.length,
          errors: toJsonbParam(errors) as any,
          ended_at: new Date() as any,
        })
        .where('id', '=', run.id)
        .execute();
    } catch (err) {
      await db
        .updateTable('sync_runs')
        .set({
          status: 'failed',
          processed_count: processedCount,
          success_count: successCount,
          failure_count: processedCount - successCount,
          errors: toJsonbParam([
            { externalId: '*', error: err instanceof Error ? err.message : String(err) },
          ]) as any,
          ended_at: new Date() as any,
        })
        .where('id', '=', run.id)
        .execute();
      throw err;
    }

    return { runId: run.id, processedCount, successCount, failureCount: errors.length };
  }
}
