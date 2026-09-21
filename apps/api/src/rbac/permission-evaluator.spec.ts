import { FlatRolePermissionEvaluator, PermissionCheckSubject } from './permission-evaluator';

describe('FlatRolePermissionEvaluator', () => {
  const evaluator = new FlatRolePermissionEvaluator();

  function subject(permissions: string[]): PermissionCheckSubject {
    return {
      userAccountId: 'user-1',
      organisationId: 'org-1',
      grantedPermissions: new Set(permissions),
    };
  }

  it('denies by default when the user holds no permissions', () => {
    expect(evaluator.check(subject([]), 'core.users.manage')).toBe(false);
  });

  it('denies a permission the user does not hold, even if they hold others', () => {
    expect(evaluator.check(subject(['core.people.view']), 'core.users.manage')).toBe(false);
  });

  it('grants a permission the user holds via their role', () => {
    expect(evaluator.check(subject(['core.users.manage']), 'core.users.manage')).toBe(true);
  });

  it('ignores context in v1 - same result with or without it', () => {
    const s = subject(['core.requisitions.approve']);
    const withoutContext = evaluator.check(s, 'core.requisitions.approve');
    const withContext = evaluator.check(s, 'core.requisitions.approve', {
      organisationalUnitId: 'unit-1',
      amount: 999999,
    });
    expect(withoutContext).toBe(true);
    expect(withContext).toBe(true);
  });

  it('returns false for empty/undefined permission or subject', () => {
    expect(evaluator.check(subject(['x']), '')).toBe(false);
    expect(evaluator.check(undefined as unknown as PermissionCheckSubject, 'x')).toBe(false);
  });
});
