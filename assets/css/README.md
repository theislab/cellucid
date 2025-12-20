# Cellucid CSS Design System

`assets/css/main.css` is the single entry point. Styles are organized into CSS Layers so the cascade stays predictable:

- `tokens` → primitive design values (the only place raw hex lives)
- `themes` → semantic token mapping per theme (`[data-theme="..."]`, currently `light`/`dark`)
- `base` → reset/global defaults
- `utilities` → composable, atomic helpers
- `components` → theme‑agnostic UI modules
- `layouts` → app/page layout rules

## Directory Map

- `assets/css/tokens/`: primitives and scales (`--gray-*`, `--space-*`, `--breakpoint-*`, `--text-*`, `--z-*`, …)
- `assets/css/themes/`: semantic tokens (`--color-*`) for each theme
- `assets/css/base/`: reset + global element styles
- `assets/css/utilities/`: atomic classes (spacing/typography/colors/layout)
- `assets/css/components/`: modules (sidebar, accordion, modals, analysis, …)
- `assets/css/layouts/`: app layout + responsive/print

## Rules Of The Road

- No inline styles in `index.html`. Use utilities + component classes.
- No raw hex outside `assets/css/tokens/_colors.css`.
- Components must use semantic tokens (e.g. `var(--color-text-primary)`), not primitives.
- Prefer utilities for spacing/typography before adding new bespoke rules.

## JS Integration (Dynamic UI)

Dynamic values should flow through CSS variables and data attributes so CSS stays the source of truth:

- Use `assets/js/utils/style-manager.js`:
  - `StyleManager.setVariable(el, '--some-var', value)`
  - `StyleManager.setState(el, 'state', 'open')` (writes `data-state="open"`)
- Theme changes are driven by `assets/js/utils/theme-manager.js`:
  - persists `cellucid_theme` (`light` or `dark`)
  - sets `document.documentElement.dataset.theme`
  - emits `cellucid:theme-change` with `{ detail: { theme } }`

### Plotly Theming

Plotly needs resolved colors (not `var(--...)`). We centralize this in:

- `assets/js/app/analysis/shared/plot-theme.js`
  - reads design tokens via `StyleManager.resolveVariable(...)`
  - applies theme updates to existing plots on `cellucid:theme-change`

## Adding A Theme (Future)

Cellucid currently ships only `light` and `dark`. To add a new theme later:

1. Create `assets/css/themes/_my-theme.css` defining the full `--color-*` semantic token set under `[data-theme="my-theme"]`.
2. Add it to `assets/css/themes/_index.css`.
3. Update `types/design-tokens.d.ts` (`ThemeName`) to include the new theme.
4. Update `assets/js/utils/theme-manager.js` (`VALID_THEMES`) and `index.html` (Theme `<select>`).
5. Run `node cellucid/scripts/validate-tokens.js`.

## Validation

- Token + theme contract check: `node cellucid/scripts/validate-tokens.js`
- Token definitions ↔ type sync: `node cellucid/scripts/validate-token-types.js`
- Quick audits:
  - `rg "style=\\\"" cellucid/index.html` (should be empty)
  - `rg \"#[0-9a-fA-F]{3,8}\\\\b\" cellucid/assets/css --glob '!cellucid/assets/css/tokens/_colors.css'` (should be empty)

## Token Workflow (When Adding/Changing Tokens)

1. Add/modify primitives in `assets/css/tokens/` (raw hex lives only in `assets/css/tokens/_colors.css`).
2. Add/modify semantic mappings in `assets/css/themes/` (themes should only set `--color-*` tokens).
3. Update `types/design-tokens.d.ts` so JS gets autocomplete/typo protection.
4. Run:
   - `node cellucid/scripts/validate-token-types.js`
   - `node cellucid/scripts/validate-tokens.js`
