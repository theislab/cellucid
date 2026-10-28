"""Create the gene-read fixtures: one small dataset shaped as CELLxGENE
publishes its Census ``.h5ad`` files, in every layout a gene is read from.

``tests/gene-read-every-source.test.mjs`` reads genes from them through every
link provider (mocked hosts), a served folder, the viewer host and a local
file, and checks the gene names, the symbol search and what the first gene of
a cell-major matrix is said to cost.

The shape is the Census's (e.g. the Human Lung Cell Atlas,
``9f222629-9e39-47d0-b83f-e08d610c7479``), scaled down:

- ``var`` index of Ensembl ids, symbols in the categorical ``feature_name``
  beside ``feature_reference``, ``feature_biotype``, ``feature_length`` and
  ``feature_is_filtered`` (none of which name genes);
- ``X`` CSR (cell-major), ``indices`` and ``indptr`` int64, gzip in small
  chunks (64 entries), so one gene of the file is spread over every chunk;
- ``raw/X`` the same matrix, ``obsm['X_umap']`` (2-D),
  ``obs['cell_type']`` categorical; no ``uns['cellucid']``.

Written as ``cellxgene-shaped.h5ad`` (CSR), ``cellxgene-shaped-csc.h5ad``
(the same values gene-major), ``cellxgene-shaped-dense.h5ad`` (dense, in
chunks of whole rows: cell-major) and ``cellxgene-shaped.zarr.zip`` (Zarr v2,
CSR), and ``positions-beyond-2-32.h5``: 5e9-entry ``indices`` (int64) and
``data`` (float32) arrays of which only the chunks holding positions 2^31 and
2^32 are written, each value its own position (stored-value positions of the
lung atlas pass 2^31). ``cellxgene-shaped.expected.json`` records, computed here with numpy
and independently of the browser's code: the ids, the symbols, the stored
entries, and the float32 values of the genes the test reads.

Run with an environment that has ``anndata``, ``h5py``, ``zarr`` and
``scipy``::

    python scripts/generate-gene-read-fixtures.py           # write
    python scripts/generate-gene-read-fixtures.py --check   # compare, write nothing
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import anndata as ad
import h5py
import numpy as np
import pandas as pd
import scipy.sparse as sp
import zarr

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "gene-read"
N_CELLS = 300
CHUNK = 64
SYMBOLS = [
    "SFTPC", "EPCAM", "SFTPB", "AGER", "SCGB1A1", "FOXJ1", "KRT5", "PTPRC", "CD3E", "MS4A1",
    "LYZ", "MARCO", "PECAM1", "VWF", "COL1A2", "ACTA2", "MT-CO1", "HLA-DRB1", "LINC01128", "AL627309.1",
    "NKG7", "GNLY", "CD68", "C1QA", "TPSAB1", "KIT", "MKI67", "TOP2A", "SCGB3A2", "NAPSA",
    "LAMP3", "ABCA3", "HOPX", "CAV1", "EMP2", "RTKN2", "CLDN18", "AQP4", "MUC5B", "BPIFB1",
]
GENES_READ = ["SFTPC", "EPCAM", "MT-CO1", "AL627309.1"]
HUGE = 5_000_000_000
HUGE_CHUNK = 1000


def ensembl(position: int) -> str:
    return f"ENSG{168484 + 7919 * position:011d}"


def dataset() -> ad.AnnData:
    rng = np.random.default_rng(20261027)
    n_genes = len(SYMBOLS)
    clusters = rng.integers(0, 4, N_CELLS)
    density = rng.uniform(0.05, 0.45, n_genes)
    # SFTPC in about one cell in ten (alveolar type 2 cells), all of one cluster.
    density[0] = 0.0
    mask = rng.random((N_CELLS, n_genes)) < density
    mask[:, 0] = (clusters == 2) & (rng.random(N_CELLS) < 0.45)
    counts = rng.poisson(3.0, (N_CELLS, n_genes)) + 1
    dense = np.where(mask, counts, 0).astype(np.float32)
    X = sp.csr_matrix(dense)
    X.indices = X.indices.astype(np.int64)
    X.indptr = X.indptr.astype(np.int64)
    var = pd.DataFrame(
        {
            "feature_is_filtered": np.zeros(n_genes, dtype=bool),
            "feature_name": pd.Categorical(SYMBOLS),
            "feature_reference": pd.Categorical(["NCBITaxon:9606"] * n_genes),
            "feature_biotype": pd.Categorical(["gene"] * n_genes),
            "feature_length": rng.integers(500, 9000, n_genes).astype(np.int64),
        },
        index=pd.Index([ensembl(g) for g in range(n_genes)]),
    )
    obs = pd.DataFrame(
        {"cell_type": pd.Categorical([["AT1", "AT2", "basal", "macrophage"][c] for c in clusters])},
        index=pd.Index([f"cell-{i:04d}" for i in range(N_CELLS)]),
    )
    umap = np.stack([clusters * 4.0 + rng.normal(0, 1, N_CELLS), rng.normal(0, 1, N_CELLS)], axis=1).astype(np.float32)
    adata = ad.AnnData(X=X, obs=obs, var=var, obsm={"X_umap": umap})
    adata.raw = adata.copy()
    return adata


def rechunk_sparse(path: Path, group: str) -> None:
    """Rewrite a sparse matrix's arrays as int64 / float32 in gzip chunks of CHUNK entries."""
    with h5py.File(path, "r+") as file:
        node = file[group]
        for name, dtype in (("data", np.float32), ("indices", np.int64), ("indptr", np.int64)):
            values = node[name][()].astype(dtype)
            del node[name]
            node.create_dataset(name, data=values, chunks=(min(CHUNK, len(values)),), compression="gzip", compression_opts=4)


def write_all(directory: Path) -> dict:
    adata = dataset()
    csr = directory / "cellxgene-shaped.h5ad"
    adata.write_h5ad(csr)
    rechunk_sparse(csr, "X")
    rechunk_sparse(csr, "raw/X")

    csc = adata.copy()
    csc.X = sp.csc_matrix(adata.X)
    csc.X.indices = csc.X.indices.astype(np.int64)
    csc.X.indptr = csc.X.indptr.astype(np.int64)
    csc.write_h5ad(directory / "cellxgene-shaped-csc.h5ad")

    dense = adata.copy()
    dense.X = np.asarray(adata.X.todense(), dtype=np.float32)
    dense_path = directory / "cellxgene-shaped-dense.h5ad"
    dense.write_h5ad(dense_path)
    with h5py.File(dense_path, "r+") as file:
        values = file["X"][()]
        attributes = dict(file["X"].attrs)
        del file["X"]
        # Whole rows per chunk: a gene is spread over every chunk (cell-major).
        file.create_dataset("X", data=values, chunks=(16, values.shape[1]), compression="gzip")
        for key, value in attributes.items():
            file["X"].attrs[key] = value

    folder = Path(tempfile.mkdtemp())
    try:
        store = folder / "cellxgene-shaped.zarr"
        adata.write_zarr(store, chunks=None)
        # A web host cannot list a folder: its metadata is consolidated, as
        # a published store's must be.
        zarr.consolidate_metadata(str(store))
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
            for file in sorted(store.rglob("*")):
                if file.is_file():
                    info = zipfile.ZipInfo(file.relative_to(store).as_posix(), date_time=(2026, 10, 27, 0, 0, 0))
                    archive.writestr(info, file.read_bytes())
        (directory / "cellxgene-shaped.zarr.zip").write_bytes(buffer.getvalue())
    finally:
        shutil.rmtree(folder)

    # Stored-value positions past 2^31 and 2^32 (the lung atlas holds
    # 4,033,400,260): a 5e9-entry int64 `indices` and float32 `data` of
    # which only the chunks holding 2^31 and 2^32 are written.
    with h5py.File(directory / "positions-beyond-2-32.h5", "w") as file:
        for name, dtype in (("indices", np.int64), ("data", np.float32)):
            array = file.create_dataset(name, shape=(HUGE,), dtype=dtype, chunks=(HUGE_CHUNK,), fillvalue=0, compression="gzip")
            for boundary in (2**31, 2**32):
                start = boundary // HUGE_CHUNK * HUGE_CHUNK
                array[start:start + HUGE_CHUNK] = (np.arange(start, start + HUGE_CHUNK) % 2**53).astype(dtype)

    X = adata.X
    genes = {}
    for symbol in GENES_READ:
        position = SYMBOLS.index(symbol)
        column = np.asarray(X[:, position].todense(), dtype=np.float32).ravel()
        genes[symbol] = {
            "position": position,
            "id": ensembl(position),
            "nonzero": int(np.count_nonzero(column)),
            "values": [float(v) for v in column],
        }
    return {
        "n_obs": N_CELLS,
        "n_vars": len(SYMBOLS),
        "nnz": int(X.nnz),
        "chunk": CHUNK,
        "ids": [ensembl(g) for g in range(len(SYMBOLS))],
        "symbols": SYMBOLS,
        "genes": genes,
    }


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = Path(tempfile.mkdtemp()) if args.check else OUT
    target.mkdir(parents=True, exist_ok=True)
    expected = write_all(target)
    text = json.dumps(expected, indent=1) + "\n"
    (target / "cellxgene-shaped.expected.json").write_text(text)
    if args.check:
        stale = [p.name for p in sorted(target.iterdir()) if not (OUT / p.name).exists() or digest(p) != digest(OUT / p.name)]
        shutil.rmtree(target)
        if stale:
            print("Out of date:", ", ".join(stale))
            return 1
        print("Up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
