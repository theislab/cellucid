# `formats/`: container readers

Reads files as **containers**, with no knowledge of AnnData or of Cellucid's
features. Everything above (the AnnData reader in `data/anndata/`) is written
once against the store model in `store.js`.

Layer: L1. Imports `utils/`, `workers/` and other `formats/` modules. Its edges into
`data/` are wrong-way imports; do not add more: `data/sources/identity.js`,
`data/sources/link-credentials.js`, `data/sources/link-text.js`,
`data/anndata/transcode/space.js`, `kept-format.js` and `kept-journal.js`, and
`allocateTypedArray` from `data/sparse-column-index.js`.

| Folder / file | Owns | Entry points |
| --- | --- | --- |
| `store.js` | The store contract every container is opened as: `Group` (`load`, `keys`, `get`, `has`, `loaded`), `ArrayNode` (`read`, `storedBytes`, `readRows`, `chunkIndexReads`), dtypes, selections, `StoreNotLoadedError`. Read its header before touching any reader. | `isGroup`, `isArrayNode`, `loadBelow`, `normalizeSelection` |
| `io/` | Bytes: where they come from (local `File`, HTTP range reads, a notebook kernel), how reads become requests, the link model, kept parts, the page's range cache, decoding on other cores. See `io/README.md`. | `createByteReader`, `httpByteSource`, `blobByteSource` |
| `hdf5/` | HDF5 (`.h5ad`, `.loom`, 10x `.h5`, `.h5mu`): superblock, object headers, B-trees and every chunk index, heaps, filters, a lazy tree (`load.js`: nothing read before something asks), and the read plan of a selection (`read-plan.js`). `writer.js` is the minimal `.h5ad` writer. | `index.js` `openHdf5(reader, {load})` |
| `zarr/` | Zarr v2 and v3 (folders, `.zarr.zip`, web hosts): metadata, dtypes, codec pipelines (`codecs/`), store backends (`stores/`: directory, http, zip, memory, mapped). The whole tree is read at open (consolidated or listed metadata). `format-v2.js` is the Zarr v2 format as the app writes it (documents' JSON, dtypes, the `.zarray` document, `vlen-utf8` bytes), shared with the transcoders' kept stores; `writer.js` streams a compressed store (codecs, chunks in order with any number encoded at once), `encode-task.js` encodes a chunk on a decode worker. Keys are compared in one Unicode form (`open.js` `sameForm`, the zip and folder stores' lookups), so a name written decomposed finds its entry. | `index.js` `openZarr`, store backends `httpStore`, `directoryStore`, `zipStore`; `writer.js` `ZarrV2StoreWriter` |
| `zarr/codecs/javascript/` | JavaScript decoders of Zstandard, LZ4 and Blosc, measured against the WebAssembly ones (`io/wasm-codecs.js`) by `io/decoder-choice.js`. | via `zarr/codecs/pipeline.js` |
| `zip/` | ZIP archives read in place through a byte reader; `writer.js` writes one as a stream (stored entries, ZIP64 where a field overflows, deterministic bytes). | `index.js` `openZipArchive`; `writer.js` `createZipWriter` |
| `rds/` | R serialization (`.rds`, `.rda`): one stream (gzip, bzip2, xz), parsed into plain records while large payloads go where the caller's plan says. | `index.js` `readRFile` |
| `text/` | MatrixMarket coordinate files and text lines, parsed from bytes as they stream. | `matrix-market.js` `readMatrixMarket`, `lines.js` |

The writers (`zip/writer.js`, `zarr/format-v2.js`, `zarr/writer.js`) are imported by their own
path, never re-exported from an `index.js`: the readers' entry points are
entries of the code fingerprint of kept gene indexes
(`scripts/kept-code-fingerprints.mjs`), which follows their imports, and a
writer is not code that decides what an index holds (a change to one would
make every browser build its kept indexes again). Their users are
`data/anndata/write/` (a copy of the open dataset), the transcoders
(`data/anndata/transcode/zarr-writer.js`) and the figure export's batch
archive.

## Invariants

- A value returned by `read()` or `readField()` belongs to the caller (never a
  view of a cache); values are in host byte order (`io/byte-order.js`).
- A group not loaded throws `StoreNotLoadedError`; it never answers as empty.
- `storedBytes(selection, {toFetch: true})` counts only bytes a read would
  fetch now (not kept, not cached): every time estimate above prices this.
- Each container's failures are its own error classes (`hdf5/errors.js`,
  `zarr/errors.js`, `zip/errors.js`, `rds/errors.js`; `text/` has
  `MatrixMarketError`).

## Tests

`tests/hdf5-*`, `tests/zarr-*`, `tests/formats-*`, `tests/rds-*`,
`tests/text-matrix-*` and the corpus conformance tests (find more with
`grep -l "formats/<folder>/" tests/*.test.mjs`), and `tests/wasm-codecs-contract.test.mjs` (pins the
WebAssembly build).

## Decision records

Why this code is the way it is (dated decisions, measurements per engine,
what was tried and reverted, open items): `cellucid-python/docs/user_guide/web_app/p_developer_docs/21_decisions_decoders_and_codecs.md`, `cellucid-python/docs/user_guide/web_app/p_developer_docs/22_decisions_link_model_and_request_planning.md`. Update them in the same change as the code.
