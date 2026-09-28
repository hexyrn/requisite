import React from 'react';

/**
 * The tile/logo for an app in the suite. Painted in the app's own accent
 * (inherit --hx-accent from the surrounding ThemeScope, or pass `color`).
 * Manifests name an icon by key; an unknown or missing key falls back to the
 * app's first letter, so a third-party app always gets a usable mark.
 */
const PATHS: Record<string, React.ReactNode> = {
  cart: (
    <>
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="18" cy="20" r="1.5" />
      <path d="M2 3h3l2.6 12.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20.5 7H6" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-2.6-.6-.6-2.6z" />
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6 6 0 0 1 3.5 6" />
    </>
  ),
  chart: <path d="M4 20V4M4 20h16M8 16v-5M13 16V8M18 16v-8" />,
  shield: <path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  home: <path d="m3 11 9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5" />,
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.2" />
      <rect x="14" y="4" width="6" height="6" rx="1.2" />
      <rect x="4" y="14" width="6" height="6" rx="1.2" />
      <rect x="14" y="14" width="6" height="6" rx="1.2" />
    </>
  ),
};

export interface AppIconProps {
  /** Icon key from the app manifest's brand.icon. */
  icon?: string | null;
  /** Used for the fallback initial when the icon key is unknown. */
  name: string;
  /** Accent as #rrggbb; omit to inherit from the surrounding theme. */
  color?: string | null;
  size?: 'md' | 'lg';
}

export function AppIcon({ icon, name, color, size = 'md' }: AppIconProps) {
  const glyph = icon ? PATHS[icon] : undefined;
  return (
    <span
      className={`hx-app-icon${size === 'lg' ? ' hx-app-icon--lg' : ''}`}
      style={color ? ({ '--hx-accent': color } as React.CSSProperties) : undefined}
      aria-hidden="true"
    >
      {glyph ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {glyph}
        </svg>
      ) : (
        (name.trim()[0] ?? '?').toUpperCase()
      )}
    </span>
  );
}
