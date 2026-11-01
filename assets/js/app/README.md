# Cellucid App Layer

The browser-side application (state, UI, sessions, analysis, exports) on top of:

- `assets/js/data/` (data sources, the reader worker and its client, cells, memory, mappings; `data/README.md`)
- `assets/js/formats/` (container readers and the byte layer; `formats/README.md`)
- `assets/js/rendering/` (WebGL viewer and point renderer; `rendering/README.md`)

The layers, glossary and "where to change X" index are in `assets/js/ARCHITECTURE.md`.

## Directory structure

```
app/
├── main.js                  # Entry point: bootstrap, dataset load and publication (≈5,700 lines;
│                            #   split by stage 5e of the reorganisation plan)
├── state/                   # DataState and its managers
│   ├── core/                # data-state.js (DataState + mixin wiring), base-manager.js, constants.js
│   ├── managers/            # Mixins: colours, filters, highlights, views, mappings, open cells,
│   │   │                    #   outliers, latent space, var axis, per-cell array ownership
│   │   └── field/           # Field methods by concern: loading, residency, summary, overlays,
│   │                        #   categories (category-growth, pending-categories, category-ops),
│   │                        #   gene-sample.js (gene sample and top-up on the page)
│   └── index.js             # Public state exports
├── ui/                      # UI wiring
│   ├── core/                # ui-coordinator.js (initUI), dom-cache, early classic-script bootstraps
│   ├── modules/             # Sidebar features (dataset connections, subsample control, Genes read for, legend,
│   │                        #   kept-stores dialog, highlight, figure-export/, benchmark/, …)
│   ├── components/          # Reusable controls
│   ├── onboarding/          # Welcome modal and keyboard shortcuts
│   ├── place-names.js       # Names of places in the UI used in sentences
│   └── utils.js             # One re-export of escapeHtml (removal listed in the reorganisation plan)
├── session/                 # .cellucid-session bundle (format 3): serializer, contributors/, codecs/,
│                            #   bundle/, session-context.js (dataset fingerprint), cell-subset-record.js
├── state-serializer/        # Per-concern capture/restore used by sessions (README.md)
├── analysis/                # Analysis windows, compute workers, plots, statistics (developer doc 11)
├── exports/                 # cell-exports.js (cells and values out of the viewer)
├── jobs/                    # Cancellable jobs and their status view
├── community-annotations/   # GitHub-backed community annotation (REPO_SETUP.md)
├── dockable-accordions/ + dockable-accordions.js + dockable-accordions-registry.js  # Floating panels
├── notification-center/ + notification-center.js  # Notifications
├── registries/              # Field registries (rename, delete, user-defined)
└── utils/                   # App-layer helpers (dom, events, cell sets, field registry, sha256,
                             #   opaque ids, page colours, state validator, gene lookup
                             #   (gene-lookup.js: which gene a name chooses, or why none), …)
```

Loose modules in `app/` by concern (stage 4a of the plan groups them into folders):

| Concern | Modules |
| --- | --- |
| Startup | `startup-phase.js`, `startup-url-intent.js`, `startup-failure.js`, `url-state.js`, `subsample-url.js` (a subsample in a link), `app-code.js`, `asset-url.js`, `optional-analytics.js`, `citation.js` |
| Dataset publication and open cells | `dataset-reload-outcome.js`, `open-cells-resize.js` (Apply with another share, progressive growth), `cell-subset-carry.js` (highlights and user fields carried to other cells), `view-snapshot-publication.js`, `data-load-methods.js`, `local-file-handles.js`, `graphics-reset-session.js`, `highlight-draft.js` |
| Telling the person | `opening-progress-view.js`, `read-progress-notifications.js`, `matrix-share-notices.js`, `unplaced-cells-notice.js`, `source-sign-in-view.js`, `page-memory.js` (other tabs, hidden/frozen release, shortage notice) |
| Viewer host (Python, R) | `viewer-host-command-handler.js`, `viewer-host-pointer-delivery.js`, `viewer-host-results.js` |
| Layout | `sidebar-metrics.js` |

## State layer (`app/state/`)

`DataState` is the state coordinator used by the app and the analysis layer.
Its methods are manager modules mixed into `DataState` at load time
(`state/core/data-state.js`); field methods are split by concern under
`state/managers/field/` and assembled by `state/managers/field-manager.js`.

**Events:** `DataState` is an `EventEmitter`; subscribe with `state.on(eventName, handler)`.

- `visibility:changed`: filters or outlier visibility updated
- `field:changed`: field metadata changed (payload `{ source, fieldIndex, changeType, detail }`)
- `highlight:changed`: highlight groups changed
- `page:changed`: highlight pages changed (add, remove, rename, switch)
- `view:representation-changed`: the representation a view shows changed, or focus moved to a view showing another one (payload `{viewId, layoutKey, dimension, previousLayoutKey}`)

**Performance-critical paths (benchmark before changing):**
`computeGlobalVisibility()` (O(n × filters)), `updateColorsContinuous()` /
`updateColorsCategorical()` (O(n) colour buffer updates).

## UI layer (`app/ui/`)

`initUI()` (`ui/core/ui-coordinator.js`) collects DOM references and starts
the modules in `ui/modules/`; it is about 850 lines of wiring, so new
features go into a module of their own, not into the coordinator.

## Utilities

Shared, layer-free helpers belong in `assets/js/utils/` (`utils/README.md`:
cancellation, errors, large arrays, radix order, formatting). `app/utils/`
holds helpers that know the app (DOM, events, field registry, cell sets).
`analysis/shared/number-utils.js` re-exports `isFiniteNumber` from
`app/utils/number-utils.js` beside its own statistics helpers.

## Debugging

```js
localStorage.setItem('CELLUCID_DEBUG', 'true');   // then reload
localStorage.removeItem('CELLUCID_DEBUG');        // to turn it off
```

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/23_decisions_partial_reading.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/25_decisions_exports.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/26_decisions_served_store_and_widgets.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/28_decisions_rendering_layers.md`. Update them in the same change as the code.
