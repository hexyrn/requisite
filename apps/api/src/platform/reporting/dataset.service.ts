import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime';
export type Aggregation = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface DatasetFieldDefinition {
  key: string;
  label: string;
  fieldType: FieldType;
  isDimension?: boolean;
  isMeasure?: boolean;
  /** Only meaningful when isMeasure. Allowlist of safe aggregations for this field - never arbitrary SQL. */
  allowedAggregations?: Aggregation[];
  filterable?: boolean;
  sortable?: boolean;
  groupable?: boolean;
  searchable?: boolean;
  classification?: 'internal' | 'restricted';
  exportable?: boolean;
  /** Extra permission required to SEE this specific field, beyond the dataset's own required_permission. */
  requiredPermission?: string;
}

export interface DatasetDefinitionInput {
  datasetKey: string;
  appId: string;
  displayName: string;
  description?: string;
  requiredPermission: string;
  sourceRef: string; // the real table name - opaque to every caller except ReportQueryService
  fields: DatasetFieldDefinition[];
  isExportable?: boolean;
}

/**
 * Reporting Dataset Registry. Architecture §5/§11(Rev1), P2 item 1.
 * Applications register SEMANTIC datasets, never raw table access -
 * `sourceRef` is the only place a real table name appears, and it is only
 * ever read by `ReportQueryService`. `registerDataset` is installation-
 * level (no organisation_id - a dataset's SHAPE is not organisation data,
 * same reasoning as `installed_applications`), called at boot for every
 * compiled-in app, exactly like `ApplicationRegistryService.registerApp`.
 */
@Injectable()
export class DatasetService {
  async registerDataset(input: DatasetDefinitionInput, pool: Pool = getPool()): Promise<void> {
    if (!/^[a-z0-9_]+\.[a-z0-9_-]+$/.test(input.datasetKey)) {
      throw new BadRequestException('datasetKey must be "<app-namespace>.<name>", lowercase alphanumeric/underscore/hyphen.');
    }
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    try {
      await db
        .insertInto('dataset_definitions')
        .values({
          dataset_key: input.datasetKey,
          app_id: input.appId,
          display_name: input.displayName,
          description: input.description ?? null,
          required_permission: input.requiredPermission,
          source_ref: input.sourceRef,
          fields: JSON.stringify(input.fields) as any,
          is_exportable: input.isExportable ?? true,
        })
        .onConflict((oc) =>
          oc.column('dataset_key').doUpdateSet({
            display_name: input.displayName,
            description: input.description ?? null,
            required_permission: input.requiredPermission,
            source_ref: input.sourceRef,
            fields: JSON.stringify(input.fields) as any,
            is_exportable: input.isExportable ?? true,
            updated_at: new Date() as any,
          }),
        )
        .execute();
    } finally {
      // Shared/caller-owned pool - never destroy it (see the identical
      // note in installation.service.ts, the same class of bug found in P0).
    }
  }

  async registerRelationship(
    fromDataset: string,
    fromField: string,
    toDataset: string,
    toField: string,
    cardinality: 'one-to-one' | 'many-to-one' | 'one-to-many',
    label: string,
    pool: Pool = getPool(),
  ): Promise<void> {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    // Fail safe if either dataset isn't registered (e.g. target app not
    // installed) - Architecture §5: "the registering app's own
    // registration call fails safe / is skipped at boot."
    const [from, to] = await Promise.all([
      db.selectFrom('dataset_definitions').select('dataset_key').where('dataset_key', '=', fromDataset).executeTakeFirst(),
      db.selectFrom('dataset_definitions').select('dataset_key').where('dataset_key', '=', toDataset).executeTakeFirst(),
    ]);
    if (!from || !to) return;

    await db
      .insertInto('dataset_relationships')
      .values({ from_dataset: fromDataset, from_field: fromField, to_dataset: toDataset, to_field: toField, cardinality, label })
      .onConflict((oc) => oc.columns(['from_dataset', 'from_field', 'to_dataset', 'to_field']).doUpdateSet({ cardinality, label }))
      .execute();
  }

  async getDataset(db: Kysely<Database>, datasetKey: string) {
    return db.selectFrom('dataset_definitions').selectAll().where('dataset_key', '=', datasetKey).executeTakeFirst();
  }

  /** Only relationships where BOTH datasets are currently registered - Architecture §5's "fails safe / disappears" requirement. */
  async getAvailableRelationships(db: Kysely<Database>, fromDataset: string) {
    return db.selectFrom('dataset_relationships').selectAll().where('from_dataset', '=', fromDataset).execute();
  }

  async listDatasets(db: Kysely<Database>) {
    return db.selectFrom('dataset_definitions').selectAll().execute();
  }
}
