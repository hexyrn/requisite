import { Injectable } from '@nestjs/common';
import { SyncAdapter } from './sync-adapter';

/** In-process connector_id -> SyncAdapter map, same pattern as every other Core handler registry. */
@Injectable()
export class SyncAdapterRegistryService {
  private readonly adapters = new Map<string, SyncAdapter>();
  register(adapter: SyncAdapter): void {
    this.adapters.set(adapter.connectorId, adapter);
  }
  get(connectorId: string): SyncAdapter | undefined {
    return this.adapters.get(connectorId);
  }
}
