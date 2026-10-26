# Cellucid CSS Design System

`assets/css/main.css` is the app's entry point, and `assets/css/page.css` the standalone pages' (a subset of the same modules; see Site Design Principles). Styles are organized into CSS Layers so the cascade stays predictable:

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
- Font families come only from `var(--font-sans)` (Inter, all interface text) and `var(--font-mono)` (inline `code` and preformatted output only); only `@font-face` in `base/_fonts.css` names a family directly.
- Prefer utilities for spacing/typography before adding new bespoke rules.

## Site Design Principles

Every screen of www.cellucid.com is one product: the app, its dialogs, the
standalone pages (`404.html`, the reading pages `privacy.html`, `terms.html`
and `accessibility.html`, `assets/auth/callback.html`) and
the screens shown when the app cannot run (startup failure, code-load failure,
`<noscript>`). Each says its own thing, built from the same principles:

1. **Tokens only.** Colour, type, spacing, borders, shadows and motion come
   from `tokens/` and `themes/`; nothing is styled inline or with a raw value.
2. **Light and dark.** A page follows the theme the visitor chose in the app
   (`theme-init.js`) on the viewer's backdrop, and reads in both.
3. **Composition.** The brand card (`components/_welcome.css`): the wordmark,
   one calm heading, one short sentence, then clear actions (the first one
   filled), quiet links at the foot. A reading page widens the card; it does
   not add a second look.
4. **Tone.** Tidy, informative, never verbose. Say what happened and what to
   do, in plain words for the person. Technical detail (a host, a status, an
   address, an exception) is folded under **Details** and goes to the console
   and the notification log. Explanations live behind (i) tips and in the
   documentation; logs live in the notification center.
5. **Never a dead end.** Every failure offers a way on: try again, continue
   without what failed, or read the guide.
6. **Terminal only when the app cannot run** (no WebGL2, its code did not
   load, no JavaScript). A dataset or link that failed is a failure of that
   opening, not of the app.
7. **Flat type scale, square shapes, quiet edges** — the rules below apply to
   every page, not only the sidebar.
8. **Everyone can use it.** Phone widths without horizontal scroll, a visible
   keyboard focus ring, theme contrast held by `theme-contrast-contract`, and
   `prefers-reduced-motion` stopping motion.

Standalone pages load `assets/css/page.css`: the same layers, tokens, themes
and base as `main.css`, plus the brand card and `layouts/_page.css`, without
the app's panels. A rule a page needs goes in the shared module, which the
app's own copy of that surface (the startup failure screen) uses too.

## Sidebar Control Standard

The sidebar, its floating (undocked) panels, the phone full-screen sheet, the
analysis windows, the dialogs (welcome, license, confirm, figure export,
community annotation), notifications, the selection bar, the view title chips,
the camera-path transport bar and the info popovers are one product. Every control pattern below has exactly
one implementation: one rule set in `components/_controls.css` or
`components/_buttons.css`, sized from `tokens/_controls.css`, and one builder in
`assets/js/app/ui/components/controls.js`. Static markup in `index.html` uses
the same elements and classes the builders produce. A panel adds layout (where
a control sits), never a second look for a control.

| Pattern | Markup / class | Builder |
| --- | --- | --- |
| Section heading | `details.accordion-section > summary` | static, or `analysis-window-manager.js` |
| Sub-section heading | `h3.section-title` in `.control-group-header`; the group is `div.control-group[role=group][aria-labelledby]` | `createGroup` |
| Field | `div.control-block` > `label[for]` + control (+ `p.field-help`) | `createField` |
| Field label + info | `div.field-label-row` > `label[for]` + `button.info-btn` | static |
| Composite field caption | `span.field-label[id]` named by the group's `aria-labelledby` (chip groups, select pairs) | per builder |
| Info button | `button.info-btn[aria-controls]` + `div.info-tooltip[role=dialog][data-info-tip][hidden]`, empty in markup; its text comes from the tip registry `ui/components/info-tips.js` | `createInfoTip`; `info-popovers.js` (one document-level controller) |
| Checkbox + info | `div.checkbox-info-row` > `label.checkbox-inline` + `button.info-btn` | static |
| Select, text, number, textarea | `.obs-select` | `createSelect`, or the element with `.obs-select` |
| Slider | `label[for]` + `div.slider-row` > `input[type=range]` + `output.slider-value` (or `span`) | `createSliderField` |
| Checkbox | `label.checkbox-inline` wrapping `input[type=checkbox]` + text | `createCheckbox` |
| Switch (applies immediately) | `button.switch[role=switch][aria-checked]` > `.switch-track` + `.switch-label` | `createSwitch` |
| Segmented (2–4 exclusive settings) | `div.segmented[role=group][aria-label]` > `button.segmented-btn[aria-pressed]` | `createSegmented` |
| Tool or mode choice | `button.btn[aria-pressed]` in a `role=group` | static |
| Button | `button.btn`; `.btn-primary` for the one action that commits a panel's work; `.btn-compact` inside lists, boxes and rows | `createButton` |
| Icon button | `button.icon-btn[aria-label][title]` (+ `.icon-btn-danger`) with an `ICONS` glyph | `createIconButton` |
| Chip (selectable page, group) | `.chip` (+ `.chip-name`, `.chip-count`, `.color-swatch` + `.color-swatch-input`) | per list, cloned from one prototype |
| Help line | `p.field-help` | `createField({ help })` |
| Status line | `p.status-line[role=status][aria-live=polite][data-tone]` | `createStatusLine` |
| Empty state | `p.empty-state` | `createEmptyState` |
| Loading | `span.spinner` (one `spin` keyframe) | – |
| Settings box (settings of the choice above) | `.control-box`, a quiet tinted box | – |
| Solid box (a list the user edits) | `.list-box` | – |
| Removable row in a list box | `div.list-item` > checkbox + `.list-item-text` + `button.icon-btn.list-item-remove` | `createListItem` |
| Collapsible sub-section | `div.disclosure` > `button.disclosure-header[aria-expanded][aria-controls]` + `div.disclosure-content[hidden]`; in a `.disclosure-list` | `createDisclosure`; `bindDisclosure` for template or static markup (`[data-static-disclosure]`) |

### Rules

- **States.** Interactive state lives in ARIA (`aria-pressed`, `aria-checked`,
  `aria-expanded`, `aria-selected`, `disabled`) and CSS styles that attribute.
  Visibility is the `hidden` attribute, never an inline `display`. Inline
  styles are written only for geometry and for colours that are data
  (`StyleManager.setVariable`); `tests/sidebar-control-standard-contract.test.mjs`
  holds the allowlist.
- **One look per state.** Hover, focus, active and disabled come from the
  shared rule set: focus is the base `:focus-visible` ring (never `:focus`),
  disabled is `--control-disabled-opacity` with `cursor: not-allowed`.
- **Touch.** See "Rhythm and touch" below. A panel never lists its own
  controls in `layouts/_responsive.css`.
- **Tokens only.** Component CSS names colours, sizes, radii, shadows,
  durations and z-indices through tokens. No `!important` outside utilities,
  reduced motion, overrides of third-party or owner-written inline styles,
  and the drag-in-progress states.
- **No work for what nobody sees.** A list redrawn on every visibility frame
  renders through `createVisibilityGatedRender` (`ui/core/visibility-gate.js`),
  which defers it while its `<details>` is closed or the sidebar is hidden and
  runs it once when the panel opens.
- **Lists stay responsive.** A list that can grow with the data (legend
  categories, gene matches, keyframes) delegates its events to the list
  container, keeps a row index instead of querying rows, writes a row only
  when its content changed, and skips off-screen rows with
  `content-visibility: auto`. Slider `input` work is coalesced to one
  animation frame (`coalesceToFrame`) or deferred to `change`.

### Type scale

Interface text takes a role token from `tokens/_typography.css`, never a raw
size or a `--text-*` step. The roles, largest first, with the mouse / coarse
pointer size:

| Role | Mouse | Touch | Weight | Used for |
| --- | --- | --- | --- | --- |
| `--type-title` | 13px | 14px | semibold | panel summaries, dialog titles, welcome actions |
| `--type-heading` | 12px | 13px | semibold | `.section-title`, disclosure titles, tip titles |
| `--type-body` | 12px | 13px | regular | running prose in dialogs, notifications and tips |
| `--type-label` | 12px | 13px | medium, secondary colour | field labels, captions, view title chips |
| `--type-control` | 12px | 13px | regular | the text inside a field, option rows, switches, list rows |
| `--type-button` | 12px | 13px | medium | button text, compact buttons included |
| `--type-hint` | 11px | 12px | regular | help lines, empty states, status lines |
| `--type-readout` | 11px | 12px | regular, tabular figures | slider values, timings, counters |
| `--type-compact` | 10px | 11px | – | badges and counts only |

- The scale is flat on purpose: a title is one step above the one size
  everything else is set in, secondary text one step below, a badge one
  further. Hierarchy comes from weight and colour, not size. A coarse pointer
  raises every role one step (`layouts/_responsive.css`).
- Interface text is one family (Inter), set as written: no
  `text-transform`, no wide letter-spacing, nothing bolder than semibold.
  Numbers use `font-variant-numeric: tabular-nums`, never a monospace face.
- Glyph buttons (dock, copy, close, the sidebar tab) size their character with
  `--control-glyph-sm/md/lg`; a glyph is an icon, not text.
- Plot content (centroid labels, Plotly axes) keeps `--text-*` sizes: it is
  part of the figure, which figure export reproduces at a fixed size.
- Field text is not raised to 16px on touch screens. iOS focus zoom is
  handled by `ui/core/viewport-init.js`, which adds `maximum-scale=1` on iOS
  WebKit only (Safari still honours pinch zoom there); the reasoning is in
  that file and in `layouts/_responsive.css`.
- `tests/ui-type-scale-contract.test.mjs` holds every rule above.

### Rhythm and touch

- **One spacing rhythm** (`tokens/_controls.css`): `--control-panel-gap`
  between panels, `--control-group-gap` between the top-level groups of a
  panel, `--control-block-gap` between blocks inside a group or a box,
  `--control-row-gap` between a label and its control or one row and the
  next, `--control-box-padding-y/x` inside a box, and
  `--control-dialog-header-padding-y/x` / `--control-dialog-padding` for the
  dialog header band and body. A block's first child sits flush with its
  container; spacing comes from the container's gap, never from margins that
  double up.
- **Drawn compact, hit large.** On a coarse pointer every control is drawn
  `--control-target-min` (36px) tall; buttons, icon buttons, segments,
  switches and option rows carry an invisible `::after` that reaches
  `--control-hit-extend` (3px) above and below, so the target is 42px. A
  one-line field cannot carry a pseudo-element, so it gets the same 3px as
  transparent border with its frame drawn as an inset ring.
  Stacked controls keep at least `--space-1-5` between them so one control's
  extension never covers its neighbour's drawn box. Legend row icons are the
  one opt-out: rows are packed, so their extension is cancelled.
- **Compact lists.** A list row (legend categories, shortcuts, kept views,
  keyframes, filters, dataset facts, disclosure headers) is at least
  `--control-list-row-height` (20px) tall on a mouse layout: one line of
  text with a little air. The interface is deliberately dense; a coarse
  pointer raises rows to `--control-row-min`.
- **Quiet edges.** A surface (panel, dialog, menu, card, tip) is drawn with
  `--border-default` and a soft `--shadow-*`; a box inside it with
  `--border-light` on a tinted fill; a field, button or switch with
  `--border-control`. `--border-strong` (ink) is kept for a selected or
  emphasised edge.
- **One shape language.** Surfaces (panels, cards, boxes, fields, chips,
  rows, menus, tooltips, dialogs) are square (`--radius-none`); small badges
  are `--radius-sm`; buttons, switches, pills and scrollbar thumbs are
  `--radius-full`. No other radius is used.
- **One scrollbar.** Every scroll area inside a panel or dialog (floating
  panel body, long legends, the keyframe list, community dialogs) takes the
  shared thin scrollbar at the end of `components/_controls.css`.
- **One dialog chrome.** Dialog headers, titles and close glyphs share one
  rule set in `components/_modals.css`.
- **Motion.** Colour feedback uses `--transition-colors` (150ms); moving
  surfaces (sidebar, notifications, transport bar) use `--duration-normal`.
  Nothing transitions `all`, and `prefers-reduced-motion` stops every
  transition and animation (`base/_accessibility.css`).

### Wording and numbers

- Labels, headings, buttons and options are **sentence case** in the source
  ("Session file", "Gene expression") and are displayed exactly as written.
- **One level of headings per panel.** A panel's summary names it; inside,
  each group of related controls has one `h3.section-title` of one to three
  words, and fields are labelled under it. Qualifiers and explanations go in
  the heading's (i) tip, not in the heading.
- **Every heading and every non-obvious control has an (i) tip** from the
  registry (`ui/components/info-tips.js`): what it does, when to use it and
  what it costs, how it interacts with neighbouring settings, and one or more
  short text links to the documentation section that explains it.
  `tests/info-tips-contract.test.mjs` holds the registry, the pinned links and
  their resolution against the documentation source.
- Labels and headings **never end in a colon**.
- Status lines and help are full sentences with a full stop; empty states say
  what is missing ("No keyframes saved yet.").
- Data units are **cells**, not points; "point" is reserved for the rendered
  mark ("Point size").
- Numbers go through `assets/js/app/ui/components/display-format.js`:
  compact counts with upper-case suffixes (`15K`, `2.5M`), a spaced unit
  (`8.0 s`, `1.00 u/s`), an attached `%` and `×` (never the letter x). Exact
  counts are grouped (`1,234`), and a count with its noun agrees with it
  (`1 cell`, `1,234 cells`): `formatCount`, `formatCountOf` and `countNoun` in
  `assets/js/utils/format-units.js`, never a template like `${n} cells`
  (`tests/count-noun-agreement-contract.test.mjs`). Placeholders and in-progress text end in
  an ellipsis character (`Search genes…`, `Loading…`).

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

## Adding A Theme

Cellucid currently ships `light` and `dark`. A new theme must update every
current theme owner:

1. Create `assets/css/themes/_my-theme.css` defining the full `--color-*` semantic token set under `[data-theme="my-theme"]`.
2. Add it to `assets/css/themes/_index.css`.
3. Update `types/design-tokens.d.ts` (`ThemeName`) to include the new theme.
4. Update `assets/js/utils/theme-manager.js` (`VALID_THEMES`) and `index.html` (Theme `<select>`).
5. Run both validation commands listed below.

## Validation

- Token + theme contract check (unknown tokens, literal font stacks): `node scripts/validate-tokens.js`
- Token definitions ↔ type sync: `node scripts/validate-token-types.js`
- Quick audits:
  - `rg "style=\\\"" index.html` (should be empty)
  - `rg '#[0-9a-fA-F]{3,8}\\b' assets/css --glob '!assets/css/tokens/_colors.css'` (should be empty)

## Token Workflow (When Adding/Changing Tokens)

1. Add/modify primitives in `assets/css/tokens/` (raw hex lives only in `assets/css/tokens/_colors.css`).
2. Add/modify semantic mappings in `assets/css/themes/` (themes should only set `--color-*` tokens).
3. Update `types/design-tokens.d.ts` so JS gets autocomplete/typo protection.
4. Run:
   - `node scripts/validate-token-types.js`
   - `node scripts/validate-tokens.js`
