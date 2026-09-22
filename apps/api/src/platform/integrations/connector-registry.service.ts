import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { toJsonbParam } from '../../db/jsonb-param';

export type IntegrationDirection = 'inbound' | 'outbound' | 'bidirectional';

export interface ConnectorConfigField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
}

/**
 * Integration Centre's connector catalogue, P2 items 16/17.
 * `connector_registrations` is installation-level (no RLS) - it describes
 * which connector IMPLEMENTATIONS exist in this build, not any
 * organisation's configuration of one (that's integration_connections,
 * below).
 */
@Injectable()
export class ConnectorRegistryService {
  async registerConnector(connectorId: string, displayName: string, supportedEntities: string[], supportedDirections: IntegrationDirection[], configSchema: ConnectorConfigField[], pool: Pool = getPool()): Promise<void> {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await db
      .insertInto('connector_registrations')
      .values({ connector_id: connectorId, display_name: displayName, supported_entities: supportedEntities, supported_directions: supportedDirections, config_schema: toJsonbParam(configSchema) as any })
      .onConflict((oc) => oc.column('connector_id').doUpdateSet({ display_name: displayName, supported_entities: supportedEntities, supported_directions: supportedDirections, config_schema: toJsonbParam(configSchema) as any }))
      .execute();
  }

  async listConnectors(db: Kysely<Database>) {
    return db.selectFrom('connector_registrations').selectAll().execute();
  }
}
