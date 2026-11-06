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
│   ├── actions/             # The actions the state alone implements (field-actions.js, README.md)
│   ├── domains/             # The owner of each state domain (capture, restore, describe) the
│   │                        #   history, sessions and agents read; the state fingerprint (README.md)
│   └── index.js             # Public state exports
├── ui/                      # UI wiring
│   ├── core/                # ui-coordinator.js (initUI), dom-cache, early classic-script bootstraps
│   ├── modules/             # Sidebar features (dataset connections, subsample control, Genes read for, legend,
│   │                        #   kept-stores dialog, my-datasets/ (My datasets and All…), highlight,
│   │                        #   figure-export/, benchmark/, state/ (the State panel: Share… and Load…,
│   │                        #   the branch graph, branches, trackers, tour, exports), …)
│   ├── components/          # Reusable controls
│   ├── onboarding/          # Welcome modal and keyboard shortcuts
│   ├── place-names.js       # Names of places in the UI used in sentences
│   └── utils.js             # One re-export of escapeHtml (removal listed in the reorganisation plan)
├── session/                 # .cellucid-session files (format 4, the history): session-serializer.js (save, load,
│                            #   starting views), history-file.js (the format), published-default.js (starting
│                            #   views), codecs/, bundle/, session-context.js (dataset fingerprint),
│                            #   cell-subset-record.js, view-carry.js (what a reading of other cells keeps)
│                            #   (README.md)
├── state-serializer/        # The control inventory: every stable sidebar control, its value, the domain
│                            #   that holds it (ui-controls.js, README.md)
├── actions/                 # The action catalogue, the state domains' list and the dispatcher: every change
│                            #   and read (README.md); definitions/ one pure module per area, targets/ names
│                            #   to the open dataset's objects
├── history/                 # The action history: trackers, value pool, undo/jumps/branches, the dataset's
│                            #   history (dataset-history.js), the autosave and saved states (autosave.js),
│                            #   settings, exports/ (README.md)
├── reads/                   # What an agent reads of the open dataset: summary, fields, cells, views,
│                            #   a picture of a view (README.md)
├── analysis/                # Analysis windows, compute workers, plots, statistics (developer doc 11);
│                            #   actions.js: the analyses as actions
├── exports/                 # cell-exports.js (cells and values out of the viewer)
├── library/                 # What this browser keeps of the person's own datasets (README.md):
│                            #   my-datasets.js (My datasets: the datasets opened here, how each opens
│                            #   again), local-file-handles.js (one-click reopen of a local file or folder)
├── viewer-host/             # Python and R viewer hosts: command-handler.js (their actions, dispatched as the host's,
│                            #   in the notebook's turn; a session file a host pushes, loaded),
│                            #   pointer-delivery.js (hover/click events), results.js (what the person
│                            #   made, published to the host), history-events.js (every change of the
│                            #   history, told to the host)
├── agent/                   # Agents operate Cellucid: instructions.js (what Claude, ChatGPT and the chat bar
│                            #   are told), bridge/ (this tab's end of the relay in /relay; README.md)
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
| Dataset publication and open cells | `dataset-reload-outcome.js`, `open-cells-resize.js` (Apply with another share, progressive growth), `cell-subset-carry.js` (highlights and user fields carried to other cells), `view-snapshot-publication.js`, `data-load-methods.js`, `graphics-reset-session.js` |
| Telling the person | `opening-progress-view.js`, `read-progress-notifications.js`, `matrix-share-notices.js`, `unplaced-cells-notice.js`, `source-sign-in-view.js`, `page-memory.js` (other tabs, hidden/frozen release, shortage notice) |
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
