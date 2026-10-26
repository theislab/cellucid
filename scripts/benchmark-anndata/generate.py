"""Write the AnnData files `scripts/benchmark-anndata.mjs` measures.

Realistic shapes, written by the current anndata: an atlas-like obs (many
categorical columns, numeric, boolean and nullable columns), embeddings, a
neighbour graph, and X in each layout the readers treat differently — CSR,
CSC, dense chunked by gene strips, dense contiguous — as `.h5ad` (gzip, the
way CELLxGENE and most portals ship them, and uncompressed, the anndata
default) and as Zarr (v2 and v3, each as a folder and as a ZIP).

    python scripts/benchmark-anndata/generate.py OUT_DIR [--cells N] [--genes G] [--density D]

Deterministic for a given anndata/h5py/zarr build. Nothing is committed: the
files go to OUT_DIR.
"""

from __future__ import annotations

import argparse
import json
import shutil
import zipfile
from pathlib import Path

import anndata as ad
import h5py
import numpy as np
import pandas as pd
from scipy import sparse


def make_adata(n_cells: int, n_genes: int, density: float) -> ad.AnnData:
    rng = np.random.default_rng(42)
    nnz_per_row = max(1, int(n_genes * density))
    rows = np.repeat(np.arange(n_cells), nnz_per_row)
    cols = rng.integers(0, n_genes, size=rows.size)
    data = rng.gamma(2.0, 1.5, size=rows.size).astype(np.float32)
    X = sparse.csr_matrix((data, (rows, cols)), shape=(n_cells, n_genes))
    X.sum_duplicates()
    obs = pd.DataFrame(index=[f"cell_{i}" for i in range(n_cells)])
    for k, n_cats in enumerate([3, 8, 20, 45, 120, 300, 12, 6, 2, 1000]):
        labels = np.array([f"type_{k}_{j}" for j in range(n_cats)])
        codes = rng.integers(0, n_cats, n_cells)
        obs[f"cat_{k}"] = pd.Categorical(labels[codes], categories=labels)
    for k in range(5):
        values = rng.normal(size=n_cells).astype(np.float32)
        values[rng.random(n_cells) < 0.01] = np.nan
        obs[f"score_{k}"] = values
    for k in range(3):
        obs[f"count_{k}"] = rng.integers(0, 50_000, n_cells).astype(np.int64)
    obs["is_doublet"] = rng.random(n_cells) < 0.05
    obs["is_primary"] = rng.random(n_cells) < 0.9
    nullable = pd.array(rng.integers(0, 100, n_cells), dtype="Int64")
    nullable[rng.random(n_cells) < 0.1] = pd.NA
    obs["nullable_count"] = nullable
    var = pd.DataFrame(
        {"gene_symbol": [f"SYM{g}" for g in range(n_genes)], "highly_variable": rng.random(n_genes) < 0.2},
        index=[f"ENSG{g:011d}" for g in range(n_genes)],
    )
    adata = ad.AnnData(X=X, obs=obs, var=var)
    angle = rng.random(n_cells) * 2 * np.pi
    radius = rng.random(n_cells)
    adata.obsm["X_umap"] = np.column_stack([radius * np.cos(angle), radius * np.sin(angle)]).astype(np.float32)
    adata.obsm["X_pca"] = rng.normal(size=(n_cells, 50)).astype(np.float32)
    k = 15
    src = np.repeat(np.arange(n_cells), k)
    dst = (src + rng.integers(1, n_cells, size=src.size)) % n_cells
    graph = sparse.csr_matrix((np.ones(src.size, dtype=np.float32), (src, dst)), shape=(n_cells, n_cells))
    graph = graph.maximum(graph.T)
    graph.setdiag(0)
    graph.eliminate_zeros()
    adata.obsp["connectivities"] = graph.tocsr()
    adata.uns["title"] = "Benchmark atlas"
    return adata


def zip_folder(folder: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            archive.write(path, f"{folder.name}/{path.relative_to(folder).as_posix()}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--cells", type=int, default=100_000)
    parser.add_argument("--genes", type=int, default=5_000)
    parser.add_argument("--density", type=float, default=0.05)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    base = make_adata(args.cells, args.genes, args.density)
    manifest = {"cells": args.cells, "genes": args.genes, "density": args.density, "files": {}}

    def record(name: str, layout: str, storage: str) -> None:
        path = out / name
        size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.is_dir() else path.stat().st_size
        manifest["files"][name] = {"layout": layout, "storage": storage, "bytes": size}
        print(f"{name}: {size:,} bytes")

    variants = {
        "csr": base,
        "csc": None,
        "dense-strips": None,
        "dense-contiguous": None,
    }
    csc = base.copy()
    csc.X = base.X.tocsc()
    variants["csc"] = csc
    dense = base.copy()
    dense.X = base.X.toarray()
    variants["dense-strips"] = dense
    variants["dense-contiguous"] = dense

    for layout, adata in variants.items():
        if layout == "dense-strips":
            name = f"{layout}.h5ad"
            adata.write_h5ad(out / name, compression="gzip")
            # Rewrite X chunked by gene strips (all cells x 64 genes).
            with h5py.File(out / name, "r+") as f:
                values = f["X"][...]
                attrs = dict(f["X"].attrs)
                del f["X"]
                d = f.create_dataset("X", data=values, chunks=(min(values.shape[0], 4096), 64), compression="gzip")
                for key, value in attrs.items():
                    d.attrs[key] = value
            record(name, layout, "h5ad-gzip")
            continue
        if layout == "dense-contiguous":
            name = f"{layout}.h5ad"
            adata.write_h5ad(out / name)
            record(name, layout, "h5ad-uncompressed")
            continue
        adata.write_h5ad(out / f"{layout}-gzip.h5ad", compression="gzip")
        record(f"{layout}-gzip.h5ad", layout, "h5ad-gzip")
        adata.write_h5ad(out / f"{layout}.h5ad")
        record(f"{layout}.h5ad", layout, "h5ad-uncompressed")
        folder = out / f"{layout}.zarr"
        shutil.rmtree(folder, ignore_errors=True)
        with ad.settings.override(zarr_write_format=2):
            adata.write_zarr(folder)
        record(f"{layout}.zarr", layout, "zarr-v2-folder")
        zip_folder(folder, out / f"{layout}.zarr.zip")
        record(f"{layout}.zarr.zip", layout, "zarr-v2-zip")
        # Zarr v3, which anndata writes by default from its next release.
        folder3 = out / f"{layout}-v3.zarr"
        shutil.rmtree(folder3, ignore_errors=True)
        with ad.settings.override(zarr_write_format=3):
            adata.write_zarr(folder3)
        record(f"{layout}-v3.zarr", layout, "zarr-v3-folder")
        zip_folder(folder3, out / f"{layout}-v3.zarr.zip")
        record(f"{layout}-v3.zarr.zip", layout, "zarr-v3-zip")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
