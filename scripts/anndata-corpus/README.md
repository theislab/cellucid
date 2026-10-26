# AnnData conformance corpus

Small AnnData files written by the real writers - every anndata release line
from 0.6 to 0.12, as `.h5ad` and as Zarr (v2 and v3) - plus the exact values
each one holds. The browser AnnData reader is tested against them value for
value. The files live in `tests/fixtures/anndata/`; this folder holds the
scripts that make them.

## What is where

```
tests/fixtures/anndata/
  index.json                      every fixture (path, writer, variant, format, reader expectation, tags)
                                  and every variant a writer refused to write, with its error
  anndata-<version>.zip           one archive per writer release (deflated), holding:
    <variant>.h5ad                  HDF5 (.h5ad)
    <variant>.v2.zarr.zip           Zarr format 2 store, packed (the store at the top level)
    <variant>.v3.zarr.zip           Zarr format 3 store, packed (0.12 only)
    <file>.expected.json            expected values for <file>
    _writer.json                    exact package versions, and every attempt with its outcome
  emulated.zip                    layouts other tools leave behind (see below)
```

Paths in `index.json` read `anndata-<version>/<file>`: the file inside that
writer's archive. `pack.py` packs and unpacks the corpus (`generate.py`
unpacks before writing and packs afterwards; `verify_with_python.py`
verifies an unpacked copy), so the repository holds nine files.

Writers and the packages they ran with (all wheels on macOS arm64; only
`asciitree`, a pure-Python dependency of zarr 2, installs from source):

| Writer | Python | Pins |
|---|---|---|
| anndata 0.12.19 | 3.12 | numpy 2.5.1, pandas 2.3.3, h5py 3.16.0, zarr 3.3.0, numcodecs 0.16.5, scipy 1.18.0, awkward 2.14.0 |
| anndata 0.11.4 | 3.12 | numpy 2.2.6, pandas 2.2.3, h5py 3.13.0, zarr 2.18.7, numcodecs 0.15.1, scipy 1.15.3 |
| anndata 0.10.9 | 3.12 | numpy 1.26.4, pandas 2.2.3, h5py 3.11.0, zarr 2.18.2, numcodecs 0.12.1, scipy 1.13.1 |
| anndata 0.9.2 | 3.11 | numpy 1.24.4, pandas 1.5.3, h5py 3.9.0, zarr 2.16.1, numcodecs 0.12.1, scipy 1.11.4 |
| anndata 0.8.0 | 3.10 | numpy 1.22.4, pandas 1.4.4, h5py 3.7.0, zarr 2.11.3, numcodecs 0.12.1, scipy 1.8.1 |
| anndata 0.7.8 | 3.10 | numpy 1.23.5, pandas 1.5.3, h5py 3.7.0, zarr 2.13.3, numcodecs 0.12.1, scipy 1.9.3 |
| anndata 0.6.22.post1 | 3.10 | numpy 1.21.6, pandas 1.3.5, h5py 3.7.0, zarr 2.13.3, numcodecs 0.12.1, scipy 1.9.3, natsort 8.4.0 |

Every release installed and ran; none had to be skipped. 0.8.0 is the first
release of the current encoding (`encoding-type` / `encoding-version`
attributes); 0.7.8 is the last of the `__categories` layout; 0.6.22 is the
last of the compound-dataset layout.

The latest release writes every variant in all three formats. Older releases
write the variants whose layout differs between releases (see
`CORE_VARIANTS` / `CURRENT_ENCODING_EXTRA` / `LEGACY_EXTRA` in
`write_corpus.py`): every older release writes the core set as `.h5ad` and
Zarr v2; 0.8 and 0.11 add more `.h5ad` variants, and 0.6 and 0.7, whose
layouts differ the most, add more still. 0.9 and 0.10 write the same
encodings as 0.8 and 0.11, so they write only the core set. Keeping the
corpus small matters more than writing the same layout seven times.

## Regenerating

```
python scripts/anndata-corpus/generate.py --setup     # create one venv per writer (once)
python scripts/anndata-corpus/generate.py --verify    # write everything, then verify
python scripts/anndata-corpus/generate.py --writer 0.12 x_csr_float32   # one writer, some variants
```

Venvs go to `$ANNDATA_CORPUS_VENVS` (default `../.anndata-corpus-venvs`
beside the repository). Interpreters are found as `python3.X` on `PATH` or
under `~/.pyenv/versions`; set `ANNDATA_CORPUS_PYTHON_3_10=/path/to/python`
(and so on) to choose one.

- `write_corpus.py` runs inside each writer's venv. It builds each variant
  with that release's own `AnnData`, writes it, reads it straight back with
  the same release and stores the expected values. A variant the release
  refuses to write is recorded in `_writer.json` with the error; that is a
  result, not a failure.
- `postprocess.py` runs with the latest release. It writes `emulated/`, fills
  in expected values where the writer could not read its own file back
  (from the current anndata, said so in `expected_source`), adds the
  `storage` section to every expected-values file, writes `index.json`, and
  rewrites the variant tables in this README.
- `verify_with_python.py` re-reads every fixture with the current anndata,
  recomputes the expected values with the same code, re-derives `storage`
  from the bytes, and requires both to match.
- `corpus_expected.py` is the one function that turns an `AnnData` into the
  expected values; every environment and the verifier use it.

Generation is deterministic: fixed seeds, no timestamps (HDF5 is written
without object times; the modification time in gzip streams written by
numcodecs is pinned to 0). Two consecutive full runs produce byte-identical
output.

## The variants

Each cell lists the formats that writer produced; a struck-through format is
one the writer refused (the error is in `index.json` and `_writer.json`).
"Reader must" is the expectation for the Cellucid reader. A "refuse" must be
a clear message naming the feature, never a wrong value.

<!-- variant-matrix:start (written by postprocess.py) -->

| Writer | h5ad | Zarr v2 | Zarr v3 | refused attempts |
|---|---|---|---|---|
| anndata-0.12.19 | 102 | 112 | 108 | 20 |
| anndata-0.11.4 | 26 | 17 | 0 | 0 |
| anndata-0.10.9 | 17 | 17 | 0 | 0 |
| anndata-0.9.2 | 17 | 17 | 0 | 0 |
| anndata-0.8.0 | 26 | 17 | 0 | 0 |
| anndata-0.7.8 | 31 | 15 | 0 | 4 |
| anndata-0.6.22.post1 | 30 | 13 | 0 | 7 |
| emulated | 8 | 0 | 0 | 0 |

573 fixtures, 21.4 MB unpacked, kept as 8 writer archives and index.json.

| Variant | What it holds | 0.12.19 | 0.11.4 | 0.10.9 | 0.9.2 | 0.8.0 | 0.7.8 | 0.6.22.post1 | Reader must |
|---|---|---|---|---|---|---|---|---|---|
| `column_name_slash` | A column name containing '/'. | h5ad ~~v2~~ ~~v3~~ |  |  |  |  |  |  | read exactly |
| `column_named_underscore_index` | A column literally named '_index'. | ~~h5ad~~ ~~v2~~ ~~v3~~ |  |  |  |  |  |  | n/a: every writer refused |
| `column_names_unusual` | Column names with spaces, dots, unicode, digits only, '__categories', a leading dash. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `index_duplicates` | Duplicate obs names and duplicate var names. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `index_empty_strings` | Index containing empty strings (one in var, two in obs). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `index_int_like` | Index values that look like integers ('0', '1', ...) for obs and var. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `index_name_equals_column` | Index named like a column whose values equal the index (anndata accepts this). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `index_name_equals_column_different` | Index named like a column with different values (anndata refuses this). | ~~h5ad~~ ~~v2~~ ~~v3~~ |  |  |  |  |  |  | n/a: every writer refused |
| `index_named` | Named indexes (obs.index.name = 'cell_id', var.index.name = 'gene_id'): the index is stored under that name. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `index_range` | obs/var built with a RangeIndex; anndata converts the index to strings. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `index_unicode` | Unicode and emoji index values. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `layers_mixed` | Layers of every storage form: dense float32/int64/bool, CSR int32, CSC float64, special values. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_cat_bool` | Boolean categories (categories [False, True]). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_cat_labels` | Categorical labels: empty string, literal 'nan', unicode, 300-character label, whitespace. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_cat_numeric` | Numeric categories: int (incl. > 2^53), float (incl. -0.0) categories. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `obs_cat_wide_int16` | Categorical with 200 categories, so the codes are stored as int16. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_cat_wide_int32` | Categorical with 32 769 categories, so the codes are stored as int32. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_categoricals` | Categoricals: unordered, ordered, missing codes (-1), unused categories, single category, all missing. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `obs_float_special` | Float obs columns with NaN, +-inf, -0.0, 1e40, subnormals, float16 extremes, all-NaN columns. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_int_extremes` | Integer obs columns beyond 2^53: int64 min/max, 2^53+1, uint64 max. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_no_columns` | obs and var with no columns at all. | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly |
| `obs_nullable_bool` | Nullable boolean column with NA. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | ~~h5ad~~ ~~v2~~ | ~~h5ad~~ ~~v2~~ | read exactly |
| `obs_nullable_float` | Nullable float column (pandas Float64) with NA. | ~~h5ad~~ ~~v2~~ ~~v3~~ |  |  |  |  |  |  | n/a: every writer refused |
| `obs_nullable_int` | Nullable integer columns (Int8..Int64, UInt8..UInt64) with and without NA. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | ~~h5ad~~ ~~v2~~ | ~~h5ad~~ ~~v2~~ | read exactly |
| `obs_nullable_string` | Nullable string column (pandas StringDtype) with NA, written with settings.allow_write_nullable_strings and convert_strings_to_categoricals=False where the writer has them (otherwise it becomes a categorical). | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `obs_numeric_dtypes` | obs and var columns of every numeric dtype int8..uint64, float16/32/64, bool (with dtype extremes). | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_object_bytes` | Object column holding bytes. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_object_datetime` | datetime64 column. | ~~h5ad~~ ~~v2~~ ~~v3~~ |  |  |  |  |  |  | n/a: every writer refused |
| `obs_object_mixed_int_str` | Object column mixing ints and strings. | ~~h5ad~~ v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_object_nested_lists` | Object column holding lists. | ~~h5ad~~ v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_object_timedelta` | timedelta64 column. | ~~h5ad~~ ~~v2~~ ~~v3~~ |  |  |  |  |  |  | n/a: every writer refused |
| `obs_string_nul` | String column containing an embedded NUL character. | ~~h5ad~~ v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_strings` | String obs/var columns: all values distinct (stay strings), including unicode. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obs_strings_converted` | Repeated strings that anndata converts to a categorical on write (default behaviour). | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obs_strings_edge` | String column edge cases: empty string, 10 000-character string, emoji, combining marks, RTL, whitespace. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad ~~v2~~ | read exactly |
| `obs_strings_not_categorical` | Repeated strings written with convert_strings_to_categoricals=False, so they stay a string array. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obsm_1d` | A 1-D array assigned to obsm (anndata stores it as an n x 1 matrix). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `obsm_awkward` | An awkward array in obsm (anndata's awkward-array encoding). | h5ad v2 v3 |  |  |  |  |  |  | refuse, naming awkward-array encoding in obsm |
| `obsm_plain` | obsm entries that are only plain arrays (no sparse/dataframe), for every writer. | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obsm_varm_variants` | obsm: float32 width 2, float64 width 3, float32 width 50, int32, CSR, a dataframe, special values; varm likewise. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `obsp_varp_variants` | obsp: symmetric CSR connectivities, CSR distances, CSC graph, dense matrix; varp dense and CSR. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | ~~h5ad~~ | read exactly |
| `raw_dense` | raw with dense raw.X (same genes as X); X CSR. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `raw_sparse_more_genes` | raw with CSR raw.X over more genes than X, raw.var with extra categorical/numeric columns; X dense. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `raw/var/`, `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `scanpy_like` | Scanpy-style object: CSR X, counts layer, raw with more genes, embeddings, graphs, rank_genes_groups. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `shape_0_obs` | Zero cells: obs has 0 rows, var 20; X dense 0 x 20. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `shape_0_obs_csr` | Zero cells with CSR X (0 x 20, indptr = [0]). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `shape_0_vars` | Zero genes: var has 0 rows, X dense 30 x 0. | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly |
| `shape_0_vars_csc` | Zero genes with CSC X (30 x 0). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `uns_basic` | uns: title, nested dicts, numeric scalars, string array, numeric arrays, colours list, empty dict. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad ~~v2~~ | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `uns_bool` | uns: bool scalars (Python and numpy). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `uns_dataframe` | uns: a dataframe and a sparse matrix. | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `uns_recarray` | uns: rank_genes_groups-style structured (record) arrays. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `uns_special` | uns: special numeric scalars and arrays (NaN, inf, -0.0, 1e40, int64 max) and unicode keys. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `uns_title_array` | uns: title stored as a one-element string array (as older writers leave it). | h5ad v2 v3 | h5ad |  |  | h5ad | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `x_absent` | No X at all: shape comes from obs/var; one layer holds the values. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `x_csc_duplicates` | CSC X with duplicate entries; they must be summed. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_empty_edges` | CSC X whose first/last rows and first/last columns are empty. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_float32` | CSC X, float32 data, int32 indptr/indices. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `x_csc_float64` | CSC X, float64 data. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_h5_lzf` | CSC X in HDF5 with 50-element chunks and LZF. | h5ad |  |  |  |  |  |  | read exactly |
| `x_csc_index_int64` | CSC X with int64 indptr and int64 indices. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_indices_uint16` | CSC X over 300 cells with uint16 indices (minimum-dtype setting). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_nnz0` | CSC X with no stored entries (nnz = 0). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_special_float64` | CSC X float64 with stored NaN, +-inf, -0.0, +-1e40, subnormals. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csc_unsorted` | CSC X with row indices in descending order inside each column. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_all_irregular` | CSR X: unsorted + duplicates + explicit zeros + empty edge rows/columns together. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_bool` | CSR X, bool data. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_duplicates` | CSR X with duplicate (row, col) entries, adjacent and not; they must be summed. | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `x_csr_empty_edges` | CSR X whose first/last rows and first/last columns are empty. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_explicit_zeros` | CSR X with explicitly stored 0.0 values. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_float32` | CSR X, float32 data, int32 indptr/indices. | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `x_csr_float64` | CSR X, float64 data. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_h5_chunked_gzip` | CSR X in HDF5 with 64-element chunks and gzip. | h5ad |  |  |  |  |  |  | read exactly |
| `x_csr_index_int64` | CSR X with int64 indptr and int64 indices. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_indices_uint8` | CSR X with uint8 indices (settings.write_csr_csc_indices_with_min_possible_dtype). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_indptr_int64` | CSR X with int64 indptr and int32 indices (write_elem indptr_dtype). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_int32` | CSR X, int32 counts. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_int64_huge` | CSR X, int64 counts including 2^53+1, 2^62 and int64 max. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_nnz0` | CSR X with no stored entries (nnz = 0). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_special_float32` | CSR X float32 with stored NaN, +-inf, -0.0 and float32 extremes. | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `x_csr_uint16` | CSR X, uint16 data. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_unsorted` | CSR X with column indices in descending order inside each row. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_csr_z2_chunked_blosc` | CSR X in zarr v2 with 64-element chunks and Blosc zstd. | v2 |  |  |  |  |  |  | read exactly |
| `x_csr_z3_sharded` | CSR X in zarr v3 with 64-element chunks inside 256-element shards. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_1x1` | Dense X with a single row and a single column (1 x 1). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_bigendian` | Dense big-endian float32 X (written from a '>f4' array). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_bool` | Dense X of dtype bool (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_float16` | Dense X of dtype float16 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_float16_extremes` | Dense float16 X with 65504, subnormals, NaN, +-inf, -0.0. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_float32` | Dense X of dtype float32 (integer variants include the dtype's extreme values). | h5ad v2 v3 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | h5ad v2 | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/`; 0.6.22.post1 v2: read exactly, or refuse naming zarr v2 object codec 'json2' (anndata 0.6 structured obs/var) |
| `x_dense_float64` | Dense X of dtype float64 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_h5_chunk_cols` | Dense X chunked in narrow column strips (5 wide; last strip partial). | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_chunk_rows` | Dense X chunked in row blocks of 16 (last block partial). | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_chunk_square` | Dense X in 16x16 chunks; edge chunks are partial. | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_contiguous` | Dense X, contiguous HDF5 layout (anndata default). | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_fletcher32` | Dense X with the Fletcher-32 checksum filter. | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_gzip` | Dense X, gzip level 6. | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_gzip_shuffle` | Dense X, shuffle + gzip. | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_lzf` | Dense X, LZF (h5py's built-in filter; scanpy writes it). | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_resizable` | Dense X chunked with unlimited maxshape in both dimensions. | h5ad |  |  |  |  |  |  | read exactly |
| `x_dense_h5_scaleoffset` | Dense float X with the lossy scale-offset filter (3 decimal digits kept). | h5ad |  |  |  |  |  |  | read exactly, or refuse naming HDF5 scale-offset filter (id 6) |
| `x_dense_int16` | Dense X of dtype int16 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_int32` | Dense X of dtype int32 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_int64` | Dense X of dtype int64 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  | h5ad | h5ad | read exactly; 0.6.22.post1 h5ad: current anndata differs at `uns/` |
| `x_dense_int64_huge_counts` | Dense int64 counts far beyond float32 precision (2^40, 2^53+1, 2^62). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_int8` | Dense X of dtype int8 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_missing_chunks` | Dense X in zarr v2 with all-zero chunks that zarr does not store (absent chunks = fill_value 0). | v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_special_float32` | Dense float32 X with NaN, +inf, -inf, -0.0, float32 max/min-subnormal. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_special_float64` | Dense float64 X with NaN, +-inf, -0.0, +-1e40, subnormals and float64 max. | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_uint16` | Dense X of dtype uint16 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_uint32` | Dense X of dtype uint32 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_uint64` | Dense X of dtype uint64 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_uint8` | Dense X of dtype uint8 (integer variants include the dtype's extreme values). | h5ad v2 v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_blosc_blosclz` | Dense X in zarr v2: Blosc blosclz. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_blosc_lz4` | Dense X in zarr v2: Blosc lz4 + byte shuffle. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_blosc_lz4hc` | Dense X in zarr v2: Blosc lz4hc. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_blosc_zlib` | Dense X in zarr v2: Blosc zlib, no shuffle. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_blosc_zstd` | Dense X in zarr v2: Blosc zstd + bit shuffle. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_bz2` | Dense X in zarr v2: BZ2. | v2 |  |  |  |  |  |  | read exactly, or refuse naming zarr codec 'bz2' |
| `x_dense_z2_chunk_cols` | Dense X in zarr v2: narrow 5-wide column strips. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_chunk_rows` | Dense X in zarr v2: row blocks of 16. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_chunk_square` | Dense X in zarr v2: 16x16 chunks with partial edges. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_fill_nan` | Dense X in zarr v2: fill_value NaN, so all-NaN chunks are not stored. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_gzip` | Dense X in zarr v2: GZip level 5. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_lz4` | Dense X in zarr v2: numcodecs LZ4 (not inside Blosc). | v2 |  |  |  |  |  |  | read exactly, or refuse naming zarr codec 'lz4' |
| `x_dense_z2_lzma` | Dense X in zarr v2: LZMA. | v2 |  |  |  |  |  |  | read exactly, or refuse naming zarr codec 'lzma' |
| `x_dense_z2_order_f` | Dense X in zarr v2: Fortran (column-major) chunk order. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_shuffle_filter` | Dense X in zarr v2: Shuffle filter + Zlib compressor. | v2 |  |  |  |  |  |  | read exactly, or refuse naming zarr filter 'shuffle' |
| `x_dense_z2_uncompressed` | Dense X in zarr v2: no compressor. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_zlib` | Dense X in zarr v2: Zlib level 5. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z2_zstd` | Dense X in zarr v2: Zstd level 3. | v2 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_bigendian` | Dense X in zarr v3: bytes codec with big-endian byte order. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_blosc_lz4` | Dense X in zarr v3: Blosc lz4 + shuffle. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_blosc_zstd` | Dense X in zarr v3: Blosc zstd + bitshuffle. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_chunk_cols` | Dense X in zarr v3: narrow 5-wide column strips. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_chunk_rows` | Dense X in zarr v3: row blocks of 16. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_chunk_square` | Dense X in zarr v3: 16x16 chunks with partial edges. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_crc32c` | Dense X in zarr v3: zstd followed by a crc32c checksum. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_fill_nan` | Dense X in zarr v3: fill_value NaN, so all-NaN chunks are not stored. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_gzip` | Dense X in zarr v3: gzip level 5. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_sharded` | Dense X in zarr v3: 16x8 chunks inside 32x16 shards (sharding_indexed codec; edge shards partial). | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_sharded_gzip` | Dense X in zarr v3: sharded, inner chunks gzip-compressed. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_uncompressed` | Dense X in zarr v3: no compressor. | v3 |  |  |  |  |  |  | read exactly |
| `x_dense_z3_zstd` | Dense X in zarr v3: zstd level 3. | v3 |  |  |  |  |  |  | read exactly |
| `zarr3_auto_shard` | Small object (CSR X, dense layer, strings, categorical, obsm) written with anndata.settings.auto_shard_zarr_v3 = True: every array, strings included, is sharded. | v3 |  |  |  |  |  |  | read exactly |

Emulated layouts (`emulated/`, made from real writer output by `postprocess.py`):

| File | What it is | Reader must |
|---|---|---|
| `h5sparse_markers.h5ad` | anndata 0.7.8 CSR X relabelled the h5sparse way (h5sparse_format='csr', h5sparse_shape). | read exactly |
| `libver_latest_scanpy_like.h5ad` | anndata 0.12.19 file re-created object by object with h5py libver='latest': the Scanpy-like object. | read exactly |
| `libver_latest_x_csr_h5_chunked_gzip.h5ad` | anndata 0.12.19 file re-created object by object with h5py libver='latest': gzip CSR X with resizable 1-D arrays (extensible-array chunk index). | read exactly |
| `libver_latest_x_dense_h5_chunk_square.h5ad` | anndata 0.12.19 file re-created object by object with h5py libver='latest': dense X in 16x16 chunks (fixed-array chunk index). | read exactly |
| `libver_latest_x_dense_h5_resizable.h5ad` | anndata 0.12.19 file re-created object by object with h5py libver='latest': dense X with two unlimited dimensions (version-2 B-tree chunk index). | read exactly |
| `obsm_compound_06.h5ad` | anndata 0.6.22 file with obsm rewritten as one compound dataset (one member per embedding), the layout of anndata before 0.6.20. | read exactly |
| `seuratdisk_partial_column_order.h5ad` | anndata 0.7.8 file whose obs column-order lists only 'cell_type' and 'n_counts' while the group holds more columns, as SeuratDisk's Convert() leaves it. anndata reads only the listed columns. | read exactly |
| `track_order_scanpy_like.h5ad` | anndata 0.12.19 Scanpy-like file re-created with track_order=True on the file and every group (creation-order indexed links). | read exactly |

<!-- variant-matrix:end -->

## What could not be produced, and why

- **Pickled object arrays.** No anndata release writes pickles. The closest
  thing, anndata 0.6's Zarr stores, encode string fields with the `json2`
  object codec; those files are in the corpus (`anndata-0.6.22.post1/*.v2.zarr`).
  zarr-python 3 cannot decode `json2`, so the current anndata cannot read
  them; the expected values come from anndata 0.6 reading them back, and the
  reader may read them or refuse naming the `json2` codec.
- **Dask arrays.** A dask array is written with the same encoding as a dense
  array; there is no separate on-disk layout to test.
- **A true 1-D `obsm` entry.** anndata reshapes a 1-D array to `n x 1` when it
  is assigned, so `obsm_1d` holds an `n x 1` matrix.
- **Embedded NUL in an h5ad string.** HDF5 variable-length strings cannot hold
  NUL; anndata refuses (`obs_string_nul`). Zarr keeps the NUL, so the Zarr
  files have it.
- **Columns anndata will not write:** pandas `Float64` (nullable float),
  datetime and timedelta columns are refused by every release. Mixed int/str
  and list-valued object columns are refused for h5ad; for Zarr anndata
  writes them as strings (`'1'`, `'[0, 1]'`), and that is what the files hold.
  A column named `_index`, and an index name equal to a column with different
  values, are refused.
- **A `/` in a column name** is refused for Zarr; in h5ad it becomes a nested
  group (`obs/a/b`), which is what `column_name_slash.h5ad` holds.
- **Nullable integers and booleans** do not exist before 0.8 (0.6 and 0.7
  refuse them). **Nullable strings** need 0.11 or later
  (`settings.allow_write_nullable_strings`); 0.6 to 0.10 write the column as
  a categorical. **obsp/varp** do not exist in 0.6.
- **anndata 0.6 Zarr with non-ASCII strings** is refused by 0.6 itself
  (it encodes with ASCII).
- **SeuratDisk files** need R; they are emulated from real anndata 0.7.8
  output exactly as `Convert()` leaves them (`emulated/`). anndata 0.6
  itself marks sparse matrices the h5sparse way (`h5sparse_format`,
  `h5sparse_shape`), so the 0.6 sparse files are real h5sparse-style output;
  `emulated/h5sparse_markers.h5ad` puts the same markers on a 0.7 layout. Files from h5py with `libver='latest'` and with
  `track_order=True` are re-created object by object from real anndata files.

## Where the current anndata disagrees with the writing release

Recorded per file in `current_anndata_differs` / `current_anndata_unreadable`;
the expected values keep what the writing release read back.

- anndata 0.6 stored every `uns` scalar as a one-element array and unwrapped
  it on reading; the current anndata returns the one-element array
  (`uns/...`).
- anndata 0.6 stored `raw.var` categoricals as integer codes in the compound
  `raw.var` dataset, with the categories in `uns['<column>_categories']`; the
  current anndata returns the codes (`raw/var/...`).
- anndata 0.6 Zarr stores (`json2` codec, above).

## Expected-values JSON

One compact JSON object per fixture (`<file>.expected.json`). Numbers:

- Finite floats are JSON numbers, printed so they parse back to the identical
  float64 (a float32 value appears as its exact float64 widening, e.g. 0.1f is
  `0.10000000149011612`). `-0.0` is written as `-0.0`.
- `NaN`, `Infinity`, `-Infinity` are the strings `"NaN"`, `"Infinity"`,
  `"-Infinity"`.
- Integers are JSON numbers when |v| <= 2^53 - 1 and decimal strings
  otherwise (`"9223372036854775807"`), so nothing is rounded by `JSON.parse`.
- Booleans are `true` / `false`; missing values are `null`.

Top-level keys:

| Key | Meaning |
|---|---|
| `schema` | `1` |
| `file`, `format`, `zarr_format` | file name next to this JSON; `"h5ad"` or `"zarr"`; `2`, `3` or `null` |
| `writer` | `{tool, version, settings, write_kwargs}` (anndata settings / write arguments used); emulated files: `{tool: "emulated", base_writer, base_file}` |
| `variant`, `description`, `covers` | variant name, what it holds, tags (`X:csr`, `special-values`, ...) |
| `reader` | `{expect: "read"}`, `{expect: "read-or-refuse", refuse_reason}` or `{expect: "refuse", refuse_reason}` |
| `expected_source` | who computed the values: the writer reading its file back, or the current anndata (and why) |
| `current_anndata_differs` / `current_anndata_unreadable` | see above; absent when there is nothing to say |
| `n_obs`, `n_vars` | shape |
| `obs`, `var` | dataframe (below) |
| `X` | matrix (below) or `null` when the file has no X |
| `layers`, `obsm`, `varm`, `obsp`, `varp` | `{name: {t: "matrix", v: matrix} or {t: "dataframe", v: dataframe} or {t: "other", type}}` |
| `raw` | `null` or `{n_vars, var: dataframe, X: matrix, varm}` |
| `uns_title` | `uns["title"]` as a string (a one-element array is unwrapped), or `null` |
| `uns` | typed tree (below) |
| `storage` | on-disk layout (below) |

**Dataframe** `{n_rows, index_name, index, columns}`; `index` is the list of
index values (strings). `columns` is in file order, each
`{name, kind, ...}`:

- `kind: "numeric"`, `dtype` (numpy name, e.g. `int8`, `uint64`, `float16`), `values`
- `kind: "bool"`, `values`
- `kind: "string"`, `values` (strings; `null` for missing)
- `kind: "categorical"`, `ordered`, `categories: {kind: string|integer|float|bool, dtype, values}`,
  `codes` (integers, `-1` = missing). The stored code width is in `storage`.
- `kind: "nullable-integer" | "nullable-boolean" | "nullable-string"`, `dtype` (pandas name), `values` with `null`
- `kind: "other"`, `values` as Python reprs (not expected to occur)

A list longer than 1000 items (only the categories of `obs_cat_wide_int32`)
is replaced by `{count, first5, last5, sha256_strings}`.

**Matrix** `{format: "dense"|"csr"|"csc", dtype, shape, nnz_stored?, stats, sha256_f64, ...}`:

- `nnz_stored`: number of stored entries of a sparse matrix, explicit zeros
  and duplicates included.
- Values are those of the dense matrix, duplicates summed.
- `stats`: `count_nonzero` (NaN counts as non-zero), `n_nan`, `n_posinf`,
  `n_neginf`, `n_negzero`, `min` / `max` (ignoring NaN; in the stored dtype),
  `fsum` (correctly rounded sum of the finite values as float64, Python's
  `math.fsum`; JS needs an exact summation such as Shewchuk's to match).
- `sha256_f64`: SHA-256 of the dense matrix converted to float64,
  little-endian, row-major, with every NaN written as `0x7FF8000000000000`.
  This checks every value exactly.
- When the matrix has at most 1000 elements: `values`, all of them, row-major.
- Otherwise: `first5` / `last5` (row-major), `rows: {"<i>": [...]}` and
  `cols: {"<j>": [...]}` for the first, middle and last row/column plus the
  first all-zero row/column if there is one.

**uns tree**: every node is `{t, ...}`: `dict` (`v`: object of nodes), `str`
(`v`), `bool` (`v`), `num` (`kind: int|float`, `v`), `num0d` (`dtype`, `v`),
`array` (`dtype`, `shape`, `v`: flattened values, or a matrix object when
large), `strings` (`shape`, `v`), `records` (structured/compound arrays:
`shape`, `fields: {name: {dtype, values}}`), `dataframe` (`v`), `sparse`
(`v`: matrix), `none`, `other` (`type`).

**storage**: the layout on disk, re-derived from the bytes by the verifier.
For h5ad `{superblock_version, nodes}`; for Zarr `{zarr_format, consolidated, nodes}`.
`nodes` maps every path (`/`, `/obs`, `/obs/cell_type/codes`, ...) to:

- groups: `{type: "group", encoding: "<encoding-type>@<encoding-version>", attrs, track_order?}`
- h5ad datasets: `{type: "array", dtype, shape, layout: contiguous|chunked|compact, chunks?, maxshape?, filters?, encoding?, attrs?}`;
  `dtype` is the numpy dtype string, or `vlen-str(utf-8)`, `fixed-str[n](ascii)`,
  `enum(...)` (h5py booleans), a list of `[name, dtype]` pairs for compound
  types; `filters` are `name(id=N,values=[...])`. Object references in
  attributes (the 0.7 `categories` attribute) appear as `{object_reference: "/path"}`.
- Zarr v2 arrays: `{type, dtype, shape, chunks, order, fill_value, dimension_separator, compressor, filters, stored_chunk_files}`
- Zarr v3 arrays: `{type, dtype, shape, chunks (the outer chunk = shard shape when sharded), chunk_key_encoding, fill_value, codecs, stored_chunk_files}`;
  codecs as `name(key=value,...)`; sharding as
  `sharding_indexed(chunk_shape=AxB,codecs=[...],index_codecs=[...],index_location=end)`.

`stored_chunk_files` below the number of chunks means some chunks are absent
and read as `fill_value`.

## Verification

```
<0.12 venv>/bin/python scripts/anndata-corpus/verify_with_python.py tests/fixtures/anndata
```

Last run (anndata 0.12.19, after a full `generate.py --verify`):

```
anndata 0.12.19: 573 fixtures, ok 537, known-difference 24, known-unreadable 12, differs 0, unreadable 0
```

All 36 "known" files are anndata 0.6.22 output: 24 `.h5ad` files differ only
at the recorded `uns/` and `raw/var/` paths, and 12 Zarr stores use the
`json2` codec (see above). Every other file matches its expected values and
its recorded storage layout exactly.
