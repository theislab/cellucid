"""Create the served-store fixtures of ``tests/served-priority-store.test.mjs``.

When cellucid-python serves an AnnData object, or an AnnData file not in
priority order (``show_anndata``, ``cellucid.Widget``, ``serve_anndata``,
``cellucid serve``), the browser reads a Zarr store whose cells are in
priority order, made by ``cellucid._served_store.PriorityStore`` from the
source. This script asks that store for every key and writes them, with the
source's values in its own cell order, so the web test reads exactly what the
Python server sends through the browser's reader and checks it against the
source:

- ``object.json``: an in-memory AnnData with a cell-major ``X`` (served
  gene-major, with ``varm['cellucid_prefix_counts']``), a gene-major layer,
  an embedding, a neighbour graph, a categorical and a float obs column;
- ``file.json``: the same data written to an ``.h5ad`` with a cell-major
  ``X`` and served from the file (``X`` stays cell-major, rows in order).

Each file is ``{"keys": {key: base64 bytes}, "source": {...}}``.

Foreign formats served by path (``serve_anndata("x.loom")``, ``cellucid
serve outs/``), which the browser itself presents through its layout views:
``loom.json`` (a Loom file), ``outs.json`` (a Cell Ranger ``outs/`` folder of
two feature types: a MuData of modalities) and ``h5mu.json`` (a MuData whose
second modality measured three cells in four) hold the served keys and the
source files themselves (``{"keys", "files": {path: base64 bytes},
"compare": {...}}``), so the web test opens both through the browser's reader
and compares what they present. Run from the
repository root with an environment that has cellucid-python installed:

```bash
python scripts/generate-served-priority-fixtures.py
```
"""

from __future__ import annotations

import base64
import json
import tempfile
from pathlib import Path

import h5py

import anndata as ad
import numpy as np
import pandas as pd
from scipy import sparse

from cellucid._anndata_files import classify_anndata_path
from cellucid._served_store import PriorityStore

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "served"
N_OBS, N_VARS = 300, 7


def source() -> ad.AnnData:
    rng = np.random.default_rng(20261027)
    x = sparse.random(N_OBS, N_VARS, density=0.35, format="csr", dtype=np.float32, random_state=7)
    x = x.tolil()
    x[:, 0] = (rng.random((N_OBS, 1)) + 1).astype(np.float32)
    x = sparse.csr_matrix(x)
    adata = ad.AnnData(
        X=x,
        obs=pd.DataFrame(
            {
                "cluster": pd.Categorical(rng.choice(["a", "b", "c", "d"], N_OBS)),
                "score": rng.random(N_OBS).astype(np.float32),
            },
            index=pd.Index([f"cell-{i}" for i in range(N_OBS)], dtype=object),
        ),
        var=pd.DataFrame(index=pd.Index([f"g{j}" for j in range(N_VARS)], dtype=object)),
    )
    adata.layers["counts"] = sparse.csc_matrix(x * 3)
    adata.obsm["X_umap"] = rng.random((N_OBS, 2)).astype(np.float32)
    graph = sparse.random(N_OBS, N_OBS, density=0.02, format="csr", dtype=np.float32, random_state=8)
    adata.obsp["connectivities"] = sparse.csr_matrix(graph + graph.T)
    return adata


def dump(store: PriorityStore, adata: ad.AnnData) -> dict:
    keys = {key: base64.b64encode(store.get(key)).decode() for key in sorted(store.stored_keys())}
    graph = sparse.csr_matrix(adata.obsp["connectivities"])
    return {
        "keys": keys,
        "source": {
            "nObs": adata.n_obs,
            "names": list(adata.obs_names),
            "score": adata.obs["score"].astype(float).tolist(),
            "codes": adata.obs["cluster"].cat.codes.astype(int).tolist(),
            "umap": adata.obsm["X_umap"].astype(float).ravel().tolist(),
            "X": np.asarray(adata.X.toarray(), dtype=float).ravel().tolist(),
            "counts": np.asarray(adata.layers["counts"].toarray(), dtype=float).ravel().tolist(),
            "graph": {
                "indptr": graph.indptr.tolist(),
                "indices": graph.indices.tolist(),
                "data": graph.data.astype(float).tolist(),
            },
        },
    }


def _keys(store: PriorityStore) -> dict[str, str]:
    return {key: base64.b64encode(store.get(key)).decode() for key in sorted(store.stored_keys())}


def _files(folder: Path) -> dict[str, str]:
    return {
        path.relative_to(folder).as_posix(): base64.b64encode(path.read_bytes()).decode()
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    }


def write_loom(path: Path, n_cells: int = 160, n_genes: int = 12) -> None:
    rng = np.random.default_rng(11)
    matrix = (rng.random((n_genes, n_cells)) * (rng.random((n_genes, n_cells)) < 0.4) * 10).astype(np.float32)
    with h5py.File(path, "w") as file:
        file.attrs["LOOM_SPEC_VERSION"] = "2.0.1"
        file.attrs["title"] = "A loom"
        file.create_dataset("matrix", data=matrix, chunks=(4, 32), compression="gzip")
        file.create_dataset("layers/spliced", data=matrix * 2, chunks=(4, 32))
        col = file.create_group("col_attrs")
        col.create_dataset("CellID", data=np.asarray([f"c&#233;{i}".encode() for i in range(n_cells)], dtype="S12"))
        col.create_dataset("ClusterName", data=np.asarray([f"k{i % 3}" for i in range(n_cells)], dtype="S3"))
        col.create_dataset("Score", data=rng.random(n_cells))
        col.create_dataset("_X", data=rng.random(n_cells).astype(np.float32))
        col.create_dataset("_Y", data=rng.random(n_cells).astype(np.float32))
        col.create_dataset("X_pca", data=rng.random((n_cells, 3)))
        row = file.create_group("row_attrs")
        row.create_dataset("Gene", data=np.asarray([f"G{j}" for j in range(n_genes)], dtype=object), dtype=h5py.string_dtype())


def write_outs(folder: Path, n_cells: int = 160) -> None:
    rng = np.random.default_rng(12)
    types = (("Gene Expression", 9), ("Antibody Capture", 3))
    n_features = sum(count for _, count in types)
    cells = sparse.random(n_cells, n_features, density=0.35, format="csr", random_state=3, dtype=np.float64)
    cells.data = np.ceil(cells.data * 20)
    cells.sort_indices()
    folder.mkdir(parents=True)
    barcodes = [f"AAAC{i:06d}-1" for i in range(n_cells)]
    with h5py.File(folder / "filtered_feature_bc_matrix.h5", "w") as file:
        file.attrs["filetype"] = "matrix"
        matrix = file.create_group("matrix")
        matrix.create_dataset("barcodes", data=np.asarray(barcodes, dtype="S14"))
        matrix.create_dataset("data", data=cells.data.astype(np.int32), chunks=(64,), compression="gzip")
        matrix.create_dataset("indices", data=cells.indices.astype(np.int64), chunks=(64,), compression="gzip")
        matrix.create_dataset("indptr", data=cells.indptr.astype(np.int64))
        matrix.create_dataset("shape", data=np.asarray([n_features, n_cells], dtype=np.int32))
        features = matrix.create_group("features")
        features.create_dataset("id", data=np.asarray([f"ID{j}" for j in range(n_features)], dtype="S8"))
        features.create_dataset("name", data=np.asarray([f"{kind[:3]}{j}" for kind, count in types for j in range(count)], dtype="S8"))
        features.create_dataset("feature_type", data=np.asarray([kind for kind, count in types for _ in range(count)], dtype="S20"))
        features.create_dataset("genome", data=np.asarray(["GRCh38"] * n_features, dtype="S6"))
    umap = folder / "analysis" / "umap" / "gene_expression_2_components" / "projection.csv"
    umap.parent.mkdir(parents=True)
    umap.write_text("Barcode,UMAP-1,UMAP-2\n" + "".join(f"{b},{float(x)!r},{float(y)!r}\n" for b, (x, y) in zip(barcodes[:-1], rng.random((n_cells - 1, 2)), strict=True)))
    clusters = folder / "analysis" / "clustering" / "gene_expression_graphclust" / "clusters.csv"
    clusters.parent.mkdir(parents=True)
    clusters.write_text("Barcode,Cluster\n" + "".join(f"{b},{c}\n" for b, c in zip(barcodes, rng.integers(1, 12, n_cells), strict=True)))


def write_h5mu(path: Path, n_cells: int = 160) -> None:
    import mudata

    rng = np.random.default_rng(13)
    names = [f"cell-{i}" for i in range(n_cells)]
    rna = ad.AnnData(
        X=sparse.random(n_cells, 6, density=0.4, format="csr", random_state=4, dtype=np.float32),
        obs=pd.DataFrame({"leiden": pd.Categorical(rng.choice(["a", "b"], n_cells))}, index=names),
        var=pd.DataFrame(index=[f"g{j}" for j in range(6)]),
    )
    rna.obsm["X_umap"] = rng.random((n_cells, 2)).astype(np.float32)
    measured = [name for i, name in enumerate(names) if i % 4]
    prot = ad.AnnData(
        X=rng.random((len(measured), 3)).astype(np.float32),
        obs=pd.DataFrame(index=measured),
        var=pd.DataFrame(index=[f"p{j}" for j in range(3)]),
    )
    mdata = mudata.MuData({"rna": rna, "prot": prot})
    mdata.obsm["X_wnn_umap"] = rng.random((n_cells, 2))
    mdata.obs["sample"] = pd.Categorical(rng.choice(["s1", "s2"], n_cells))
    mdata.write_h5mu(path)


#: What the web test compares for each foreign source: obs fields, obsm keys, matrices (element, genes).
COMPARE = {
    "loom": {"source": "data.loom", "fields": ["ClusterName", "Score"], "obsm": ["X_embedding", "X_pca"], "matrices": ["X", "layers/spliced"]},
    "outs": {
        "source": "outs",
        "fields": ["gene_expression_graphclust"],
        "obsm": ["X_umap"],
        "matrices": ["mod/Gene Expression/X", "mod/Antibody Capture/X"],
    },
    "h5mu": {"source": "data.h5mu", "fields": ["sample", "rna:leiden"], "obsm": ["X_wnn_umap", "rna:X_umap"], "matrices": ["mod/rna/X", "mod/prot/X"]},
}


def foreign() -> None:
    for name, compare in COMPARE.items():
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / str(compare["source"])
            if name == "loom":
                write_loom(path)
                store = PriorityStore.of_loom(classify_anndata_path(path))
            elif name == "outs":
                write_outs(path)
                store = PriorityStore.of_cell_ranger(classify_anndata_path(path))
            else:
                write_h5mu(path)
                store = PriorityStore.of_mudata_file(classify_anndata_path(path))
            try:
                fixture = {"keys": _keys(store), "files": _files(root), "compare": compare}
            finally:
                store.close()
        (OUT / f"{name}.json").write_text(json.dumps(fixture) + "\n")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    foreign()
    adata = source()
    store = PriorityStore.of_anndata(adata)
    try:
        (OUT / "object.json").write_text(json.dumps(dump(store, adata)) + "\n")
    finally:
        store.close()
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "cells.h5ad"
        adata.write_h5ad(path)
        store = PriorityStore.of_file(classify_anndata_path(path))
        try:
            (OUT / "file.json").write_text(json.dumps(dump(store, adata)) + "\n")
        finally:
            store.close()


if __name__ == "__main__":
    main()
