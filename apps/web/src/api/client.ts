const API_BASE = '/api/v1';

let csrfToken: string | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

/** Thrown for any non-2xx response; `status` lets callers tell "not signed in" (401) from other failures. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  // Only declare a JSON body when there is one: Fastify rejects a request that
  // says "application/json" but has an empty body with a 400, which silently
  // broke every body-less POST from the UI (logout - so the server session was
  // never revoked - MFA enrolment start, and action buttons).
  const headers: Record<string, string> = {
    ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
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
    throw new ApiError(body.message ?? `Request failed: ${res.status}`, res.status);
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
    throw new ApiError(body.message ?? `Upload failed: ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export interface LauncherApp {
  appId: string;
  displayName: string;
  description: string | null;
  version: string;
  brand: { color: string; icon: string | null } | null;
  launchPath: string;
  basePath: string | null;
  status: 'active' | 'not_licensed' | 'disabled' | 'incompatible';
}

export interface Launcher {
  apps: LauncherApp[];
  canAdminister: boolean;
}

export const api = {
  /** The apps this user may open from the Core home page / app switcher. */
  getLauncher: () => request<Launcher>('/apps/launcher'),
  /** Recovers this session's CSRF token after a reload; 401 means there is no valid (MFA-verified) session. */
  getSession: () =>
    request<{ csrfToken: string; user: { id: string; email: string } }>('/auth/session'),
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
