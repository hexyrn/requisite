import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export type ImportRowHandler = (
  db: Kysely<Database>,
  organisationId: string,
  row: Record<string, unknown>,
) => Promise<void>;

/** In-process entity_type -> handler map, same pattern as EventHandlerRegistryService/JobHandlerRegistryService - Core never knows how to write an app's own table directly. */
@Injectable()
export class ImportHandlerRegistryService {
  private readonly handlers = new Map<string, ImportRowHandler>();
  register(entityType: string, handler: ImportRowHandler): void {
    this.handlers.set(entityType, handler);
  }
  get(entityType: string): ImportRowHandler | undefined {
    return this.handlers.get(entityType);
  }
}
