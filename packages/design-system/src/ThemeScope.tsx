import React from 'react';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export interface ThemeScopeProps {
  /** Preset accent (see styles.css): 'core', 'requisite', ... */
  app?: string;
  /** Explicit accent as #rrggbb (e.g. an app manifest's brand.color). Takes precedence over `app`. */
  color?: string | null;
  children: React.ReactNode;
}

/**
 * Gives everything inside it one app's accent colour. Renders no box of its
 * own (display: contents), so it can wrap a page without affecting layout.
 * Colours are validated because they end up in CSS.
 */
export function ThemeScope({ app, color, children }: ThemeScopeProps) {
  const safe = color && HEX_COLOR.test(color) ? color : undefined;
  return (
    <div
      className="hx-theme"
      data-app={app}
      style={{ display: 'contents', ...(safe ? { ['--hx-accent' as string]: safe } : {}) }}
    >
      {children}
    </div>
  );
}
