# `data/anndata/`: the AnnData reader, its views, transcoders and the share planner

Every dataset is read as AnnData by one class, `AnnDataReader` (`reader.js`),
in the reader worker (`../anndata-reader-worker.js`), over the store model
of `formats/store.js`. Formats that are not AnnData on disk are presented as
AnnData: by a **view** when the container allows random access (HDF5, Zarr),
by a **transcoder** when the file is one stream (R objects, MatrixMarket).
The step-by-step read path is developer doc 20
(`cellucid-python/docs/user_guide/web_app/p_developer_docs/20_read_path_architecture.md`).

## Opening

| Module | Owns |
| --- | --- |
| `open.js` | `openDatasetStore()`: the one entry from a source to a store root, whatever the file arrived as (view, transcoder, older layout). |
| `views/` | Layout views by input-format id (`views/index.js`): `loom.js`, `tenx-h5.js`, `tenx-outs.js`, `mudata.js`, `modalities.js` (several feature spaces on the same cells), `h5seurat.js` and `refusal.js` (recognised, refused with what to do), `view-nodes.js` (the node wrappers), and `cell-subset.js` (a subsample presented as a smaller AnnData; see below). |
| `transcode/` | One pass over a stream into an AnnData Zarr store in the origin-private file system: `r-object.js` (+ `seurat.js`, `sce.js`, `r-matrices.js`, `r-values.js`), `matrix-market.js`, `tables.js`, `entries.js`, `zarr-writer.js`, `priority.js`, `session.js` (one transcoding, reused across tabs and visits), `space.js` (**kept-store storage for the whole stack**: OPFS directories, manifests, locks, quota, `KEPT_STORE_REVISION` / `KEPT_INDEX_REVISION`), `kept-store.js`, `anndata-model.js`, `refusals.js`. |
| `older-layouts.js` | Files written before anndata 0.8, presented in the current layout. |
| `elements.js`, `dataframe.js`, `sparse.js`, `values.js` | The element rules and readers of dataframes, sparse groups and arrays (`readRowsInStoreOrder`, `readInSourceOrder`, exact integers). |

## Which cells are open (the share planner)

| Module | Owns |
| --- | --- |
| `subsample-plan.js` | Resolves a cell subset request (`resolveCellSubset`) on the worker before anything is read: auto-fit (`autoFitCount`), the default `blocks` size (`defaultBlockSize`, `blockRung`), the gene sample (`geneSampleOf`, `geneTimeFit`, `geneIndexFit`, `GENE_READ_TARGET_MS`), progressive steps (`prefix`, `chunks`). Its header lists every request mode. |
| `progressive-open.js` | A first view smaller than the cells asked for, grown in place (`app/open-cells-resize.js`). |
| `priority-layout.js` | Files whose rows are stored in priority order (what `prepare()` and `cellucid_prepare()` write): a share is their first rows. |
| `views/cell-subset.js` | The subsample as a view of `k` rows: `gatheredArray` (row runs read as boxes in source order, in waves), `KeptPositions`, `CellRows`, CSR row pointers of kept rows only. Invariants at its header: bit-identical to reading the original and taking rows; no chunk without a kept row is fetched; at most two slabs of decoded boxes held. |
| `decoded-chunks.js` | Whole decoded chunks kept for later reads of other kept rows. |

## Matrices, genes and graphs

| Module | Owns |
| --- | --- |
| `matrix-access.js` | Gene columns and cell rows by layout (CSC, dense strips, CSR / dense across genes via the column index), cell-subset reads by the cheaper of rows or columns, read prices (`requestPriceOf`, each layout's `readCost`), `geneLayoutOf`, `columnIndexResidentBytes`. |
| `prefix-column-index.js` | Gene columns of a priority-ordered cell-major matrix, indexed in segments of rows. |
| `kept-column-index.js` | Gene indexes kept in this browser across visits. |
| `subset-entries.js` | Keeping a CSC gene's entries that fall in a cell subset. |
| `graph-lines.js` | Neighbour graphs (`obsp`) read line by line; the induced subgraph of open cells. |
| `reader.js` | `AnnDataReader`: open, fields, genes, embeddings, graphs, category codings, gene-sample reads, exports' row reads. About 5,900 lines; the split is stage 5c of the reorganisation plan. |

## Invariants

- One reader for every format: a format-specific path is a view or a
  transcoder, never a branch in `reader.js`.
- A share never costs more than a larger share or every cell in what a person
  meets (time, download, memory, rendering and analysis work; the request
  count is a means, not a cost); prices use the link's round trip under load.
  Decisions and measurements: developer doc 23 (partial reading).
- Open cells are exact (the cells the request names); values read for a
  share are bit-identical to the same rows of a whole read.
- Memory that grows with cells or values is counted (`../memory-budget.js`).
- Raising `KEPT_STORE_REVISION` or `KEPT_INDEX_REVISION` deletes every user's
  kept data of that kind; the guards digest source and module paths, so do not
  move guarded modules outside the staged plan.

## Tests

`tests/anndata-*` (reader, corpus conformance, sparse columns),
`tests/subsample-*`, `tests/gene-sample-*`, `tests/kept-column-index-*`,
`tests/graph-lines-*`, `tests/edges-at-a-share-*`, `tests/text-matrix-*`,
`tests/transcode-*`; find others with
`grep -l "data/anndata/<module>" tests/*.test.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/23_decisions_partial_reading.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/24_decisions_graph_edges_at_scale.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/25_decisions_exports.md`. Update them in the same change as the code.
