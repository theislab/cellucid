"""Write one synthetic AnnData store of up to hundreds of millions of cells,
streamed block by block (memory stays a few hundred MB whatever the size), for
the scale check of `scripts/efficiency-floor.mjs` (`--scale`): does opening a
10 % share cost about a tenth of opening every cell, on every axis?

    python -I scripts/efficiency-floor/scale.py OUT_PATH --kind KIND [--cells 100000000]
      [--genes 1000] [--per-cell 4] [--dense-genes 16]

Kinds, each the way its producer lays it out:

- ``priority-h5ad``, ``priority-zarr``: as ``cellucid.prepare()`` writes (cells
  in priority order under seed 0, ``obs['cellucid_original_position']``,
  gene-major X with ``varm['cellucid_prefix_counts']``, per-cell arrays in
  chunks of 2^16, X's entries in chunks of 2^14, DEFLATE);
- ``csr-h5ad``, ``csc-h5ad``, ``dense-h5ad``: as anndata writes with
  ``compression='gzip'`` (h5py's own chunk shapes), X cell-major, gene-major or
  dense (``--dense-genes`` columns);
- ``csr-zarr``: as anndata writes a Zarr v3 store (zarr-python's own chunk
  shapes, Zstandard), consolidated.

Every store has an obs index of strings, a 30-category ``cluster``, a float32
``score`` and a 2-D ``X_umap``. Values are random: only the layout matters.
Nothing is committed; delete the store after measuring it (they are GBs).
"""

from __future__ import annotations

import argparse
import shutil
import time
from pathlib import Path

import numpy as np
import pandas as pd

BLOCK = 1 << 20
N_CLUSTERS = 30


class Hdf5Store:
    def __init__(self, path: Path, *, chunked_by_h5py: bool):
        import h5py

        self.h5py = h5py
        self.file = h5py.File(path, "w")
        self.auto = chunked_by_h5py
        self.root = self.file

    def group(self, path: str, attrs: dict):
        group = self.file.require_group(path)
        group.attrs.update(attrs)
        return group

    def array(self, path: str, shape, dtype, chunks, attrs: dict | None = None, strings: bool = False):
        kwargs = {"compression": "gzip"}
        if strings:
            dtype = self.h5py.string_dtype()
        kwargs["chunks"] = True if self.auto else tuple(chunks)
        dataset = self.file.create_dataset(path, shape=shape, dtype=dtype, **kwargs)
        dataset.attrs.update(attrs or {})
        return dataset

    def close(self):
        self.file.close()


class ZarrStore:
    def __init__(self, path: Path, *, zarr_format: int, priority: bool):
        import zarr
        from zarr.codecs import GzipCodec, ZstdCodec

        shutil.rmtree(path, ignore_errors=True)
        self.zarr = zarr
        self.path = path
        self.format = zarr_format
        self.root = zarr.open_group(path, mode="w", zarr_format=zarr_format)
        self.auto = not priority
        if zarr_format == 2:
            import numcodecs

            self.compression = {"compressors": numcodecs.GZip(6) if priority else numcodecs.Zstd(0)}
        else:
            self.compression = {"compressors": [GzipCodec(level=6) if priority else ZstdCodec(level=0)]}

    def group(self, path: str, attrs: dict):
        group = self.root.require_group(path)
        group.attrs.update(attrs)
        return group

    def array(self, path: str, shape, dtype, chunks, attrs: dict | None = None, strings: bool = False):
        from zarr.dtype import VariableLengthUTF8

        dtype = VariableLengthUTF8() if strings else dtype
        array = self.root.create_array(path, shape=shape, dtype=dtype, chunks="auto" if self.auto else tuple(chunks),
                                       **self.compression)
        array.attrs.update(attrs or {})
        return array

    def close(self):
        self.zarr.consolidate_metadata(self.path, zarr_format=self.format)


ARRAY = {"encoding-type": "array", "encoding-version": "0.2.0"}
STRINGS = {"encoding-type": "string-array", "encoding-version": "0.2.0"}


def write(path: Path, kind: str, n: int, genes: int, per_cell: int, dense_genes: int) -> dict:
    import anndata as ad

    priority = kind.startswith("priority")
    is_zarr = kind.endswith("zarr")
    store = ZarrStore(path, zarr_format=2 if priority else 3, priority=priority) if is_zarr else Hdf5Store(path, chunked_by_h5py=not priority)
    rng = np.random.default_rng(1)
    cell_chunk = 1 << 16
    entry_chunk = 1 << 14

    store.group("/", {"encoding-type": "anndata", "encoding-version": "0.1.0"})
    columns = ["cluster", "score"] + (["cellucid_original_position"] if priority else [])
    store.group("obs", {"_index": "_index", "column-order": np.array(columns, dtype=object) if not is_zarr else columns,
                        "encoding-type": "dataframe", "encoding-version": "0.2.0"})
    names = store.array("obs/_index", (n,), None, (cell_chunk,), STRINGS, strings=True)
    store.group("obs/cluster", {"encoding-type": "categorical", "encoding-version": "0.2.0", "ordered": False})
    codes = store.array("obs/cluster/codes", (n,), "int8", (cell_chunk,), ARRAY)
    categories = store.array("obs/cluster/categories", (N_CLUSTERS,), None, (N_CLUSTERS,), STRINGS, strings=True)
    categories[:] = np.array([f"type {c}" for c in range(N_CLUSTERS)], dtype=object)
    score = store.array("obs/score", (n,), "float32", (cell_chunk,), ARRAY)
    store.group("obsm", {"encoding-type": "dict", "encoding-version": "0.1.0"})
    umap = store.array("obsm/X_umap", (n, 2), "float32", (cell_chunk, 2), ARRAY)
    positions = store.array("obs/cellucid_original_position", (n,), "uint32", (cell_chunk,), ARRAY) if priority else None

    # The rows' original positions (priority order under seed 0: ascending rank).
    order = None
    if priority:
        from cellucid.subsample import _ranks

        order = np.argsort(_ranks(np.arange(n, dtype=np.uint32), 0), kind="stable").astype(np.uint32)
    centers = rng.normal(scale=8.0, size=(N_CLUSTERS, 2)).astype(np.float32)
    for start in range(0, n, BLOCK):
        end = min(n, start + BLOCK)
        original = np.arange(start, end, dtype=np.uint32) if order is None else order[start:end]
        names[start:end] = np.char.add("c", original.astype(str)).astype(object)
        cluster = (original.astype(np.uint64) * 2654435761 % N_CLUSTERS).astype(np.int8)
        codes[start:end] = cluster
        score[start:end] = rng.normal(size=end - start).astype(np.float32)
        umap[start:end] = centers[cluster] + rng.normal(size=(end - start, 2)).astype(np.float32)
        if positions is not None:
            positions[start:end] = original
    del order

    # X.
    if kind.startswith("dense"):
        X = store.array("X", (n, dense_genes), "float32", (cell_chunk, dense_genes), ARRAY)
        for start in range(0, n, BLOCK):
            end = min(n, start + BLOCK)
            block = rng.random((end - start, dense_genes), dtype=np.float32)
            block[block < 0.75] = 0
            X[start:end] = block
        n_vars = dense_genes
    elif kind.startswith("csr"):
        nnz = n * per_cell
        store.group("X", {"encoding-type": "csr_matrix", "encoding-version": "0.1.0", "shape": [n, genes]})
        data = store.array("X/data", (nnz,), "float32", (entry_chunk,))
        indices = store.array("X/indices", (nnz,), "int32", (entry_chunk,))
        indptr = store.array("X/indptr", (n + 1,), "int64", (cell_chunk,))
        for start in range(0, n, BLOCK):
            end = min(n, start + BLOCK)
            rows = end - start
            base = rng.integers(0, genes, rows)
            step = rng.integers(1, genes // per_cell, rows)
            cols = np.sort((base[:, None] + np.arange(per_cell)[None, :] * step[:, None]) % genes, axis=1).astype(np.int32)
            indices[start * per_cell:end * per_cell] = cols.ravel()
            data[start * per_cell:end * per_cell] = rng.geometric(0.5, rows * per_cell).astype(np.float32)
            indptr[start:end + 1] = np.arange(start, end + 1, dtype=np.int64) * per_cell
        n_vars = genes
    else:
        # Gene-major: each gene's rows ascending (a priority file's rows are
        # its priority order, so a gene's kept entries are its first).
        per_gene = n * per_cell // genes
        nnz = per_gene * genes
        store.group("X", {"encoding-type": "csc_matrix", "encoding-version": "0.1.0", "shape": [n, genes]})
        data = store.array("X/data", (nnz,), "float32", (entry_chunk,))
        indices = store.array("X/indices", (nnz,), "int32", (entry_chunk,))
        indptr = store.array("X/indptr", (genes + 1,), "int64", (genes + 1,))
        indptr[:] = np.arange(genes + 1, dtype=np.int64) * per_gene
        levels = None
        counts = None
        if priority:
            from cellucid.prepare_data._priority import prefix_levels

            levels = prefix_levels(n)
            counts = np.zeros((genes, len(levels)), dtype=np.uint32)
        pending_rows = []
        pending_values = []
        at = 0
        for g in range(genes):
            rows = np.sort(rng.choice(n, per_gene, replace=False) if n < 1 << 22 else _distinct_rows(rng, n, per_gene))
            pending_rows.append(rows.astype(np.int32))
            pending_values.append(rng.geometric(0.5, per_gene).astype(np.float32))
            if counts is not None:
                counts[g] = np.searchsorted(rows, levels)
            if sum(len(r) for r in pending_rows) >= BLOCK * 8 or g == genes - 1:
                block_rows = np.concatenate(pending_rows)
                indices[at:at + len(block_rows)] = block_rows
                data[at:at + len(block_rows)] = np.concatenate(pending_values)
                at += len(block_rows)
                pending_rows, pending_values = [], []
        n_vars = genes
        if priority:
            store.group("varm", {"encoding-type": "dict", "encoding-version": "0.1.0"})
            table = store.array("varm/cellucid_prefix_counts", (genes, len(levels)), "uint32", (genes, 1), ARRAY)
            table[:] = counts

    for name in ("layers", "obsp") + (() if priority and not kind.startswith("dense") and not kind.startswith("csr") else ("varm",)):
        store.group(name, {"encoding-type": "dict", "encoding-version": "0.1.0"})
    var = pd.DataFrame(index=[f"G{g}" for g in range(n_vars)])
    ad.io.write_elem(store.root, "var", var)
    uns: dict = {}
    if priority:
        from cellucid.prepare_data._priority import prefix_levels

        uns["cellucid"] = {
            "schema": 1,
            "id": f"scale-{kind}",
            "name": f"Scale {kind}",
            "priority": {"seed": 0, "specVersion": 1, "nObs": n, "levels": prefix_levels(n)},
        }
    ad.io.write_elem(store.root, "uns", uns)
    store.close()
    return {"kind": kind, "cells": n, "genes": n_vars}


def _distinct_rows(rng: np.random.Generator, n: int, m: int) -> np.ndarray:
    """`m` distinct rows of `n`, without a permutation of all `n`."""
    rows = np.unique(rng.integers(0, n, int(m * 1.02) + 16))
    while len(rows) < m:
        rows = np.unique(np.concatenate([rows, rng.integers(0, n, m - len(rows) + 16)]))
    return rng.choice(rows, m, replace=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("--kind", required=True,
                        choices=["priority-h5ad", "priority-zarr", "csr-h5ad", "csc-h5ad", "dense-h5ad", "csr-zarr"])
    parser.add_argument("--cells", type=int, default=100_000_000)
    parser.add_argument("--genes", type=int, default=1000)
    parser.add_argument("--per-cell", type=int, default=4)
    parser.add_argument("--dense-genes", type=int, default=16)
    args = parser.parse_args()
    started = time.perf_counter()
    info = write(args.out, args.kind, args.cells, args.genes, args.per_cell, args.dense_genes)
    size = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file()) if args.out.is_dir() else args.out.stat().st_size
    print(f"{info['kind']}: {info['cells']:,} cells x {info['genes']} genes, {size / 1e9:.2f} GB, {time.perf_counter() - started:.0f} s")


if __name__ == "__main__":
    main()
