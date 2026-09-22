import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

/**
 * Applies one mapped external record to a Hexyrn table and returns the
 * Hexyrn entity id it created/updated - the sync engine needs that id
 * back (unlike the plain Import Framework's row handler, which returns
 * void) so it can record/refresh the sync_external_ids dedup mapping.
 * `existingHexyrnEntityId` is populated when sync_external_ids already has
 * a mapping for this external record, letting the handler UPDATE instead
 * of INSERT.
 */
export type SyncRowHandler = (
  db: Kysely<Database>,
  organisationId: string,
  mappedFields: Record<string, unknown>,
  existingHexyrnEntityId: string | undefined,
) => Promise<string>;

/** In-process entity_type -> handler map, same pattern as every other Core handler registry. */
@Injectable()
export class SyncHandlerRegistryService {
  private readonly handlers = new Map<string, SyncRowHandler>();
  register(entityType: string, handler: SyncRowHandler): void {
    this.handlers.set(entityType, handler);
  }
  get(entityType: string): SyncRowHandler | undefined {
    return this.handlers.get(entityType);
  }
}
