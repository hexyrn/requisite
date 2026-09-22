/**
 * `pg`'s parameter serialization only automatically JSON-encodes a bare
 * JS *object* correctly for a `jsonb` column - found empirically (twice,
 * in two different subsystems) while writing P1 tests:
 *
 *   - A JS array is special-cased to a Postgres ARRAY literal
 *     (`{a,b,c}`), which is invalid input for a jsonb column
 *     (custom_field_definitions.select_options).
 *   - A JS string/number/boolean is sent via its own `.toString()`,
 *     which for a bare string is not valid JSON text on its own (`pass`
 *     is not valid JSON; `"pass"` is) (checklist_responses.value).
 *
 * Use this helper for ANY value bound into a `jsonb`/`json` column that
 * might not be a plain object - it is a safe no-op for objects (already
 * correctly auto-serialized) and null.
 */
export function toJsonbParam(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && !Array.isArray(value)) return value; // plain object - pg already serializes this correctly
  return JSON.stringify(value); // array, string, number, boolean
}
