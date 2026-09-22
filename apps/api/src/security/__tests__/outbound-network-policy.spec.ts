import { validateOutboundUrl, classifyIp, getConfiguredOutboundNetworkPolicy, DEFAULT_OUTBOUND_NETWORK_POLICY } from '../outbound-network-policy';

describe('Outbound network policy / SSRF hardening (P3 item 34/12)', () => {
  describe('classifyIp', () => {
    it('blocks IPv4 loopback', () => {
      expect(classifyIp('127.0.0.1').blocked).toBe(true);
      expect(classifyIp('127.5.5.5').blocked).toBe(true);
    });

    it('blocks IPv6 loopback', () => {
      expect(classifyIp('::1').blocked).toBe(true);
    });

    it('blocks link-local, including the cloud metadata address', () => {
      expect(classifyIp('169.254.169.254').blocked).toBe(true); // AWS/GCP/Azure IMDS
      expect(classifyIp('169.254.1.1').blocked).toBe(true);
      expect(classifyIp('fe80::1').blocked).toBe(true);
    });

    it('blocks private IPv4 ranges (10/8, 172.16/12, 192.168/16)', () => {
      expect(classifyIp('10.0.0.1').blocked).toBe(true);
      expect(classifyIp('10.255.255.255').blocked).toBe(true);
      expect(classifyIp('172.16.0.1').blocked).toBe(true);
      expect(classifyIp('172.31.255.255').blocked).toBe(true);
      expect(classifyIp('172.32.0.1').blocked).toBe(false); // just outside the 172.16/12 range
      expect(classifyIp('192.168.0.1').blocked).toBe(true);
      expect(classifyIp('192.168.255.255').blocked).toBe(true);
    });

    it('blocks private IPv6 (unique local addresses, fc00::/7)', () => {
      expect(classifyIp('fd00::1').blocked).toBe(true);
      expect(classifyIp('fc00::1').blocked).toBe(true);
    });

    it('blocks multicast/reserved ranges', () => {
      expect(classifyIp('224.0.0.1').blocked).toBe(true);
      expect(classifyIp('255.255.255.255').blocked).toBe(true);
    });

    it('allows an ordinary public IPv4 address', () => {
      expect(classifyIp('93.184.216.34').blocked).toBe(false); // example.com's old IP, a real public address
      expect(classifyIp('8.8.8.8').blocked).toBe(false);
    });
  });

  describe('validateOutboundUrl - scheme and literal-IP handling', () => {
    it('rejects non-http(s) schemes (e.g. file://, gopher://)', async () => {
      const result = await validateOutboundUrl('file:///etc/passwd');
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/scheme/i);
    });

    it('rejects a malformed URL', async () => {
      const result = await validateOutboundUrl('not a url at all');
      expect(result.allowed).toBe(false);
    });

    it('blocks a URL whose hostname IS a literal loopback IP - no DNS lookup needed', async () => {
      const result = await validateOutboundUrl('http://127.0.0.1:8080/hook');
      expect(result.allowed).toBe(false);
      expect(result.resolvedIp).toBe('127.0.0.1');
    });

    it('blocks a URL whose hostname IS a literal private IP', async () => {
      const result = await validateOutboundUrl('https://192.168.1.50/webhook');
      expect(result.allowed).toBe(false);
    });

    it('blocks the literal cloud metadata address directly', async () => {
      const result = await validateOutboundUrl('http://169.254.169.254/latest/meta-data/');
      expect(result.allowed).toBe(false);
    });

    it('allows a literal public IP with no policy exceptions configured', async () => {
      const result = await validateOutboundUrl('https://8.8.8.8/hook', DEFAULT_OUTBOUND_NETWORK_POLICY);
      expect(result.allowed).toBe(true);
    });
  });

  describe('validateOutboundUrl - hostname resolution (real DNS, no mocking)', () => {
    it('resolves and allows a real public hostname (localhost-safe test target)', async () => {
      // example.com is a stable, IANA-reserved test domain unlikely to ever
      // resolve to a private address - a genuine DNS lookup, not mocked.
      const result = await validateOutboundUrl('https://example.com/webhook');
      expect(result.allowed).toBe(true);
      expect(result.resolvedIp).toBeDefined();
    }, 10000);

    it('blocks "localhost" by hostname (resolves to a loopback address)', async () => {
      const result = await validateOutboundUrl('http://localhost:3000/hook');
      expect(result.allowed).toBe(false);
      expect(result.resolvedIp).toMatch(/^(127\.|::1)/);
    });
  });

  describe('administrator-controlled allow-list (self-hosted internal destinations)', () => {
    it('an explicitly allowed hostname bypasses the private-range block', async () => {
      const result = await validateOutboundUrl('http://internal-erp.local/hook', { allowedHosts: ['internal-erp.local'] });
      // internal-erp.local won't resolve via real DNS in this test
      // environment, so this specific case is expected to fail at the
      // allowedHosts-by-hostname check path before DNS is even attempted -
      // proving the hostname-level allow-list check happens BEFORE lookup.
      expect(result.allowed).toBe(true);
    });

    it('an explicitly allowed literal private IP is permitted', async () => {
      const result = await validateOutboundUrl('http://192.168.1.50/hook', { allowedHosts: ['192.168.1.50'] });
      expect(result.allowed).toBe(true);
    });

    it('a private IP NOT on the allow-list is still blocked even when the policy has other entries', async () => {
      const result = await validateOutboundUrl('http://192.168.1.99/hook', { allowedHosts: ['192.168.1.50'] });
      expect(result.allowed).toBe(false);
    });
  });

  describe('getConfiguredOutboundNetworkPolicy (env-driven admin configuration)', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('defaults to an empty allow-list (safest default) when unset', () => {
      delete process.env.HEXYRN_OUTBOUND_ALLOWED_HOSTS;
      expect(getConfiguredOutboundNetworkPolicy()).toEqual({ allowedHosts: [] });
    });

    it('parses a comma-separated HEXYRN_OUTBOUND_ALLOWED_HOSTS', () => {
      process.env.HEXYRN_OUTBOUND_ALLOWED_HOSTS = '192.168.1.50, internal-erp.local ,10.0.0.5';
      expect(getConfiguredOutboundNetworkPolicy()).toEqual({ allowedHosts: ['192.168.1.50', 'internal-erp.local', '10.0.0.5'] });
    });
  });
});
