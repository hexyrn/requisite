import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthenticatedShell } from '../pages/AuthenticatedShell';
import { ApiError } from '../api/client';
import { api } from '../api/client';

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/requisite']}>
      <Routes>
        <Route path="/login" element={<p>LOGIN PAGE</p>} />
        <Route path="/" element={<AuthenticatedShell />}>
          <Route path="requisite" element={<p>PROTECTED CONTENT</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthenticatedShell - session gate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects a visitor with no valid session to /login and never renders protected content', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(new ApiError('No session.', 401));
    const org = vi.spyOn(api, 'getOrganisation');
    renderShell();
    await waitFor(() => expect(screen.getByText('LOGIN PAGE')).toBeTruthy());
    expect(screen.queryByText('PROTECTED CONTENT')).toBeNull();
    expect(org).not.toHaveBeenCalled();
  });

  it('restores the CSRF token from the server on load, so saves still work after a page refresh', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const body = url.endsWith('/auth/session')
        ? { csrfToken: 'restored-token', user: { id: 'u1', email: 'a@b.co' } }
        : url.endsWith('/apps/launcher')
          ? { apps: [], canAdminister: false }
          : { display_name: 'Acme' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderShell();
    await waitFor(() => expect(screen.getByText('PROTECTED CONTENT')).toBeTruthy());

    await api.logout();
    const logoutCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/logout'))!;
    expect((logoutCall[1] as RequestInit).headers).toMatchObject({
      'X-Hexyrn-CSRF': 'restored-token',
    });
    vi.unstubAllGlobals();
  });

  it('shows an error (not a redirect) when the failure is not authentication', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(new ApiError('boom', 500));
    renderShell();
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.queryByText('LOGIN PAGE')).toBeNull();
  });
});

describe('api client - request headers', () => {
  it('does not send a JSON Content-Type on body-less requests (Fastify rejects that with 400), but does when there is a body', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await api.logout();
    await api.login('a@b.co', 'pw');
    const [logoutInit, loginInit] = fetchMock.mock.calls.map(([, init]) => init as RequestInit);
    expect(logoutInit.headers).not.toHaveProperty('Content-Type');
    expect(loginInit.headers).toMatchObject({ 'Content-Type': 'application/json' });
    vi.unstubAllGlobals();
  });
});
