# `data/anndata/reader/`: the AnnData reader's method groups

`AnnDataReader` (`../reader.js`) is one class. `reader.js` holds its state
and the lifecycle of that state: the constructor that declares every field,
`open`, `_adopt` and the carry (which move fields between readers), opening
the cells and the structure (which write them), clearing, trimming,
releasing and closing (which reset them), and the few helpers every part
calls (`_ready`, `_track`, `_ensureOpen`, `_assertGeneration`, `_rowRange`,
`_splitModality`, `_readsAhead`, `_inFlightEntries`, `_mergeGapBytes`,
`_readsNoMoreThanRows`). Every other member is in one module here: a class
of methods, mixed onto the reader's prototype at the end of `reader.js`
(`applyMixin`, `../../../utils/apply-mixin.js`), so `this` is the reader and
every member stays an own member of `AnnDataReader.prototype`.

| Module | Group | Owns |
| --- | --- | --- |
| `stored-outliers.js` | `AnnDataReaderStoredOutlierMethods` | A field's stored outlier quantiles (`uns['cellucid']['outlierQuantiles']`), read when its filter is used. |
| `names.js` | `AnnDataReaderNameMethods` | Obs names of the open cells, gene names by var axis, a var column's flags. |
| `obsm.js` | `AnnDataReaderObsmMethods` | `obsm` arrays: the refusal of nothing to draw, slabs, cost, columns, embeddings, the cell-order digest, vector fields. |
| `fields.js` | `AnnDataReaderFieldMethods` | Obs fields: kind, information, values, codes, present categories, 64-bit identifiers, a subsample's representation of a field. |
| `graphs.js` | `AnnDataReaderGraphMethods` | Neighbor graphs (`obsp`): edges, rows, the whole graph, what a subsample keeps of it. |
| `mapping-probe.js` | `AnnDataReaderMappingProbeMethods` | The data-mapping probe of every element, and the dataset metadata. |
| `matrix-rows.js` | `AnnDataReaderMatrixRowMethods` | Rows of cells as an export reads them, and their price. |
| `gene-columns.js` | `AnnDataReaderGeneColumnMethods` | Gene columns, dense and sparse, on the open cells. |
| `cell-subset-reads.js` | `AnnDataReaderCellSubsetMethods` | Some cells' genes as an analysis reads them, and what a run keeps of them. |
| `gene-sample.js` | `AnnDataReaderGeneSampleMethods` | The gene sample: its plan, its cost, its growth, the rows a store holds. |
| `kept-indexes.js` | `AnnDataReaderKeptIndexMethods` | Gene indexes kept in this browser: found, taken, kept. |
| `row-pointers.js` | `AnnDataReaderRowPointerMethods` | Row pointers of CSR matrices and the open rows readied for a read. |
| `matrices.js` | `AnnDataReaderMatrixMethods` | Expression matrices: an element resolved, its column and row access, its index's options, what stays and its release. |
| `gene-segments.js` | `AnnDataReaderGeneSegmentMethods` | The gene index of a cell-major matrix in segments: carried, built in doubling segments or in store order, restricted, grown. |

Each module's header names the fields it writes; every other field it only
reads. The gene-index groups (`matrices.js`, `row-pointers.js`,
`kept-indexes.js`, `gene-segments.js`) are one machine and call each other
through `this` in every direction.

## Rules

- A group imports no `reader.js` (the class is named in JSDoc only, as a
  type: `@this {import('../reader.js').AnnDataReader}`); functions it needs
  come from modules of functions (`../uns.js`, `../probe.js`,
  `../cell-maps.js`, `../positions.js`, `../cell-subset-blocks.js`,
  `../present-categories.js`, `../prefix-reads.js` and the rest of
  `data/anndata/`).
- A member's `@this` is the first tag of its JSDoc, and each group has its
  line in `types/mixins.d.ts`, so the type check follows `this` into the
  group and sees the group's members on the reader (`ARCHITECTURE.md`, "Rules
  that hold everywhere").
- A member with an underscore is the reader's own, not for callers. It
  carries `@private` only when no other group or `reader.js` reaches it: the
  compiler holds `@private` to the class body it is written in.
- Tests replace members on `AnnDataReader.prototype` and build readers with
  `Object.create(AnnDataReader.prototype)`: a member stays on that prototype,
  and is reached through `this`.

## Tests

The reader's: `grep -lE "anndata/reader\.js|anndata-reader-worker\.js" tests/*.test.mjs`;
`tests/anndata-reader-contract.test.mjs` first.
