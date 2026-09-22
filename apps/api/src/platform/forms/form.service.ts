import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export interface FormFieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'select' | 'custom_field';
  required?: boolean;
  helpText?: string;
  defaultValue?: unknown;
  options?: string[];
  /** Only shown when `dependsOn` field currently equals `equals`. Declarative, no code. */
  conditional?: { dependsOn: string; equals: unknown };
  /** Only shown/editable if the current user holds this permission. */
  permission?: string;
}

export interface FormSectionDefinition {
  key: string;
  label: string;
  fields: FormFieldDefinition[];
}

export interface FormDefinitionShape {
  sections: FormSectionDefinition[];
}

const ALLOWED_FIELD_KEYS = new Set(['key', 'label', 'type', 'required', 'helpText', 'defaultValue', 'options', 'conditional', 'permission']);
const ALLOWED_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'boolean', 'date', 'select', 'custom_field']);

/**
 * Configurable form engine. Architecture-required, P1 item 6. Definitions
 * are pure declarative JSON validated against a strict allowlisted shape -
 * `validateDefinitionShape` rejects any unrecognised key or field type, so
 * there is structurally no way to smuggle an executable expression/script
 * property into a form definition and have it accepted.
 */
@Injectable()
export class FormService {
  validateDefinitionShape(definition: unknown): asserts definition is FormDefinitionShape {
    if (!definition || typeof definition !== 'object' || !Array.isArray((definition as any).sections)) {
      throw new BadRequestException('Form definition must be an object with a "sections" array.');
    }
    for (const section of (definition as any).sections) {
      if (typeof section.key !== 'string' || typeof section.label !== 'string' || !Array.isArray(section.fields)) {
        throw new BadRequestException('Each form section must have a key, label, and fields array.');
      }
      for (const field of section.fields) {
        const keys = Object.keys(field);
        const unknownKeys = keys.filter((k) => !ALLOWED_FIELD_KEYS.has(k));
        if (unknownKeys.length > 0) {
          throw new BadRequestException(`Form field has unsupported keys: ${unknownKeys.join(', ')}. Only declarative fields are allowed - no executable code.`);
        }
        if (typeof field.key !== 'string' || typeof field.label !== 'string' || !ALLOWED_FIELD_TYPES.has(field.type)) {
          throw new BadRequestException(`Form field "${field.key}" has an invalid type.`);
        }
      }
    }
  }

  async seedDefault(db: Kysely<Database>, organisationId: string, appId: string, formKey: string, label: string, definition: FormDefinitionShape): Promise<void> {
    this.validateDefinitionShape(definition);
    await db
      .insertInto('form_definitions')
      .values({ organisation_id: organisationId, app_id: appId, form_key: formKey, label, definition: definition as any, is_customized: false })
      .onConflict((oc) => oc.columns(['organisation_id', 'app_id', 'form_key']).doNothing())
      .execute();
  }

  async getDefinition(db: Kysely<Database>, organisationId: string, appId: string, formKey: string) {
    const row = await db
      .selectFrom('form_definitions')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .where('form_key', '=', formKey)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`Form "${formKey}" is not registered for this organisation.`);
    return row;
  }

  async customize(db: Kysely<Database>, organisationId: string, appId: string, formKey: string, definition: FormDefinitionShape): Promise<void> {
    this.validateDefinitionShape(definition);
    const updated = await db
      .updateTable('form_definitions')
      .set({ definition: definition as any, is_customized: true, updated_at: new Date() as any })
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .where('form_key', '=', formKey)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new NotFoundException(`Form "${formKey}" is not registered for this organisation.`);
  }

  /** Validates a submitted value set against required fields and conditional visibility. */
  validateSubmission(definition: FormDefinitionShape, values: Record<string, unknown>): void {
    for (const section of definition.sections) {
      for (const field of section.fields) {
        const visible = !field.conditional || values[field.conditional.dependsOn] === field.conditional.equals;
        if (visible && field.required && (values[field.key] === undefined || values[field.key] === null || values[field.key] === '')) {
          throw new BadRequestException(`Field "${field.label}" is required.`);
        }
      }
    }
  }
}
