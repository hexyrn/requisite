import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { HttpWebhookSender } from '../webhook-sender';

/**
 * Real HTTP round-trip tests (a genuine local Node http.Server, real
 * fetch() calls, real redirect responses) proving webhook-sender.ts's SSRF
 * hardening: every redirect hop is re-validated through the outbound
 * network policy before being followed, not just the initial URL.
 *
 * These tests deliberately talk to 127.0.0.1 (the test server), which the
 * global SAFE DEFAULT policy would normally block - that's the point: each
 * test explicitly configures `allowedHosts: ['127.0.0.1']` to permit it,
 * proving the allow-list mechanism itself works end-to-end, not just in
 * isolation (outbound-network-policy.spec.ts already covers the policy
 * logic alone without a real server).
 */
describe('HttpWebhookSender SSRF hardening - real HTTP server, real redirects', () => {
  let server: Server;
  let port: number;
  let lastReceivedPath: string | null = null;
  let redirectTarget: string | null = null;

  beforeAll((done) => {
    server = createServer((req, res) => {
      lastReceivedPath = req.url ?? null;
      if (req.url === '/redirect-once' && redirectTarget) {
        res.writeHead(302, { Location: redirectTarget });
        res.end();
        return;
      }
      if (req.url === '/redirect-loop') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/redirect-loop` });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('delivers successfully to an explicitly allowed host with no redirect involved', async () => {
    const sender = new HttpWebhookSender({ allowedHosts: ['127.0.0.1'] });
    const result = await sender.send(`http://127.0.0.1:${port}/hook`, '{}', {});
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('refuses delivery to the same server when it is NOT on the allow-list (proves the check actually runs)', async () => {
    const sender = new HttpWebhookSender({ allowedHosts: [] }); // safe default - nothing allowed
    const result = await sender.send(`http://127.0.0.1:${port}/hook`, '{}', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked by outbound network policy/i);
  });

  it('follows a redirect to another ALLOWED destination', async () => {
    redirectTarget = `http://127.0.0.1:${port}/hook`;
    const sender = new HttpWebhookSender({ allowedHosts: ['127.0.0.1'] });
    const result = await sender.send(`http://127.0.0.1:${port}/redirect-once`, '{}', {});
    expect(result.success).toBe(true);
    expect(lastReceivedPath).toBe('/hook'); // proves the redirect was actually followed
  });

  it('refuses to follow a redirect to a destination the policy blocks, even though the INITIAL url was allowed', async () => {
    // The initial request to 127.0.0.1 is allowed, but it redirects to
    // 10.0.0.99 (a private address never on the allow-list) - the
    // redirect target must be independently validated and rejected, not
    // blindly followed just because the first hop passed.
    redirectTarget = 'http://10.0.0.99/internal-only';
    const sender = new HttpWebhookSender({ allowedHosts: ['127.0.0.1'] });
    const result = await sender.send(`http://127.0.0.1:${port}/redirect-once`, '{}', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked by outbound network policy/i);
  });

  it('caps redirect-following at a fixed limit rather than looping forever', async () => {
    const sender = new HttpWebhookSender({ allowedHosts: ['127.0.0.1'] });
    const result = await sender.send(`http://127.0.0.1:${port}/redirect-loop`, '{}', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too many redirects/i);
  });
});
