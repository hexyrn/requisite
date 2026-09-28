import { readFileSync } from 'fs';

export interface TlsOptions {
  pfx?: Buffer;
  passphrase?: string;
  cert?: Buffer;
  key?: Buffer;
}

/**
 * Optional HTTPS for the built-in web server. Off by default: a single-PC Windows install listens on
 * loopback (http://localhost), which browsers treat as a secure context. Turning on LAN access (see
 * scripts/windows/Enable-LanAccess.ps1) points these settings at a real certificate.
 *
 *   HEXYRN_TLS_PFX_FILE [+ HEXYRN_TLS_PFX_PASSPHRASE]   - a Windows .pfx, or
 *   HEXYRN_TLS_CERT_FILE + HEXYRN_TLS_KEY_FILE          - PEM files.
 *
 * Misconfiguration is fatal on purpose: if TLS was requested but cannot be set up, the service must not
 * quietly fall back to plain HTTP on a network-reachable address.
 */
export function loadTlsOptions(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = readFileSync,
): TlsOptions | null {
  const pfxFile = env.HEXYRN_TLS_PFX_FILE?.trim();
  const certFile = env.HEXYRN_TLS_CERT_FILE?.trim();
  const keyFile = env.HEXYRN_TLS_KEY_FILE?.trim();
  if (!pfxFile && !certFile && !keyFile) return null;
  if (pfxFile && (certFile || keyFile)) {
    throw new Error(
      'Set either HEXYRN_TLS_PFX_FILE or HEXYRN_TLS_CERT_FILE + HEXYRN_TLS_KEY_FILE, not both.',
    );
  }
  try {
    if (pfxFile) {
      return { pfx: read(pfxFile), passphrase: env.HEXYRN_TLS_PFX_PASSPHRASE || undefined };
    }
    if (!certFile || !keyFile) {
      throw new Error('HEXYRN_TLS_CERT_FILE and HEXYRN_TLS_KEY_FILE must be set together.');
    }
    return { cert: read(certFile), key: read(keyFile) };
  } catch (err) {
    throw new Error(
      `HTTPS was requested but the certificate could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
