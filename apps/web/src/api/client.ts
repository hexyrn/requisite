const API_BASE = '/api/v1';

let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (csrfToken && method !== 'GET') {
    headers['X-Hexyrn-CSRF'] = csrfToken;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Real multipart file upload (item 17) - deliberately bypasses `request()`
 * because a multipart body must NOT set its own Content-Type header (the
 * browser generates the boundary parameter itself); everything else
 * (CSRF header, credentials, error handling) matches `request()` exactly.
 */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const headers: Record<string, string> = {};
  if (csrfToken) headers['X-Hexyrn-CSRF'] = csrfToken;

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: formData,
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Upload failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ requiresMfa: boolean; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  verifyMfa: (code: string) =>
    request<{ verified: boolean; csrfToken: string }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  completeBootstrap: (input: Record<string, unknown>) =>
    request('/bootstrap/complete', { method: 'POST', body: JSON.stringify(input) }),
  getOrganisation: () => request('/organisation'),
};
