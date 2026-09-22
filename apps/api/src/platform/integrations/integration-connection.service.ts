import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { encryptSecretsMap, decryptSecretsMap } from '../../security/secret-encryption';
import { toJsonbParam } from '../../db/jsonb-param';

/**
 * Per-organisation configured instances of a registered connector, P2
 * item 16. Secret configuration values (API keys/tokens for the external
 * system) are ENCRYPTED, not hashed - same reasoning as webhook signing
 * keys, the sync engine must be able to recover the plaintext to actually
 * call the external system.
 */
@Injectable()
export class IntegrationConnectionService {
  async createConnection(db: Kysely<Database>, organisationId: string, connectorId: string, displayName: string, config: Record<string, unknown>, secrets: Record<string, unknown>, createdBy?: string) {
    const connector = await db.selectFrom('connector_registrations').selectAll().where('connector_id', '=', connectorId).executeTakeFirst();
    if (!connector) throw new NotFoundException(`Connector "${connectorId}" is not registered.`);

    return db
      .insertInto('integration_connections')
      .values({
        organisation_id: organisationId,
        connector_id: connectorId,
        display_name: displayName,
        config: toJsonbParam(config) as any,
        config_secrets_encrypted: toJsonbParam(encryptSecretsMap(secrets)) as any,
        created_by: createdBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getDecryptedSecrets(db: Kysely<Database>, organisationId: string, connectionId: string): Promise<Record<string, string>> {
    const connection = await db.selectFrom('integration_connections').selectAll().where('id', '=', connectionId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!connection) throw new NotFoundException('Integration connection not found.');
    return decryptSecretsMap(connection.config_secrets_encrypted as Record<string, string>);
  }

  async setOwnership(db: Kysely<Database>, organisationId: string, connectionId: string, entityType: string, direction: 'external_to_hexyrn' | 'hexyrn_to_external' | 'bidirectional', authoritativeSystem: 'external' | 'hexyrn', conflictResolution?: string) {
    if (direction === 'bidirectional' && !conflictResolution) {
      throw new BadRequestException('conflictResolution is required when direction is "bidirectional".');
    }
    await db
      .insertInto('sync_ownership')
      .values({ organisation_id: organisationId, connection_id: connectionId, entity_type: entityType, direction, authoritative_system: authoritativeSystem, conflict_resolution: conflictResolution ?? null })
      .onConflict((oc) => oc.columns(['connection_id', 'entity_type']).doUpdateSet({ direction, authoritative_system: authoritativeSystem, conflict_resolution: conflictResolution ?? null }))
      .execute();
  }

  private static readonly ALLOWED_TRANSFORMS = new Set(['none', 'trim', 'uppercase', 'lowercase', 'to_string', 'to_number']);

  async setFieldMapping(db: Kysely<Database>, organisationId: string, connectionId: string, entityType: string, mappings: { hexyrnField: string; externalField: string; transform?: string; required?: boolean }[]) {
    for (const m of mappings) {
      const transform = m.transform ?? 'none';
      if (!IntegrationConnectionService.ALLOWED_TRANSFORMS.has(transform)) {
        throw new BadRequestException(`Unknown transform "${transform}". Allowed: ${[...IntegrationConnectionService.ALLOWED_TRANSFORMS].join(', ')}`);
      }
    }
    await db.deleteFrom('field_mappings').where('connection_id', '=', connectionId).where('entity_type', '=', entityType).execute();
    if (mappings.length === 0) return;
    await db
      .insertInto('field_mappings')
      .values(
        mappings.map((m) => ({
          organisation_id: organisationId,
          connection_id: connectionId,
          entity_type: entityType,
          hexyrn_field: m.hexyrnField,
          external_field: m.externalField,
          transform: m.transform ?? 'none',
          is_required: m.required ?? false,
        })),
      )
      .execute();
  }

  applyTransform(value: unknown, transform: string): unknown {
    switch (transform) {
      case 'trim':
        return typeof value === 'string' ? value.trim() : value;
      case 'uppercase':
        return typeof value === 'string' ? value.toUpperCase() : value;
      case 'lowercase':
        return typeof value === 'string' ? value.toLowerCase() : value;
      case 'to_string':
        return value === null || value === undefined ? value : String(value);
      case 'to_number':
        return value === null || value === undefined ? value : Number(value);
      case 'none':
      default:
        return value;
    }
  }
}
