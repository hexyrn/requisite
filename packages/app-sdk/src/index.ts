/**
 * Hexyrn App SDK - P0 scope.
 *
 * The App Registry / loader itself (installing, enabling, licensing,
 * capability resolution) is NOT a P0 item and is not implemented here.
 * This package exists only to pin down the manifest *contract* shape now,
 * per Architecture §3/§4, so that Core's module boundaries (e.g. "app code
 * never reaches into another app's tables directly") are already respected
 * by anything written in P0, even though nothing consumes this contract yet.
 *
 * Do not add loader/registry logic here in P0 - that is explicitly out of
 * scope per the P0 task brief.
 */

export interface CapabilityDeclaration {
  /** '<domain>.<noun>.v<n>', e.g. 'purchasing.cost-source.v1'. Architecture §4. */
  capability: string;
  provides?: string;
  requires?: string[];
}

export interface HexyrnAppManifest {
  /** Reverse-DNS, e.g. 'com.hexyrn.requisite'. */
  appId: string;
  name: string;
  /** Independent semver axis - see Architecture §3/§4. */
  version: string;
  requiresCoreVersion: string;
  capabilities?: CapabilityDeclaration[];
}
