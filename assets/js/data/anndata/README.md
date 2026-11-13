# `data/anndata/`: the AnnData reader, its views, transcoders and the share planner

Every dataset is read as AnnData by one class, `AnnDataReader` (`reader.js`),
in the reader worker (`../anndata-reader-worker.js`), over the store model
of `formats/store.js`. Formats that are not AnnData on disk are presented as
AnnData: by a **view** when the container allows random access (HDF5, Zarr),
by a **transcoder** when the file is one stream (R objects, MatrixMarket).
The step-by-step read path is developer doc 20
(`cellucid-python/docs/user_guide/web_app/p_developer_docs/20_read_path_architecture.md`).

## The reader

| Module | Owns |
| --- | --- |
| `reader.js` | `AnnDataReader`: its state and the lifecycle of it (the constructor declares every field; `open`, `_adopt` and the carry move them between readers; opening the cells and the structure write them; clearing, trimming, releasing and closing reset them) and the helpers every part calls. Its other members are its method groups. |
| `reader/` | The reader's method groups, one module each, mixed onto its prototype (`utils/apply-mixin.js`): fields, names, `obsm`, stored outliers, the mapping probe, graphs, matrices, row pointers, kept indexes, gene segments, the gene sample, gene columns, rows of cells, cell-subset reads. See `reader/README.md`. |
| `uns.js` | What `uns` says to Cellucid: `uns['cellucid']` (checked by the adapter; its outlier quantiles described, the packages' records read only by an apply plan), the launch expression matrix, `uns['title']`, an obs field's colors, `uns['log1p']`. The copy reads it too. |
| `probe.js` | A store and its elements described from their metadata (`describeAnnDataStore` for a dataset catalog, `probeElement` for the data mapping, `storedValueFacts`, `storedMatrix`). |
| `cell-maps.js` | A matrix's rows placed on the dataset's cells through a cell map (a modality's, a subsample's kept rows). |
| `positions.js`, `cell-subset-blocks.js`, `present-categories.js`, `prefix-reads.js` | Positions a caller names, checked; the gene-major blocks of a cell-subset read; coding a categorical by the categories its open cells hold; the prefix a priority-ordered file's opening reads. |

## Opening

| Module | Owns |
| --- | --- |
| `open.js` | `openDatasetStore()`: the one entry from a source to a store root, whatever the file arrived as (view, transcoder, older layout). |
| `views/` | Layout views by input-format id (`views/index.js`): `loom.js`, `tenx-h5.js`, `tenx-outs.js`, `mudata.js`, `modalities.js` (several feature spaces on the same cells), `h5seurat.js` and `refusal.js` (recognized, refused with what to do), `view-nodes.js` (the node wrappers), and `cell-subset.js` (a subsample presented as a smaller AnnData; see below). |
| `transcode/` | One pass over a stream into an AnnData Zarr store in the origin-private file system: `r-object.js` (+ `seurat.js`, `sce.js`, `r-matrices.js`, `r-values.js`), `matrix-market.js`, `tables.js`, `entries.js`, `zarr-writer.js`, `priority.js`, `session.js` (one transcoding, reused across tabs and visits), `space.js` (**kept-store storage for the whole stack**: it keeps the OPFS directories of every kind of kept data under locks and the quota, and stamps and checks each manifest's code fingerprint), `kept-format.js` (what a kept directory is on disk: its files' names, what it is filed under, its manifest, the page checksum tables; pure), `kept-journal.js` (a journal's records: the downloaded parts of files; pure), `kept-code-fingerprints.js` (generated: the code fingerprint of each kind), `kept-store.js`, `anndata-model.js`, `refusals.js`. |
| `older-layouts.js` | Files written before anndata 0.8, presented in the current layout. |
| `elements.js`, `dataframe.js`, `sparse.js`, `values.js` | The element rules and readers of dataframes, sparse groups and arrays (`readRowsInStoreOrder`, `readInSourceOrder`, exact integers). A file that breaks a rule is refused with `AnnDataFormatError` (`elements.js`), as is every other check of what a file holds (the reader, `matrix-access.js`, `graph-lines.js`, `priority-layout.js`, `views/`); `open.js` `explainFormatError` says it as the file's problem. A check of Cellucid's own work throws a plain error. |

## Writing (a copy of the open dataset)

| Module | Owns |
| --- | --- |
| `write/` | The element layer the Zarr writers share (`element-writer.js`: the transcoders' and the copy's; the `.h5ad` cell export does not use it yet), the Cellucid-ready layout (`layout.js`), and the copy of the open dataset as a Cellucid-ready AnnData `.zarr.zip` (`copy.js`, `gene-major.js`, `ready-writer.js`), streamed from the reader worker to a file the page holds. See `write/README.md`. |

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
| `graph-lines.js` | Neighbor graphs (`obsp`) read line by line; the induced subgraph of open cells. |

## Invariants

- One reader for every format: a format-specific path is a view or a
  transcoder, never a branch in the reader (`reader.js`, `reader/`).
- A share never costs more than a larger share or every cell in what a person
  meets (time, download, memory, rendering and analysis work; the request
  count is a means, not a cost); prices use the link's round trip under load.
  Decisions and measurements: developer doc 23 (partial reading).
- Open cells are exact (the cells the request names); values read for a
  share are bit-identical to the same rows of a whole read.
- Memory that grows with cells or values is counted (`../memory-budget.js`).
- Kept data is stamped with the code fingerprint of its kind
  (`transcode/kept-code-fingerprints.js`, written by
  `node scripts/generate-web-asset-inventory.mjs` from the closures in
  `scripts/kept-code-fingerprints.mjs`), and a directory stamped by other
  code is removed, never read. Nothing is raised by hand. What each
  fingerprint covers, comments and layout aside:
  - a **converted store**: the transcoders and every module they load
    (`transcode/index.js`, the R and text parsers, `write/element-writer.js`,
    `formats/zarr/format-v2.js`), `kept-format.js` and the page checksums;
  - a **gene index**: `kept-column-index.js`, `sparse-column-index.js`,
    `prefix-column-index.js`, the matrix reads and conversions
    (`matrix-access.js`, `values.js`, `views/`), the container readers and
    their decoders, and `kept-format.js`;
  - a **file downloaded whole**: four modules and nothing else:
    `kept-format.js`, the page checksums (`formats/io/page-checks.js`) and
    the two identity rules a directory is filed by (`sources/identity.js`,
    `sources/link-credentials.js`);
  - the **downloaded parts of a file**: those four and `kept-journal.js`.

  A change to covered code makes browsers remove what they kept of that kind
  and make it again (minutes for a store or an index; a download is fetched
  again), so keep in those five modules only what decides a kept
  directory's bytes or how they are checked. Transport, link measurement,
  cancellation, scheduling, memory policy, messages, the SHA-256 and CRC-32
  implementations (held to their standards' vectors) and `space.js` itself
  are in no fingerprint.

## Tests

`tests/anndata-*` (reader, corpus conformance, sparse columns),
`tests/subsample-*`, `tests/gene-sample-*`, `tests/kept-column-index-*`,
`tests/kept-code-fingerprints-contract.test.mjs` (what each code fingerprint
covers; the generated module is current),
`tests/anndata-copy-*`, `tests/browser/anndata-copy.spec.mjs`,
`tests/graph-lines-*`, `tests/edges-at-a-share-*`, `tests/text-matrix-*`,
`tests/transcode-*`; find others with
`grep -l "data/anndata/<module>" tests/*.test.mjs`.

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/23_decisions_partial_reading.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/24_decisions_graph_edges_at_scale.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/25_decisions_exports.md`. Update them in the same change as the code.
