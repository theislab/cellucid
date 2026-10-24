# Browser AnnData fixtures

`current-ui-smoke.h5ad` is the 120-cell, six-gene direct-H5AD fixture used by
the visible file-picker acceptance.

`current-ui-smoke.zarr.zip` is generated from that H5AD with the AnnData Zarr
writer and a deterministic ZIP container:

```bash
python scripts/generate-zarr-browser-fixture.py
```

The archive contains one `current-ui-smoke.zarr/` root and fixed ZIP metadata,
so identical Zarr writer output produces identical archive bytes.

`zarr-fixtures.expected.json` records what zarr-python reads from every
`*.zarr.zip` here (tree, attributes, shapes, chunks, fill values, and a digest
of every array's values); `tests/zarr-format-fixtures.test.mjs` requires the
app's Zarr reader to read the same. Regenerate it whenever an archive changes:

```bash
python scripts/generate-zarr-browser-fixture-expected.py
```

`byte-order-big-endian.h5ad` and `byte-order-little-endian.h5ad` are an
eight-cell, three-gene pair carrying identical values that differ only in the
recorded HDF5 datatype byte order of every multi-byte dataset, plus the numeric
`shape` attribute on the sparse `obsp/connectivities` group:

```bash
python scripts/generate-byte-order-h5ad-fixtures.py
```

The generator is deterministic and re-verifies the recorded byte order of each
dataset before finishing. `tests/h5ad-byte-order-contract.test.mjs` loads both
through the real `AnnDataFileSource` path and requires identical numbers, which
pins the guarantee that the HDF5 reader converts stored data to the host byte
order — the reason the AnnData reader judges an array by its kind alone and
never by its stored byte order. `dataset-switch-owned-state.spec.mjs` and
`smoke-dataset-switch.spec.mjs` open the little-endian file over
`data-mapping-full.h5ad` as the smaller dataset (fewer cells, genes and
fields) a switch replaces it with. Every
value in the pair is chosen so that reading it in the wrong byte order produces
a *different* number, so the fixture cannot quietly stop discriminating.

`data-mapping-guess.h5ad`, `data-mapping-guess.zarr.zip`,
`data-mapping-wide.h5ad` and `data-mapping-multi.h5ad` are the 300-cell
data-mapping fixtures used by `tests/browser/data-mapping.spec.mjs`: a file
with no UMAP whose best-ranked candidate holds a NaN (so the best guess skips
it for `X_tsne`), one with only a wide `X_pca` (guessed at columns 0 and 1),
and one with `X_umap`, `X_tsne`, `X_pca` and a vector field bound to `X_umap`.
`data-mapping-crowded.h5ad` (`tests/browser/data-mapping-layout.spec.mjs`)
holds twelve embeddings with no default UMAP, as a segmentation export has
them: three 2-column `X_umap_scale*_latents`, two 3-column arrays, an integer
4-column `coordinates` and six wide latent and PCA arrays, plus a layer, a
neighbour graph and Scanpy's colours for `cell_type`
(`uns['cell_type_colors']`); the sidebar layout, the dimension choice of a
narrow array and the sidebar's scroll position are tested on it, and
`tests/browser/dataset-switch-opening-view.spec.mjs` opens it after another
dataset (the embedding, camera, point size and palette it opens with). The 12,000-cell
`data-mapping-representations.h5ad` and `data-mapping-full.h5ad` (with its Zarr
ZIP) are described in the generator. Every array is drawn from a seeded
generator, so a second run writes the same bytes.
`data-mapping-full.expected.json` is what the browser must read from the full
fixture -- each neighbour graph's edges or its refusal, every gene list's names
and values, the outlier quantiles of every latent space and categorical field,
and every bound vector payload -- computed by the generator with numpy,
independently of the browser's code, which the `data-mapping-*-contract` and
`outlier-quantile-exact-contract` tests check against it:

```bash
python scripts/generate-data-mapping-fixtures.py          # write
python scripts/generate-data-mapping-fixtures.py --check  # compare, write nothing
```

`outliers-stored.h5ad` and `outliers-stored.zarr.zip` are written by
`cellucid.prepare(latent_key="X_scVI")` itself, so they hold the outlier
quantiles the writer stores (`uns['cellucid']['outlierQuantiles']`);
`outliers-stale.h5ad` is the same file with `cell_type` changed afterwards, so
its stored quantiles no longer fit and are computed; `outliers-stored.expected.json`
holds the digests the numpy reference gives in every latent space
(`outlier-quantile-stored-contract`, `outlier-filtering.spec.mjs`):

```bash
python scripts/generate-outlier-quantile-fixtures.py   # needs cellucid-python
```

The dataset catalogs the browser specs read are written by one deterministic
generator (a second run writes the same bytes):

```bash
python scripts/generate-browser-catalog-fixtures.py
```

- `catalog/` is the default sample catalog of the specs: `datasets.json`
  (schema 2) and `current-ui.h5ad`, the current-ui cells with
  `uns['cellucid']`. Beside it, unlisted, `current-ui-vector.h5ad` carries a
  vector field on the same UMAP (`velocity_umap_2d`); a spec lists it by
  answering the catalog request itself.
- `demo-catalog/` holds the three synthetic datasets of
  `cellucid-demo-custom-datasets` as zipped Zarr stores: 1-D, 2-D and 3-D
  embeddings, connectivity and vector arrays.
- `forms-catalog/` lists the 1-D trajectory once in every form a catalog
  names: `.h5ad`, `.zarr.zip`, and `forms-zarr.zarr/`, the one Zarr store
  folder of the browser tests (one chunk per array, consolidated metadata),
  which the folder picker and folder-drop specs also read.
- `uint32-categories.h5ad` is the current-ui cells with a 70,000-category
  `cell_type`: gamma at code 0, alpha at 65,536 and beta at 69,999, so a
  16-bit copy of a code names another category; five gamma cells are missing.
- `broken-catalogs/` holds one catalog per way listing fails: a listed file
  missing, truncated or not a file at all, a file stating another id, a
  truncated `datasets.json`, and a catalog without `schema`.

`legacy-*.h5ad` and `legacy-0.7.zarr.zip` are AnnData files in the layouts
anndata wrote before 0.8 (written by anndata 0.6 and 0.7.8, plus the
SeuratDisk and h5sparse variants found in published files);
`legacy-twin-current.h5ad` and `legacy-0.6-twin-current.h5ad` hold the same
data written by a current anndata. `tests/legacy-anndata-contract.test.mjs`
requires both to read identically:

```bash
python scripts/generate-legacy-anndata-fixtures.py  # needs anndata 0.7.8 / 0.6
python scripts/generate-legacy-anndata-twin.py      # current anndata
```

Datasets whose shape a spec chooses at run time -- a cell count, a category
inventory, a damaged entry -- are built in memory by
`tests/browser/helpers/anndata-zarr-zip.mjs` and served by request
interception, not kept on disk.
