/**
 * The seam every connector implements to participate in a sync run, P2
 * item 20. Deliberately minimal: `fetchExternalRecords` returns whatever
 * the external system currently has for one entity type, each tagged with
 * a stable `externalId` the sync engine uses (via sync_external_ids) to
 * decide "have we seen this record before, and which Hexyrn row does it
 * map to."
 */
export interface ExternalRecord {
  externalId: string;
  fields: Record<string, unknown>;
}

export interface SyncAdapter {
  connectorId: string;
  fetchExternalRecords(
    connectionConfig: Record<string, unknown>,
    connectionSecrets: Record<string, string>,
    entityType: string,
  ): Promise<ExternalRecord[]>;
}

export const SYNC_ADAPTER = Symbol('SYNC_ADAPTER_REGISTRY');
