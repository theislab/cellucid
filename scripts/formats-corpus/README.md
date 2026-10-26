# Layout-view corpus: Loom, 10x Cell Ranger HDF5, MuData

Small files of the formats the browser reads through layout views
(`assets/js/data/anndata/views/`), written by the real writers, and what each
format's own library reads back from them. `tests/formats-corpus-conformance.test.mjs`
opens every file through `openDatasetStore` and the AnnData reader and checks
it value for value against those values;
`tests/data-mapping-modality-contract.test.mjs` uses the multimodal ones.

## What is where

```
tests/fixtures/loom/     loompy-3.0.8.zip, loompy-2.0.17.zip, index.json
tests/fixtures/tenx/     tenx.zip, index.json
tests/fixtures/mudata/   mudata-0.4.1.zip, mudata-0.3.2.zip, mudata-0.2.4.zip, index.json
  <writer>.zip           one deflated archive per writer, holding:
    <fixture>                       a file, or a folder (a Cell Ranger outs/ folder)
    <fixture>.zarr.zip              a MuData Zarr store, packed (stored, the store at the top level)
    <fixture>.expected.json         what the library read back (see write_fixtures.py)
    _writer.json                    the writer's package versions
  index.json             every fixture: path, expected values, layout, format, refusal
```

| Writer | Python | Fixtures | Read back with |
|---|---|---|---|
| loompy 3.0.8 | 3.12 | Loom 3.0.0: attributes and a layer, velocyto layers with `_X`/`_Y`, a neighbour graph and `_tSNE1`/`_tSNE2`, SCope compound embeddings (written with h5py as pySCENIC does), loomR's cells × genes orientation (h5py), no embedding (refused) | loompy (text with h5py: loompy 3.0.8 drops the non-ASCII characters of the UTF-8 text it reads) |
| loompy 2.0.17 | 3.11 | Loom 2.0.1: fixed-length ASCII text with character references, root attributes | loompy |
| tenx (scanpy 1.12.4) | 3.12 | Cell Ranger 3+ written with h5py as `CountMatrix.save_h5_file` writes it: gene expression alone (refused: no embedding), CITE-seq (Gene Expression + Antibody Capture) in an `outs/` folder with UMAP, t-SNE, PCA and a clustering (rows shuffled, one barcode missing, one extra), the same `.h5` alone (refused), a `molecule_info.h5` (refused); Cell Ranger 1.2 files from scanpy's test data (BSD-3-Clause), one genome and two, each in an `outs/` folder with a t-SNE | `scanpy.read_10x_h5(gex_only=False)`, one genome at a time |
| mudata 0.4.1, 0.3.2, 0.2.4 | 3.12, 3.12, 3.11 | CITE-seq (RNA sparse with a layer, obs columns and a UMAP; proteins dense; a joint WNN UMAP), with every cell measured and with the proteins on fewer cells; each as `.h5mu` and MuData Zarr (v3 from 0.4.1, v2 from the others) | `mudata.read_h5mu` / `mudata.read_zarr` |

## Regenerating

```
python scripts/formats-corpus/generate.py --setup
python scripts/formats-corpus/generate.py --scanpy-data <scanpy>/tests/_data/10x_data
python scripts/formats-corpus/generate.py --writer mudata-0.4.1
```

Venvs go to `$FORMATS_CORPUS_VENVS` (default `../.formats-corpus-venvs`
beside the repository); each writer's pins are in `generate.py`.
`write_fixtures.py` runs inside each venv: it writes the fixtures, reads them
back with the format's library and stores the values; `generate.py` packs
each writer's folder and writes the indexes.
