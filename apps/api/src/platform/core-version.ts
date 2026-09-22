export const CORE_VERSION = '0.1.0-p1';

/**
 * Compatibility check. Architecture §3/§9: "derived at boot by comparing
 * the installed app version's requiresCoreVersion range against the
 * running Core version." P1 implements a deliberately small comparator
 * (not a full semver range library) supporting exactly the two forms
 * manifests are expected to use:
 *   '^X.Y.Z'  - compatible if Core's version is >= X.Y.Z and, per semver's
 *               own rule for 0.x versions, shares the same major.minor
 *               (since Core is pre-1.0, a "breaking change" boundary is
 *               minor, not major - this matches how npm/semver itself
 *               treats ^0.x.y ranges).
 *   '>=X.Y.Z' - compatible if Core's version is >= X.Y.Z, no upper bound.
 * Anything else falls back to exact-string match. This is a documented,
 * intentional simplification, not a hidden gap - a real semver library can
 * replace this function's internals without changing its signature if a
 * future need outgrows it.
 */
export function isCoreVersionCompatible(requiresCoreVersion: string, coreVersion: string = CORE_VERSION): boolean {
  const parse = (v: string) => {
    const clean = v.replace(/^[\^>=]+/, '').split('-')[0];
    const [major, minor, patch] = clean.split('.').map((n) => parseInt(n, 10) || 0);
    return { major, minor, patch };
  };

  const actual = parse(coreVersion);

  if (requiresCoreVersion.startsWith('^')) {
    const req = parse(requiresCoreVersion);
    if (req.major === 0) {
      return actual.major === 0 && actual.minor === req.minor && actual.patch >= req.patch;
    }
    return actual.major === req.major && (actual.minor > req.minor || (actual.minor === req.minor && actual.patch >= req.patch));
  }

  if (requiresCoreVersion.startsWith('>=')) {
    const req = parse(requiresCoreVersion);
    if (actual.major !== req.major) return actual.major > req.major;
    if (actual.minor !== req.minor) return actual.minor > req.minor;
    return actual.patch >= req.patch;
  }

  return requiresCoreVersion === coreVersion;
}
