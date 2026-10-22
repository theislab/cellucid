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

`byte-order-big-endian.h5ad` and `byte-order-little-endian.h5ad` are an
eight-cell, three-gene pair carrying identical values that differ only in the
recorded HDF5 datatype byte order of every multi-byte dataset, plus the numeric
`shape` attribute on the sparse `obsp/connectivities` group:

```bash
python scripts/generate-byte-order-h5ad-fixtures.py
```

The generator is deterministic and re-verifies the recorded byte order of each
dataset before finishing. `tests/h5ad-byte-order-contract.test.mjs` loads both
through the real `H5adDataSource` path and requires identical numbers, which
pins the guarantee that HDF5 converts stored data to the host byte order — the
reason `classifyH5WasmDtype` may discard the NumPy byte-order prefix. Every
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
4-column `coordinates` and six wide latent and PCA arrays, plus a layer and a
neighbour graph; the sidebar layout, the dimension choice of a narrow array
and the sidebar's scroll position are tested on it. The 12,000-cell
`data-mapping-representations.h5ad` and `data-mapping-full.h5ad` (with its Zarr
ZIP and `data-mapping-full.expected.json`) are described in the generator.
Every array is drawn from a seeded generator:

```bash
python scripts/generate-data-mapping-fixtures.py
```
