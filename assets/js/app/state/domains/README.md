# `app/state/domains/`: the owners of the state domains

**Owns:** one owner `{capture, restore, describe}` for each state domain of
`app/actions/domains.js` (one module per domain), installed once by `main.js`
(`installStateDomains`); the state fingerprint (`fingerprint.js`); the shared
rules every owner follows: cells by original position (`cell-positions.js`),
fields by name (`fields.js`), views by position (`view-list.js`), value
equality (`same-value.js`). Each per-view owner (`filters`, `visibility`,
`active-field`, `colors`, `camera`, `views`) gives `readPart`
(`view-list.js` `viewReadPart`): the entry of the view a step acted in, which
staleness compares (F156).

**Entry points:** `installStateDomains({state, viewer, sidebar, refreshUi,
cinematicCamera, figureExport, analysis, getDockable, openCells,
sidebarLayout})` (`index.js`, returns the uninstaller); `stateFingerprint(domains)`, `captureEveryDomain(domains)`,
`fingerprintOf(values)`, `differingDomains(a, b)` (`fingerprint.js`). The
history (`app/history/history.js`), the session file and the agents' reads use
the owners through the registry (`getStateDomains()` in `app/actions/index.js`).

| Domain | Module | Value (plain data, typed arrays immutable) |
| --- | --- | --- |
| `cells` | `cells.js` | `{open: null or the subsample's specification, genes: null or the cells genes were asked to be read for}` |
| `mapping` | `mapping.js` | the canonical DataMapping, or null with no dataset |
| `expression` | `expression.js` | `{normalize, log1p}`: the expression values asked (Data mapping › Expression values); both false by default and in a session without it |
| `field-overlays` | `field-overlays.js` | `{renamedFields, renamedCategories, deletedFields, userFields}`; user fields' codes and values as columns by original position |
| `gene-sets` | `gene-sets.js` | `{sets: [{name, description, genes}]}` (the notebook's sets) |
| `views` | `views.js` | `{layout, focus, liveHidden, camerasLinked, views: [{embedding, followsDefault, centroids}]}` |
| `active-field` | `active-field.js` | `{views: [field ref or null]}` |
| `filters` | `filters.js` | `{views: [[{field, off?, hidden?, limits?, missingHidden?, outlier?, outlierOff?, range?}]]}` (`limits`: filter by cell count) |
| `colors` | `colors.js` | `{views: [[{field, colors?, colormap?, range?, log?, rescale?, zeroGray?}]]}` |
| `visibility` | `visibility.js` | `{views: [Uint32Array of original positions hidden by hand]}` |
| `highlights` | `highlights.js` | `{active, pages: [{id, name, color, groups: [{id, type, label, enabled, cells, field?, category?, range?}]}]}` |
| `camera` | `camera.js` | `{views: [camera state]}` (navigation mode included) |
| `camera-path` | `camera-path.js` | the Camera Path's keyframes and playback settings, or null |
| `settings` | `settings.js` | `{controls: {id: record}, figureExport}` (the generic control inventory) |
| `analysis` | `analysis.js` | `{windows, docked}` (each analysis, its settings, how it is shown, its result; windows in the order they opened) |
| `layout` | `layout.js` | `{theme, sections, panels: [{id, rect}], analysis: {windows: [{rect, open}], sizes}, sidebar}` (every panel's and analysis window's place, the sizes remembered per analysis, the sidebar shown or hidden as chosen and its width; not which is in front, nor the phone sheet open or closed: page chrome is no step) |

Each module's header gives its value in full.

**Invariants:**
- Every piece of state a person can change belongs to exactly one domain. The
  generic control inventory is split between domains by one map
  (`state-serializer/ui-controls.js` `controlDomainOf`): the theme and the
  accordion sections are `layout`'s, the centroid toggles `views'` (they show
  the focused view's own flags), every other control `settings'`. The
  inventory is every stable `input`, `select` and section; a button group is
  never in it.
- Page chrome is in no domain (History v2 §3.3.8): the phone sheet open or
  closed (on the phone layout the sidebar's toggle, peek bar and H key open
  and close the sheet with no step, and `layout.sidebar.open` is the choice
  the sidebar's owner keeps, which the sheet does not change, so Undo inside
  the sheet never closes it), scroll and focus, which panel is in front, and
  input modes (the selection tool and Select mode, like a held Alt key).
- An analysis window is split between two domains, as every panel's content
  and place are: what it shows (its analysis, settings and result) is
  `analysis`'s, where it stands, its size and whether it is folded are
  `layout`'s (`layout.analysis.windows`, one place per window in window
  order), with the sizes remembered per analysis. So History settings ›
  "Panels, windows and theme" covers every window's geometry and never an
  analysis. Opening, copying or closing a window touches both; moving,
  resizing or folding one, and an expanded view's size, touch `layout` only.
  `analysis` restores first (a window it must open again keeps the place the
  window at its position had, else opens where a new one would), then
  `layout` puts every window at its place.
- A read makes no state. The `analysis` domain holds every mode the panel
  has made (a mode never made holds its opening settings and is left out), and
  the panel makes a mode on first use, so a read of a mode (`analysis.<mode>.get`,
  `analysis.result`, `analysis.cancel`, the run's estimate, the copy button's
  data check) goes through `ComparisonModule.readPanelUI`, which unmakes a mode
  it had to make; one analysis reading another's results uses
  `AnalysisUIManager.peekUI`, which never makes one. Otherwise a read would
  change the value with no step, and undo could not take it back.
- Values name things: a field by `{source, key}` with the key the dataset
  gave it (or `{source, user}` with a user field's id), so a rename changes
  `field-overlays` only; a category by its label; a view by its position
  (live first, then kept views in order), never a viewer id; cells by original
  position (`data/cell-identity.js`), so a value applies to whatever cells are
  open (cells not open are left out; columns give a newly open cell the missing
  marker).
- A value is never changed after capture. Arrays the app replaces rather than
  writes (highlight groups, user codes and values) are taken by reference and
  conversions are cached by the array and the open cells; the visibility mask,
  written in place, is copied and cached by its write count. Capturing an
  unchanged domain again returns the same arrays, whose content hashes the
  value pool caches by identity.
- A kept view's field objects are shallow copies of its source's
  (`managers/view-context-core.js` `_cloneFieldState`) and share the category
  list and its originals, the centroid tables and their records, category
  colors and visibility, codes and values. None of these is written in
  place: a change makes a new one (a rename, `renameCategory`; a relabel,
  `_syncCentroidCategoryLabels`), so restoring one view's fields never
  changes another's. A user field's copies share its one definition, which
  an edit replaces in the registry and in every copy at once.
- A value records only what differs from the dataset's opening state where
  opening fills defaults in lazily (filters, colors): opening a field changes
  no value. A color range is measured against the data, never the filter, so
  each change belongs to one domain.
- `restore(value)` puts the value back through the state methods the app's own
  controls use (never by dispatching actions), changes only what differs, and
  is idempotent: `restore(v)` then `capture()` gives `v` again. Per-view state
  of a view that is not focused is changed while that view is focused, and the
  focus is put back (`view-list.js` `inEachView`).
- A user field whose categories a `field-overlays` restore changes (a view's
  copy, or the registry's template, which a view may show as itself: a
  category deleted into "Unassigned") drops what belonged to the categories it
  had and carries its colors and hidden categories by label (`adoptDefinition`).
- A restore checks the whole value before it changes anything (`field-overlays`
  prepares every changed user field's arrays and checks its codes first;
  `camera` checks every camera), and owners whose state another owner may
  refuse to take check what they put back (`cells`, `views`, `camera`: a part
  that did not come back is named in the failure, and the history puts back
  what was shown).
- Comparison lines (`describe(a, b, {liveHidden})`) name a view as the Compare
  views list numbers it (`app/actions/targets/views.js`, the one owner of view
  names): the history passes whether the live view is hidden at `b`.
- After a session file, saved state or starting view is loaded, the person is
  told once per field which categories it holds for cells that are not open (a
  text or boolean column on a subsample: `pending-categories.js`
  `heldCategoriesOf`, said by `app/session/session-serializer.js`).
- Restores run in domain order: `cells` first (reading other cells makes the
  dataset's state again, so the history captures every domain again after
  it), then `mapping` (the arrays everything is read against), `expression`
  (the values its genes are shown in, before any view reads one), `views` before
  every per-view domain (the views a value names exist). A per-view value whose view count does not fit the views shown is
  refused, naming both counts.
- Async restores load what they need first (a field's values or categories, a
  gene once the gene list is read, the analysis code), as choosing it does.

**Records of before.** A value saved by an earlier version must still read:
the samples' starting views and every older session hold the records of the
day they were written. A key added to a domain's record is an *added key*
(`record-keys.js`): written only when it differs from the value its absence
means, filled with that value when read, so a record that does not use it is
the record of before, byte for byte (no hash changes, no step); a key a record
no longer holds is *dropped* (read and left out). Only a missing required key
or an unknown one is refused. Every domain's records are declared once in
`records.js` (required, optional, added and dropped keys, and the shape of
each nested record), and `installStateDomains` reads every value a domain
restores or describes through its declaration and writes what it captures as
before (`index.js` `readingRecords`); a record another module owns (the Camera
Path's own state, R9R-13; the settings, read one control at a time, F181; the
data mapping; a camera state's parts; the analyses' windows and modes) is that
module's to read. Test: `tests/state-record-added-keys.test.mjs` (every
domain reads every sample's published starting view, saved states written by
0.9.7 and during 0.9.8, and the history goldens; each starting view restores
its camera path).

**Tests:** `tests/state-domains-contract.test.mjs` (every domain owned, value
shapes, cells, equality, describe lines, fingerprint), and
`tests/browser/state-domains-roundtrip.spec.mjs` (each domain changed through
the interface, captured, changed again, restored: value, visible state and
fingerprint back; across live and kept views, after a data-mapping change, on a
subsample); `tests/kept-view-category-ownership.test.mjs` and
`tests/browser/kept-view-category-ownership.spec.mjs` (category changes with a
kept view, undone and redone, step by step, in one jump and through a rollback).
