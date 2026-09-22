import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';
import { toJsonbParam } from '../../db/jsonb-param';

export type CustomFieldType =
  | 'short_text'
  | 'long_text'
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percentage'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiselect'
  | 'person'
  | 'org_unit'
  | 'location'
  | 'reference'
  | 'url'
  | 'email'
  | 'phone'
  | 'attachment';

export interface CustomFieldDefinitionInput {
  appId: string;
  entityType: string;
  key: string;
  label: string;
  helpText?: string;
  fieldType: CustomFieldType;
  isRequired?: boolean;
  defaultValue?: unknown;
  validation?: Record<string, unknown>;
  visibility?: 'visible' | 'hidden' | 'read_only';
  ordering?: number;
  fieldGroup?: string;
  isSearchable?: boolean;
  isFilterable?: boolean;
  isSortable?: boolean;
  isReportable?: boolean;
  isExportable?: boolean;
  classification?: string;
  selectOptions?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/;


/**
 * Custom field engine. Architecture §2, P1 item 5. JSONB is the canonical
 * store (`custom_field_values.values`); this service and
 * `CustomFieldQueryProvider` below are the ONLY code in Core (or any app)
 * permitted to reference the raw `values->>'key'` JSONB path - every other
 * caller (report engine in a future phase, the entity list/filter API,
 * app code) goes through `expression()`/`filterCondition()`/
 * `sortExpression()`/`groupExpression()` and never writes JSONB syntax
 * itself. This is exactly the seam Architecture §2.2 specifies.
 */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

@Injectable()
export class CustomFieldService {
  async defineField(db: Kysely<Database>, organisationId: string, input: CustomFieldDefinitionInput) {
    // Defense in depth (P1 security review item: "custom-field injection/
    // query issues"): `key` is embedded into a raw SQL fragment by
    // CustomFieldQueryProvider.expression() below. Single-quote doubling
    // there is already provably sufficient to prevent SQL injection (it's
    // the standard SQL string-literal escape), but constraining the
    // allowed character set here removes any need to reason about that in
    // the first place, and rejects garbage keys before they can ever reach
    // a query.
    if (!FIELD_KEY_RE.test(input.key)) {
      throw new BadRequestException('Custom field key must be lowercase alphanumeric/underscore, starting with a letter (max 64 chars).');
    }
    return db
      .insertInto('custom_field_definitions')
      .values({
        organisation_id: organisationId,
        app_id: input.appId,
        entity_type: input.entityType,
        key: input.key,
        label: input.label,
        help_text: input.helpText ?? null,
        field_type: input.fieldType,
        is_required: input.isRequired ?? false,
        default_value: toJsonbParam(input.defaultValue ?? null) as any,
        validation: (input.validation ?? null) as any,
        visibility: input.visibility ?? 'visible',
        ordering: input.ordering ?? 0,
        field_group: input.fieldGroup ?? null,
        is_searchable: input.isSearchable ?? false,
        is_filterable: input.isFilterable ?? false,
        is_sortable: input.isSortable ?? false,
        is_reportable: input.isReportable ?? false,
        is_exportable: input.isExportable ?? true,
        classification: input.classification ?? 'internal',
        select_options: toJsonbParam(input.selectOptions ?? null) as any,
      })
      .onConflict((oc) =>
        oc.columns(['organisation_id', 'app_id', 'entity_type', 'key']).doUpdateSet({
          label: input.label,
          help_text: input.helpText ?? null,
          field_type: input.fieldType,
          is_required: input.isRequired ?? false,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async getDefinitions(db: Kysely<Database>, organisationId: string, entityType: string) {
    return db
      .selectFrom('custom_field_definitions')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('entity_type', '=', entityType)
      .orderBy('ordering', 'asc')
      .execute();
  }

  async getValues(db: Kysely<Database>, organisationId: string, entityType: string, entityId: string): Promise<Record<string, unknown>> {
    const row = await db
      .selectFrom('custom_field_values')
      .select('values')
      .where('organisation_id', '=', organisationId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return (row?.values as Record<string, unknown>) ?? {};
  }

  /**
   * Validates each value against its field definition's type (and
   * `is_required`) BEFORE writing anything - a caller can never persist a
   * value that doesn't match its declared type. This is the type-safety
   * property Architecture §2.2 describes as "enforced by field-type-driven
   * expression generation at the one seam all callers use," applied on the
   * write side (the read/query side is `CustomFieldQueryProvider` below).
   */
  async setValues(
    db: Kysely<Database>,
    organisationId: string,
    entityType: string,
    entityId: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const definitions = await this.getDefinitions(db, organisationId, entityType);
    const byKey = new Map(definitions.map((d) => [d.key, d]));

    for (const [key, value] of Object.entries(values)) {
      const def = byKey.get(key);
      if (!def) {
        throw new BadRequestException(`Unknown custom field "${key}" for entity type "${entityType}".`);
      }
      this.validateValue(def.field_type as CustomFieldType, key, value, def.select_options as string[] | null);
    }

    for (const def of definitions) {
      if (def.is_required && (values[def.key] === undefined || values[def.key] === null)) {
        // Only enforce "required" when the caller is setting a full value
        // set that should include it - a partial update (patch semantics)
        // is the caller's responsibility to assemble correctly; here we
        // just refuse to WRITE an explicit null/undefined over a required field.
        if (Object.prototype.hasOwnProperty.call(values, def.key)) {
          throw new BadRequestException(`Custom field "${def.key}" is required.`);
        }
      }
    }

    const existing = await this.getValues(db, organisationId, entityType, entityId);
    const merged = { ...existing, ...values };

    const now = new Date();
    await db
      .insertInto('custom_field_values')
      .values({ organisation_id: organisationId, entity_type: entityType, entity_id: entityId, values: merged as any, updated_at: now as any })
      .onConflict((oc) => oc.columns(['organisation_id', 'entity_type', 'entity_id']).doUpdateSet({ values: merged as any, updated_at: now as any }))
      .execute();
  }

  private validateValue(fieldType: CustomFieldType, key: string, value: unknown, selectOptions: string[] | null): void {
    if (value === null || value === undefined) return;
    switch (fieldType) {
      case 'integer':
        if (!Number.isInteger(value)) throw new BadRequestException(`Custom field "${key}" must be an integer.`);
        break;
      case 'decimal':
      case 'currency':
      case 'percentage':
        if (typeof value !== 'number' || Number.isNaN(value)) throw new BadRequestException(`Custom field "${key}" must be a number.`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') throw new BadRequestException(`Custom field "${key}" must be a boolean.`);
        break;
      case 'date':
      case 'datetime':
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new BadRequestException(`Custom field "${key}" must be a valid date.`);
        break;
      case 'select':
        if (typeof value !== 'string' || (selectOptions && !selectOptions.includes(value))) {
          throw new BadRequestException(`Custom field "${key}" must be one of the configured options.`);
        }
        break;
      case 'multiselect':
        if (!Array.isArray(value) || (selectOptions && !value.every((v) => selectOptions.includes(v)))) {
          throw new BadRequestException(`Custom field "${key}" must be an array of configured options.`);
        }
        break;
      case 'email':
        if (typeof value !== 'string' || !EMAIL_RE.test(value)) throw new BadRequestException(`Custom field "${key}" must be a valid email.`);
        break;
      case 'url':
        if (typeof value !== 'string' || !URL_RE.test(value)) throw new BadRequestException(`Custom field "${key}" must be a valid URL.`);
        break;
      case 'short_text':
      case 'long_text':
      case 'phone':
      case 'person':
      case 'org_unit':
      case 'location':
      case 'reference':
      case 'attachment':
        if (typeof value !== 'string') throw new BadRequestException(`Custom field "${key}" must be a string.`);
        break;
    }
  }
}

export interface CustomFieldDefinitionRow {
  key: string;
  field_type: string;
}

/**
 * CustomFieldQueryProvider - Architecture §2.2, verbatim contract. Produces
 * type-aware Kysely expression fragments from a field's declared type, so
 * callers (a future report engine, filter/sort API) never write
 * `values->>'x'` themselves.
 */
export class CustomFieldQueryProvider {
  expression(def: CustomFieldDefinitionRow) {
    const path = sql.raw(`values->>'${def.key.replace(/'/g, "''")}'`);
    switch (def.field_type) {
      case 'integer':
        return sql<number>`((${path})::integer)`;
      case 'decimal':
      case 'currency':
      case 'percentage':
        return sql<number>`((${path})::numeric)`;
      case 'boolean':
        return sql<boolean>`((${path})::boolean)`;
      case 'date':
        return sql<Date>`((${path})::date)`;
      case 'datetime':
        return sql<Date>`((${path})::timestamptz)`;
      default:
        return sql<string>`${path}`;
    }
  }

  filterCondition(def: CustomFieldDefinitionRow, operator: '=' | '>' | '<' | '>=' | '<=' | '!=', value: unknown) {
    const expr = this.expression(def);
    switch (operator) {
      case '=':
        return sql`${expr} = ${value}`;
      case '!=':
        return sql`${expr} != ${value}`;
      case '>':
        return sql`${expr} > ${value}`;
      case '<':
        return sql`${expr} < ${value}`;
      case '>=':
        return sql`${expr} >= ${value}`;
      case '<=':
        return sql`${expr} <= ${value}`;
    }
  }

  sortExpression(def: CustomFieldDefinitionRow, direction: 'asc' | 'desc') {
    const expr = this.expression(def);
    return direction === 'asc' ? sql`${expr} ASC` : sql`${expr} DESC`;
  }

  groupExpression(def: CustomFieldDefinitionRow) {
    return this.expression(def);
  }
}
