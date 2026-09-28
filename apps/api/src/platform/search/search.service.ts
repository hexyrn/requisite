import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';

export interface SearchResult {
  entityType: string;
  entityId: string;
  label: string;
  destination: string;
}

/**
 * Platform Search, P2 item 9. Apps register a (entity_type, required
 * permission) pair once via `registerEntityType`, then keep
 * `search_index` up to date as their own records change via `indexUpsert`.
 * `search()` is the read path and is PERMISSION-SAFE by construction: it
 * only ever searches entity_types whose `required_permission` the caller
 * actually holds (checked per entity_type before that type's rows are ever
 * touched) - there is no way to see a search hit for data you could not
 * otherwise query, exactly like the report query engine's dataset
 * permission gate.
 */
@Injectable()
export class SearchService {
  async registerEntityType(
    db: Kysely<Database>,
    entityType: string,
    appId: string,
    requiredPermission: string,
    resultLabelTemplate: string,
    resultDestinationTemplate: string,
  ): Promise<void> {
    await db
      .insertInto('search_entity_registrations')
      .values({
        entity_type: entityType,
        app_id: appId,
        required_permission: requiredPermission,
        result_label_template: resultLabelTemplate,
        result_destination_template: resultDestinationTemplate,
      })
      .onConflict((oc) =>
        oc.column('entity_type').doUpdateSet({
          required_permission: requiredPermission,
          result_label_template: resultLabelTemplate,
          result_destination_template: resultDestinationTemplate,
        }),
      )
      .execute();
  }

  /** Upserts (or, with searchText='', effectively removes from matching) one entity's search-index row - called by an app whenever the underlying record changes. */
  async indexUpsert(
    db: Kysely<Database>,
    organisationId: string,
    entityType: string,
    entityId: string,
    searchText: string,
    resultLabel: string,
    resultDestination: string,
  ): Promise<void> {
    await db
      .insertInto('search_index')
      .values({
        organisation_id: organisationId,
        entity_type: entityType,
        entity_id: entityId,
        search_text: searchText,
        result_label: resultLabel,
        result_destination: resultDestination,
      })
      .onConflict((oc) =>
        oc.columns(['organisation_id', 'entity_type', 'entity_id']).doUpdateSet({
          search_text: searchText,
          result_label: resultLabel,
          result_destination: resultDestination,
          updated_at: new Date() as any,
        }),
      )
      .execute();
  }

  async removeFromIndex(
    db: Kysely<Database>,
    organisationId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await db
      .deleteFrom('search_index')
      .where('organisation_id', '=', organisationId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .execute();
  }

  async search(
    db: Kysely<Database>,
    subject: PermissionCheckSubject,
    query: string,
    limit = 20,
  ): Promise<SearchResult[]> {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('Search query must not be empty.');
    }

    const registrations = await db.selectFrom('search_entity_registrations').selectAll().execute();
    const allowedEntityTypes = registrations
      .filter((r) => subject.grantedPermissions.has(r.required_permission))
      .map((r) => r.entity_type);
    if (allowedEntityTypes.length === 0) return [];

    const rows = await db
      .selectFrom('search_index')
      .select(['entity_type', 'entity_id', 'result_label', 'result_destination'])
      .where('organisation_id', '=', subject.organisationId)
      .where('entity_type', 'in', allowedEntityTypes)
      .where(sql<boolean>`search_vector @@ plainto_tsquery('english', ${query})`)
      .limit(Math.min(limit, 100))
      .execute();

    return rows.map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      label: r.result_label,
      destination: r.result_destination,
    }));
  }
}
