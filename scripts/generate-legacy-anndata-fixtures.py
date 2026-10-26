"""Write the AnnData files Cellucid reads in the layouts anndata wrote before 0.8.

Run once with each real old writer, so the bytes are the ones it produced
rather than an imitation of them. anndata 0.7.8 (the last of the 0.7 layout)
writes the 0.7 set; anndata 0.6.22 writes the 0.6 set:

    python -m venv legacy07 && legacy07/bin/pip install --only-binary :all: \\
        anndata==0.7.8 numpy==1.23.5 pandas==1.5.3 h5py==3.7.0 \\
        scipy==1.9.3 zarr==2.13.3 numcodecs==0.12.1
    python -m venv legacy06 && legacy06/bin/pip install --only-binary :all: \\
        anndata==0.6.22.post1 numpy==1.21.6 pandas==1.3.5 h5py==3.7.0 \\
        scipy==1.9.3 natsort
    legacy07/bin/python scripts/generate-legacy-anndata-fixtures.py
    legacy06/bin/python scripts/generate-legacy-anndata-fixtures.py

Then write their current-layout twins with ``generate-legacy-anndata-twin.py``.

Three more variants are found in published files and are made here the way
those writers leave them, by editing a written file:

- SeuratDisk's ``Convert()`` writes a ``column-order`` that lists only some of
  a dataframe's columns;
- files from the h5sparse era name a sparse matrix with ``h5sparse_format``
  and ``h5sparse_shape`` instead of an encoding;
- anndata before 0.6.20 stored ``obsm`` as one compound dataset with a member
  per embedding.
"""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path

import anndata
import h5py
import numpy as np
import pandas as pd
from scipy import sparse

if anndata.__version__ not in ("0.7.8", "0.6.22.post1"):
    raise SystemExit(f"Run with anndata 0.7.8 or 0.6.22.post1, not {anndata.__version__}.")
LEGACY_06 = anndata.__version__.startswith("0.6.")

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPOSITORY_ROOT / "tests" / "browser" / "fixtures"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
N_CELLS = 120
N_GENES = 6


def legacy_anndata(matrix_format: str) -> anndata.AnnData:
    rng = np.random.default_rng(7)
    cell_types = np.array(["B cell", "T cell", "Monocyte"])[np.arange(N_CELLS) % 3]
    batch = pd.Categorical(
        np.where(np.arange(N_CELLS) % 10 == 0, None, np.array(["a", "b"])[np.arange(N_CELLS) % 2]),
        categories=["a", "b"],
    )
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical(cell_types, categories=["B cell", "Monocyte", "T cell"]),
            "batch": batch,
            "stage": pd.Categorical(
                np.array(["early", "mid", "late"])[np.arange(N_CELLS) % 3],
                categories=["early", "mid", "late"],
                ordered=True,
            ),
            "n_counts": rng.integers(500, 5000, N_CELLS).astype(np.int64),
            "percent_mito": rng.random(N_CELLS).astype(np.float32),
            "is_doublet": np.arange(N_CELLS) % 17 == 0,
        },
        index=[f"cell-{i:03d}" for i in range(N_CELLS)],
    )
    var = pd.DataFrame(
        {
            "gene_symbol": [f"GENE{i}" for i in range(N_GENES)],
            "highly_variable": np.arange(N_GENES) % 2 == 0,
            "mean": rng.random(N_GENES),
        },
        index=[f"ENSG{i:011d}" for i in range(N_GENES)],
    )
    dense = (rng.random((N_CELLS, N_GENES)) * (rng.random((N_CELLS, N_GENES)) > 0.4)).astype(np.float32)
    X = dense if matrix_format == "dense" else getattr(sparse, f"{matrix_format}_matrix")(dense)
    angle = np.arange(N_CELLS) / N_CELLS * 2 * np.pi
    umap = np.column_stack([np.cos(angle), np.sin(angle)]).astype(np.float32) * (1 + np.arange(N_CELLS) % 3)[:, None]
    graph = sparse.csr_matrix(
        (np.ones(N_CELLS * 2, dtype=np.float32),
         (np.repeat(np.arange(N_CELLS), 2),
          np.concatenate([[(i + 1) % N_CELLS, (i - 1) % N_CELLS] for i in range(N_CELLS)]))),
        shape=(N_CELLS, N_CELLS),
    )
    adata = anndata.AnnData(
        X=X,
        obs=obs,
        var=var,
        obsm={"X_umap": umap, "X_pca": rng.random((N_CELLS, 10)).astype(np.float32)},
        layers={"counts": sparse.csr_matrix(np.round(dense * 10))},
        uns={
            "title": f"Legacy AnnData {'0.6' if LEGACY_06 else '0.7'} fixture",
            "params": {"n_neighbors": 15, "method": "umap"},
        },
    )
    # obsp arrived in 0.7.
    if not LEGACY_06:
        adata.obsp["connectivities"] = graph
    adata.raw = adata.copy()
    return adata


def write_zip(store: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
        for source in sorted(path for path in store.rglob("*") if path.is_file()):
            info = zipfile.ZipInfo(f"{store.name}/{source.relative_to(store).as_posix()}", date_time=ZIP_TIMESTAMP)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes())


def main_06() -> None:
    target = FIXTURES / "legacy-0.6.h5ad"
    legacy_anndata("csr").write_h5ad(target)

    compound_obsm = FIXTURES / "legacy-0.6-compound-obsm.h5ad"
    shutil.copyfile(target, compound_obsm)
    with h5py.File(compound_obsm, "r+") as file:
        umap = file["obsm/X_umap"][()]
        pca = file["obsm/X_pca"][()]
        del file["obsm"]
        records = np.zeros(
            N_CELLS,
            dtype=[("X_umap", umap.dtype, (umap.shape[1],)), ("X_pca", pca.dtype, (pca.shape[1],))],
        )
        records["X_umap"] = umap
        records["X_pca"] = pca
        file.create_dataset("obsm", data=records)


def main() -> None:
    if LEGACY_06:
        main_06()
        return
    legacy_anndata("dense").write_h5ad(FIXTURES / "legacy-0.7-dense.h5ad")
    legacy_anndata("csr").write_h5ad(FIXTURES / "legacy-0.7-csr.h5ad")

    seuratdisk = FIXTURES / "legacy-seuratdisk.h5ad"
    shutil.copyfile(FIXTURES / "legacy-0.7-csr.h5ad", seuratdisk)
    with h5py.File(seuratdisk, "r+") as file:
        file["obs"].attrs["column-order"] = np.array(["cell_type", "n_counts"], dtype=object)

    h5sparse = FIXTURES / "legacy-h5sparse.h5ad"
    shutil.copyfile(FIXTURES / "legacy-0.7-csr.h5ad", h5sparse)
    with h5py.File(h5sparse, "r+") as file:
        X = file["X"]
        shape = np.array(X.attrs["shape"])
        for key in ("encoding-type", "encoding-version", "shape"):
            del X.attrs[key]
        X.attrs["h5sparse_format"] = "csr"
        X.attrs["h5sparse_shape"] = shape

    with tempfile.TemporaryDirectory(prefix="cellucid-legacy-zarr-") as temporary:
        store = Path(temporary) / "legacy-0.7.zarr"
        legacy_anndata("csr").write_zarr(store)
        write_zip(store, FIXTURES / "legacy-0.7.zarr.zip")


if __name__ == "__main__":
    main()
