"""Write the corpus `scripts/efficiency-floor.mjs` measures: one dataset, every
element the viewer reads, in every storage the readers treat differently, each
file with its stored layout (``layout.py``) beside it.

    python -I scripts/efficiency-floor/generate.py OUT [--cells 40000] [--genes 2000] [--files a,b]

The dataset is the count matrix of ``benchmark-formats/generate.py`` (sorted
genes per cell, integer counts, clusters, UMAP and PCA) at ``--genes`` genes,
with every element kind added: obs columns of each kind (categorical,
continuous, plain strings, boolean), embeddings in 2 and 3 dimensions and a
30-dimensional latent space, a velocity field, a neighbour graph
(``obsp['connectivities']`` and ``['distances']``), a ``counts`` layer, ``raw``,
var columns, ``varm`` and ``uns``. It is written as:

- ``.h5ad`` as anndata writes it, X cell-major (CSR): gzip, lzf and unfiltered
  chunks (h5py's own chunk shapes, as CELLxGENE and most portals ship), and
  contiguous (anndata's default, no compression);
- ``.h5ad`` with X gene-major (CSC) and dense, gzip;
- Zarr v2 (Blosc LZ4, numcodecs' default) and v3 (Zstandard, zarr-python's
  default; and gzip), each as a folder and as a ``.zarr.zip``; v3 sharded
  (inner chunks inside shards, the index at the end or the start; Zstandard,
  Blosc LZ4 and gzip inside; CSR, CSC and dense X);
- the same AnnData as ``cellucid.prepare()`` writes it (priority order,
  gene-major X, prefix counts, stored outlier quantiles), as ``.h5ad``, a Zarr
  folder and a ``.zarr.zip``;
- MuData (``.h5mu`` and Zarr: RNA and 20 proteins), Loom (genes x cells, gzip
  64 x 64 chunks), a 10x Cell Ranger ``outs/`` folder, the store ``cellucid_serve``
  answers for the dataset (cellucid-r run from its sources), a MatrixMarket folder and a
  Seurat ``.rds`` (through ``benchmark-formats/generate.R``, when R is given
  with ``--rscript``).

Each file's layout goes to ``OUT/<file>.layout.json`` and the values its floor
needs to ``OUT/<file>.content/``; the corpus is listed in ``OUT/manifest.json``.
Nothing is committed. Deterministic for a given numpy/anndata/h5py/zarr build.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
from scipy import sparse

HERE = Path(__file__).resolve().parent


def _formats_module():
    spec = importlib.util.spec_from_file_location("benchmark_formats", HERE.parent / "benchmark-formats" / "generate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


formats = _formats_module()
_layout_spec = importlib.util.spec_from_file_location("efficiency_floor_layout", HERE / "layout.py")
layout = importlib.util.module_from_spec(_layout_spec)
_layout_spec.loader.exec_module(layout)

NEIGHBOURS = 15


def neighbour_graph(rng: np.random.Generator, clusters: np.ndarray) -> tuple[sparse.csr_matrix, sparse.csr_matrix]:
    """A symmetric kNN-like graph: each cell's neighbours are cells of its cluster."""
    n = len(clusters)
    order = np.argsort(clusters, kind="stable")
    starts = np.searchsorted(clusters[order], np.arange(clusters.max() + 2))
    rows = np.repeat(np.arange(n), NEIGHBOURS)
    cols = np.empty(n * NEIGHBOURS, dtype=np.int64)
    for c in range(clusters.max() + 1):
        members = order[starts[c]:starts[c + 1]]
        if len(members) == 0:
            continue
        picks = members[rng.integers(0, len(members), size=(len(members), NEIGHBOURS))]
        for j, cell in enumerate(members):
            cols[cell * NEIGHBOURS:(cell + 1) * NEIGHBOURS] = picks[j]
    distances = sparse.csr_matrix((rng.random(n * NEIGHBOURS).astype(np.float32) + 0.1, (rows, cols)), shape=(n, n))
    distances.setdiag(0)
    distances.eliminate_zeros()
    distances = distances.maximum(distances.T).tocsr()
    distances.sort_indices()
    connectivities = distances.copy()
    connectivities.data = np.exp(-connectivities.data).astype(np.float32)
    return connectivities.astype(np.float32), distances.astype(np.float32)


def full_anndata(data: dict):
    import anndata as ad

    rng = np.random.default_rng(11)
    adata = formats.anndata_of(data)
    n = adata.n_obs
    adata.obs["score"] = rng.normal(size=n).astype(np.float32)
    adata.obs["is_doublet"] = rng.random(n) < 0.05
    adata.obs["note"] = np.array([f"note-{i}" for i in range(n)], dtype=object)
    umap = data["umap"]
    adata.obsm["X_umap_3d"] = np.column_stack([umap, rng.normal(size=n).astype(np.float32)])
    adata.obsm["velocity_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    connectivities, distances = neighbour_graph(rng, data["clusters"])
    adata.obsp["connectivities"] = connectivities
    adata.obsp["distances"] = distances
    adata.layers["counts"] = adata.X.copy()
    adata.raw = ad.AnnData(X=adata.X.copy(), var=adata.var.copy())
    adata.var["highly_variable"] = rng.random(adata.n_vars) < 0.2
    adata.varm["PCs"] = rng.normal(size=(adata.n_vars, 30)).astype(np.float32)
    adata.uns["neighbors"] = {"params": {"n_neighbors": NEIGHBOURS, "method": "umap"}}
    adata.uns["cluster_colors"] = np.array([f"#{i:06x}" for i in range(20)], dtype=object)
    return adata


def write_hdf5(path: Path, adata, **dataset_kwargs) -> None:
    import anndata as ad

    with h5py.File(path, "w") as file:
        _write_root(file, adata, dataset_kwargs)


def _write_root(group, adata, dataset_kwargs: dict) -> None:
    """Every element with the codec asked for; `uns` as anndata writes it (its
    scalars cannot take chunk or filter options)."""
    import anndata as ad

    uns = dict(adata.uns)
    stripped = adata.copy()
    stripped.uns = {}
    ad.io.write_elem(group, "/", stripped, dataset_kwargs=dataset_kwargs)
    del group["uns"]
    ad.io.write_elem(group, "uns", uns)


def write_zarr(path: Path, adata, zarr_format: int, **dataset_kwargs) -> None:
    import anndata as ad
    import zarr

    shutil.rmtree(path, ignore_errors=True)
    ad.settings.zarr_write_format = zarr_format
    group = zarr.open_group(path, mode="w", zarr_format=zarr_format)
    _write_root(group, adata, dataset_kwargs)
    # As anndata's write_zarr leaves a store: consolidated (a web host cannot list a folder).
    zarr.consolidate_metadata(path, zarr_format=zarr_format)


def sharded_plan(codec, *, entries: int, shard_entries: int, cells: int, shard_cells: int, strip: tuple[int, int],
                 shard_strip: tuple[int, int], index_location: str = "end"):
    """How `reshard` writes each array of an AnnData Zarr v3 store: 1-D
    entries (sparse `indices`/`data`) in inner chunks of `entries` inside
    shards of `shard_entries`, pointers and per-cell 1-D arrays in chunks of
    `cells` inside `shard_cells`, a dense X in `strip` (rows, genes) inside
    `shard_strip`, other 2-D arrays (obsm, varm) by rows; `codec` inside the
    shards, the index at `index_location`."""
    from zarr.codecs import BytesCodec, ShardingCodec, VLenUTF8Codec

    def settings(array, inner, outer):
        if index_location == "end":
            return {"chunks": inner, "shards": outer, "compressors": codec}
        values = VLenUTF8Codec() if array.dtype.kind in "OT" else BytesCodec()
        return {"chunks": outer, "compressors": None,
                "serializer": ShardingCodec(chunk_shape=inner, codecs=[values, codec], index_location=index_location)}

    def plan(path, array):
        if array.ndim == 0 or min(array.shape) == 0:
            return None
        name = path.rsplit("/", 1)[-1]
        if array.ndim == 1:
            if name in ("indices", "data"):
                return settings(array, (entries,), (shard_entries,))
            return settings(array, (cells,), (shard_cells,))
        if path in ("X", "layers/counts", "raw/X"):
            return settings(array, strip, shard_strip)
        width = array.shape[1]
        return settings(array, (cells, width), (shard_cells, width))

    return plan


def reshard(store: Path, plan) -> None:
    """Write every array of a Zarr v3 store again as `plan(path, array)` says
    (`create_array` keyword arguments), or leave it (None); values, fill and
    attributes are kept, and the store consolidated again."""
    import zarr

    root = zarr.open_group(store, mode="r+", use_consolidated=False)
    paths = []

    def walk(group, prefix):
        for name, node in group.members():
            if isinstance(node, zarr.Group):
                walk(node, f"{prefix}{name}/")
            else:
                paths.append(f"{prefix}{name}")

    walk(root, "")
    for path in paths:
        array = root[path]
        settings = plan(path, array)
        if settings is None:
            continue
        values, attrs, fill = array[...], dict(array.attrs), array.fill_value
        dtype = str if array.dtype.kind in "OT" else array.dtype
        parent, _, name = path.rpartition("/")
        group = root[parent] if parent else root
        del group[name]
        group.create_array(name, shape=values.shape, dtype=dtype, fill_value=fill, attributes=attrs, **settings)[...] = values
    zarr.consolidate_metadata(store, zarr_format=3)


def write_sharded(path: Path, adata, plan) -> None:
    write_zarr(path, adata, 3)
    reshard(path, plan)


def r_served_store(path: Path, adata) -> None:
    """The store cellucid-r serves for the dataset (`.serve_object`, run from
    its sources by `generate-subsample-analysis-fixtures.py` `r_served`), as
    the folder its server answers: priority order, gene-major X."""
    spec = importlib.util.spec_from_file_location("subsample_fixtures", HERE.parent / "generate-subsample-analysis-fixtures.py")
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)
    archive = path.with_name(path.name + ".tmp.zip")
    fixtures.r_served(served_given(adata), archive)
    shutil.rmtree(path, ignore_errors=True)
    with zipfile.ZipFile(archive) as opened:
        opened.extractall(path)
    archive.unlink()


def served_given(adata):
    """The dataset as both served stores are measured on it: what the R
    objects hold (categorical and numeric obs, the embeddings, the velocity
    field), gene symbols beside the ids."""
    given = adata.copy()
    given.var["feature_name"] = list(given.var_names)
    keep = [name for name in given.obs.columns
            if isinstance(given.obs[name].dtype, pd.CategoricalDtype) or np.issubdtype(given.obs[name].dtype, np.number)]
    given.obs = given.obs[keep]
    given.obsm = {key: value for key, value in given.obsm.items() if key in ("X_umap", "X_pca", "velocity_umap")}
    return given


def py_served_store(path: Path, adata) -> None:
    """The store cellucid-python serves for the same dataset (`serve_anndata`,
    the notebook widget: `cellucid._served_store.PriorityStore`), as the
    folder its server answers: priority order, gene-major X."""
    from cellucid._served_store import PriorityStore

    store = PriorityStore.of_anndata(served_given(adata))
    try:
        shutil.rmtree(path, ignore_errors=True)
        for key in store.stored_keys():
            target = path / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(store.get(key))
    finally:
        store.close()


def zip_folder(folder: Path, path: Path) -> None:
    """A `.zarr.zip` as anndata and zarr read one: entries stored, not compressed."""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for item in sorted(folder.rglob("*")):
            if item.is_file():
                archive.write(item, item.relative_to(folder).as_posix())


def prepared(out: Path, name: str, adata, format: str) -> Path:
    from cellucid import prepare

    path = out / name
    prepare(path, format=format, data=adata, dataset_id="efficiency-floor", dataset_name="Efficiency floor",
            latent_key="X_pca", force=True)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("--cells", type=int, default=40_000)
    parser.add_argument("--genes", type=int, default=2_000)
    parser.add_argument("--detected", type=int, default=100, help="mean genes detected per cell")
    parser.add_argument("--files", default=None, help="comma-separated names to (re)write; default all")
    parser.add_argument("--rscript", default=None, help="Rscript to build the Seurat .rds with")
    parser.add_argument("--layouts-only", action="store_true", help="rewrite only the layouts of the files written before")
    args = parser.parse_args()
    if args.layouts_only:
        for name in json.loads((args.out / "manifest.json").read_text())["files"]:
            path = args.out / name
            content = args.out / f"{name}.content"
            shutil.rmtree(content, ignore_errors=True)
            if name == "tenx-outs":
                record = layout.layout_of(path / "filtered_feature_bc_matrix.h5", content)
                record["file"] = f"{name}/filtered_feature_bc_matrix.h5"
            elif name.endswith((".h5ad", ".h5mu", ".loom", ".h5", ".zarr", ".zip")):
                record = layout.layout_of(path, content)
            else:
                record = {"kind": "whole", "arrays": {}}
            record["bytes"] = sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.is_dir() else path.stat().st_size
            (args.out / f"{name}.layout.json").write_text(json.dumps(record))
        return
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    formats.N_GENES = args.genes
    formats.MEAN_DETECTED = args.detected
    import numcodecs
    from zarr.codecs import BloscCodec, GzipCodec, ZstdCodec

    started = time.perf_counter()
    data = formats.make_dataset(args.cells)
    adata = full_anndata(data)
    csc = adata.copy()
    csc.X = sparse.csc_matrix(adata.X)
    dense = adata.copy()
    dense.X = adata.X.toarray()
    print(f"{adata.n_obs} cells x {adata.n_vars} genes, {adata.X.nnz:,} stored values "
          f"({time.perf_counter() - started:.1f} s)", flush=True)

    def zipped(name: str, folder_name: str):
        def write(path: Path) -> None:
            zip_folder(out / folder_name, path)
        return write

    writers = {
        "csr-gzip.h5ad": lambda p: write_hdf5(p, adata, compression="gzip"),
        "csr-lzf.h5ad": lambda p: write_hdf5(p, adata, compression="lzf"),
        "csr-unfiltered.h5ad": lambda p: write_hdf5(p, adata, chunks=True),
        "csr-contiguous.h5ad": lambda p: write_hdf5(p, adata),
        "csc-gzip.h5ad": lambda p: write_hdf5(p, csc, compression="gzip"),
        "dense-gzip.h5ad": lambda p: write_hdf5(p, dense, compression="gzip"),
        "csr-v2-blosc.zarr": lambda p: write_zarr(p, adata, 2, compressor=numcodecs.Blosc(cname="lz4", clevel=5, shuffle=1)),
        "csr-v2-blosc.zarr.zip": zipped("", "csr-v2-blosc.zarr"),
        "csr-v3-zstd.zarr": lambda p: write_zarr(p, adata, 3, compressors=[ZstdCodec(level=0)]),
        "csr-v3-zstd.zarr.zip": zipped("", "csr-v3-zstd.zarr"),
        "csr-v3-gzip.zarr": lambda p: write_zarr(p, adata, 3, compressors=[GzipCodec(level=5)]),
        "csc-v3-zstd.zarr": lambda p: write_zarr(p, csc, 3, compressors=[ZstdCodec(level=0)]),
        # Zarr v3 sharded: inner chunks of several shapes inside shards, the
        # index at the end (CRC-32C) or the start; CSR, CSC and dense X.
        "csr-v3-sharded.zarr": lambda p: write_sharded(p, adata, sharded_plan(
            ZstdCodec(level=0), entries=65536, shard_entries=1048576, cells=5000, shard_cells=20000, strip=(2500, 100), shard_strip=(10000, 400))),
        "csr-v3-sharded.zarr.zip": zipped("", "csr-v3-sharded.zarr"),
        "csc-v3-sharded.zarr": lambda p: write_sharded(p, csc, sharded_plan(
            BloscCodec(cname="lz4", clevel=5, shuffle="shuffle"), entries=32768, shard_entries=524288, cells=10000, shard_cells=40000,
            strip=(2500, 100), shard_strip=(10000, 400), index_location="start")),
        "dense-v3-sharded.zarr": lambda p: write_sharded(p, dense, sharded_plan(
            GzipCodec(level=5), entries=65536, shard_entries=1048576, cells=2500, shard_cells=20000, strip=(2500, 100), shard_strip=(10000, 400))),
        # What `cellucid_serve` answers over HTTP (cellucid-r, from its sources; needs Rscript).
        "served-r.zarr": lambda p: r_served_store(p, adata),
        # What `serve_anndata` and the notebook widget answer (cellucid-python), for the same dataset.
        "served-py.zarr": lambda p: py_served_store(p, adata),
        "prepared.h5ad": lambda p: prepared(out, p.name, adata, "h5ad"),
        "prepared.zarr": lambda p: prepared(out, p.name, adata, "zarr"),
        "prepared.zarr.zip": lambda p: prepared(out, p.name, adata, "zarr.zip"),
        "mudata.h5mu": lambda p: formats.mudata_of(data).write(p),
        "mudata.zarr": lambda p: (shutil.rmtree(p, ignore_errors=True), formats.mudata_of(data).write_zarr(p)),
        "cells.loom": lambda p: shutil.move(formats.write_loom(out, data, args.cells), p),
        "tenx-outs": lambda p: _moved_folder(formats.write_tenx_outs(out, data, args.cells), p),
        "cells-mtx": lambda p: _moved_folder(formats.write_mtx(out, data, args.cells), p),
        "seurat.rds": lambda p: _seurat(out, data, args.cells, p, args.rscript),
    }
    wanted = list(writers) if args.files is None else args.files.split(",")
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": {}}
    manifest.update({"cells": args.cells, "genes": args.genes, "nnz": int(adata.X.nnz)})
    for name in wanted:
        if name not in writers:
            parser.error(f"unknown file {name}")
        path = out / name
        began = time.perf_counter()
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        if name == "seurat.rds" and args.rscript is None:
            print("  seurat.rds: skipped (no --rscript)")
            continue
        writers[name](path)
        content = out / f"{name}.content"
        shutil.rmtree(content, ignore_errors=True)
        measurable = name.endswith((".h5ad", ".h5mu", ".loom", ".h5", ".zarr", ".zip"))
        if name == "tenx-outs":
            # The matrix is read in parts; the projection and clusters are tables read whole.
            record = layout.layout_of(path / "filtered_feature_bc_matrix.h5", content)
            record["file"] = f"{name}/filtered_feature_bc_matrix.h5"
        else:
            record = layout.layout_of(path, content) if measurable else {"kind": "whole", "arrays": {}}
        record["bytes"] = sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.is_dir() else path.stat().st_size
        (out / f"{name}.layout.json").write_text(json.dumps(record))
        manifest["files"][name] = {"bytes": record["bytes"], "kind": record["kind"]}
        print(f"  {name}: {record['bytes'] / 1e6:.1f} MB ({time.perf_counter() - began:.1f} s)", flush=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


def _moved_folder(folder: Path, path: Path) -> None:
    shutil.move(folder, path)


def _seurat(out: Path, data: dict, n: int, path: Path, rscript: str) -> None:
    arrays = formats.write_r_arrays(out, data, n)
    subprocess.run([rscript, str(HERE.parent / "benchmark-formats" / "generate.R"), str(arrays), str(out), "seurat"], check=True)
    shutil.move(out / f"cells-{n}.seurat.rds", path)
    shutil.rmtree(arrays)


if __name__ == "__main__":
    main()
