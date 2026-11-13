# `app/state-serializer/`: the control inventory

**Owns:** `ui-controls.js`, the one inventory of the sidebar's and the floating panels' stable
controls, read from the markup: what each control's value is, how it is put back, and which state
domain holds it. The session file is `app/session/` (`README.md` there); what each state domain
holds is `app/state/domains/README.md`.

**Entry points:** `createUiControlSerializer({sidebar, domains})` (`collectUIControls`,
`restoreUIControls`, `validateUIControls`, `embeddingDependentControlIds`, and for settings
`listSettings`, `readSetting`, `setSetting`, `settingKeyOf`); `controlDomainOf(key, type)`;
`SETTING_CONTROL_DOMAINS`; `isApplyingControls()`.

## The inventory

Lightweight UI state, by **DOM element id**:
- `input[id]`: checkbox, range, number, color, text/search
- `select[id]`: selected option
- `details.accordion-section`: open/closed state (key `accordion:<id>`)

A control added to the markup is in the inventory with no code here.

## Which domain holds each control

`controlDomainOf(key, type)` is the one map that splits the inventory between the state domains
(`app/actions/domains.js`): the accordion sections and the theme (`#theme-select`) are the
`layout` domain's; the centroid toggles (`#toggle-centroid-points`, `#toggle-centroid-labels`)
show the focused view's own flags, which the `views` domain holds view by view; every other
control is a setting (the `settings` domain). `createUiControlSerializer({sidebar, domains})`
keeps the controls those domains hold: the `settings` and `layout` domains each take their part
(`app/state/domains/settings.js`, `layout.js`), and the settings actions every control
`setting.set` sets (`SETTING_CONTROL_DOMAINS`: all but the layout's, which the layout actions
change; `ui/modules/settings-actions.js`). So a settings value never changes when a panel opens or
another view is focused.

`listSettings()`, `readSetting(id)` and `setSetting(id, value)` are what `setting.set` and
`settings.list` use: each setting's label, section, kind, range or choices are read from the
markup. `setSetting` refuses a value in the control's words (outside its range, between steps, not
one of its choices, a control another setting has switched off) and goes through the restore path
below. `isApplyingControls()` is true while a restore or `setSetting` dispatches a control's
event: a change heard then is the app putting a value back, never a person's, and is not recorded.

## Page chrome: kept in sessions, outside the history

The selection tool (Annotation, KNN drag, Proximity drag, Lasso: `#highlight-mode`) decides what
the next drag on the canvas does, so a session reopened in another tool would do something the
person did not ask for. It is **page chrome kept outside the history**: no setting, no
domain, never a step, never moved by undo or a jump, yet kept by a save and the autosave. A group
of buttons marked `data-state-serializer-pressed-group`, exactly one of them `aria-pressed="true"`,
is one such control: `capturePageChrome()` gives `{pressed: {[groupId]: buttonId}}`, and
`planPageChrome(chrome)` checks the record whole (each id by `utils/stable-id.js`, the rule the
session reader checks too), leaves out a group or a button the page lacks and says so (`notes`), and
its `apply()` clicks each button as a person would (its owner's listener tells the viewer); a load
takes the plan before the history is replaced and applies it once the head is shown
(`applyPageChrome` does both at once). The session file's manifest and each saved state carry it as `chrome`; a load or Continue
applies it after the head is shown. Select mode, like the phone sheet open or closed, is not kept at all. A button group is never in the settings inventory: a control that is
state is an `input`, a `select` or a section.

## How a restored control reaches the thing it controls

There is no registry mapping an id to a setter. A control is restored by writing its DOM value and
then **dispatching the event its owner listens for** (`change` for checkboxes and selects; `input`
then `change` for the rest, as a person's drag ends with its release: an owner may follow `input`
on the next frame and apply only on `change`, as the vector field's Particle density does). The
owner's own listener publishes the value to the viewer, to `DataState`, or to wherever that
control leads.

- **The owner's listener must already be attached when a restore runs.** A dispatch with no
  listener does nothing, silently. Every control in the inventory is wired by `initUI` before the
  dataset's starting view is put back (the renderer controls,
  `ui/modules/render-controls.js`, included). Accordions are the one exception:
  setting `open` needs no owner.
- **A control that refuses its restored value fails the restore.** After dispatching, the control
  is re-read; an owner that rolled the value back leaves a mismatch, which is raised (the history
  then puts back what was shown). Silence is never an outcome.

`restoreUIControls` restores in a fixed order (accordions, checkboxes, selects, ranges, numbers,
colors, texts). `deferControlIds` moves named controls to the end and returns the
function that applies them; `withholdControlIds` names controls validated and never applied (Smoke
on a device that cannot draw it: the mode is reported instead, `state/domains/settings.js`).

A subtree marked `data-state-serializer-after-embedding="true"` holds controls whose *choices*
follow the embedding the active view shows (the vector-field block, where a field is bound to one
embedding): their records are checked for shape with every other control, but their values are
checked and applied only by the returned function, after the embeddings and the active view are
back. The `views` domain is restored before `settings` (domain order), so a settings restore
applies them in the same call. `embeddingDependentControlIds()` lists them. The returned function
restores selects before checkboxes (the choice, then the switch that shows it): `Show overlay`
switched on before `Vector field` holds its choice would show the field the page had.

A slider marked `data-session-preference` saves a **preference its owner keeps**, not the value it
shows. `#connectivity-limit` (Max edges) is the one in the interface today: its range follows the
visible edges of the graph, which is read only when edges are switched on. The owner writes the
preference into the attribute whenever it changes (`setUserEdgeLimit` in `ui/modules/connectivity-controls.js`); capture saves
the attribute; validation checks the record in full (a positive whole number a person can choose);
restore writes the attribute and dispatches `session-preference`, and the owner shows what the
graph allows of it once the graph is read. An owner that does not take the preference fails the
restore, as for every other control.

## What is not in the inventory

- `#hp-antialias`, the one member of `DEVICE_PREFERENCE_CONTROL_IDS`: a device capability its
  owner keeps in `localStorage` (with a third state, `auto`, no checkbox can express;
  `ui/core/antialias-preference.js`). A restore that set it made a shared state the last writer of
  a preference that describes the machine.
- Any control whose id was minted on the page by `createDomId` (`ui/components/dom-id.js`,
  `isGeneratedDomId`: the id holds `--`, the separator only a minted id, or one made from it, holds),
  never a hand-written id: such an id names nothing on another page; what the control shows is held by
  the state that renders it (the continuous legend's range sliders: the `filters` and `colors`
  domains).
- Any subtree marked `data-state-serializer-skip="true"`: the Figure export root (its settings are
  one record of the `settings` domain, `exportSessionSettings`), the benchmark section, dataset
  selection and connection, community annotation, the State section, the Camera path (the
  `camera-path` domain), the floating analysis windows and the docked analysis panels (the
  `analysis` domain). The marker keeps the controls inside a section out, not the section itself:
  every sidebar section's open state (`accordion:<id>`) and where it floats are the `layout`
  domain's, the State, Camera path, Figure export, Community annotation and Benchmark sections
  included.
- The ids of `DOMAIN_OWNED_IDS`, whose state another domain's owner reads from the state it
  shows, or which are not a preference at all. This is the complete list
  (`tests/session-ui-controls-exact-contract.test.mjs` holds that capture omits every id of the
  set):
  - Active field selectors: `categorical-field`, `continuous-field`, `gene-expression-search`
    (the `active-field` domain)
  - Outlier slider: `outlier-filter` (the `filters` domain)
  - Navigation mode: `navigation-mode` (the `camera` domain)
  - Representation picker: `view-representation-select` (the `views` domain: what each view shows)
  - View layout: `view-layout-mode` (the `views` domain; the layout mode is the viewer's,
    `getViewLayout()`, and the selector only shows it; `view.layout.set` changes it)
  - Dataset and connection controls: `dataset-select`, `data-address` (a state assumes its dataset
    is loaded)
  - Pointer capture: `pointer-lock` is put back by nothing. It mirrors the browser's live
    pointer-lock state (`ui/modules/camera-controls.js` forces it unchecked on init and writes it
    from the pointer-lock state the viewer publishes); restoring it would either lie about the pointer or grab it without
    a user gesture, which browsers refuse.

**Tests:** `tests/session-ui-controls-exact-contract.test.mjs`,
`tests/session-ui-control-dispatch-guard-contract.test.mjs`,
`tests/antialias-setting-contract.test.mjs`,
`tests/session-preset-control-inventory-contract.test.mjs`, `tests/state-domains-contract.test.mjs`
(the one map), `tests/actions-settings-layout-analysis.test.mjs`.
