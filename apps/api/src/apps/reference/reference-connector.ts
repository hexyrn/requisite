import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { getPool } from '../../db/pool';
import { Database } from '../../db/types';
import { SyncAdapter, ExternalRecord } from '../../platform/integrations/sync-adapter';
import { SyncAdapterRegistryService } from '../../platform/integrations/sync-adapter-registry.service';
import { SyncHandlerRegistryService } from '../../platform/integrations/sync-row-handler';
import { ConnectorRegistryService } from '../../platform/integrations/connector-registry.service';

export const REFERENCE_CONNECTOR_ID = 'com.hexyrn.connector.reference';

/**
 * Reference Connector, P2 item 27 - a genuine (if trivial) end-to-end
 * demonstration of the Integration Framework/Sync Engine, mirroring the
 * reference APP's role for the App Platform in P1. "Fetches" from an
 * in-memory fixture list rather than a real external system (no real
 * third-party dependency belongs in Core's own test suite), but every
 * step downstream of `fetchExternalRecords` - field mapping, transform
 * application, sync_external_ids dedup, sync_runs bookkeeping - is the
 * exact same code path a real commercial connector would run through.
 */
export class ReferenceConnectorAdapter implements SyncAdapter {
  connectorId = REFERENCE_CONNECTOR_ID;
  private fixtureRecords: ExternalRecord[] = [];

  /** Test/demo seam - a real connector would call an external API here instead. */
  setFixtureRecords(records: ExternalRecord[]): void {
    this.fixtureRecords = records;
  }

  async fetchExternalRecords(_config: Record<string, unknown>, _secrets: Record<string, string>, entityType: string): Promise<ExternalRecord[]> {
    if (entityType !== 'reference.widget') return [];
    return this.fixtureRecords;
  }
}

export async function registerReferenceConnector(
  registry: ConnectorRegistryService,
  adapters: SyncAdapterRegistryService,
  syncHandlers: SyncHandlerRegistryService,
  pool: Pool = getPool(),
): Promise<ReferenceConnectorAdapter> {
  await registry.registerConnector(
    REFERENCE_CONNECTOR_ID,
    'Reference Connector (demo)',
    ['reference.widget'],
    ['inbound'],
    [{ key: 'apiToken', label: 'API Token', secret: true, required: true }],
    pool,
  );

  const adapter = new ReferenceConnectorAdapter();
  adapters.register(adapter);

  syncHandlers.register('reference.widget', async (db: Kysely<Database>, organisationId: string, mappedFields: Record<string, unknown>, existingId?: string) => {
    const title = String(mappedFields.title ?? 'Untitled');
    const widgetNumber = String(mappedFields.widgetNumber ?? `SYNC-${Date.now()}`);

    if (existingId) {
      await db.updateTable('reference_widgets').set({ title }).where('id', '=', existingId).where('organisation_id', '=', organisationId).execute();
      return existingId;
    }

    const row = await db
      .insertInto('reference_widgets')
      .values({ organisation_id: organisationId, widget_number: widgetNumber, title })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row.id;
  });

  return adapter;
}
