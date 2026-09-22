import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { ApplicationRegistryService } from '../app-registry/application-registry.service';

export interface CapabilityProvider {
  appId: string;
  serviceRef: string;
}

/**
 * Capability discovery. Architecture §4, P1 item 3. Resolution is always
 * "who provides X for THIS organisation, RIGHT NOW" - it intersects the
 * installation-level `capability_providers` registration with each
 * candidate app's per-org active state (enabled ∧ licensed ∧ compatible),
 * per the §3 inactivity invariant ("an inactive app is not a resolvable
 * provider"). Consuming code asks for a capability, never for a specific
 * app - there is no `if (appId === 'com.hexyrn.requisite')` anywhere in
 * this class or intended to be anywhere in Core.
 */
@Injectable()
export class CapabilityResolverService {
  constructor(private readonly registry: ApplicationRegistryService) {}

  async resolve(db: Kysely<Database>, organisationId: string, capability: string): Promise<CapabilityProvider[]> {
    const candidates = await db.selectFrom('capability_providers').selectAll().where('capability', '=', capability).execute();

    const active: CapabilityProvider[] = [];
    for (const candidate of candidates) {
      const state = await this.registry.getApplicationState(db, organisationId, candidate.app_id);
      if (state.active) {
        active.push({ appId: candidate.app_id, serviceRef: candidate.service_ref });
      }
    }
    return active;
  }
}
