# State Serializer (Session Bundle) — What Is Saved and Restored

This folder contains **small, feature-scoped helpers** used by Cellucid’s **Session Bundle** system (`cellucid/assets/js/app/session/`).

It is **not** the save/load orchestrator:
- The **orchestrator** is `cellucid/assets/js/app/session/session-serializer.js`
- Features persist state via small **contributors** under `cellucid/assets/js/app/session/contributors/`

Current constraints:
- Only the one current state document is accepted: session format 2, whose
  version is part of the file signature (`CELLUCID_SESSION/2\n`, see
  `session/bundle/format.js`). Any file without that signature is refused
  with `NOT_A_SESSION_FILE_MESSAGE`.
- The reader implements one exact current document shape and rejects every
  other shape; restoration is always all-or-nothing.
- Sessions are treated as **untrusted input** with exact profiles, bounds,
  an exact single-member gzip envelope (trailer size checked before one paced
  native inflate), and transactional rollback.
- Row indices restore only against a proven cell ordering; a bundle whose
  ordering cannot be proven is refused. See
  [Dataset Fingerprint (Cell-Order Identity)](#dataset-fingerprint-cell-order-identity).

---

## Big Picture

A `.cellucid-session` is a single-file container with a manifest + length-prefixed chunks:
- **Eager chunks** establish dependencies and UI-critical state first.
- **Lazy chunks** carry heavier arrays and run with responsive yielding.

Both classes belong to one awaited public operation. Success is emitted only
after the complete inventory applies, every participant commits, and the final
UI refresh succeeds. Any later failure rolls back earlier state.

---

## Explicit Session Loading

Ordinary user state is saved and restored through the **Save** and **Load**
buttons under Session file. Separately, an official catalog generation may explicitly advertise
one SHA-256-pinned seven-chunk `default.cellucid-session`; Cellucid applies that
bounded static view automatically after the scientific dataset is published.
Other startup/data-source paths are not probed.

Generic sessions always carry `cinematic/camera`, including an explicit empty
path. Playback remains stopped unless the saved Camera Path explicitly enables
Autoplay; enabled autoplay starts only after the complete transaction commits.
Rollback restores the exact prior keyframes, nonzero timeline position,
playing/paused/stopped state, and viewer camera.

---

## What Is Kept (Session Bundle Coverage)

This is the source-of-truth list of what the current session system persists.

### Core Visualization + UI (“first pixels + UI-ready”)

Scheduled eagerly:
- **Camera state** (position/orbit target/navigation mode, etc.)
  - Every view's own camera (live + each snapshot view) and whether cameras
    are linked; the focused view's camera is that view's, not stored twice
- **Representations**
  - The embedding reference the live view shows (`liveEmbedding`)
  - The embedding reference each snapshot view shows (`embedding`); a view’s
    dimension is its representation’s and is not stored separately
- **Views / multiview**
  - Layout mode (single/grid)
  - Active view id (which view is focused)
  - Live view hidden (if applicable)
  - Per view: embedding, camera, active field, filters, and centroid point
    and label toggles; a view's label and filter summary are derived and
    recomputed when it is rebuilt
- **Active coloring field selection**
  - Active obs field key (categorical/continuous)
  - Active var field key (gene expression)
  - Source (`obs` vs `var`)
  - Per-snapshot active field selections
- **Active filtering state**
  - “Modified-only” filters for obs + var fields
  - Per-snapshot filters (replayed per view during multiview restore)
- **Generic sidebar controls state**
  - Checkboxes/selects/ranges/text inputs (by DOM id), including the
    background and the app theme
  - Accordion open/closed state (by DOM id; visible summary copy is never an
    identity)
  - Pressed-button groups (by DOM id), recording which button is pressed —
    today this is the highlight toolbelt, so the **active selection tool**
    (Annotation based / KNN drag / Proximity drag / Lasso) is part of a session
- **Floating panels layout** (non-analysis)
  - Which accordion sections were floated
  - Their geometry + open/closed state
- **Figure Export settings** (`ui/figure-export`): the panel's own validated
  record (`exportSessionSettings()` / `importSessionSettings()`), applied in
  the presentation stage

### Filtering/Coloring “Overlays” (rename/delete/user-defined fields)

Saved + restored eagerly:
- **RenameRegistry**
  - Field display renames
  - Category label renames
- **DeleteRegistry**
  - Soft-deleted fields
  - Purged fields (confirmed, non-restorable)
- **User-defined fields metadata**
  - Field definitions, categories, provenance/operation metadata
  - Deleted/purged flags
  - Codes are NOT stored here (codes are separate chunks)

This answers: “Do I keep ALL renamed/deleted things in Filtering/Coloring?” → **Yes**.

### Highlights

Saved:
- **Eager**: highlight pages + group metadata **without** memberships
- **Lazy**: exactly one compact binary membership chunk per advertised group,
  in the smallest of five encodings (`session/codecs/cell-set.js`): sorted
  gaps, a bitset over all cells, runs, or — for a category group on a dataset
  observation field — a bitset over that category's cells or the whole
  category, checked on restore against the category's size and digest
- Groups record `fieldKey`/`categoryName`; positions are resolved on restore

Restored:
- Metadata precedes membership arrays.
- Terminal success waits for every membership and buffer refresh; a missing,
  reordered, or invalid chunk rejects and rolls back the complete operation.

### User-Defined Categorical Codes

Saved:
- One chunk per user-defined categorical field: `user-defined/codes/<fieldId>`,
  as raw codes, runs, or codes packed at 1, 2 or 4 bits, whichever is smallest
- **Eager** only for fields required to render the initial view (active coloring + snapshot actives)
- **Lazy** for everything else

Restored:
- Codes attach to the correct user-defined field by stable field id.
- If the restored field is currently active, colors/centroids refresh automatically.
- Exactly one codes chunk is required for every categorical overlay field.
  Priority and within-priority order must exactly match the target active-field
  dependency graph.

### Analysis

Saved (eager, typed JSON — `session/codecs/typed-json.js`, so result columns
are stored as their raw values):
- `analysis/windows`: open floating analysis windows (modeId, geometry,
  settings, result)
- `analysis/docked`: the sidebar analysis panel (`comparisonModule.exportSessionState()`:
  the open mode and every initialized mode's settings and result)

Restored in the presentation stage, after every state participant commits.
Per-cell gene values an analysis read are not stored; they are re-read from
the dataset.

---

## Chunk Inventory (What Goes Where)

These are the chunk IDs you will see inside a `.cellucid-session` file:

| Chunk id | Priority | Dataset dependent | Contains |
|---|---:|---:|---|
| `core/field-overlays` | eager | yes | rename/delete registries + user-defined field definitions (metadata only) |
| `cinematic/camera` | eager | yes | exact Camera Path, settings, and explicit empty state |
| `core/state` | eager | yes | UI controls + the live view's representation, filters and active field + the multiview graph (layout, link state, every view's camera and centroid toggles, each kept view's representation, filters and active field) |
| `ui/dockable-layout` | eager | no | floating non-analysis panels geometry + open/closed |
| `ui/figure-export` | eager | no | Figure Export settings record |
| `analysis/windows` | eager | yes | floating analysis windows: mode, geometry, settings, result (typed JSON) |
| `analysis/docked` | eager | yes | sidebar analysis panel: open mode, each mode's settings and result (typed JSON) |
| `highlights/meta` | eager | yes | highlight pages + group shells (no cellIndices) |
| `user-defined/codes/<fieldId>` | eager/lazy | yes | user-defined categorical codes (binary) |
| `highlights/cells/<groupId>` | lazy | yes | highlight group membership (binary cell set) |

The manifest also carries `requires` — every dataset observation field and
gene the views and highlights use — which is checked, naming every missing key,
before any chunk applies.

Dataset mismatch behavior:
- If the bundle’s dataset fingerprint does not match the currently loaded dataset:
  - the complete restore rejects and rolls back
  - no dataset-agnostic layout subset is salvaged

Every manifest chunk has exactly `id`, `contributorId`, `priority`, `kind`,
`codec`, `label`, `datasetDependent`, `storedBytes`, and
`uncompressedBytes`. Every generic singleton above is mandatory; dynamic
families are complete and ordered. Unknown, missing, duplicate, aliased,
reordered, or dishonestly described chunks are rejected before success.

The official published-default path is deliberately different. It accepts
exactly the seven static chunks other than `cinematic/camera`
(`PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE`), in that order, only after catalog
manifest and SHA-256 verification. It contains no cinematic data and is not
accepted by the generic Session file **Load**.

---

## Dataset Fingerprint (Cell-Order Identity)

Every chunk marked `Dataset dependent: yes` above stores **row indices**, not
cell identifiers. Those indices are only meaningful against one ordering of the
dataset, so the manifest fingerprint has to pin that ordering, not just the
dataset.

`datasetFingerprint` has exactly six fields. The route a dataset was opened
through is not one of them: the same dataset opened from another host restores
its sessions, and `cellOrder` proves the cells are in the same order.

| Field | Derived from | Shape |
|---|---|---|
| `datasetId` | `dataSourceManager.getCurrentIdentityId()` | string or `null` |
| `name` | `dataSourceManager.getCurrentMetadata().name` | string or `null`; used in messages, never compared |
| `cellCount` | `state.pointCount` | safe integer |
| `varCount` | source var fields in `state.varData.fields` (user-defined fields excluded) | safe integer |
| `cellOrder` | see below | `{ embedding, dimension, digest }` |
| `dataMapping` | `state.getDataMapping()` | a canonical DataMapping (`data/data-mapping.js`) |

`dataMapping` names the stored arrays the dataset is shown with: the embeddings
that are on (`embeddings.enabled`, any number of each dimension), the default
of each dimension (`embeddings.defaults`), the vector bindings, the neighbour
graph, gene names, expression matrix and latent space. It is resolved
once per load by `data/dataset-mapping.js` (from the AnnData candidate catalog
of the `.h5ad` or Zarr file opened in the browser, or of the object a Python
server serves) and changed in the
Session › Data mapping panel (`state/managers/mapping-manager.js`). The panel
changes only the embeddings (which are on, and each dimension's default); the
other groups are fixed for the session.

`cellOrder.embedding` names the layout the live view shows: an AnnData `obsm`
key with its 0-based columns. `cellOrder.dimension` is that layout's dimension, exactly 1, 2, or 3.
`cellOrder.digest` is 16 lowercase hex characters produced by
`digestCellOrder(state.positionsArray, dimension)` in
`cellucid/assets/js/app/session/session-context.js`. The digest is defined over
XYZ triples: the live positions hold only the embedding's own components per
cell, and the axes a 1D or 2D embedding does not have are folded in as zero
words, so the digest does not depend on the in-memory layout.

Why the coordinates:
- The scalars all survive a row permutation. Re-export a dataset at the
  same id from re-sorted input and every one of them is unchanged, while every
  stored row index now denotes a different cell.
- Observation and variable names are also invariant under a row permutation, so
  they cannot detect the change either.
- Positions are the only per-cell payload the viewer always holds in memory, and
  a re-ordered export permutes them.

Why the embedding travels with the digest:
- Every embedding is a separate payload, normalized on its own, so a digest is
  comparable only within one of them.
- A restore verifies the digest against the very layout the session names,
  loading it (pinned, without touching any view) whichever layout is on screen,
  so a session saved in 2D opens while 3D is shown.

Cost and memoization:
- 4.3 ms for the digest and 5.6 ms for the complete fingerprint on 842k cells
  (9.64 MiB of Float32 coordinates).
- Memoized in a `WeakMap` keyed by the coordinate array. That array is replaced,
  never rewritten, on every dataset and dimension change, so the per-contributor
  re-derivations during one capture cost 0.06 ms in total.

Restore is verify-then-apply (`verifySessionFingerprint()`): every check below
runs before any chunk touches state, and each refusal has its own message,
surfaced verbatim by the session controls:

| Cause | Where it is raised | What the user is told |
|---|---|---|
| A file without the format-2 signature | the signature, `bundle/reader.js` | `NOT_A_SESSION_FILE_MESSAGE` |
| The id or a count differs | `verifySessionFingerprint()` | it is a different dataset, with both saved and current cell/gene counts, or both identities, named |
| `dataMapping` differs in a group the viewer cannot change (graph, gene names, expression, latent space, vector fields), or turns on an embedding this dataset cannot show | `verifySessionFingerprint()` | the group or the embedding is named, by its embedding id or `obsm` key |
| `cellOrder.embedding` names no layout of this dataset | `verifySessionFingerprint()` | the embedding is named |
| `cellOrder.digest` differs, everything else matches | `verifySessionFingerprint()` | same name and counts, different cell order, so every saved selection would mark the wrong cells |
| A field or gene in `requires` is missing (checked under the session's mapping) | `describeMissingRequiredFields()` | every missing key is named |

A session whose embeddings differ from the open dataset's, but which the
dataset can show, is not refused: before any chunk restores a view, the
restore turns on the union of the session's and the dataset's enabled
embeddings, so every view the session names can be shown; at commit the
session's exact mapping (its enabled set and defaults) is applied, as a
participant of the restore transaction whose rollback restores the previous
mapping.

Attributing a refusal to the wrong cause is itself an integrity failure: telling
someone their data was re-ordered when the session only named another embedding
teaches them to distrust a sound dataset. Keep the causes separate when changing
this code.

The published-default path is not exempt. `restorePublishedDefaultState()`
shares `validateManifest()`, the same fingerprint verification and the same
`requires` check, so an
advertised `default.cellucid-session` must carry `cellOrder` and `dataMapping`,
and must have been captured in the generation's default data mapping.

---

## What This Folder (“state-serializer/”) Specifically Does

The **`core/state`** eager chunk uses these helper modules:
- `cellucid/assets/js/app/state-serializer/ui-controls.js`
  - Generic capture/restore of sidebar + floating panel inputs (by DOM id)
- `cellucid/assets/js/app/state-serializer/filters.js`
  - Modified-only filters snapshot/restore for obs + var fields
- `cellucid/assets/js/app/state-serializer/active-fields.js`
  - Active obs/var field selection snapshot/restore
- `cellucid/assets/js/app/state-serializer/multiview.js`
  - Restores multiview by replaying each kept view once on the live view and
    freezing it, then applying the live view's own state last

### `ui-controls.js` — Sidebar + Floating UI Controls

Captures and restores lightweight UI state using **DOM element IDs**:
- `input[id]`: checkbox, range, number, color, text/search
- `select[id]`: selected option
- `details.accordion-section`: open/closed state (by DOM id)
- `[data-state-serializer-pressed-group]`: the id of the group's one
  `aria-pressed="true"` button

#### Pressed-button groups

A toolbelt — several buttons of which exactly one is pressed — is a standing
choice, not a momentary action, so it is state. The highlight toolbelt is the
one in the interface today: it decides whether a drag on the canvas is an
annotation, a KNN expansion, a proximity brush, or a lasso, and switching it
publishes `setLassoEnabled`, `setProximityEnabled`, and `setKnnEnabled` to the
viewer. A session that did not carry it reopened in whatever tool the markup
starts in, and the user's next drag did something they had not asked for.

Marking the container is what puts it in the inventory; there is no list of
group ids in `ui-controls.js`, so a second toolbelt is carried the day its
markup lands. Two rules make a group well-formed, and both are enforced on
capture *and* on validation rather than assumed:

- every button in the group carries a stable nonempty DOM id, because the id of
  the pressed button is the saved value;
- exactly one button is `aria-pressed="true"`. None, several, or a value other
  than `"true"`/`"false"`/absent is refused rather than resolved to a guess.

`role="group"` alone is deliberately *not* the signal. `index.html` already uses
it for the field-action toolbars, whose buttons are momentary actions that also
carry ids, so recognizing groups by role would have inventoried controls that
have no value to save. The explicit marker is also what keeps the group visible
to `tests/session-preset-control-inventory-contract.test.mjs`, which reads the
static markup: a group recognized only by a runtime-set attribute would be
invisible there and would read as a preset carrying a key the markup lacks.

Restoration follows the same publication rule as every other control — the
pressed button is sent a `click`, and the group is re-read afterwards. Writing
`aria-pressed` directly would repaint the toolbelt and leave the viewer in the
previous tool, which is exactly the CEL-0129 failure in another shape. Pressed
groups are restored **last**, after every value control has settled, because a
tool switch reads the viewer's unified selection state.

#### How a restored control reaches the thing it controls

There is no registry mapping an id to a setter. A control is restored by
writing its DOM value and then **dispatching the event its owner listens for**
— `change` for checkboxes and selects, `input` for the rest. The owner's own
listener is what publishes the value to the viewer, to `DataState`, or to
wherever that control leads.

Two consequences bind anything that touches this path:

- **The owner's listener must already be attached when the restore runs.** A
  dispatch with no listener does nothing at all, silently: the panel shows the
  saved value and the thing it controls never hears about it. `main.js` restores
  the advertised dataset state part-way through its bootstrap, so every control
  in the inventory must be wired before that point. This was the CEL-0129
  defect: the four renderer controls (`#hp-shader-quality`, `#hp-lod-enabled`,
  `#hp-lod-force`, `#hp-frustum-culling`) were wired inline at the end of the
  bootstrap, and every restored renderer setting was dropped. They now belong to
  `cellucid/assets/js/app/ui/modules/render-controls.js`, which `initUI` builds
  first. Accordions are the one exception, and only because setting `open`
  needs no owner.
- **A control that refuses its restored value fails the whole restore.** After
  dispatching, the helper re-reads the control; an owner that rolled the value
  back on a rejected publication leaves a mismatch, which is raised and rolls
  the session back. Silence is never an outcome.

`#hp-antialias` is **neither captured nor restored** — the one member of
`DEVICE_PREFERENCE_CONTROL_IDS`. Its owner publishes to the viewer *and* to
`localStorage`: antialiasing is a live setting (`rendering/scene-msaa-target.js`)
whose stored preference describes the machine rather than the view.

Applying it was a defect, not a design. The owner persists on every `change`,
including the synthetic one a restore dispatches, so a session became the last
writer of a preference that describes the machine rather than the view. Every
sample publishes an advertised default state, so switching antialiasing off and
reloading re-applied the saved value and stored it, and the setting could never
stay off; a shared session did the same to whoever opened it.

The stored preference also has a third state, `auto`, which no session can
express: a checkbox records ticked or unticked, and `auto` is neither. See
`cellucid/assets/js/app/ui/core/antialias-preference.js`.

The app theme (`#theme-select`) is a session control like any other: its
`change` reaches the ThemeManager, which shows and stores the restored theme
exactly as a choice made by hand.

`restoreUIControls` also accepts `deferControlIds`, which moves the named
controls to the **end of the same restore call** and returns a function that
applies them. It orders controls against each other, not against the bootstrap;
`session/contributors/core-state.js` uses it so `render-mode` is replayed last,
after the snapshot graph is rebuilt. `withholdControlIds` names controls that
are validated and never applied (a smoke session on a device that cannot run
smoke: the mode is reported instead).

A subtree marked `data-state-serializer-after-embedding="true"` holds controls
whose *choices* follow the embedding the active view shows: the vector-field
block, where a field is bound to one embedding and the select lists different
fields, or none, per view layout. Those controls stay in the inventory, their
records are checked for shape with every other control, but their values are
checked against the interface and applied only by the returned function, which
`core-state.js` calls after the embeddings, the kept views and the active view
are back. Checked earlier, a session saved on one embedding was refused on a
page showing another (`Session UI select option "" is not available in current
control "velocity-field"`); applied earlier, the saved field was overwritten
when the embedding changed under it. `embeddingDependentControlIds()` lists
them.

Explicit exclusions:
- Any control whose id was minted on the page by `createDomId`
  (`ui/components/dom-id.js`, `isGeneratedDomId`) is ignored. Such an id is
  unique to that page, so a session that recorded it could never be loaded on
  another one; what the control shows is saved by the state that renders it.
  The continuous legend's range sliders (`minimum-1b`, …) are the case that
  made saved sessions unloadable.
- Any subtree marked with `data-state-serializer-skip="true"` is ignored.
  - Figure Export root is skipped in `cellucid/index.html`, and its controls
    subtree in `figure-export-ui.js`; the panel's settings are saved as one
    record instead (`ui/figure-export`)
  - Benchmark section is skipped in `cellucid/index.html`
  - Dataset selection + connection UI is skipped in `cellucid/index.html` (sample dataset picker, local/remote/GitHub connect controls)
  - Community Annotation section is skipped in `cellucid/index.html` (network/auth-driven; sessions do not persist votes/moderation/UI state)
  - Floating analysis windows and the docked analysis panels are skipped in
    `cellucid/assets/js/app/analysis/ui/`; they are saved by their own
    contributors (`analysis/windows`, `analysis/docked`)
- Some IDs are intentionally skipped by `DOMAIN_OWNED_IDS`, either because a
  feature owner restores them or because they are not a preference at all.
  This is the complete list; `tests/session-docs-current-contract.test.mjs`
  reads the set out of `ui-controls.js` and fails when an id is missing here:
  - Active field selectors: `categorical-field`, `continuous-field`, `gene-expression-search`
  - Outlier slider: `outlier-filter` (restored after active field is set)
  - Navigation mode: `navigation-mode` (restored by camera restore)
  - Representation picker: `view-representation-select` (what each view
    shows is restored by `core/state` as `liveEmbedding` and by the multiview
    descriptors as each snapshot's `embedding`; the picker redraws from the
    state)
  - Dataset/connection controls: `dataset-select`, `remote-server-url`, `data-link-url` (sessions assume the dataset is already loaded)
  - Pointer capture: `pointer-lock` is not restored by anything. It is not a
    preference — it mirrors the browser's live pointer-lock state, and
    `ui/modules/camera-controls.js` forces it unchecked on init and writes it
    from the `pointerlockchange` event. Restoring it would either lie about the
    pointer or grab it without a user gesture, and browsers refuse the latter.

### `filters.js` — Modified-Only Field Filters

Persists *only* filter state that differs from defaults to keep eager restore small.

Categorical fields:
- category visibility toggles (`_categoryVisible`), recorded as `categoryName`
- category color overrides (`_categoryColors`), recorded as `categoryName`
- filter enabled/disabled (`_categoryFilterEnabled`)
- colormap override (`_colormapId`)
- outlier enabled + threshold (`_outlierFilterEnabled`, `_outlierThreshold`);
  latent outlier quantiles exist only for categorical fields, so this is the
  only entry kind that carries them. Restore gets the quantiles a threshold
  below 100% needs (stored in the file, or computed with progress and Cancel,
  `state/managers/outlier-quantiles.js`); a threshold whose quantiles cannot
  be got is not applied, and a notification names it with the reason

Fields are recorded by `source:key` and categories by name, never by position.
A position in the obs/var inventory or in `field.categories` is not pinned by
the dataset fingerprint, which covers the cells and not the schema, so a dataset
exported again with one more column or one more category moves every position
after it. Restore resolves both from the names and refuses by name when a name
is gone; it never applies a saved change to whatever now sits at the old
position. The same rule owns field-owned highlight groups in
`session/contributors/highlights-meta.js` (`fieldKey`, `categoryName`).

Continuous fields:
- numeric filter range (`_continuousFilter`)
- color range (`_continuousColorRange`)
- filter enabled/disabled (`_filterEnabled`)
- log scale (`_useLogScale`)
- color-range follows filter (`_useFilterColorRange`)
- colormap override (`_colormapId`)

Restore behavior:
- preloads needed fields (`ensureFieldLoaded` / `ensureVarFieldLoaded`)
- clears every obs/var field back to its load-time defaults first, so a restore
  reproduces the saved state instead of merging onto whatever is on screen
- applies changes in a batch (`beginBatch/endBatch`) when available

### `active-fields.js` — Active Coloring Field (Obs/Var)

Persists:
- active obs field key
- active var field key
- active source (`obs` vs `var`)

Restore:
- ensures required field data is loaded
- updates UI selectors to match (without forcing unrelated resets)

### `multiview.js` — Snapshot View Restore (“Keep View”)

Session bundles intentionally do **not** store per-cell buffers (colors/transparency/etc).
Instead, `core-state.js` first requests every field, gene and embedding any
view names, together (the embeddings pinned until the views are built), and
`restoreMultiview()` then, for each kept view:
1) applies its filters (`restoreFilters` clears every field first, so each
   replay is a complete state and nothing is reset in between)
2) applies its active field and embedding
3) freezes the view via `state.getSnapshotPayload()` + `viewer.createSnapshotView(...)`
   and sets its centroid toggles

and finally applies the live view's own filters, active field, embedding,
centroid toggles and camera.

Per snapshot, this restores:
- per-view filters + active fields (drives coloring/filtering; the label and
  filter summary are recomputed from them)
- per-view outlier threshold
- per-view representation (its embedding reference)
- per-view camera state and centroid point/label toggles

Important details:
- Snapshot representation restoration uses `state.restoreViewEmbedding(viewId, ref)`, which resolves the saved reference to the layout the view shows; a view that shows its dimension's default follows it again.
- The live camera is verified with `cameraStatesHaveSamePose()` from
  `rendering/camera-state-contract.js`: exactly the half the navigation mode
  drives, never the derived half, whose `Math.sin`/`atan2`/`asin` bits differ
  between browser engines. Comparing it refused every Safari-saved session in
  Chrome and Firefox.
- A failed replay rolls the graph back to the live camera and camera lock the
  restore *found*, not to the saved camera it was replaying — that one may be
  exactly what just proved unreachable.

---

## What Is NOT Kept (Intentional Exclusions)

The session system does **not** persist:
- The antialiasing preference (a device capability)
- Per-cell gene values analyses read (re-read from the dataset)
- Benchmarking/performance test UI state
- Community Annotation state (votes, comments, moderation UI, GitHub sync/auth, drafts)
- The dataset itself (data files are not embedded; the session assumes the dataset is already loaded)
- Dataset selection / connection UI state (sample dataset picker, local/remote/GitHub connect inputs)
- DOM/WebGL/runtime objects (only declarative state is stored)
- Notifications
- In-progress interaction state (e.g., pointer lock active at the moment of save)

---

## Extension Rule

A new persisted feature changes the only current format. Define its exact
metadata/payload and owner transaction, encode empty replacement state, bound
stored/decoded work, avoid cloning cell-scale arrays, and add causal success,
late-failure, cancellation, supersession, rollback, ordering, and browser
coverage. Update every current producer, consumer, fixture, and reference
together; do not add a reader for an older shape.
