# Cellucid App Layer

This directory contains the browser-side application layer (state + UI wiring) that sits on top of:
- `assets/js/data/` (data source + loaders)
- `assets/js/rendering/` (WebGL viewer)

Primary goals:
- DRY utilities and consistent patterns
- Clear module boundaries (state vs UI)
- No rendering performance regressions (typed arrays, no hot-path allocations)

## Directory Structure

```
app/
├── state/                  # State management (coordinator + managers)
│   ├── core/
│   │   ├── data-state.js    # DataState constructor + mixin wiring
│   │   ├── base-manager.js  # BaseManager (EventEmitter-based)
│   │   └── constants.js     # Shared state constants
│   ├── managers/            # Extracted DataState method mixins
│   │   └── field/           # Field methods split by concern (overlay/loading/etc.)
│   └── index.js             # Public state exports
│
├── ui/                      # UI wiring and modules
│   ├── core/
│   │   └── ui-coordinator.js # initUI implementation
│   ├── modules/              # Feature modules (dataset/highlight/session, etc.)
│   │   ├── dataset-connections.js # Local/remote/GitHub dataset connection UI
│   │   └── field-selector-deleted-fields.js # Deleted Fields panel (restore/confirm)
│   ├── components/           # Reusable UI components
│   ├── category-builder.js
│   └── utils.js              # UI helper re-exports
│
├── utils/                   # App-layer utilities (DRY)
│   ├── number-utils.js
│   ├── dom-utils.js
│   ├── debug.js
│   └── event-emitter.js
│
├── registries/              # Field registries (rename/delete/user-defined)
├── main.js                  # Application entry point
├── state-serializer.js      # Session persistence (save/load)
├── notification-center.js   # User-facing notifications
├── dockable-accordions.js   # Floating panels
├── sidebar-metrics.js
└── url-state.js
```

## Architecture Overview

### State Layer (`app/state/`)

`DataState` is the primary state coordinator used by the app and analysis layer.
Its method surface is organized into manager modules and mixed into `DataState`
at load time (see `app/state/core/data-state.js`). Field methods are further
split by concern under `app/state/managers/field/` and assembled by
`app/state/managers/field-manager.js`.

**Events:** `DataState` is an `EventEmitter`. UI/analysis subscribe via `state.on(eventName, handler)`.

Common state events:
- `visibility:changed` — filters/outlier visibility updated
- `field:changed` — field metadata changed (payload: `{ source, fieldIndex, changeType, detail }`)
- `highlight:changed` — highlight groups changed
- `page:changed` — highlight pages changed (add/remove/rename/switch)
- `dimension:changed` — active view dimension changed (payload: `level`)

**Performance-critical paths (benchmark before changing):**
- `computeGlobalVisibility()` (visibility recomputation, O(n × filters))
- `updateColorsContinuous()` / `updateColorsCategorical()` (color buffer updates, O(n))

### UI Layer (`app/ui/`)

`initUI()` is the main UI coordinator. Large UI features are extracted into
`app/ui/modules/` so the coordinator focuses on orchestration and shared glue.

### Utilities (`app/utils/`)

Cross-cutting helpers live in one place:
- `utils/number-utils.js`: finite-safe number helpers (canonical `isFiniteNumber` implementation)
- `utils/random-utils.js`: deterministic PRNG helpers (reproducible sampling/shuffles)
- `utils/dom-utils.js`: small DOM helpers (escape, create, listener cleanup)
- `utils/debug.js`: app-layer re-export of `assets/js/utils/debug.js`
- `analysis/shared/number-utils.js`: re-exports `isFiniteNumber` from `utils/number-utils.js` to keep one definition

## Debugging

Enable debug logging in the browser console:

```js
localStorage.setItem('CELLUCID_DEBUG', 'true');
// reload
```

Disable:

```js
localStorage.removeItem('CELLUCID_DEBUG');
```

## Verification

From the `cellucid/` repo root, run:

```bash
./scripts/verify-refactor.sh
```
