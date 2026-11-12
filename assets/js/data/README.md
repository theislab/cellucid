# `data/`: sources, the reader worker, cells, memory, mappings

`data/` has 65 modules at its root. They are not grouped into folders yet
(the staged reorganization in
`cellucid-private/plans/audit-2026-10-28/code-organisation.md` §B, stage 3,
moves them; do not move files outside that plan: the kept-data revision
guards digest module paths). Until then, this table is the map. Subfolders:
`anndata/` (the AnnData reader, its views and transcoders: see
`anndata/README.md`) and `sources/` (links, providers, sign-in, file
identity: see `sources/README.md`).

The end-to-end read path (source → bytes → formats → reader → share planner
→ worker/client → page → renderer) is developer doc 20,
`cellucid-python/docs/user_guide/web_app/p_developer_docs/20_read_path_architecture.md`.

## Root modules by concept

| Concept | Modules |
| --- | --- |
| **What a file is** | `input-formats.js` (the one input-format registry; mirrored byte for byte as `input_formats.json` in Python and R; also Cellucid's own files, `CELLUCID_FILES`: a library file goes to My datasets' Import, a session file is refused saying where it goes), `matrix-market-files.js` (which lists go with which `.mtx`), `local-folder.js` (a picked folder's files) |
| **Data sources** (one class per way a dataset arrives) | `data-source.js` (interface), `data-source-manager.js` (registration, active dataset, switching), `local-demo-source.js` (sample catalog), `local-user-source.js` (a file or folder on this computer), `link-source.js` (any link), `remote-source.js` (a Cellucid server), `viewer-host-source.js` (a viewer Python or R opened), `anndata-file-source.js` (the source every format is read through), `served-anndata.js` (a server's served store), `whole-download.js` + `whole-read-notice.js` (hosts or formats that cannot be read in parts) |
| **Viewer host** (Python, R, notebooks) | `viewer-protocol.js` (messages; mirrored as `viewer_protocol.json`), `viewer-channel.js` (the WebSocket), `viewer-embed.js` (the notebook widget frame) |
| **Reader worker boundary** | `anndata-reader-worker.js` (runs `anndata/reader.js` over one opened store), `anndata-reader-client.js` (`AnnDataReaderClient`, the page's end), `anndata-provider.js`, `base-anndata-adapter.js` (the adapter base class: obs fields, launch defaults, connectivity), `data-loaders.js` (`anndata://` loading), `fetch-scheduler.js` (what the person looks at first; no field read twice at once), `gene-delivery.js` (genes straight to an analysis worker), `anndata-storage.js`, `anndata-cellucid-metadata.js` (`uns['cellucid']`), `anndata-value-kinds.js` |
| **Which cells are open** | `cell-identity.js` (open cells and how a cell is named across boundaries), `cell-priority.js` (the one priority order every "first m cells" uses), `subsample.js` (the subsampling specification: methods, ranks, `createSubsampleCache`), `cell-subset-policy.js` (the request every opening sends, checked by `requireCellSubsetRequest`), `open-cells-work.js` (work that holds the open cells, when they change in place), `cell-order-digest.js` (binds a session to its cells) |
| **Opening, progress, links** | `opening-progress.js` (one state every entry point reports into), `opening-cost.js` (measured page cost of a cell), `transfer-log.js` (Transfers log), `read-activity-log.js` (read activity log), `host-link-memory.js` (round trip and rate per host from earlier visits; seeds a link before it is measured), `byte-range-cache.js` (page side of `formats/io/range-cache.js`) |
| **Gene reads and column indexes** | `sparse-column-index.js` (the column index of a cell-major matrix, memory and disk stores; also exports `allocateTypedArray`), `column-store-placement.js` (where index stores live: memory budget and OPFS spill), `column-forms.js`, `gene-read-plan.js` (what a person is told before a cell-major gene read), `gene-names.js`, `continuous-values.js`, `continuous-payload-diagnosis.js`, `discovered-categories.js` (categories of text columns found in the worker), `categorical-storage-contract.js` |
| **Memory** | `memory-budget.js` (the one memory model: device, census, working set, ledger, refusals), `memory-census.js` (other Cellucid pages of this origin) |
| **Mappings and layouts** | `data-mapping.js` (which stored arrays are plotted and read), `data-mapping-candidates.js`, `dataset-mapping.js`, `representation-names.js`, `dimension-manager.js` (the layout registry), `embedding-payload.js` (coordinates made in the worker), `vector-field-manager.js` |
| **Derived data** | `connectivity-edges.js` (neighbor graph → forward adjacency), `connectivity-summary-contract.js`, `latent-outliers.js`, `latent-outliers-stream.js`, `outlier-quantile-source.js` |
| **Small contracts** | `metadata-load-contract.js`, `dataset-lifecycle-errors.js`, `palettes.js`, `distinct-colors.js` (the one rule for a color the app picks: told apart from the others) |

## Known wrong-way imports (do not add more)

`gene-read-plan.js` and `transfer-log.js` import `app/ui/place-names.js`;
`dimension-manager.js` and `vector-field-manager.js`
import `rendering/unplaced-positions.js`. They are listed in
`cellucid-private/plans/audit-2026-10-28/tidiness-2026-10-30.md` and
resolved by the reorganization (stage 1).

## Tests

Most test files are named after the module or concept
(`tests/subsample-*`, `tests/memory-budget-*`, `tests/data-mapping-*`,
`tests/viewer-protocol-*`, `tests/opening-progress-*`); find the rest with
`grep -l "data/<module>.js" tests/*.test.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/22_decisions_link_model_and_request_planning.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/23_decisions_partial_reading.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/24_decisions_graph_edges_at_scale.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/26_decisions_served_store_and_widgets.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/27_decisions_memory_model.md`. Update them in the same change as the code.
