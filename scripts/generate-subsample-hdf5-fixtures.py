"""Write the `.h5ad` stores the subsampled-read differential test reads.

``tests/fixtures/subsample/*.h5ad``: one small AnnData (300 cells; a
categorical obs field with an unused category and missing codes, a float
column, a 2-D embedding with NaN rows, a neighbour graph with self-loops, a
CSR layer) written in every HDF5 layout the reader treats differently:

- ``X`` as CSR, CSC or dense;
- every array chunked and gzip-compressed (decoded a chunk at a time),
  chunked without a filter (the reader fetches a chunk's rows alone:
  ``partialChunks``), or contiguous (read byte by byte);
- the earliest file format (version 1 B-tree chunk indexes) or the latest
  (fixed-array, extensible-array and version 2 B-tree indexes).

Chunks are small (17 elements, 7 rows), so a subsample has many chunks to
skip. ``tests/subsample-gather-differential.test.mjs`` reads each through a
subsample and compares with reading every cell and taking the kept rows.

Run from the repository root (needs ``anndata``, ``h5py``)::

    python scripts/generate-subsample-hdf5-fixtures.py
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

import anndata as ad
import h5py
import numpy as np
import pandas as pd
from scipy import sparse

TARGET = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "subsample"
N_CELLS, N_GENES = 300, 12


def base() -> ad.AnnData:
    rng = np.random.default_rng(20261027)
    density = rng.random(N_CELLS) * 0.6
    values = rng.random((N_CELLS, N_GENES)) < density[:, None]
    values[rng.random(N_CELLS) < 0.1] = False  # empty rows
    values[:, 3] = False  # an all-zero gene
    X = np.where(values, rng.gamma(2.0, 1.5, (N_CELLS, N_GENES)), 0).astype(np.float32)
    codes = rng.integers(0, 4, N_CELLS)
    codes[rng.random(N_CELLS) < 0.05] = -1
    cluster = pd.Categorical.from_codes(codes, categories=["a", "b", "c", "d", "unused"])
    obs = pd.DataFrame({"cluster": cluster, "score": rng.random(N_CELLS).astype(np.float32)},
                       index=[f"cell-{i}" for i in range(N_CELLS)])
    umap = rng.normal(size=(N_CELLS, 2)).astype(np.float32)
    umap[rng.random(N_CELLS) < 0.02] = np.nan
    graph = sparse.random(N_CELLS, N_CELLS, density=0.02, random_state=1, format="csr", dtype=np.float32)
    graph = (graph + sparse.eye(N_CELLS, dtype=np.float32, format="csr")).tocsr()
    return ad.AnnData(
        X=sparse.csr_matrix(X),
        obs=obs,
        var=pd.DataFrame(index=[f"g{g}" for g in range(N_GENES)]),
        obsm={"X_umap": umap},
        obsp={"connectivities": graph},
        layers={"counts": sparse.csr_matrix(np.round(X * 3))},
    )


def copy_tree(source: h5py.Group, target: h5py.Group, storage: str) -> None:
    for key, value in source.attrs.items():
        target.attrs[key] = value
    for name, node in source.items():
        if isinstance(node, h5py.Group):
            copy_tree(node, target.create_group(name), storage)
            continue
        data = node[()]
        options: dict = {}
        if node.shape and node.size > 1 and storage != "contiguous":
            rows = 17 if len(node.shape) == 1 else 7
            options["chunks"] = (min(rows, node.shape[0]),) + tuple(node.shape[1:])
            if storage == "gzip":
                options["compression"] = "gzip"
        dataset = target.create_dataset(name, data=data, dtype=node.dtype, **options)
        for key, value in node.attrs.items():
            dataset.attrs[key] = value


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    adata = base()
    for layout, storage, libver in itertools.product(("csr", "csc", "dense"), ("gzip", "unfiltered", "contiguous"), ("earliest", "latest")):
        current = adata.copy()
        if layout == "csc":
            current.X = sparse.csc_matrix(current.X)
        elif layout == "dense":
            current.X = current.X.toarray()
        with tempfile.TemporaryDirectory() as folder:
            plain = Path(folder) / "plain.h5ad"
            current.write_h5ad(plain)
            out = TARGET / f"{layout}-{storage}-{libver}.h5ad"
            with h5py.File(plain, "r") as source, h5py.File(out, "w", libver=(libver, "latest")) as target:
                copy_tree(source, target, storage)
        print("wrote", out)


if __name__ == "__main__":
    main()
