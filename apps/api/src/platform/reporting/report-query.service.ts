import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';
import { DatasetFieldDefinition, Aggregation } from './dataset.service';
import {
  FlatRolePermissionEvaluator,
  PermissionCheckSubject,
} from '../../rbac/permission-evaluator';

export interface QueryFilter {
  field: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains';
  value: unknown;
}

export interface QuerySort {
  field: string;
  direction: 'asc' | 'desc';
}

export interface QueryAggregation {
  field: string;
  fn: Aggregation;
  alias?: string;
}

export interface JoinSpec {
  /** Which registered relationship to traverse, by its `label`. */
  relationshipLabel: string;
  /** Fields from the joined (target) dataset to select - only meaningful for a non-aggregated join. */
  fields?: string[];
  /** Aggregations to compute on the target dataset, pre-aggregated BEFORE joining if the relationship is one-to-many (fan-out safety). */
  aggregations?: QueryAggregation[];
}

export interface ReportQueryDefinition {
  datasetKey: string;
  fields?: string[];
  filters?: QueryFilter[];
  sort?: QuerySort[];
  groupBy?: string[];
  aggregations?: QueryAggregation[];
  join?: JoinSpec;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 1000; // P2 item 25 - query resource controls
const MAX_JOIN_DEPTH = 1; // one relationship hop in P2

/**
 * The central, permission-safe report query engine. Architecture §5/§11,
 * P2 items 3/5 - SECURITY-CRITICAL. Every query issued through this class:
 *   1. Requires the dataset's `required_permission` (deny-by-default,
 *      reusing the exact same FlatRolePermissionEvaluator every other
 *      permission check in Core uses - no second authorisation universe).
 *   2. Only ever selects/filters/sorts/groups on fields the dataset
 *      DECLARED (`dataset_definitions.fields`) - a caller-supplied field
 *      key that isn't in that allowlist is rejected outright, so there is
 *      no way to reach an arbitrary column via this engine.
 *   3. Only ever aggregates using each field's own declared
 *      `allowedAggregations` - never an arbitrary SQL function.
 *   4. Runs inside the caller's `withOrgContext` transaction, so RLS
 *      confines every result to the caller's organisation for free -
 *      this class never opens its own connection.
 *   5. Only traverses a relationship if it is registered in
 *      `dataset_relationships` AND the caller holds the required
 *      permission on the target dataset too (checked independently) -
 *      never an arbitrary user-supplied join condition.
 *   6. Pre-aggregates the "many" side of a one-to-many relationship in a
 *      derived subquery BEFORE joining, so a fan-out join can never
 *      silently inflate a SUM/COUNT/AVG on the "one" side.
 */
@Injectable()
export class ReportQueryService {
  private readonly evaluator = new FlatRolePermissionEvaluator();

  async execute(
    db: Kysely<Database>,
    subject: PermissionCheckSubject,
    query: ReportQueryDefinition,
  ): Promise<Record<string, unknown>[]> {
    const dataset = await this.loadDatasetOrThrow(db, query.datasetKey);
    this.requirePermission(subject, dataset.required_permission);

    const fields = dataset.fields as unknown as DatasetFieldDefinition[];
    const fieldByKey = new Map(fields.map((f) => [f.key, f]));

    const limit = Math.min(query.limit ?? 100, MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    if (query.join) {
      return this.executeJoinedQuery(db, subject, dataset, fieldByKey, query, limit, offset);
    }

    let builder = (db as any).selectFrom(dataset.source_ref);

    const selectedFields =
      query.aggregations && query.aggregations.length > 0
        ? (query.groupBy ?? [])
        : (query.fields ?? fields.map((f) => f.key));
    for (const key of selectedFields) {
      const field = this.requireDeclaredField(fieldByKey, key, subject);
      builder = builder.select(sql.ref(field.key).as(field.key));
    }

    for (const agg of query.aggregations ?? []) {
      const field = this.requireDeclaredField(fieldByKey, agg.field, subject);
      this.requireAllowedAggregation(field, agg.fn);
      builder = builder.select(
        this.aggregateExpr(agg.fn, field.key).as(agg.alias ?? `${agg.fn}_${field.key}`),
      );
    }

    for (const filter of query.filters ?? []) {
      const field = this.requireDeclaredField(fieldByKey, filter.field, subject);
      if (!field.filterable)
        throw new BadRequestException(`Field "${filter.field}" is not filterable.`);
      builder = this.applyFilter(builder, field, filter);
    }

    if (query.groupBy) {
      for (const key of query.groupBy) {
        const field = this.requireDeclaredField(fieldByKey, key, subject);
        if (!field.groupable) throw new BadRequestException(`Field "${key}" is not groupable.`);
        builder = builder.groupBy(field.key);
      }
    }

    for (const s of query.sort ?? []) {
      const field = this.requireDeclaredField(fieldByKey, s.field, subject);
      if (!field.sortable) throw new BadRequestException(`Field "${s.field}" is not sortable.`);
      builder = builder.orderBy(field.key, s.direction);
    }

    builder = builder.limit(limit).offset(offset);

    return builder.execute();
  }

  /**
   * Handles exactly one relationship hop. For a one-to-many relationship
   * with aggregations requested on the "many" side, the many side is
   * pre-aggregated (GROUP BY the join field) in a derived subquery BEFORE
   * being joined to the "one" side - this is what prevents fan-out
   * inflation. Verified by `report-query.integration.spec.ts`'s explicit
   * fan-out test.
   */
  private async executeJoinedQuery(
    db: Kysely<Database>,
    subject: PermissionCheckSubject,
    fromDataset: { dataset_key: string; source_ref: string; fields: unknown },
    fromFieldByKey: Map<string, DatasetFieldDefinition>,
    query: ReportQueryDefinition,
    limit: number,
    offset: number,
  ): Promise<Record<string, unknown>[]> {
    const join = query.join!;
    const relationship = await db
      .selectFrom('dataset_relationships')
      .selectAll()
      .where('from_dataset', '=', fromDataset.dataset_key)
      .where('label', '=', join.relationshipLabel)
      .executeTakeFirst();
    if (!relationship) {
      // Architecture §5: an unregistered / no-longer-available relationship
      // simply isn't traversable - fails safe, not an error that leaks structure.
      throw new NotFoundException(`Relationship "${join.relationshipLabel}" is not available.`);
    }

    const toDataset = await this.loadDatasetOrThrow(db, relationship.to_dataset);
    // Independent permission check on BOTH datasets - Architecture §5's
    // "join authorisation" rule, the exact mechanism that prevents the
    // "Manchester totals via a joined report" leak.
    this.requirePermission(subject, toDataset.required_permission);

    const toFields = toDataset.fields as unknown as DatasetFieldDefinition[];
    const toFieldByKey = new Map(toFields.map((f) => [f.key, f]));

    if (
      relationship.cardinality === 'one-to-many' &&
      join.aggregations &&
      join.aggregations.length > 0
    ) {
      // FAN-OUT SAFE PATH: pre-aggregate the many side, grouped by the join
      // field, in a derived subquery - then join that (already-aggregated,
      // one-row-per-key) result to the "one" side. The "one" side's own
      // rows are never duplicated because the subquery has already
      // collapsed the many side to one row per join key before any join happens.
      let subquery = (db as any)
        .selectFrom(toDataset.source_ref)
        .select(sql.ref(relationship.to_field).as('__join_key'));
      for (const agg of join.aggregations) {
        const field = this.requireDeclaredField(toFieldByKey, agg.field, subject);
        this.requireAllowedAggregation(field, agg.fn);
        subquery = subquery.select(
          this.aggregateExpr(agg.fn, field.key).as(agg.alias ?? `${agg.fn}_${field.key}`),
        );
      }
      subquery = subquery.groupBy(relationship.to_field);

      let builder = (db as any)
        .selectFrom(fromDataset.source_ref)
        .leftJoin(
          subquery.as('joined'),
          `joined.__join_key`,
          `${fromDataset.source_ref}.${relationship.from_field}`,
        );

      const selectFields = query.fields ?? [relationship.from_field];
      for (const key of selectFields) {
        const field = this.requireDeclaredField(fromFieldByKey, key, subject);
        builder = builder.select(sql.ref(`${fromDataset.source_ref}.${field.key}`).as(field.key));
      }
      for (const agg of join.aggregations) {
        const alias = agg.alias ?? `${agg.fn}_${agg.field}`;
        builder = builder.select(sql.ref(`joined.${alias}`).as(alias));
      }

      for (const filter of query.filters ?? []) {
        const field = this.requireDeclaredField(fromFieldByKey, filter.field, subject);
        if (!field.filterable)
          throw new BadRequestException(`Field "${filter.field}" is not filterable.`);
        builder = this.applyFilter(builder, field, filter, fromDataset.source_ref);
      }

      builder = builder.limit(limit).offset(offset);
      return builder.execute();
    }

    // Simple (non-aggregating, or not one-to-many) join - safe to join directly.
    let builder = (db as any)
      .selectFrom(fromDataset.source_ref)
      .innerJoin(
        toDataset.source_ref,
        `${toDataset.source_ref}.${relationship.to_field}`,
        `${fromDataset.source_ref}.${relationship.from_field}`,
      );

    const fromSelect = query.fields ?? [relationship.from_field];
    for (const key of fromSelect) {
      const field = this.requireDeclaredField(fromFieldByKey, key, subject);
      builder = builder.select(sql.ref(`${fromDataset.source_ref}.${field.key}`).as(field.key));
    }
    for (const key of join.fields ?? []) {
      const field = this.requireDeclaredField(toFieldByKey, key, subject);
      builder = builder.select(
        sql.ref(`${toDataset.source_ref}.${field.key}`).as(`joined_${field.key}`),
      );
    }

    builder = builder.limit(limit).offset(offset);
    return builder.execute();
  }

  private async loadDatasetOrThrow(db: Kysely<Database>, datasetKey: string) {
    const dataset = await db
      .selectFrom('dataset_definitions')
      .selectAll()
      .where('dataset_key', '=', datasetKey)
      .executeTakeFirst();
    if (!dataset) throw new NotFoundException(`Dataset "${datasetKey}" is not registered.`);
    return dataset;
  }

  private requirePermission(subject: PermissionCheckSubject, permission: string): void {
    if (!this.evaluator.check(subject, permission)) {
      throw new ForbiddenException(`Missing required permission "${permission}" for this dataset.`);
    }
  }

  private requireDeclaredField(
    fieldByKey: Map<string, DatasetFieldDefinition>,
    key: string,
    subject: PermissionCheckSubject,
  ): DatasetFieldDefinition {
    const field = fieldByKey.get(key);
    if (!field) throw new BadRequestException(`Field "${key}" is not part of this dataset.`);
    if (field.requiredPermission && !this.evaluator.check(subject, field.requiredPermission)) {
      throw new ForbiddenException(`Missing required permission to view field "${key}".`);
    }
    return field;
  }

  private requireAllowedAggregation(field: DatasetFieldDefinition, fn: Aggregation): void {
    if (!field.isMeasure || !field.allowedAggregations?.includes(fn)) {
      throw new BadRequestException(`Aggregation "${fn}" is not allowed on field "${field.key}".`);
    }
  }

  private aggregateExpr(fn: Aggregation, column: string) {
    switch (fn) {
      case 'count':
        return sql`count(${sql.ref(column)})`;
      case 'sum':
        return sql`sum(${sql.ref(column)})`;
      case 'avg':
        return sql`avg(${sql.ref(column)})`;
      case 'min':
        return sql`min(${sql.ref(column)})`;
      case 'max':
        return sql`max(${sql.ref(column)})`;
    }
  }

  private applyFilter(
    builder: any,
    field: DatasetFieldDefinition,
    filter: QueryFilter,
    tablePrefix?: string,
  ) {
    const ref = tablePrefix ? `${tablePrefix}.${field.key}` : field.key;
    switch (filter.operator) {
      case '=':
        return builder.where(ref, '=', filter.value);
      case '!=':
        return builder.where(ref, '!=', filter.value);
      case '>':
        return builder.where(ref, '>', filter.value);
      case '<':
        return builder.where(ref, '<', filter.value);
      case '>=':
        return builder.where(ref, '>=', filter.value);
      case '<=':
        return builder.where(ref, '<=', filter.value);
      case 'contains':
        return builder.where(ref, 'ilike', `%${filter.value}%`);
    }
  }
}

export { MAX_LIMIT, MAX_JOIN_DEPTH };
