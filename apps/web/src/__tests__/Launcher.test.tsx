import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { HomePage } from '../pages/HomePage';
import { AppSwitcher } from '../shell/AppSwitcher';
import { ShellProvider, type ShellState } from '../shell/ShellContext';
import type { LauncherApp } from '../api/client';

const REQUISITE: LauncherApp = {
  appId: 'com.hexyrn.requisite',
  displayName: 'Hexyrn Requisite',
  description: 'Purchasing and procurement control.',
  version: '1.0.0',
  brand: { color: '#0f766e', icon: 'cart' },
  launchPath: '/requisite',
  basePath: '/requisite',
  status: 'active',
};
const UNLICENSED: LauncherApp = {
  ...REQUISITE,
  appId: 'com.x.other',
  displayName: 'Hexyrn Assets',
  brand: null,
  launchPath: '/admin/licence',
  basePath: '/assets',
  status: 'not_licensed',
};

function renderWith(state: Partial<ShellState>, ui: React.ReactNode) {
  const value: ShellState = {
    orgName: 'Acme Ltd',
    userEmail: 'a@b.co',
    apps: [],
    canAdminister: false,
    ...state,
  };
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ShellProvider value={value}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </ShellProvider>
    </MemoryRouter>,
  );
}

describe('HomePage - the suite launcher', () => {
  it('shows a tile per app linking to its launch path, with the org name', () => {
    renderWith({ apps: [REQUISITE] }, <HomePage />);
    expect(screen.getByText('Welcome to Acme Ltd')).toBeTruthy();
    const tile = screen.getByRole('link', { name: 'Open Requisite' });
    expect(tile.getAttribute('href')).toBe('/requisite');
    expect(screen.getByText('Purchasing and procurement control.')).toBeTruthy();
  });

  it("gives each tile its own app's accent colour", () => {
    const { container } = renderWith({ apps: [REQUISITE] }, <HomePage />);
    const scope = container.querySelector('[style*="--hx-accent"]') as HTMLElement;
    expect(scope.style.getPropertyValue('--hx-accent')).toBe('#0f766e');
  });

  it('shows an Administration tile only to administrators', () => {
    const { unmount } = renderWith({ apps: [REQUISITE], canAdminister: false }, <HomePage />);
    expect(screen.queryByRole('link', { name: 'Open Administration' })).toBeNull();
    unmount();
    renderWith({ apps: [REQUISITE], canAdminister: true }, <HomePage />);
    expect(screen.getByRole('link', { name: 'Open Administration' }).getAttribute('href')).toBe(
      '/admin',
    );
  });

  it('shows inactive apps to admins with their status and a route to the licence screen', () => {
    renderWith({ apps: [UNLICENSED], canAdminister: true }, <HomePage />);
    const tile = screen.getByRole('link', { name: 'Assets - Not licensed' });
    expect(tile.getAttribute('href')).toBe('/admin/licence');
  });

  it('explains the empty state to an ordinary user with no apps', () => {
    renderWith({ apps: [], canAdminister: false }, <HomePage />);
    expect(screen.getByRole('status').textContent).toMatch(/No apps are available/);
  });
});

describe('AppSwitcher', () => {
  it('opens on click, lists Home + usable apps (not inactive ones), marks the current app, and closes on Escape', () => {
    renderWith(
      { apps: [REQUISITE, UNLICENSED], canAdminister: true },
      <AppSwitcher currentBasePath="/requisite" />,
    );
    expect(screen.queryByText('Hexyrn suite')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    expect(screen.getByText('Hexyrn suite')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Home/ })).toBeTruthy();
    const current = screen.getByRole('link', { name: /Requisite/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('link', { name: /Assets/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Administration/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Hexyrn suite')).toBeNull();
  });

  it('hides Administration from non-admins', () => {
    renderWith({ apps: [REQUISITE], canAdminister: false }, <AppSwitcher currentBasePath={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    expect(screen.queryByRole('link', { name: /Administration/ })).toBeNull();
  });
});
