# UI design system

Covers the settings window (`src/renderer/settings.html`, `settings.css`) and the tray popup (`tray-popup.html`, `tray-popup.css`). Both import the shared tokens in `src/renderer/tokens.css`. Tokens are the source of truth; if this document and `tokens.css` disagree, `tokens.css` wins and this file should be fixed.

## Direction

A native system utility: dense but calm, closer to an OS settings pane than to a web dashboard.

- Colour carries meaning only: accent for interactive and selected state, `ok` / `warn` / `danger` for status. Everything else is neutral. The one exception is the categorical palette (`--cat-N`), which tells providers apart in the spend donut and legend; it has no red, green or amber hue so it never reads as a status.
- No gradients, glow, glassmorphism, emoji icons, or decorative illustration. Icons are small inline SVG strokes.
- Flat surfaces separated by hairline borders. The tray popup is one surface with sections divided by hairlines, not nested cards.
- Motion is short (`--dur: 140ms`) and disabled under `prefers-reduced-motion: reduce`.

### System fonts

`--font` is a system stack (`"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`) and `--mono` is `ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace`.

Reason: the app promises to be local-first, and a webfont means a network request on every window open. The earlier design loaded Plus Jakarta Sans from Google Fonts. The settings page CSP is `font-src 'self'`, so a remote font would be blocked anyway. Do not add webfonts.

### Brand accent

The accent is derived from the app icon's gradient, `#4338CA` to `#3B82F6` (`INDIGO` and `BLUE` in `scripts/generate-icons.js`). Light theme uses the indigo end directly. Dark theme lightens it (`--accent: #8B8FF8`) for text and uses a mid indigo (`--accent-solid: #5B5FEF`) for filled controls.

## Tokens

Dark is the `:root` default; light overrides it inside `@media (prefers-color-scheme: light)`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0F1014` | `#F6F6F8` | Window background, sidebar |
| `--surface` | `#16171C` | `#FFFFFF` | Content panels, popup body, inputs |
| `--surface-2` | `#1D1F26` | `#F0F0F3` | Secondary buttons, hover, meter track |
| `--border` | `#2A2C35` | `#E3E3E8` | Hairlines |
| `--border-strong` | `#3A3D48` | `#CFCFD6` | Input borders, switch off state |
| `--text` | `#ECEDF1` | `#111217` | Primary text |
| `--text-2` | `#A4A7B3` | `#50535E` | Secondary text |
| `--text-3` | `#8A8E9B` | `#666A76` | Tertiary text, placeholders |
| `--accent` | `#8B8FF8` | `#4338CA` | Links, focus ring, selected state |
| `--accent-solid` | `#5B5FEF` | `#4338CA` | Primary button, checked switch (white text on top) |
| `--accent-soft` | `rgba(139, 143, 248, .14)` | `rgba(67, 56, 202, .09)` | Selected backgrounds, focus halo |
| `--ok` | `#4ADE80` | `#157A3A` | Healthy status |
| `--ok-soft` | `rgba(74, 222, 128, .12)` | `rgba(21, 122, 58, .10)` | Pill background |
| `--warn` | `#FBBF24` | `#AB4F08` | Warning status, paused |
| `--warn-soft` | `rgba(251, 191, 36, .12)` | `rgba(171, 79, 8, .10)` | Pill background |
| `--danger` | `#F87171` | `#B91C1C` | Critical status, errors |
| `--danger-soft` | `rgba(248, 113, 113, .12)` | `rgba(185, 28, 28, .10)` | Pill background |
| `--shadow-float` | `0 12px 32px rgba(0, 0, 0, .28)` | `0 12px 32px rgba(17, 18, 23, .12)` | Drawer, menus |
| `--backdrop` | `rgba(0, 0, 0, .4)` | `rgba(17, 18, 23, .16)` | Drawer backdrop |
| `--cat-1` | `#60A5FA` | `#2563EB` | Provider colour: blue |
| `--cat-2` | `#E879F9` | `#A21CAF` | Provider colour: fuchsia |
| `--cat-3` | `#22D3EE` | `#0E7490` | Provider colour: cyan |
| `--cat-4` | `#A78BFA` | `#6D28D9` | Provider colour: violet |
| `--cat-5` | `#F472B6` | `#DB2777` | Provider colour: pink |
| `--cat-6` | `#94A3B8` | `#64748B` | Provider colour: slate |

Theme-independent: `--radius: 8px`, `--radius-sm: 6px`, `--ease: cubic-bezier(.2, .8, .2, 1)`, `--dur: 140ms`.

`tray-popup.css` hardcodes `--surface` at reduced alpha for the "increase transparency" mode (`body.popup-transparent`). Keep those rgba values in sync when the palette changes.

## Contrast rule (WCAG AA)

Every text/background pair must reach at least 4.5:1 in both themes:

- `text`, `text-2`, `text-3`, `accent`, `ok`, `warn`, `danger` on `bg`, `surface` and `surface-2`;
- white on `--accent-solid`;
- `ok`, `warn`, `danger` and `accent` on their `-soft` background composited over `--surface` (pills, selected rows).

The categorical palette (`--cat-N`) is only used for graphical marks (donut arcs, legend dots), so it must reach 3:1 against `--surface` in both themes (WCAG 1.4.11) rather than 4.5:1.

Two light values were darkened to pass: `--ok` `#15803D` to `#157A3A` and `--warn` `#B45309` to `#AB4F08`. The originals measured 4.41:1 on `--surface-2` and about 4.3:1 on their own pill backgrounds.

Check with:

```bash
node scripts/check-contrast.js
```

It reads both themes from `tokens.css`, prints every ratio, and exits non-zero if any pair is below its minimum (4.5:1 for text, 3:1 for the palette). Run it after any token change.

## Theme

The theme setting (system / light / dark) is applied in the main process through `nativeTheme.themeSource` (`src/main/index.ts`), which drives `prefers-color-scheme` in both renderers. Do not add a parallel mechanism such as a `data-theme` attribute or a class toggle.

## Page structure (settings window)

- Left sidebar with the brand, the main pages **Overview**, **Integrations**, **Activity**, **Preferences**, then an **Advanced** group (`nav-group-label`) with **Webhook** and **Logs**. The footer shows the monitoring status dot and the Pause button.
- Each page is a `<section class="page" data-page="...">`; only one is visible at a time.
- Connector details open in a side drawer (`#connectorDrawer`): `role="dialog"`, `aria-modal="true"`, labelled by its title. While open, Tab and Shift+Tab are trapped inside it, Escape closes it (unless the row context menu is open, which handles Escape first), clicking the backdrop closes it, and focus returns to the row that opened it.

## Component rules

- **Buttons**: 28px high (`.btn`), 24px for `.btn-sm`. Variants: `btn-primary` (accent-solid, white text), `btn-secondary`, `btn-ghost`, `btn-danger-ghost`. Icon buttons are square (`.btn-icon`).
- **Destructive actions** (Activity *Clear*, a connector secret's *Clear*): inline two-step confirm (`bindConfirmClick` in `settings.ts`). The first click relabels the button to *Confirm clear* for 3.5 s; a second click inside that window runs the action; timing out or moving focus away disarms it. No `confirm()` dialogs. A secret's *Clear* is `btn-danger-ghost` and disabled while the key is not set.
- **Disabled rows**: a row whose control depends on a master switch (notification kinds under *Show desktop notifications*, the quiet-hours window under its switch) disables that control while the master is off. Disabled rows use `--text-3` for their label and description, never opacity, so the text still meets contrast.
- **Spend switches** (`.spend-switch`): toggle buttons with `aria-pressed`, grouped in a `role="group"` with an `aria-label` (not a tablist). At least 24px high.
- **Switch**: native checkbox with `appearance: none`, 28x16px; off is `--border-strong`, on is `--accent-solid` with a white 12px knob.
- **Inputs** (`.control`): 28px high (24px for `.control-sm`), `--surface` background, `--border-strong` border; on focus the border becomes `--accent` with a 3px `--accent-soft` halo.
- **Meters**: 4px bar on a `--surface-2` track. Fill and percentage colour come from `paceStateFor` in `src/renderer/quota-math.ts`:
  - Without both `resetsAt` and `windowMs`, or when less than 5% of the window has elapsed, or the window has already passed: static bands, warn at 75% used, critical at 90% (rounded percent).
  - Otherwise pace-projected: `projected = used fraction / elapsed fraction`; warn when projected is at least 0.9, critical when projected is at least 1.0 or usage has reached 100%.
  - The bar carries no elapsed-time ("even pace") marker. One existed and was removed at the owner's request as visual noise; pace is expressed only through colour and the reset countdown.
- **Bucket placement**: buckets with no limit, or marked `defaultVisibility: 'onDemand'`, render in the compact "More metrics" section below the main meters (`renderMeterGroup` in `quota-view.ts`).
- **No-data meter rows** (`.meter-row.no-data`): `--text-2` title and `--text-3` value, not reduced opacity.
- **Provider colours** (`connectorColor` in `quota-view.ts`): a valid `brandColor` wins; otherwise a `--cat-N` slot is assigned in registry order among the connectors that report spend (`spendColorFor`), so up to six spend providers never share a colour; the id hash is the fallback. Donut arcs set the colour through `style="stroke:…"`, since `var()` does not work in SVG presentation attributes.
- **Tray popup footer**: an *Updated 42s ago* label from the newest `fetchedAt` among visible providers. It ticks each second while the popup is shown and is not a live region. The popup never fetches on a timer: it renders what main pushes, and only the Refresh button and the row menu's *Refresh this provider* force a fetch. Re-renders keep open *More metrics* rows open and keep keyboard focus (`captureViewState` / `restoreViewState` in `quota-view.ts`).
- **Status**: small dot plus text. "App not running" (`status-app-not-running`) uses a `--text-3` dot and `--text-2` text: it is expected, not an error. Pills (`.pill-waiting`, `.pill-finished`) use the status colour on its `-soft` background.
- **Update banner** (`.update-banner`, `renderUpdateBanner` in `update-banner.ts`): `--accent-soft` background with a hairline border, `--accent` download icon, `--text` copy, one small `btn-primary` action (*Update now* / *Restart to update* where the package can install, *Download* to the release page otherwise) and a ghost dismiss button. While downloading, a 4px `--accent-solid` progress bar replaces the action. Settings window: above the page content, same max width as `.page`. Tray popup: compact variant between the header and the scroll area, divided by a hairline.
- **Neutral notice** (`.inline-notice`, `renderAppNotRunningNotice` in `quota-view.ts`): info icon plus `--text-2` text, used instead of the red error styling for `appNotRunning` snapshots. The tray popup does not show those connectors at all.

## Known gaps

- The tray popup cannot show the paused state; it would need a new IPC push from main to the popup.
- `OPAQUE_BG` in `src/main/tray-popup.ts` is `#161b22`, which no longer matches `--surface`, so the popup can flash a slightly different colour when it opens.
- Unlimited buckets (`limit: null`) still render under "More metrics", because `scripts/smoke.js` asserts that a `limit: null` bucket lands inside `meter-extras`. Changing that placement means updating those smoke checks too.
