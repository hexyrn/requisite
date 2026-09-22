/**
 * Hexyrn App SDK - P1: first usable version.
 *
 * Everything an application needs to register with and use Core is
 * exported from here. Applications import from `@hexyrn/app-sdk`, never
 * from `apps/api/src/**` - that boundary is the point of this package.
 *
 * - `manifest.ts`: the declarative contract an app's entry module exports
 *   (`HexyrnAppManifest`) so Core's App Registry can discover permissions,
 *   navigation, capabilities, events, default forms/workflows/numbering.
 * - `context.ts`: `HexyrnAppContext`, the runtime object Core hands to an
 *   app's own service/handler code - the only way that code touches
 *   permissions, events, custom fields, numbering, workflow, approvals,
 *   notifications, files, scheduling, and terminology.
 */
export * from './manifest';
export * from './context';
