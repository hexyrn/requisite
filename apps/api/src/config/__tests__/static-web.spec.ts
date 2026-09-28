import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import { registerStaticWeb, resolveStaticFile } from '../static-web';

function makeWebDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'hx-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Hexyrn</title>');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'hx-secret.txt'), 'top secret');
  return root;
}

describe('serving the web app from the API (installs with no Caddy)', () => {
  const root = makeWebDir();

  it('resolves files, SPA routes and assets with the right type and caching', () => {
    expect(resolveStaticFile(root, '/')?.contentType).toMatch(/text\/html/);
    expect(resolveStaticFile(root, '/')?.cacheControl).toBe('no-cache');
    expect(resolveStaticFile(root, '/favicon.svg')?.contentType).toBe('image/svg+xml');
    const asset = resolveStaticFile(root, '/assets/index-abc123.js?v=1');
    expect(asset?.contentType).toMatch(/javascript/);
    expect(asset?.cacheControl).toMatch(/immutable/);
    // client-side routes fall back to index.html
    expect(resolveStaticFile(root, '/requisite/requisitions/123')?.file).toBe(
      join(root, 'index.html'),
    );
  });

  it('never handles the API, and a missing asset is a real 404 rather than index.html', () => {
    expect(resolveStaticFile(root, '/api/v1/health')).toBeUndefined();
    expect(resolveStaticFile(root, '/api')).toBeUndefined();
    expect(resolveStaticFile(root, '/assets/missing.js')).toBeUndefined();
  });

  it.each([
    '/../hx-secret.txt',
    '/..%2Fhx-secret.txt',
    '/%2e%2e/hx-secret.txt',
    '/assets/../../hx-secret.txt',
    '/..\\hx-secret.txt',
    '/%00',
    '/%E0%A4%A',
  ])('cannot be tricked into reading outside the web folder: %s', (evil) => {
    const hit = resolveStaticFile(root, evil);
    if (hit) expect(hit.file.startsWith(root)).toBe(true); // at worst it is index.html, never the secret
    expect(hit?.file ?? '').not.toContain('hx-secret');
  });

  it('works end to end on a real HTTP server alongside API routes', async () => {
    const app = Fastify();
    app.get('/api/v1/health', async () => ({ status: 'ok' }));
    registerStaticWeb(app, root);
    await app.ready();

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<title>Hexyrn</title>');

    const spa = await app.inject({ method: 'GET', url: '/admin/licence' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>Hexyrn</title>');

    const js = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(js.headers['cache-control']).toMatch(/immutable/);

    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).json()).toEqual({
      status: 'ok',
    });
    expect((await app.inject({ method: 'GET', url: '/assets/nope.js' })).statusCode).toBe(404);
    // Only GET/HEAD are ever served statically
    expect((await app.inject({ method: 'POST', url: '/' })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses to start pointing at a folder that has no built web app', () => {
    expect(() => registerStaticWeb(Fastify(), mkdtempSync(join(tmpdir(), 'hx-empty-')))).toThrow(
      /index\.html/,
    );
  });
});
