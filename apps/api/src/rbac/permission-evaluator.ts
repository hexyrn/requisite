/**
 * The one seam every permission check goes through. Architecture §1/§18.
 *
 * v1 ignores `context` entirely and does a flat "does this user hold this
 * permission" check - deny-by-default. The `context` parameter exists now so
 * that callers already pass whatever they have at hand (e.g.
 * { organisationalUnitId, amount }); when scoped authorisation is designed
 * later, this is the only place that changes - no caller needs to change its
 * call signature.
 */
export interface PermissionContext {
  [key: string]: unknown;
}

export interface PermissionCheckSubject {
  userAccountId: string;
  organisationId: string;
  /** Flat permission strings already resolved for this user (via their roles). */
  grantedPermissions: ReadonlySet<string>;
}

export interface PermissionEvaluator {
  check(subject: PermissionCheckSubject, permission: string, context?: PermissionContext): boolean;
}

/**
 * v1 implementation: deny-by-default flat role/permission check.
 * `context` is accepted (per the seam contract) but deliberately unused in v1.
 */
export class FlatRolePermissionEvaluator implements PermissionEvaluator {
  check(
    subject: PermissionCheckSubject,
    permission: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    context?: PermissionContext,
  ): boolean {
    if (!subject || !permission) return false;
    return subject.grantedPermissions.has(permission);
  }
}
