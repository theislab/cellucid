# State Serializer (Session Bundle) — What Is Saved and Restored

This folder contains **small, feature-scoped helpers** used by Cellucid’s **Session Bundle** system (`cellucid/assets/js/app/session/`).

It is **not** the save/load implementation by itself anymore:
- The **orchestrator** is `cellucid/assets/js/app/session/session-serializer.js`
- Features persist state via small **contributors** under `cellucid/assets/js/app/session/contributors/`

Dev-phase constraints:
- No backward compatibility, no migrations, no version fields.
- Remove old snapshot save/load code paths.
- Sessions are treated as **untrusted input** (bounds checks + size guards).

---

## Big Picture

A `.cellucid-session` is a single-file container with a manifest + length-prefixed chunks:
- **Eager chunks**: restore “first pixels + UI-ready” quickly.
- **Lazy chunks**: restore heavy artifacts in the background with NotificationCenter progress + cancel.

The intent is:
1) You see the correct view immediately (camera + layout + active field + filters),
2) Then heavier artifacts converge in the background (highlights memberships, user-defined codes, analysis caches).

---

## Auto-Load on Startup (Dataset Base URL)

How it works:
- On startup, `cellucid/assets/js/app/main.js` calls `sessionSerializer.restoreLatestFromDatasetExports()`.
- The SessionSerializer reads `state-snapshots.json` from the **current dataset base URL** (the same folder that contains `obs_manifest.json`, `points_3d.bin.gz`, etc.).
- It filters for entries whose **filename ends with** `.cellucid-session` (case-insensitive, query/hash ignored) and loads the **last** entry.
- It resolves bundle URLs relative to the fetched manifest URL (`Response.url`) so redirects and absolute/relative entries work the same.

Expected files (example for the `suo` demo dataset, assuming an exports base like `https://theislab.github.io/cellucid-datasets/exports/`):
- `https://theislab.github.io/cellucid-datasets/exports/suo/state-snapshots.json`
- `https://theislab.github.io/cellucid-datasets/exports/suo/cellucid-session-YYYY-MM-DDTHH-MM-SS.cellucid-session`

Supported `state-snapshots.json` shapes (dev-phase):
- `{ "states": ["file.cellucid-session", ...] }` (recommended)
- `["file.cellucid-session", ...]` (also accepted)

### Troubleshooting (when auto-load “does nothing”)

If nothing happens and you see no notifications:
- Open DevTools → Console:
  - The loader logs when `state-snapshots.json` can’t be fetched/parsed or contains no `.cellucid-session` entries.
  - If you see `[Main] No session bundle auto-loaded…`, the manifest was missing/empty or had no matching `.cellucid-session` entries.
  - If you see `Invalid chunk length … (session file truncated?)`, the `.cellucid-session` response was incomplete or corrupted.
- Open DevTools → Network:
  - Verify `.../state-snapshots.json` returns **real JSON** (not an HTML SPA fallback page).
  - Verify the resolved `.cellucid-session` URL returns `200` and the response body is not empty.
  - Check response headers for `Content-Encoding`: if your host compresses `.cellucid-session`, `Content-Length` can be unreliable for bounds checks in browsers (fixed in recent builds by treating it as a hint only).

---

## What Is Kept (Session Bundle Coverage)

This is the source-of-truth list of what the current session system persists.

### Core Visualization + UI (“first pixels + UI-ready”)

Saved + restored eagerly:
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
- **Eager**: highlight pages + group metadata **without** memberships (so the UI structure appears immediately)
- **Lazy**: highlight group memberships (cell index sets) as compact binary chunks

Restored:
- Pages/groups appear immediately.
- Memberships fill in progressively; highlight buffers recompute in a throttled way.

### User-Defined Categorical Codes

Saved:
- One chunk per user-defined categorical field: `user-defined/codes/<fieldId>`
- **Eager** only for fields required to render the initial view (active coloring + snapshot actives)
- **Lazy** for everything else

Restored:
- Codes attach to the correct user-defined field by stable field id.
- If the restored field is currently active, colors/centroids refresh automatically.

### Analysis Windows + Caches

Saved:
- **Eager**: open floating analysis windows (modeId + geometry + exportSettings)
- **Lazy**: analysis caches/artifacts (dev-phase: DataLayer bulk gene cache)

Restored:
- Windows reopen quickly (settings only; results excluded).
- Caches stream in later and accelerate subsequent analysis operations.

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
| `user-defined/codes/<fieldId>` | eager/lazy | yes | user-defined categorical codes (binary) |
| `highlights/cells/<groupId>` | lazy | yes | highlight group membership indices (binary) |
| `analysis/artifacts/*` | lazy | yes | analysis caches/artifacts (binary) |

Dataset mismatch behavior:
- If the bundle’s dataset fingerprint does not match the currently loaded dataset:
  - dataset-dependent chunks are skipped (highlights, codes, caches, core state)
  - dataset-agnostic layout (floating panels) can still restore

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

## Recommended Additions (If You Want More Value)

High-value candidates that are currently NOT guaranteed to be serialized (unless already represented as sidebar controls with ids):
- Selection/brush tool state (mode, operator, last selection scope) for true “continue where I left off”

Rule of thumb:
- Put small, UI-critical things in the eager `core/state` chunk.
- Put potentially large/slow things in a dedicated lazy contributor chunk.
