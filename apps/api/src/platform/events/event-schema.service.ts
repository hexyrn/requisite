import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export type SchemaPropertyType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface EventPayloadSchema {
  required?: string[];
  properties: Record<string, SchemaPropertyType>;
}

/**
 * Event Payload Schema Validation, P2 item 15 - resolves the P1-deferred
 * technical debt (see docs/decisions and P1-DEVIATIONS.md: "the event
 * outbox accepts any payload shape uncontrolled"). Deliberately minimal and
 * NON-executable: a schema is only { required: string[], properties: {key:
 * type} } - a flat allowlist of expected top-level keys and their JS
 * typeof, never arbitrary validation code (no injection surface, unlike
 * e.g. a JSON-Schema-with-$ref engine or eval'd validator functions).
 */
@Injectable()
export class EventSchemaService {
  async registerSchema(
    db: Kysely<Database>,
    eventType: string,
    version: number,
    appId: string,
    schema: EventPayloadSchema,
  ): Promise<void> {
    await db
      .insertInto('event_schemas')
      .values({ event_type: eventType, version, app_id: appId, schema: schema as any })
      .onConflict((oc) =>
        oc.columns(['event_type', 'version']).doUpdateSet({ schema: schema as any }),
      )
      .execute();
  }

  /**
   * Validates a payload against the LATEST registered schema for
   * eventType/version, if one exists. If no schema is registered for that
   * event type at all, validation is a no-op (P1 apps that haven't
   * registered a schema yet keep working - this is additive hardening, not
   * a breaking requirement) - but if a schema for that (eventType, version)
   * pair IS registered, mismatches are rejected outright (fail closed once
   * opted in).
   */
  async validate(
    db: Kysely<Database>,
    eventType: string,
    version: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const schemaRow = await db
      .selectFrom('event_schemas')
      .selectAll()
      .where('event_type', '=', eventType)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!schemaRow) return; // no schema registered for this type/version - not an error, see class doc.

    const schema = schemaRow.schema as unknown as EventPayloadSchema;
    const errors: string[] = [];

    for (const key of schema.required ?? []) {
      if (!(key in payload)) errors.push(`missing required field "${key}"`);
    }
    for (const [key, expectedType] of Object.entries(schema.properties ?? {})) {
      if (!(key in payload)) continue;
      const actual = payload[key];
      const actualType = Array.isArray(actual) ? 'array' : typeof actual;
      if (actualType !== expectedType) {
        errors.push(`field "${key}" expected type "${expectedType}", got "${actualType}"`);
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(
        `Event payload for "${eventType}" v${version} failed schema validation: ${errors.join('; ')}`,
      );
    }
  }
}
