"""Write the files `npm run bench:formats` measures: one dataset, at one size,
in every format the browser reads that is not an AnnData file.

The dataset is a count matrix as a 10x experiment gives one (20,000 genes,
a few hundred detected per cell, integer counts, sorted by cell), clusters,
a UMAP and a PCA. It is written as:

- ``h5ad``: the Cellucid-ready AnnData (``cellucid.prepare()``), the baseline
  every other format is compared with;
- ``loom``: Loom 3 as loompy writes it (genes x cells, dense, gzip in 64 x 64
  chunks), the UMAP and clusters as column attributes;
- ``tenx-outs``: a Cell Ranger ``outs/`` folder (``filtered_feature_bc_matrix.h5``
  with gzip chunks, ``analysis/umap/2_components/projection.csv``,
  ``analysis/clustering/graphclust/clusters.csv``);
- ``mtx``: the same folder as MatrixMarket (``filtered_feature_bc_matrix/``
  with ``matrix.mtx.gz``, ``features.tsv.gz``, ``barcodes.tsv.gz``) and the
  same ``analysis/`` tables;
- ``h5mu`` and ``mudata-zarr``: a MuData of RNA and 20 proteins as mudata
  writes it (``mdata.write`` / ``mdata.write_zarr``);
- ``r``: the arrays ``generate.R`` builds the Seurat (``.rds``, ``.rda``) and
  SingleCellExperiment (``.rds``) objects from (raw little-endian files).

    python -I scripts/benchmark-formats/generate.py OUT --cells N [--formats h5ad,loom,...]

Deterministic for a given numpy build. Nothing is committed: files go to OUT,
listed in ``OUT/manifest.json``.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import time
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
from scipy import sparse

N_GENES = 20_000
MEAN_DETECTED = 400
N_CLUSTERS = 20
N_PROTEINS = 20
FORMATS = ("h5ad", "loom", "tenx-outs", "mtx", "h5mu", "mudata-zarr", "r")


def _sorted_genes(rng: np.random.Generator, detected: np.ndarray) -> np.ndarray:
    """Sorted distinct genes for each cell of a block: a cumulative sum of
    positive gaps, each cell's gaps scaled so its genes span the gene axis."""
    starts = np.zeros(len(detected) + 1, dtype=np.int64)
    np.cumsum(detected, out=starts[1:])
    gaps = rng.random(int(starts[-1]), dtype=np.float32)
    position = np.cumsum(gaps, dtype=np.float64)
    position -= np.repeat(position[starts[:-1]] - gaps[starts[:-1]], detected)
    scale = (N_GENES - detected) / position[starts[1:] - 1]
    within = np.arange(int(starts[-1]), dtype=np.int64) - np.repeat(starts[:-1], detected)
    return (np.floor(position * np.repeat(scale, detected)).astype(np.int64) + within).astype(np.int32)


def make_dataset(n_cells: int) -> dict:
    """Counts (cells x genes CSR), cell tables, embeddings; built in blocks
    of cells, so a 500,000-cell matrix never holds more than its arrays."""
    rng = np.random.default_rng(7)
    detected = np.clip(rng.lognormal(np.log(MEAN_DETECTED), 0.45, n_cells), 50, N_GENES // 4).astype(np.int64)
    indptr = np.zeros(n_cells + 1, dtype=np.int64)
    np.cumsum(detected, out=indptr[1:])
    nnz = int(indptr[-1])
    indices = np.empty(nnz, dtype=np.int32)
    block = 50_000
    for start in range(0, n_cells, block):
        end = min(n_cells, start + block)
        indices[indptr[start]:indptr[end]] = _sorted_genes(rng, detected[start:end])
    counts = np.empty(nnz, dtype=np.float32)
    step = 1 << 24
    for start in range(0, nnz, step):
        end = min(nnz, start + step)
        counts[start:end] = rng.geometric(0.55, end - start)
    clusters = rng.integers(0, N_CLUSTERS, n_cells)
    centers = rng.normal(scale=8.0, size=(N_CLUSTERS, 2))
    umap = (centers[clusters] + rng.normal(size=(n_cells, 2))).astype(np.float32)
    pca = rng.normal(size=(n_cells, 30)).astype(np.float32)
    pca[:, :2] += centers[clusters]
    barcodes = np.array([f"{i:08X}-1" for i in range(n_cells)])
    genes = np.array([f"ENSG{g:011d}" for g in range(N_GENES)])
    symbols = np.array([f"GENE{g}" for g in range(N_GENES)])
    samples = rng.integers(0, 8, n_cells)
    proteins = rng.gamma(2.0, 20.0, size=(n_cells, N_PROTEINS)).astype(np.float32)
    return {
        "indptr": indptr, "indices": indices, "counts": counts, "clusters": clusters, "samples": samples,
        "umap": umap, "pca": pca, "barcodes": barcodes, "genes": genes, "symbols": symbols, "proteins": proteins,
    }


def matrix(data: dict) -> sparse.csr_matrix:
    return sparse.csr_matrix(
        (data["counts"], data["indices"], data["indptr"]), shape=(len(data["barcodes"]), N_GENES)
    )


def obs_frame(data: dict) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "cluster": pd.Categorical([f"c{c}" for c in data["clusters"]]),
            "sample": pd.Categorical([f"s{s}" for s in data["samples"]]),
            "n_genes": np.diff(data["indptr"]).astype(np.int32),
        },
        index=data["barcodes"],
    )


def anndata_of(data: dict):
    import anndata as ad

    adata = ad.AnnData(
        X=matrix(data),
        obs=obs_frame(data),
        var=pd.DataFrame({"gene_ids": data["genes"]}, index=data["symbols"]),
    )
    adata.obsm["X_umap"] = data["umap"]
    adata.obsm["X_pca"] = data["pca"]
    return adata


def write_h5ad(out: Path, data: dict, n: int) -> Path:
    from cellucid import prepare

    path = out / f"cells-{n}.h5ad"
    prepare(path, format="h5ad", data=anndata_of(data), dataset_id=f"bench-{n}", dataset_name=f"Bench {n}", force=True)
    return path


def write_loom(out: Path, data: dict, n: int) -> Path:
    path = out / f"cells-{n}.loom"
    # Genes are the rows of the Loom matrix: written in blocks of cells.
    with h5py.File(path, "w") as file:
        block = 64
        dataset = file.create_dataset(
            "matrix", shape=(N_GENES, n), dtype="float32", chunks=(64, 64), compression="gzip", compression_opts=2
        )
        csr = matrix(data)
        for start in range(0, n, block * 16):
            end = min(n, start + block * 16)
            dataset[:, start:end] = csr[start:end].toarray().T
        file.create_group("layers")
        rows = file.create_group("row_attrs")
        rows.create_dataset("Gene", data=data["symbols"].astype("S"))
        rows.create_dataset("Accession", data=data["genes"].astype("S"))
        cols = file.create_group("col_attrs")
        cols.create_dataset("CellID", data=data["barcodes"].astype("S"))
        cols.create_dataset("ClusterName", data=np.array([f"c{c}" for c in data["clusters"]]).astype("S"))
        cols.create_dataset("X_umap", data=data["umap"])
        file.create_group("col_graphs")
        file.create_group("row_graphs")
        attrs = file.create_group("attrs")
        attrs.create_dataset("LOOM_SPEC_VERSION", data=np.bytes_("3.0.0"))
    return path


def write_analysis(folder: Path, data: dict) -> None:
    projection = folder / "analysis" / "umap" / "2_components"
    projection.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"Barcode": data["barcodes"], "UMAP-1": data["umap"][:, 0], "UMAP-2": data["umap"][:, 1]}).to_csv(
        projection / "projection.csv", index=False
    )
    clustering = folder / "analysis" / "clustering" / "graphclust"
    clustering.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"Barcode": data["barcodes"], "Cluster": data["clusters"] + 1}).to_csv(
        clustering / "clusters.csv", index=False
    )


def write_tenx_outs(out: Path, data: dict, n: int) -> Path:
    folder = out / f"cells-{n}-outs"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    options = {"compression": "gzip", "compression_opts": 4, "shuffle": True}
    with h5py.File(folder / "filtered_feature_bc_matrix.h5", "w") as file:
        group = file.create_group("matrix")
        nnz = len(data["indices"])
        chunk = (min(nnz, 1 << 16),)
        group.create_dataset("data", data=data["counts"].astype(np.int32), chunks=chunk, **options)
        group.create_dataset("indices", data=data["indices"].astype(np.int64), chunks=chunk, **options)
        group.create_dataset("indptr", data=data["indptr"], **options)
        group.create_dataset("shape", data=np.array([N_GENES, n], dtype=np.int32))
        group.create_dataset("barcodes", data=data["barcodes"].astype("S"), **options)
        features = group.create_group("features")
        features.create_dataset("id", data=data["genes"].astype("S"), **options)
        features.create_dataset("name", data=data["symbols"].astype("S"), **options)
        features.create_dataset("feature_type", data=np.array([b"Gene Expression"] * N_GENES), **options)
        features.create_dataset("genome", data=np.array([b"GRCh38"] * N_GENES), **options)
        features.create_dataset("_all_tag_keys", data=np.array([b"genome"]))
        file.attrs["filetype"] = "matrix"
        file.attrs["version"] = 2
        file.attrs["software_version"] = "cellranger-7.1.0"
    write_analysis(folder, data)
    return folder


def write_lines_gz(path: Path, lines) -> None:
    with gzip.open(path, "wt", compresslevel=6, newline="\n") as handle:
        for line in lines:
            handle.write(line)


def write_mtx(out: Path, data: dict, n: int) -> Path:
    folder = out / f"cells-{n}-mtx"
    shutil.rmtree(folder, ignore_errors=True)
    matrices = folder / "filtered_feature_bc_matrix"
    matrices.mkdir(parents=True)
    nnz = len(data["indices"])
    with gzip.open(matrices / "matrix.mtx.gz", "wb", compresslevel=6) as handle:
        handle.write(
            f"%%MatrixMarket matrix coordinate integer general\n%metadata_json: {{}}\n{N_GENES} {n} {nnz}\n".encode()
        )
        indptr = data["indptr"]
        cells_per_step = 10_000
        for first in range(0, n, cells_per_step):
            last = min(n, first + cells_per_step)
            start, end = int(indptr[first]), int(indptr[last])
            frame = pd.DataFrame(
                {
                    "gene": data["indices"][start:end].astype(np.int64) + 1,
                    "cell": np.repeat(np.arange(first + 1, last + 1, dtype=np.int64), np.diff(indptr[first:last + 1])),
                    "count": data["counts"][start:end].astype(np.int64),
                }
            )
            handle.write(frame.to_csv(sep=" ", header=False, index=False, lineterminator="\n").encode())
    write_lines_gz(
        matrices / "features.tsv.gz",
        (f"{gene}\t{symbol}\tGene Expression\n" for gene, symbol in zip(data["genes"], data["symbols"], strict=True)),
    )
    write_lines_gz(matrices / "barcodes.tsv.gz", (f"{barcode}\n" for barcode in data["barcodes"]))
    write_analysis(folder, data)
    return folder


def mudata_of(data: dict):
    import anndata as ad
    import mudata as md

    rna = anndata_of(data)
    adt = ad.AnnData(
        X=data["proteins"],
        obs=pd.DataFrame(index=data["barcodes"]),
        var=pd.DataFrame(index=[f"CD{i}" for i in range(N_PROTEINS)]),
    )
    mdata = md.MuData({"rna": rna, "prot": adt})
    mdata.obsm["X_umap"] = data["umap"]
    return mdata


def write_h5mu(out: Path, data: dict, n: int) -> Path:
    path = out / f"cells-{n}.h5mu"
    mudata_of(data).write(path)
    return path


def write_mudata_zarr(out: Path, data: dict, n: int) -> Path:
    path = out / f"cells-{n}.mudata.zarr"
    shutil.rmtree(path, ignore_errors=True)
    mudata_of(data).write_zarr(path)
    return path


def write_r_arrays(out: Path, data: dict, n: int) -> Path:
    """The arrays generate.R reads: a genes x cells dgCMatrix is the cells x genes CSR."""
    folder = out / f"cells-{n}-r-arrays"
    folder.mkdir(parents=True, exist_ok=True)
    data["indptr"].astype("<i4").tofile(folder / "p.bin")
    data["indices"].astype("<i4").tofile(folder / "i.bin")
    data["counts"].astype("<f8").tofile(folder / "x.bin")
    data["umap"].astype("<f8").T.copy().tofile(folder / "umap.bin")
    data["pca"].astype("<f8").T.copy().tofile(folder / "pca.bin")
    data["clusters"].astype("<i4").tofile(folder / "clusters.bin")
    (folder / "barcodes.txt").write_text("\n".join(data["barcodes"]) + "\n")
    (folder / "genes.txt").write_text("\n".join(data["symbols"]) + "\n")
    (folder / "shape.json").write_text(json.dumps({"cells": n, "genes": N_GENES, "nnz": int(data["indptr"][-1])}))
    return folder


WRITERS = {
    "h5ad": write_h5ad,
    "loom": write_loom,
    "tenx-outs": write_tenx_outs,
    "mtx": write_mtx,
    "h5mu": write_h5mu,
    "mudata-zarr": write_mudata_zarr,
    "r": write_r_arrays,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("--cells", type=int, required=True)
    parser.add_argument("--formats", default=",".join(FORMATS))
    args = parser.parse_args()
    formats = args.formats.split(",")
    unknown = sorted(set(formats) - set(FORMATS))
    if unknown:
        parser.error(f"unknown formats {unknown}; the formats are {', '.join(FORMATS)}")
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": {}}
    started = time.perf_counter()
    data = make_dataset(args.cells)
    nnz = int(data["indptr"][-1])
    print(f"{args.cells} cells x {N_GENES} genes, {nnz:,} counts ({time.perf_counter() - started:.1f} s)", flush=True)
    for fmt in formats:
        started = time.perf_counter()
        path = WRITERS[fmt](args.out, data, args.cells)
        size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.is_dir() else path.stat().st_size
        manifest["files"][path.name] = {"format": fmt, "cells": args.cells, "genes": N_GENES, "nnz": nnz, "bytes": size}
        print(f"  {fmt}: {path.name}, {size / 1e6:.0f} MB ({time.perf_counter() - started:.1f} s)", flush=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
