# `data/anndata/write/`: writing AnnData, and a copy of the open dataset

The web app's AnnData writers: the element layer its Zarr writers share
(the transcoders' kept stores and the copy; the highlighted cells' `.h5ad`
export, `app/exports/cell-exports.js`, builds its HDF5 tree itself), and the copy
of an open dataset as a **Cellucid-ready AnnData `.zarr.zip`**, with
changes written in. The page reaches the copy through the State panel's "Save AnnData
with this state…" (the action `history.anndata.save`, `app/history/anndata-copy-save.js`,
which plans the changes from the state shown with `app/history/exports/anndata-copy.js`);
its way in is `BaseAnnDataAdapter.writeAnnDataCopy`.

Three layers, each its own module, so another container or format plugs in
at its own level:

| Layer | Module | Owns |
| --- | --- | --- |
| Container | `formats/zip/writer.js` | A stored ZIP written as a stream (ZIP64 exactly where a field overflows, deterministic bytes). Also the figure export's batch archive. |
| Array | `formats/zarr/format-v2.js` (shared with the transcoders), `formats/zarr/writer.js`, `formats/zarr/encode-task.js` | Zarr v2: the documents' JSON, dtypes (record arrays), the `.zarray` document and `vlen-utf8` bytes (`format-v2.js`); codecs (byte shuffle, zlib level 6 by fflate), float16 bits, the streamed store with chunks by rows or by blocks of columns, encoded in order with any number in flight (`writer.js`, outside the transcoders' guards). |
| AnnData | this folder | The elements (`element-writer.js`), the Cellucid-ready layout (`layout.js`), the streamed `.zarr.zip` writer (`ready-writer.js`), the copy (`copy.js`, `gene-major.js`), and the copy's way to the page (`acknowledged-sink.js`) and to every core (`pool-encoder.js`). |

| Module | Owns |
| --- | --- |
| `element-writer.js` | `AnnDataElementWriter`: dataframes and their column kinds, `uns` values, sparse matrices, scalars, with anndata's encodings; each array with its **role** (how it is read). Subclasses decide where arrays go: `transcode/zarr-writer.js` (a kept store, uncompressed regions of the transcode space) and `ready-writer.js`. |
| `layout.js` | The specification's §3 table: chunk shape by role (`gene-entries` 2^14, `cell` 2^16, `cell-rows`, `whole` 2^18, `gene-strips`, `columns`), codecs by kind (no shuffle for expression values, text, one-byte values), `roleOf` a source array by its path. |
| `ready-writer.js` | `CellucidReadyWriter`: the element layer over a streamed Zarr v2 store at the top of a stored ZIP; `stream(path, …)` for arrays copied from a source. |
| `copy.js` | `writeAnnDataCopy(root, sink, {changes, …})`: every element of the presented store copied (every cell, rows in stored order), every expression matrix gene-major, MuData written as a Cellucid-ready MuData, the changes written in place. |
| `gene-major.js` | A `csr_matrix` written as `csc_matrix` in passes within a memory budget (count, values, rows), with the priority order's prefix counts; a 10x column window read through its real matrix. |
| `acknowledged-sink.js` | The reader worker's sink: bytes posted to the page in batches, each answered once written, a window of them in flight. |
| `pool-encoder.js` | Chunks deflated on the decode workers (`runOnDecodeWorker`), put in order. |
| `changes.js` | One pass checking a copy's changes before a byte is written: names, columns, `uns` values, the merged `uns['cellucid']` (`requireCellucidFileMetadata`), the open dataset's id and name where the file names none. |
| `names.js` | The specification's portable element-name rule (cellucid-python `require_element_key`), and `portableElementName`: the name a writer gives a name it did not choose (the copy's columns and elements, a converted store's columns, the `.h5ad` export's), said in its notes. |
| `copy-target.js` | What a copy is planned against (`readCopyTarget`): the stored obs columns (a MuData's global obs, the placed `<modality>:<key>` ones apart), the values of the columns the plan reads over every cell by original position, in the form `column()` writes them, the var columns of the frame var changes go to, the root `uns` keys, the colors of the columns the plan asks (`uns['<column>_colors']` when text, else null), and `uns['cellucid']`. |

## Entry points

- Page: `BaseAnnDataAdapter.readCopyTarget(names, {signal, owner, varModality, colors})`
  (what the plan reads) and `BaseAnnDataAdapter.writeAnnDataCopy(changes, {sink, signal, owner})`
  (the sink takes one `Blob` per batch; on a failure the caller aborts its
  writable, never closes it, and removes its spool)
  → `AnnDataReaderClient.writeAnnDataCopy` → the reader worker's
  `writeAnnDataCopy` (`anndata-reader-worker.js` header: the protocol). How
  far it is shows as its read activity (kind `cells`, "a copy of the
  dataset", of the job `owner`), the one channel the page shows reads by.
- Worker or Node: `writeAnnDataCopy(root, sink, options)` (`copy.js`).

`changes` (`copy.js` `CopyChanges`): `obs` columns (one value per cell **by
original position**, placed at each cell's file row through the verified
priority order; a change with `from` renames that column in its place, its
values as stored when `column` is null, and frees its old name; none writes,
renames or replaces `obs['cellucid_original_position']`, refused with
`PRIORITY_COLUMN_REFUSAL`), `var` columns (by var row; `varModality` in a MuData), `uns`
keys, `uns['cellucid']` keys (checked against `CELLUCID_UNS_KEYS`; `priority`
is the source's and is refused). Column kinds are `element-writer.js`
`column()`'s.

## Invariants

- The copy is deterministic: the same source and changes give the same
  bytes, however the work is cut (budget, slab, encoders in flight).
- Every array's values keep their type and every bit (little-endian order;
  float16 as float16; record arrays' text as fixed-width Unicode, as anndata
  writes a record array to Zarr). Attributes are copied as they are, less an
  HDF5 object reference (an address in the source file), which is noted.
- Nothing is declared before its first read: an unreadable element of `uns`
  is left out with a note; anything else unreadable fails the copy in the
  reader's words. A change that cannot be made is refused before a byte is
  written.
- Memory: two slabs of the array being copied (`SLAB_BYTES`, the next one's
  read under way), the budget (a transposition's block of genes, or a dense
  matrix's band of every gene: the worker gives the `columnIndex` share of
  the memory model), the chunks in flight and the batches posted to the page
  (all counted in the working set under the copy's own part while it runs),
  and the archive's central directory (about 70 bytes an entry). The archive
  goes to the page's sink as it is written. Bytes a copy reads are kept
  neither in the page's memory nor in kept parts (`ReadActivity.readOnce`).
- Names: kept exactly as stored (never normalized); every name a change
  makes a path follows the portable rule (`names.js`); a source holding one
  name in two Unicode forms is refused (`changes.js`).
- `formats/zarr/format-v2.js` and `element-writer.js` are what the
  transcoders write a kept store with, so the code fingerprint of converted
  stores covers them (`scripts/kept-code-fingerprints.mjs`): a change to
  either makes browsers convert kept R objects and MatrixMarket folders
  again on their next opening. `formats/zarr/writer.js` and the ZIP writer
  are a copy's alone, and in no fingerprint.

## Tests

`tests/anndata-copy-contract.test.mjs` (the ZIP writer and ZIP64, the Zarr
writer, the layout, every file of the AnnData, MuData, Loom and 10x corpora
copied and compared element by element, transposition in passes, prefix
counts against `prepare()`'s, changes and refusals, the worker's sink),
`tests/anndata-copy-cross-language.test.mjs` (anndata, mudata, cellucid-python
and Python's `zipfile` read the copies), `tests/browser/anndata-copy.spec.mjs`
(written in Chromium through a file's writable stream, compared, opened in the
app). `scripts/benchmark-anndata-copy.mjs` measures speed and peak memory.
