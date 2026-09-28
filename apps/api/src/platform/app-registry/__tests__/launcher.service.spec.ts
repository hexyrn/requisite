import { LauncherService } from '../launcher.service';
import type { ApplicationRegistryService } from '../application-registry.service';

type State = {
  installed: boolean;
  enabled: boolean;
  licensed: boolean;
  compatible: boolean;
  active: boolean;
};
const ACTIVE: State = {
  installed: true,
  enabled: true,
  licensed: true,
  compatible: true,
  active: true,
};
const UNLICENSED: State = { ...ACTIVE, licensed: false, active: false };

function row(appId: string, manifest: Record<string, unknown>) {
  return {
    app_id: appId,
    display_name: (manifest.displayName as string) ?? appId,
    description: null,
    version: '1.0.0',
    manifest,
  };
}

function makeService(rows: ReturnType<typeof row>[], states: Record<string, State>) {
  const registry = {
    listInstalledApps: async () => rows,
    getApplicationState: async (_db: unknown, _org: string, appId: string) => states[appId],
  } as unknown as ApplicationRegistryService;
  return new LauncherService(registry);
}

const NAV = [
  { key: 'b', label: 'Second', path: '/buy/second', permission: 'buy.view', order: 2 },
  { key: 'a', label: 'First', path: '/buy/first', permission: 'buy.view', order: 1 },
];
const BUY = row('com.x.buy', {
  displayName: 'Buy',
  brand: { color: '#0F766E', icon: 'cart' },
  navigation: NAV,
});

describe('LauncherService - what the suite launcher discloses', () => {
  it('shows an active app to a user holding a nav permission, launching at its first (lowest order) permitted page', async () => {
    const svc = makeService([BUY], { 'com.x.buy': ACTIVE });
    const res = await svc.build({} as any, 'org', new Set(['buy.view']));
    expect(res.apps).toHaveLength(1);
    expect(res.apps[0]).toMatchObject({
      appId: 'com.x.buy',
      launchPath: '/buy/first',
      basePath: '/buy',
      status: 'active',
      brand: { color: '#0f766e', icon: 'cart' },
    });
    expect(res.canAdminister).toBe(false);
  });

  it('hides an app entirely from a user with no permission for any of its pages (indistinguishable from not installed)', async () => {
    const svc = makeService([BUY], { 'com.x.buy': ACTIVE });
    expect((await svc.build({} as any, 'org', new Set())).apps).toEqual([]);
  });

  it('hides an unlicensed app from ordinary users, but shows admins its status and sends them to the licence screen', async () => {
    const svc = makeService([BUY], { 'com.x.buy': UNLICENSED });
    expect((await svc.build({} as any, 'org', new Set(['buy.view']))).apps).toEqual([]);

    const admin = await svc.build({} as any, 'org', new Set(['core.organisation.manage']));
    expect(admin.canAdminister).toBe(true);
    expect(admin.apps[0]).toMatchObject({ status: 'not_licensed', launchPath: '/admin/licence' });
  });

  it('distinguishes disabled and incompatible for admins', async () => {
    const admin = new Set(['core.organisation.manage']);
    const disabled = makeService([BUY], {
      'com.x.buy': { ...ACTIVE, enabled: false, active: false },
    });
    expect((await disabled.build({} as any, 'org', admin)).apps[0].status).toBe('disabled');
    const incompatible = makeService([BUY], {
      'com.x.buy': { ...ACTIVE, compatible: false, active: false },
    });
    expect((await incompatible.build({} as any, 'org', admin)).apps[0].status).toBe('incompatible');
  });

  it('never lists internal apps, even to admins', async () => {
    const svc = makeService(
      [row('com.x.ref', { displayName: 'Ref', internal: true, navigation: NAV })],
      {
        'com.x.ref': ACTIVE,
      },
    );
    const res = await svc.build(
      {} as any,
      'org',
      new Set(['buy.view', 'core.organisation.manage']),
    );
    expect(res.apps).toEqual([]);
  });

  it('ignores a malformed brand colour rather than passing it to the page (it becomes a CSS value)', async () => {
    const bad = row('com.x.bad', {
      displayName: 'Bad',
      brand: { color: 'red; background:url(//evil)' },
      navigation: NAV,
    });
    const svc = makeService([bad], { 'com.x.bad': ACTIVE });
    const res = await svc.build({} as any, 'org', new Set(['buy.view']));
    expect(res.apps[0].brand).toBeNull();
  });

  it('lists apps alphabetically', async () => {
    const z = row('com.x.z', { displayName: 'Zed', navigation: NAV });
    const a = row('com.x.a', { displayName: 'Alpha', navigation: NAV });
    const svc = makeService([z, a], { 'com.x.z': ACTIVE, 'com.x.a': ACTIVE });
    const res = await svc.build({} as any, 'org', new Set(['buy.view']));
    expect(res.apps.map((x) => x.displayName)).toEqual(['Alpha', 'Zed']);
  });
});
