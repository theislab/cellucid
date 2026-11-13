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

1. **Tokens only.** Color, type, spacing, borders, shadows and motion come
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
community annotation, and the app dialogs: Cite, Share, Stored, My datasets), notifications, the selection bar, the view title chips,
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
| Select, text, whole number, textarea | `.obs-select`; a whole number is `input[type=number]` with an integer `step` | `createSelect`, or the element with `.obs-select` |
| Menu (a list of actions from a button or a point) | `button[aria-haspopup=menu][aria-expanded]` (+ `aria-controls` while open) > `div.open-menu-list[role=menu]` of `button.open-menu-item[role=menuitem]` (`menuitemcheckbox` with `aria-checked`; `.is-danger`; a disabled item stays listed, `aria-disabled`, with why as its title), `div.open-menu-separator`; shown above the page; keys: ↑/↓, Home/End, Escape back to the opener, Tab on from the opener | `openMenu` (`ui/components/menu.js`) for a menu of the moment (`.popup-menu`: a history row or branch, Filter, a highlight page's Combine); `initOpenDataMenu` (`ui/modules/open-data-menu.js`) for one in the markup (Open…, the History ⋯); both `menuKeyDown` |
| Menu chosen from like a select (My datasets) | `button.obs-select[aria-haspopup=menu]` (drawn as a select: its value, the chevron) > the menu above; the item of the value shown `aria-current` and `aria-disabled` | `initOpenDataMenu` |
| Decimal number (typed; any locale) | `input.obs-select[type=text][inputmode=decimal][autocomplete=off][spellcheck=false]`, read by `parseDecimalText` (a point or a comma), written with a point; never `input[type=number]`, which refuses a decimal comma in Firefox on a page marked English and shows the system's locale in Chromium (`tests/decimal-number-input-contract.test.mjs`) | `createDecimalInput`, `readDecimalInput`, `writeDecimalInput` |
| Slider | `label[for]` + `div.slider-row` > `input[type=range]` + `output.slider-value` (or `span`); a value the user can type is `input.obs-select.slider-number` (+ `span.slider-unit`) | `createSliderField` |
| Checkbox | `label.checkbox-inline` wrapping `input[type=checkbox]` + text | `createCheckbox` |
| Switch (applies immediately) | `button.switch[role=switch][aria-checked]` > `.switch-track` + `.switch-label` | `createSwitch` |
| Segmented (2–4 exclusive settings) | `div.segmented[role=group][aria-label]` > `button.segmented-btn[aria-pressed]` | `createSegmented` |
| Tool or mode choice | `button.btn[aria-pressed]` in a `role=group` | static |
| Button | `button.btn`; `.btn-primary` for the one action that commits a panel's work; `.btn-compact` for a panel's, a dialog's or a card's own actions where room is short; `.btn-quiet` (no border, no fill, one line, the text size around it) for an action nested inside something smaller than a panel — see "Nested actions" below — and `.btn-quiet.btn-quiet-primary` (accent text) for the one main action there, never a filled button; `.btn-danger` the confirmation that destroys something, wherever it is asked | `createButton` (`variant`: `primary`, `secondary`, `quiet`, `quiet-primary`, `danger`); `buttonClassName(variant)` for template or element-helper markup |
| Icon button | `button.icon-btn[aria-label][title]` (+ `.icon-btn-danger`) with an `ICONS` glyph (never a typed character such as `✕` or `⋯`) | `createIconButton` |
| Chip (selectable page, group) | `.chip` (+ `.chip-name`, `.chip-count`, `.color-swatch` + `.color-swatch-input`); a chip's own removal is a muted `×` glyph button named for what it removes ("Delete Page 2", "Remove View 2", "Remove CD3E"), no border or fill, danger text on hover (highlight pages, kept views, gene chips) | per list, cloned from one prototype |
| Help line | `p.field-help` | `createField({ help })` |
| Status line | `p.status-line[role=status][aria-live=polite][data-tone]` | `createStatusLine` |
| Empty state | `p.empty-state` | `createEmptyState` |
| Loading | `span.spinner` (one `spin` keyframe) | – |
| Settings box (settings of the choice above) | `.control-box`, a quiet tinted box | – |
| Solid box (a list the user edits) | `.list-box` | – |
| Removable row in a list box | `div.list-item` > checkbox + `.list-item-text` + `button.icon-btn.list-item-remove` | `createListItem` |
| Row chosen for an action in a list box (Remove selected) | `label.select-item` > checkbox + `.select-item-body` (`.select-item-head` > `.select-item-name` + `.select-item-size`, then `.select-item-meta`); a row that cannot be chosen has its checkbox disabled and says why | `createSelectItem` |
| Collapsible sub-section | `div.disclosure` > `button.disclosure-header[aria-expanded][aria-controls]` + `div.disclosure-content[hidden]`; in a `.disclosure-list` | `createDisclosure`; `bindDisclosure` for template or static markup (`[data-static-disclosure]`) |
| Collapsible section of a panel (Session › Subsampling, Data mapping) | `div.control-block.disclosure.disclosure-inline.session-disclosure` > `.disclosure-header-row` (`h3.section-title.session-disclosure-heading` > `button.disclosure-header` with `.disclosure-title`, a one-line `.disclosure-desc` summary shown while collapsed, `.disclosure-chevron`; then the `.info-btn`) + `div.disclosure-content[hidden]`; open state kept per viewer in `localStorage` | `initSessionSections` (`ui/modules/session-sections.js`) |
| Details (the facts behind a short summary: the Dataset box, Cells to open) | `div.disclosure.disclosure-inline.details-disclosure` titled "Details" > `dl.fact-list` of label and value rows (a value's longer text is its `title`) | `renderFactList` (rows `{label, value, title?, href?, lines?}`) |
| Dialog (every modal: Cite, Share, Stored, My datasets, the license, a confirmation, the figure export's warnings, the history's dialogs, agent approvals) | native `dialog.app-dialog` opened with `showModal()` > `.app-dialog-header` + `.app-dialog-body` (+ `.app-dialog-actions`); a dialog that brings its own card (the welcome, the community annotation dialogs) is `dialog.dialog-layer` over the whole screen holding it | `wireAppDialog` (`components/app-dialog.js`) — the only modal implementation: no overlay `div`, no `aria-modal`, no Tab trap of its own |

### Rules

- **Nested actions are quiet.** Controls get quieter the deeper they sit.
  A panel's, a dialog's or a floating card's own actions
  are `.btn` (`.btn-primary` for the one that commits); an action inside
  something smaller — a list item's row or details (history steps, saved
  states, My datasets, Stored data, Recently deleted, deleted fields,
  connections), a chat turn or tool row, an agent's activity line, an array's
  row in Data mapping, a suggestion card in Community annotation — is
  `.btn-quiet`, its one main action `.btn-quiet-primary`, one line each; a
  well-known action there (delete, rename, close, more) is an icon button. A
  row's menu of further actions is named in words ("More…") or drawn with
  `ICONS.more`, never a typed `⋯`. There is no third, link-like look: the
  analysis windows' inner actions (Copy genes, CSV, GMT, Recompute, Swap A
  and B, Score as signature, Reset to defaults, All / None / Invert, a gene
  set's Clear / Add set / Import / Export) and Community annotation's
  comment Edit / Delete, View merged, View full evidence and View all
  comments are `.btn-quiet` too. An underline marks only a link
  (`a`) or a link inside a sentence (History settings… in the History tip,
  the gene sample line); the list is held by
  `tests/nested-actions-quiet-contract.test.mjs`.
  `tests/nested-actions-quiet-contract.test.mjs` holds the modules of nested
  areas and fails on a pill or a filled button in them.
- **States.** Interactive state lives in ARIA (`aria-pressed`, `aria-checked`,
  `aria-expanded`, `aria-selected`, `disabled`) and CSS styles that attribute.
  Visibility is the `hidden` attribute, never an inline `display`. Inline
  styles are written only for geometry and for colors that are data
  (`StyleManager.setVariable`); `tests/sidebar-control-standard-contract.test.mjs`
  holds the allowlist.
- **One look per state.** Hover, focus, active and disabled come from the
  shared rule set: focus is the base `:focus-visible` ring (never `:focus`),
  disabled is `--control-disabled-opacity` with `cursor: not-allowed`.
- **Touch.** See "Rhythm and touch" below. A panel never lists its own
  controls in `layouts/_responsive.css`.
- **Tokens only.** Component CSS names colors, sizes, radii, shadows,
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
| `--type-label` | 12px | 13px | medium, secondary color | field labels, captions, view title chips |
| `--type-control` | 12px | 13px | regular | the text inside a field, option rows, switches, list rows |
| `--type-button` | 12px | 13px | medium | button text, compact buttons included |
| `--type-hint` | 11px | 12px | regular | help lines, empty states, status lines |
| `--type-readout` | 11px | 12px | regular, tabular figures | slider values, timings, counters |
| `--type-compact` | 10px | 11px | – | badges and counts only |

- The scale is flat on purpose: a title is one step above the one size
  everything else is set in, secondary text one step below, a badge one
  further. Hierarchy comes from weight and color, not size. A coarse pointer
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
  WebKit only (Safari still honors pinch zoom there); the reasoning is in
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
  extension never covers its neighbor's drawn box. Legend row icons are the
  one opt-out: rows are packed, so their extension is canceled.
- **Compact lists.** A list row (legend categories, shortcuts, kept views,
  keyframes, filters, dataset facts, disclosure headers) is at least
  `--control-list-row-height` (20px) tall on a mouse layout: one line of
  text with a little air. The interface is deliberately dense; a coarse
  pointer raises rows to `--control-row-min`.
- **Quiet edges.** A surface (panel, dialog, menu, card, tip) is drawn with
  `--border-default` and a soft `--shadow-*`; a box inside it with
  `--border-light` on a tinted fill; a field, button or switch with
  `--border-control`. `--border-strong` (ink) is kept for a selected or
  emphasized edge.
- **One shape language.** Surfaces (panels, cards, boxes, fields, chips,
  rows, menus, tooltips, dialogs) are square (`--radius-none`); small badges
  are `--radius-sm`; buttons, switches, pills and scrollbar thumbs are
  `--radius-full`. No other radius is used.
- **One scrollbar.** Every scroll area inside a panel or dialog (floating
  panel body, long legends, the keyframe list, community dialogs) takes the
  shared thin scrollbar at the end of `components/_controls.css`.
- **One dialog chrome.** Dialog headers, titles and close glyphs share one
  rule set in `components/_modals.css`.
- **Motion.** Color feedback uses `--transition-colors` (150ms); moving
  surfaces (sidebar, notifications, transport bar) use `--duration-normal`.
  Nothing transitions `all`, and `prefers-reduced-motion` stops every
  transition and animation (`base/_accessibility.css`). Motion drawn by
  script reads the same preference from `assets/js/utils/reduced-motion.js`:
  the camera path and the tour arrive without flying, fades complete at
  once, backdrop looks hold still, and the velocity overlay draws a still
  picture of the flow.

### Wording and numbers

- Labels, headings, buttons and options are **sentence case** in the source
  ("Session file", "Gene expression") and are displayed exactly as written.
- **One level of headings per panel.** A panel's summary names it; inside,
  each group of related controls has one `h3.section-title` of one to three
  words, and fields are labeled under it. Qualifiers and explanations go in
  the heading's (i) tip, not in the heading.
- **Every heading and every non-obvious control has an (i) tip** from the
  registry (`ui/components/info-tips.js`): what it does, when to use it and
  what it costs, how it interacts with neighboring settings, and one or more
  short text links to the documentation section that explains it.
  `tests/info-tips-contract.test.mjs` holds the registry, the pinned links and
  their resolution against the documentation source.
- Labels and headings **never end in a colon**.
- **A full stop ends a sentence, never a fragment** (one rule, everywhere a
  person reads words). A sentence (a subject and a verb, or an instruction:
  "Preview is off.", "Agents cannot connect on this page.", "Sign in
  first.") ends with a full stop wherever it stands: a status line, help, a
  notice, a tip, an empty state ("No keyframes saved yet."). A fragment ends
  with none: titles and headings (even when they read as a sentence, "The data
  could not be opened"), labels, buttons, menu and option items, chips, and
  *status words*, a few words naming a state ("Saved", "Connected", "Code
  not accepted", "Repository disconnected"). Several sentences each take
  their full stop; a status word followed by a sentence takes it after the
  sentence only.
- **US spelling** ("color", "neighbor", "gray", "normalize", "center",
  "catalog", "labeled") in every word a person or an agent reads, in the
  packages and the documentation too. Keys, identifiers and file names keep
  the spelling they were stored with.
- Data units are **cells**, not points; "point" is reserved for the rendered
  mark ("Point size").
- Numbers go through `assets/js/app/ui/components/display-format.js` and
  `assets/js/utils/format-units.js`: compact counts with upper-case suffixes
  (`15K`, `2.5M`, `4M`, never `4.0M`: `formatCompactCount`), a p-value to two
  significant figures (`formatPValue`), a spaced unit
  (`8.0 s`, `1.00 u/s`), an attached `×` (never the letter x). Exact
  counts are grouped (`1,234`), and a count with its noun agrees with it
  (`1 cell`, `1,234 cells`): `formatCount`, `formatCountOf` and `countNoun` in
  `assets/js/utils/format-units.js`, never a template like `${n} cells`
  (`tests/count-noun-agreement-contract.test.mjs`). A percent has its sign
  attached (`50%`, never `50 %`) and is `formatPercent` (a value, fixed
  decimals or significant figures) or `formatShare` (a part of a whole: whole
  from 10%, never 100% short of it, two significant figures below) of the same
  module, never a template like `${n}%` (`tests/percent-format-contract.test.mjs`). Placeholders and in-progress text end in
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
