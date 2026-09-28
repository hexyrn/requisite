# Design System and the Suite Look

Every app in the Hexyrn suite shares **one design language** and differs only by **accent colour**. Core is the
host: it owns the shell (top bar, app switcher), the sign-in screens and the launcher home page; apps only fill the
page area beneath the top bar.

Package: `packages/design-system` (React components + one stylesheet, `src/styles.css`). The web app imports it once
in `apps/web/src/main.tsx`.

## The one rule: accent colour is the only per-app knob

Everything (buttons, links, active tab, focus rings, the stripe on the top bar, tile borders, table hover) derives from
`--hx-accent`. To theme an app you set that single variable; nothing else changes.

| App                         | Accent                                                                       | How it is set                                                |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Core (home, admin, sign-in) | indigo `#4f46e5`                                                             | `data-app="core"` preset                                     |
| Requisite                   | teal `#0f766e`                                                               | manifest `brand.color`; also a `data-app="requisite"` preset |
| Reserved presets            | assets `#b45309`, maintain `#c2410c`, competency `#7e22ce`, margin `#be185d` | `data-app` presets in `styles.css`                           |

Choose a new app's colour so that **white text on it has contrast >= 4.5:1** (buttons and the logo mark use white on the
accent) and it is clearly distinct from the colours above. Dark mode is automatic (`prefers-color-scheme`); the accent
is lightened for text in dark mode by the stylesheet, not by the app.

## Building a new app's UI

1. Put `brand: { color, icon }` in the manifest (`docs/APP_SDK.md`). The launcher, switcher and shell pick it up; you
   write no theming code. Icon keys: `cart`, `wrench`, `box`, `users`, `chart`, `shield`, `gear`, `home`, `grid`
   (unknown key -> the app's first letter).
2. Register routes under Core's authenticated shell (`<Route path="/yourapp" ...>` inside the `AuthenticatedShell`
   route in `main.tsx`). The shell works out which app owns the URL from the launcher's `basePath` and themes the top
   bar; do not build your own header.
3. Build pages from the shared components: `PageHeader`, `Card`, `Table`, `Button`, `Input`, `StatusBadge`,
   `EmptyState`, `Alert`, `TabNav` (+ `TAB_CLASS` for `NavLink`s), `Money`. Bare `<select>`, `<textarea>` and `<input>`
   are styled globally. Use theme variables (`var(--hx-text-muted)`, `var(--hx-danger)`, `var(--hx-border)`), never
   hard-coded hex colours, or the page will look wrong in dark mode.
4. Filter rows: wrap in `<div className="hx-toolbar">`.

## Things that will bite you

- **Derived tokens must be declared per scope.** A custom property that references another is resolved where it is
  declared, so `--hx-accent-text`, `--hx-accent-soft` etc. are re-declared on `:root, [data-app], .hx-theme`. If you add
  a new derived token, add it there, not on `:root` alone (this exact bug made link text stay indigo inside Requisite).
- **CSP.** The API sends `style-src 'self'`. Theming therefore uses a real `.css` file (bundled, external) and sets the
  accent through React's `style` prop, which goes through the CSSOM and is allowed. Do **not** inject `<style>` tags or
  write `style="..."` into HTML strings. Verified on the production build under that exact policy.
- `ThemeScope` renders `display: contents`, so it never affects layout. Colours passed to it are validated as
  `#rrggbb` (they end up in CSS); the server validates `brand.color` the same way.

## Launcher rules (Core)

`GET /api/v1/apps/launcher` returns only apps that are installed + enabled + licensed + compatible **and** have at least
one navigation entry the user may see. Organisation administrators additionally see inactive apps with a status
(`not_licensed`, `disabled`, `incompatible`) and a link to the licence screen. `internal` apps are never listed.
Covered by `launcher.service.spec.ts`, `Launcher.test.tsx` and the `suite launcher` browser test.
