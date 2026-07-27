# State Serializer (Session Bundle) — What Is Saved and Restored

This folder contains **small, feature-scoped helpers** used by Cellucid’s **Session Bundle** system (`cellucid/assets/js/app/session/`).

It is **not** the save/load orchestrator:
- The **orchestrator** is `cellucid/assets/js/app/session/session-serializer.js`
- Features persist state via small **contributors** under `cellucid/assets/js/app/session/contributors/`

Current constraints:
- Only the one current state document is accepted; incompatible documents are
  rejected and the document carries no version field.
- The reader implements one exact current document shape and rejects every
  other shape; restoration is always all-or-nothing.
- Sessions are treated as **untrusted input** with exact profiles, bounds,
  single-member gzip preflight, and transactional rollback.

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

Ordinary user state is saved and restored through **Save State** and **Load
State**. Separately, an official catalog generation may explicitly advertise
one SHA-256-pinned five-chunk `default.cellucid-session`; Cellucid applies that
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
  - Locked cameras: one global camera state
  - Unlocked cameras: per-view camera states (live + each snapshot view)
- **Dimension levels**
  - Live view dimension level
  - Each snapshot view’s dimension level (so each view returns to the correct embedding)
- **Views / multiview**
  - Layout mode (single/grid)
  - Active view id (which view is focused)
  - Live view hidden (if applicable)
  - Snapshot descriptors (label/meta) and the replay plan that rebuilds them
- **Active coloring field selection**
  - Active obs field key (categorical/continuous)
  - Active var field key (gene expression)
  - Source (`obs` vs `var`)
  - Per-snapshot active field selections
- **Active filtering state**
  - “Modified-only” filters for obs + var fields
  - Per-snapshot filters (replayed per view during multiview restore)
- **Generic sidebar controls state**
  - Checkboxes/selects/ranges/text inputs (by DOM id)
  - Accordion open/closed state (by summary label or DOM id)
- **Floating panels layout** (non-analysis)
  - Which accordion sections were floated
  - Their geometry + open/closed state

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
- **Lazy**: exactly one compact binary membership chunk per advertised group

Restored:
- Metadata precedes membership arrays.
- Terminal success waits for every membership and buffer refresh; a missing,
  reordered, or invalid chunk rejects and rolls back the complete operation.

### User-Defined Categorical Codes

Saved:
- One chunk per user-defined categorical field: `user-defined/codes/<fieldId>`
- **Eager** only for fields required to render the initial view (active coloring + snapshot actives)
- **Lazy** for everything else

Restored:
- Codes attach to the correct user-defined field by stable field id.
- If the restored field is currently active, colors/centroids refresh automatically.
- Exactly one codes chunk is required for every categorical overlay field.
  Priority and within-priority order must exactly match the target active-field
  dependency graph.

### Analysis Windows + Caches

Saved:
- **Eager**: open floating analysis windows (modeId + geometry + exportSettings)
- **Eager**: one `analysis/cache-inventory`, including an empty artifact list
- **Lazy**: DataLayer bulk-gene cache artifacts

Restored:
- Windows and the exact declared cache inventory commit together.
- Cache container ownership swaps without copying cell-scale arrays; in-flight
  writers are generation-isolated so they cannot contaminate the replacement.

---

## Chunk Inventory (What Goes Where)

These are the chunk IDs you will see inside a `.cellucid-session` file:

| Chunk id | Priority | Dataset dependent | Contains |
|---|---:|---:|---|
| `core/field-overlays` | eager | yes | rename/delete registries + user-defined field definitions (metadata only) |
| `core/state` | eager | yes | camera + UI controls + dimension + filters + active fields + multiview descriptors |
| `ui/dockable-layout` | eager | no | floating non-analysis panels geometry + open/closed |
| `analysis/windows` | eager | yes | open analysis windows descriptors (settings + geometry) |
| `highlights/meta` | eager | yes | highlight pages + group shells (no cellIndices) |
| `analysis/cache-inventory` | eager | yes | exact ordered analysis-artifact ids, including an empty list |
| `cinematic/camera` | eager | yes | exact Camera Path, settings, and explicit empty state |
| `user-defined/codes/<fieldId>` | eager/lazy | yes | user-defined categorical codes (binary) |
| `highlights/cells/<groupId>` | lazy | yes | highlight group membership indices (binary) |
| `analysis/artifacts/bulk-gene/<cacheKey>` | lazy | yes | one cache artifact named by the eager inventory |

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
exactly the first five static gzip/JSON chunks through `highlights/meta`, in
that order, only after catalog manifest and SHA-256 verification. It contains
no cinematic/cache data and is not accepted by generic **Load State**.

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
  - Restores multiview by replaying filters/active-fields per snapshot, then freezing each view

### `ui-controls.js` — Sidebar + Floating UI Controls

Captures and restores lightweight UI state using **DOM element IDs**:
- `input[id]`: checkbox, range, number, color, text/search
- `select[id]`: selected option
- `details.accordion-section`: open/closed state (by summary label or DOM id)

Explicit exclusions:
- Any subtree marked with `data-state-serializer-skip="true"` is ignored.
  - Figure Export root is skipped in `cellucid/index.html`
  - Figure Export controls subtree is also skipped in `cellucid/assets/js/app/ui/modules/figure-export/figure-export-ui.js`
  - Benchmark section is skipped in `cellucid/index.html`
  - Dataset selection + connection UI is skipped in `cellucid/index.html` (sample dataset picker, local/remote/GitHub connect controls)
  - Community Annotation section is skipped in `cellucid/index.html` (network/auth-driven; sessions do not persist votes/moderation/UI state)
  - Floating analysis windows are skipped in `cellucid/assets/js/app/analysis/ui/analysis-window-manager.js`
- Some IDs are intentionally skipped because domain logic restores them:
  - Active field selectors: `categorical-field`, `continuous-field`, `gene-expression-search`
  - Outlier slider: `outlier-filter` (restored after active field is set)
  - Navigation mode: `navigation-mode` (restored by camera restore)
  - Dimension select: `dimension-select` (restored explicitly to avoid async handler races)
  - Dataset/connection controls: `dataset-select`, `remote-server-url`, `github-repo-url` (sessions assume the dataset is already loaded)

### `filters.js` — Modified-Only Field Filters

Persists *only* filter state that differs from defaults to keep eager restore small.

Categorical fields:
- category visibility toggles (`_categoryVisible`)
- category color overrides (`_categoryColors`)
- filter enabled/disabled (`_categoryFilterEnabled`)
- colormap override (`_colormapId`)

Continuous fields:
- numeric filter range (`_continuousFilter`)
- color range (`_continuousColorRange`)
- filter enabled/disabled (`_filterEnabled`)
- log scale (`_useLogScale`)
- color-range follows filter (`_useFilterColorRange`)
- outlier enabled + threshold (`_outlierFilterEnabled`, `_outlierThreshold`)
- colormap override (`_colormapId`)

Restore behavior:
- preloads needed fields (`ensureFieldLoaded` / `ensureVarFieldLoaded`)
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
Instead, snapshot views are restored by:
1) Reset to a known base context
2) Replay saved per-view filters + active fields
3) Freeze the view via `state.getSnapshotPayload()` + `viewer.createSnapshotView(...)`

Per snapshot, this restores:
- view label/meta
- per-view filters + active fields (drives coloring/filtering)
- per-view outlier threshold
- per-view dimension level
- per-view camera state when cameras are unlocked

Important detail:
- Snapshot dimension restoration uses `state.setDimensionLevel(level, { viewId })` so each view renders the correct embedding.

---

## What Is NOT Kept (Intentional Exclusions)

The session system does **not** persist:
- Figure Export module UI state (inputs/modals/results)
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
