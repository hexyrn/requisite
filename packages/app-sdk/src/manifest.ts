/**
 * Hexyrn App Manifest - the stable contract every application declares
 * itself through. Architecture §3/§4/§8(Rev1). This is data, not code: a
 * manifest is a plain object an app's entry module exports; Core's App
 * Registry reads it, never the other way around (apps never import Core
 * internals to register themselves).
 */

export interface CapabilityDeclaration {
  /** '<domain>.<noun>.v<n>', e.g. 'purchasing.cost-source.v1'. Architecture §4. */
  capability: string;
  /** Present if this app PROVIDES the capability. */
  provides?: { serviceRef: string };
  /** Capabilities this app wants to consume, if present (informational - resolved at runtime via CapabilityResolver). */
  requires?: string[];
}

export interface NavigationEntry {
  key: string;
  label: string;
  /** Client-side route path this nav entry links to. */
  path: string;
  /** Permission required to see this entry - checked the same way as any other permission. */
  permission?: string;
  icon?: string;
  order?: number;
}

export interface EventPublication {
  eventType: string;
  version: number;
  description: string;
}

export interface EventConsumption {
  eventType: string;
  handlerRef: string;
  description?: string;
}

export interface PermissionDeclaration {
  key: string;
  label: string;
  description?: string;
}

export interface ConfigSchemaField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: string[];
  defaultValue?: unknown;
}

/**
 * Report dataset / dashboard widget registration shapes. Architecture §5
 * defers the full reporting/dashboard ENGINE to P2, but the registration
 * *contract* is defined now so an app's manifest shape doesn't need to
 * change when that engine lands - this is the same "seam defined now,
 * consumed later" pattern the architecture uses for scoped authorisation
 * (§1) and capabilities (§4).
 */
export interface DatasetRegistration {
  datasetKey: string; // e.g. 'requisite.purchase_order_line'
  label: string;
  /** Table/view this dataset reads from - resolved by the (future) report engine, never queried directly by other apps. */
  sourceRef: string;
}

export interface DashboardWidgetRegistration {
  widgetKey: string;
  label: string;
  /** Which dataset (by datasetKey) this widget visualises. */
  datasetKey: string;
}

/**
 * How an app presents itself in the Core suite launcher and app switcher.
 * Every app shares Core's design language; `color` is the ONLY per-app
 * styling knob (it becomes the app's accent colour), so apps in the suite
 * look related but are instantly distinguishable.
 */
export interface AppBrand {
  /** Accent colour as #rrggbb. Validated by the launcher; anything else falls back to the Core accent. */
  color: string;
  /** Key of a built-in launcher icon (e.g. 'cart', 'wrench'); unknown keys fall back to the app's initial. */
  icon?: string;
}

/** A ready-made role an organisation gets when the app is first activated, so access can be given without designing roles from scratch. */
export interface AppRoleTemplate {
  name: string;
  /** Must all be permission keys declared by the same manifest. */
  permissions: string[];
}

export interface HexyrnAppManifest {
  /** Reverse-DNS, e.g. 'com.hexyrn.requisite'. Globally stable identifier. */
  appId: string;
  displayName: string;
  /** Independent semver axis - see Architecture §3/§4. */
  version: string;
  majorVersion: number;
  requiresCoreVersion: string;
  description?: string;
  brand?: AppBrand;
  /** Optional starter roles created (never overwritten) on first activation; the Owner role still gets every permission. */
  roleTemplates?: AppRoleTemplate[];
  /** Internal/test apps (e.g. the reference app) are never shown in the suite launcher. */
  internal?: boolean;

  permissions?: PermissionDeclaration[];
  capabilities?: CapabilityDeclaration[];
  navigation?: NavigationEntry[];
  eventsPublished?: EventPublication[];
  eventsConsumed?: EventConsumption[];
  configSchema?: ConfigSchemaField[];
  datasets?: DatasetRegistration[];
  dashboardWidgets?: DashboardWidgetRegistration[];

  /**
   * Default form/workflow/numbering-sequence declarations seeded into an
   * organisation the first time this app is enabled there. Optional -
   * an app with no UI-configurable surface (e.g. a pure capability
   * provider) declares none of these.
   */
  defaultForms?: { formKey: string; label: string; definition: Record<string, unknown> }[];
  defaultWorkflows?: { workflowKey: string; definition: Record<string, unknown> }[];
  numberingSequences?: {
    sequenceKey: string;
    prefix: string;
    padLength: number;
    yearReset?: boolean;
  }[];
}
