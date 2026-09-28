import { resolvePublicBaseUrl } from '../public-url';

describe('resolvePublicBaseUrl', () => {
  it('prefers the configured public URL and trims a trailing slash', () => {
    expect(
      resolvePublicBaseUrl('http', 'evil.example', { HEXYRN_PUBLIC_URL: 'https://req.corp:3000/' }),
    ).toBe('https://req.corp:3000');
  });
  it('falls back to the first allowed origin', () => {
    expect(
      resolvePublicBaseUrl('http', 'evil.example', {
        ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
      }),
    ).toBe('http://localhost:3000');
  });
  it('uses the request host (with port) only as a last resort', () => {
    expect(resolvePublicBaseUrl('http', 'localhost:3000', {})).toBe('http://localhost:3000');
  });
});
