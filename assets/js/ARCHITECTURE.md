# `assets/js`: architecture map

Start here. This page names the layers, the words the code uses for each
concept, and where to change what. Folder maps (owns / entry points /
invariants / tests): `formats/README.md`, `formats/io/README.md`,
`data/README.md`, `data/anndata/README.md`, `data/sources/README.md`,
`rendering/README.md`, `utils/README.md`, `app/README.md`,
`app/state-serializer/README.md`, `app/ui/modules/figure-export/README.md`.

Long-form references live in the shared docs site,
`cellucid-python/docs/user_guide/web_app/p_developer_docs/`: 01 (codebase
map and entry points), 07 (rendering), 09 (data loading and caching), 19
(subsampling specification), **20 (the read path, step by step, with the
module that owns each step and its invariants)**.

## Decision records (why the code is the way it is)

What each subsystem does now, the dated decisions behind it, the numbers
measured per engine, what was tried and reverted, and the open items, in
`cellucid-python/docs/user_guide/web_app/p_developer_docs/`:

| Subsystem | Page |
| --- | --- |
| Decoders and codecs (WebAssembly, fflate, the measured probe, decode pool) | `21_decisions_decoders_and_codecs.md` |
| Link model and request planning (round trips, rate limits, kept parts) | `22_decisions_link_model_and_request_planning.md` |
| Partial reading (share-cost rule, block ladder, gene sample and top-up, kept indexes, progressive opening) | `23_decisions_partial_reading.md` |
| Graph edges at scale (forward adjacency, edges at a share, k-NN) | `24_decisions_graph_edges_at_scale.md` |
| Exports | `25_decisions_exports.md` |
| Served store and notebook widgets (Python, R) | `26_decisions_served_store_and_widgets.md` |
| Memory model | `27_decisions_memory_model.md` |
| Rendering layers (unread cells, zero grey, alpha layers, LOD) | `28_decisions_rendering_layers.md` |

Update the page in the same change as the code it describes. Pages 23–27
end with **Known issues (pre-commit)**: the defects, regressions and
unverified behaviour known at the last commit.

## Layers (as the tree stands)

```
L0  utils/  workers/                    pure helpers, no app knowledge, importable from any worker
L1  formats/                            containers and bytes: store model, HDF5, Zarr, ZIP, R, text, io/
L2  data/                               sources, reader worker + client, cells, memory, mappings
    data/anndata/                       the AnnData reader, views, transcoders, share planner
    data/sources/                       links, providers, sign-in, file identity
L3  rendering/                          WebGL2 viewer and point renderer
L4  app/                                state, UI, sessions, analysis, exports, community annotation
    analytics/, dev/                    loaded on demand only
```

An import goes from a higher layer to a lower one. There is no static import
cycle today (measured 2026-10-30). About 90 import edges go the wrong way:
22 formats → data, 14 data → app, 4 data → rendering, 14 rendering → app or
data, 31 app/state or app/analysis → app/ui; about 20 of them are new since
the last commit and are listed in
`cellucid-private/plans/audit-2026-10-28/tidiness-2026-10-30.md`. Do not add
another: pass a callback, or move the shared constant down a layer.

Generated files: `assets/workers/` holds worker bundles and
`cellucid-web-assets.json` the asset inventory, both written by
`scripts/generate-web-asset-inventory.mjs`; never edit them by hand, and
leave `assets/workers/` out of searches.

## Glossary: one word per concept

| Concept | Word in code | Notes |
| --- | --- | --- |
| The cells a dataset is open with | **open cells** (`cell-identity.js`) | Inside the app, per-cell arrays are in *subset positions* (`i`-th open cell); everything leaving the app names a cell by its *original position* (its `obs` row). Convert only through `createCellIdentity` (`toOriginal`, `fromOriginal`, `openValues`). |
| A subsample method and its parameters | **subsample spec** (`data/subsample.js`) | Methods `blocks`, `uniform`, `stratified`, `spatial`; defined by developer doc 19 and implemented identically in Python and R. |
| The request an opening sends the worker | **cell subset request** (checked by `requireCellSubsetRequest`, `cell-subset-policy.js`; the name `CellSubsetRequest` in comments has no typedef yet) | Modes `auto`, `all`, `subsample`, `kept`, `prefix`, `chunks` (`subsample-plan.js` header). |
| A fraction of the cells, as the owner and the cost rule speak of it | **share** | The UI says "Cells to open"; the cost rule: a share never costs more than a larger share or than every cell. Caution: `share` also names a fraction of the memory allowance (`RESIDENCY_SHARES`, "the `columnIndex` share") and a proportion (`countFromShare`). |
| The open cells a cell-major gene is read for | **gene sample** (`geneSampleOf`, `subsample-plan.js`; page side `app/state/managers/field/gene-sample.js`) | Grown on the page by the **top-up** (`DataState.topUpGeneSample`) and by **Genes read for** (Session › Open data, `ui/modules/gene-read-control.js`, `readGenesForMoreCells`). Unread cells are drawn faded (`rendering/read-cell-layer.js`). |
| The one order every "first m cells" uses | **priority order** (`data/cell-priority.js`, `subsample.js` `priorityOrder`) | `openOrder` is the order the open cells are held in (`cell-identity.js`); a priority-ordered file stores rows in priority order (`anndata/priority-layout.js`). `cellOrder` / `CellOrder` (`subsample-plan.js`) is a recipe (`{method, seed, blockSize}`), not a permutation. |
| Something stored in this browser across visits | **kept** (`transcode/space.js`, the Session panel says **Stored**) | Kept store (converted R/MatrixMarket store), kept parts (bytes of a remote file, `formats/io/kept-parts.js`), kept index (gene index, `anndata/kept-column-index.js`). Caution: `kept` also names the cells a subsample keeps (`cell-identity.js` `kept`: ascending original positions; `views/cell-subset.js` `cellSubsetView({kept})`: file rows in view order) and the recorded set of `{mode: 'kept'}`; read the context. |
| A file and the version of it | **identity** (`data/sources/identity.js`) | Only a versioned identity is kept across visits. |
| The measured connection to one file | **link** (`formats/io/link.js` `LinkMeter`) | *Round trip* (`latencyMs`, the shortest, used for shaping requests), *round trip under load* (`loadedLatencyMs` / `loadedRoundTripMs`, used for prices), *request cost under load* (`loadedRequestMs`), *bandwidth* (`bytesPerMs`). |
| One embedding a view shows | **representation** / **layout** (`layoutKey`) | `dimension-manager.js`. |
| Which stored arrays are plotted and read | **data mapping** (`data/data-mapping.js`) | |
| A Python or R program that opened the viewer | **viewer host**, over the **viewer channel** (`data/viewer-protocol.js`) | |

## Where to change X

| To change… | Start at | Then |
| --- | --- | --- |
| What a file or folder is recognised as | `data/input-formats.js` (mirror: `input_formats.json` in Python and R, digest-pinned) | `data/anndata/open.js`, `data/anndata/views/index.js`, `data/anndata/transcode/index.js` |
| How reads become requests (merging gaps, request size, concurrency) | `formats/io/byte-reader.js` (`planMergeGap`, `requestPieceBytes`) | `formats/io/link.js`, `formats/io/byte-source.js` (`REMOTE_POLICY`, `LOCAL_POLICY`) |
| The link model (round trip, bandwidth, protocol, stalls) | `formats/io/link.js` | `formats/io/hosts.js` (per host), `data/host-link-memory.js` (earlier visits) |
| Rate limits and retries of a host | `formats/io/hosts.js` (`createHostBook`: `admit`, `pace`, `budget`) | `formats/io/byte-source.js` (`isTransientFailure`, `retryWaitMs`) |
| How a read is priced (time of a gene, a share, an export) | `data/anndata/matrix-access.js` (`requestPriceOf`, each layout's `readCost`, `geneLayoutOf`) | `data/anndata/subsample-plan.js` (`geneTimeFit`, `geneIndexFit`), `formats/io/link.js` (`loadedRoundTripMs`, `roundTripBytesOf`: the one request-price-in-bytes rule) |
| The default block size of a `blocks` subsample | `data/anndata/subsample-plan.js` (`defaultBlockSize`, `blockRung`, `BLOCK_CHUNKS`) | `data/host-link-memory.js` |
| Which cells a subsample keeps | `data/subsample.js` (the specification) | `data/anndata/subsample-plan.js` (`resolveCellSubset`), Python `subsample.py`, R `subsample.R` / `src/subsample.c`, the shared subsample fixture |
| Auto-fit (how many cells fit this device) | `data/anndata/subsample-plan.js` (`autoFitCount`) | `data/memory-budget.js` (`CELL_WORKING_SET_BYTES`, `memoryAllowanceBytes`) |
| The gene sample and its top-up | `data/anndata/subsample-plan.js` (`geneSampleOf`, `GENE_READ_TARGET_MS`) | `data/anndata/reader.js` (`geneSampleOf`), `app/state/managers/field/gene-sample.js` (`topUpGeneSample`), `app/ui/modules/gene-read-control.js` (Genes read for, the one control that grows it; the legend's and analyses' lines link to it) |
| Reading a subsample's rows from the store | `data/anndata/views/cell-subset.js` (`gatheredArray`, `KeptPositions`) | `data/anndata/values.js` (`readRowsInStoreOrder`, `readInSourceOrder`), `data/anndata/decoded-chunks.js` |
| Gene indexes of cell-major matrices | `data/sparse-column-index.js` | `data/anndata/prefix-column-index.js` (segments over priority-ordered rows), `data/anndata/kept-column-index.js` (kept across visits), `data/column-store-placement.js` |
| Progressive opening (first view, growth) | `data/anndata/progressive-open.js` | `app/open-cells-resize.js`, `data/opening-cost.js` |
| Kept data (what is stored, versions, removal) | `data/anndata/transcode/space.js` (`KEPT_STORE_REVISION`, `KEPT_INDEX_REVISION`: raising one deletes every user's kept data of that kind) | `formats/io/kept-parts.js`, `data/anndata/kept-column-index.js`, `app/ui/modules/kept-stores-dialog.js` |
| Memory (budgets, what is counted, refusals) | `data/memory-budget.js` | `data/memory-census.js`, `app/page-memory.js`, `formats/io/decoded-budget.js` |
| Decoders (codec choice, WebAssembly, workers) | `formats/io/decode-pool.js` | `formats/io/decoder-choice.js`, `formats/io/wasm-codecs.js` (`scripts/build-wasm-codecs.mjs`), `formats/io/inflate.js` |
| A link provider | `data/sources/providers/<host>.js` | `data/sources/registry.js`, `data/sources/auth/` |
| The reader worker's API | `data/anndata-reader-worker.js` | `data/anndata-reader-client.js` (`AnnDataReaderClient`), `data/anndata/reader.js` (`AnnDataReader`) |
| How unread / zero / coloured cells are drawn | `rendering/alpha-visibility.js`, `rendering/read-cell-layer.js` | `rendering/high-perf-renderer.js`, `rendering/high-perf/read-cell-index.js` |
| Points, LOD, frame time | `rendering/high-perf-renderer.js` | `rendering/high-perf/`, `rendering/viewer.js` |
| Sessions | `app/session/session-serializer.js` | `app/state-serializer/README.md`, developer doc 10 |
| Python or R viewer, notebook widget | `data/viewer-protocol.js` (mirror: `viewer_protocol.json`) | `data/viewer-channel.js`, `data/viewer-host-source.js`, `app/viewer-host-*.js` |
| Analysis | `app/analysis/` | developer doc 11 |
| How a gene is chosen by name (search, Enter, an analysis's "colour by", gene sets), and what is said when none is | `app/utils/gene-lookup.js` (`rankGeneMatches`, `resolveTypedGene`, `resolveExactGene`, `describeUnavailableGene`) | `app/ui/modules/field-selector-gene-expression.js` (`selectGene`: a choice is work on the open cells and follows its gene across a gene list replaced, `DataState.locateVarField`), `app/ui/modules/field-interaction-owner.js` (`describeUnshownField`), `app/analysis/shared/gene-sets.js` (`resolveGenes`) |

## Rules that hold everywhere

- A share never costs more than a larger share or than every cell in what a
  person meets: time, download, memory, rendering and analysis work (the
  request count is a means, not a cost: decision 2026-10-30); the ideal is
  about s/n of every cell's cost.
- Open cells are exact: a subsample is the cells its spec names, never
  raised or rounded; a session restores the recorded cells.
- Memory that grows with the data is counted in `data/memory-budget.js`.
- No arbitrary size or count caps: only real platform limits.
- No feature state in URL parameters (sessions only; a link may name the
  cells to open).
- Kept-data revision guards digest module source and paths: moving or
  renaming a guarded module deletes users' kept data. Move files only through
  the staged plan.
- Wait on a signal only through `onAbort(signal, callback)` or
  `awaitWithSignal` (`utils/abort.js`), never `addEventListener('abort', …)`.
  An `abort` event fires once, when the signal aborts. A listener added after
  that never runs, so work handed a stopped signal would run to its end.
  `onAbort` calls back at once when the signal has already aborted, and
  returns a remover. Call the remover when the work settles, so a long-lived
  signal keeps nothing. Because the callback may run before `onAbort` returns,
  register it after what it undoes exists (the queue entry, the remover it
  uses). Work that starts with a stopped signal throws before doing anything
  (`throwIfAborted`). Enforced by `tests/abort-listener-contract.test.mjs`.
