import { loadTlsOptions } from '../tls';

const read = (p: string) => Buffer.from(`file:${p}`);

describe('loadTlsOptions', () => {
  it('is off when nothing is configured', () => {
    expect(loadTlsOptions({}, read)).toBeNull();
  });
  it('loads a PFX with its passphrase', () => {
    const o = loadTlsOptions(
      { HEXYRN_TLS_PFX_FILE: 'a.pfx', HEXYRN_TLS_PFX_PASSPHRASE: 'pw' },
      read,
    );
    expect(o?.pfx?.toString()).toBe('file:a.pfx');
    expect(o?.passphrase).toBe('pw');
  });
  it('loads PEM cert + key', () => {
    const o = loadTlsOptions({ HEXYRN_TLS_CERT_FILE: 'c.pem', HEXYRN_TLS_KEY_FILE: 'k.pem' }, read);
    expect(o?.cert?.toString()).toBe('file:c.pem');
    expect(o?.key?.toString()).toBe('file:k.pem');
  });
  it('refuses half-configured or ambiguous settings rather than falling back to HTTP', () => {
    expect(() => loadTlsOptions({ HEXYRN_TLS_CERT_FILE: 'c.pem' }, read)).toThrow(/together/);
    expect(() =>
      loadTlsOptions(
        { HEXYRN_TLS_PFX_FILE: 'a', HEXYRN_TLS_CERT_FILE: 'c', HEXYRN_TLS_KEY_FILE: 'k' },
        read,
      ),
    ).toThrow(/not both/);
  });
  it('fails loudly when the certificate file cannot be read', () => {
    const bad = () => {
      throw new Error('ENOENT');
    };
    expect(() => loadTlsOptions({ HEXYRN_TLS_PFX_FILE: 'missing.pfx' }, bad)).toThrow(
      /could not be loaded: ENOENT/,
    );
  });
});
