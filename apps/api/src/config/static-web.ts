import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, normalize, resolve, sep } from 'path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticResolution {
  file: string;
  contentType: string;
  /** Vite fingerprints everything under /assets, so it may be cached forever; index.html must always be revalidated. */
  cacheControl: string;
}

/**
 * Decides which file (if any) answers a browser request for `urlPath`.
 * Pure and side-effect free apart from stat calls, so it is unit-tested
 * directly - including path traversal attempts.
 *
 * - /api/* is never handled here (returns undefined -> the API routes it).
 * - An existing file inside `root` is served as itself.
 * - Any other GET for a page-like path falls back to index.html so the
 *   React router can handle client-side routes (/requisite/requisitions...).
 * - A missing file with an extension (a real asset request) is a genuine 404.
 */
export function resolveStaticFile(root: string, urlPath: string): StaticResolution | undefined {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return undefined; // malformed %-encoding
  }
  if (path === '/api' || path.startsWith('/api/')) return undefined;
  if (path.includes('\0')) return undefined;

  const rootAbs = resolve(root);
  const candidate = resolve(join(rootAbs, normalize('.' + sep + path)));
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return undefined; // traversal

  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (path !== '/' && isFile(candidate)) return describe(candidate);

  if (extname(path)) return undefined; // e.g. /assets/missing.js -> real 404, not index.html
  const index = join(rootAbs, 'index.html');
  return isFile(index) ? describe(index) : undefined;
}

function describe(file: string): StaticResolution {
  const ext = extname(file).toLowerCase();
  const immutable = file.includes(`${sep}assets${sep}`);
  return {
    file,
    contentType: TYPES[ext] ?? 'application/octet-stream',
    cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
}

/**
 * Serves the built web app from the API process itself, for installs with
 * no separate web server (the Windows installer has no Caddy). Docker keeps
 * using Caddy and never sets HEXYRN_WEB_DIR.
 */
export function registerStaticWeb(fastify: any, webDir: string): void {
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error(
      `HEXYRN_WEB_DIR "${webDir}" does not contain index.html - is the web app built?`,
    );
  }
  fastify.addHook('onRequest', async (req: any, reply: any) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return;
    const hit = resolveStaticFile(webDir, req.url);
    if (!hit) return;
    reply.header('Content-Type', hit.contentType);
    reply.header('Cache-Control', hit.cacheControl);
    reply.send(req.method === 'HEAD' ? undefined : createReadStream(hit.file));
    return reply;
  });
}
