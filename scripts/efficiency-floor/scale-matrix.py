"""Write one synthetic store of the scale matrix: every format the web app
reads, with every data kind a real atlas carries, at sizes no public file has
yet (10M, 50M, 100M cells). Streamed block by block, so memory stays a few
hundred MB at any size except where a format needs a transpose (CSC, 10x,
loom), which holds one copy of X's entries. One store at a time: measure it
(`scale-app.mjs`), then delete it.

    python -I scripts/efficiency-floor/scale-matrix.py OUT --format FORMAT
      [--cells 10000000] [--genes 30000] [--per-cell 20] [--k 15] [--latent 50]
      [--categories 1000000] [--raw] [--layers] [--modalities 2] [--no-strings]
      [--priority]

Formats: ``h5ad-csr``, ``h5ad-csc``, ``h5ad-dense`` (``--genes`` columns),
``zarr2``, ``zarr3``, ``zarr3-sharded``, ``zarr-zip`` (Zarr v2 in one stored
zip), ``h5mu`` and ``mudata-zarr`` (``--modalities`` modalities over the same
cells), ``loom`` (dense genes x cells, gzip), ``10x-h5`` (a Cell Ranger ``outs``
folder: ``filtered_feature_bc_matrix.h5`` and ``analysis/`` with a UMAP
projection and graph-based clusters), ``mtx`` (a gzipped MatrixMarket folder
with barcodes, features and the same ``analysis/``), ``rds-sce`` and
``rds-seurat`` (a SingleCellExperiment or Seurat object saved by R with
``saveRDS``: counts as a ``dgCMatrix``, ``cell_type``, a UMAP; R from
``CELLUCID_RSCRIPT``, else ``Rscript``).

``--priority`` (``h5ad-*``, ``zarr2``, ``zarr3``, ``zarr3-sharded``) writes the
same cells as ``cellucid.prepare()`` lays a Cellucid-ready AnnData out: rows in
priority order under seed 0 (file row ``r`` is cell ``order[r]``, its name
``c<order[r]>``), ``obs['cellucid_original_position']``, X gene-major with
``varm['cellucid_prefix_counts']``, the graph's rows and columns in file rows,
and ``uns['cellucid']['priority']``. Each file block gathers its cells from
the blocks that generate them, so writing takes about ten times as long.

Every AnnData-shaped store holds, for ``n`` cells:

- ``obs``: a string index; ``cell_type`` (10 categories, int8 codes),
  ``cluster`` (300, int16), ``barcode_group`` (``--categories`` distinct,
  int32 codes), ``n_counts`` (float32), ``n_genes`` (int32), ``is_doublet``
  (bool), ``batch_size`` (nullable integer), ``passed_qc`` (nullable boolean),
  ``donor`` (a string array, not categorical; left out with ``--no-strings``)
  and ``score`` (float32 with NaN in 10 % of cells);
- ``obsm``: ``X_umap`` (2-D), ``X_umap_3d`` (3-D), ``X_pca`` (``--latent``
  dimensions), and the vector fields ``velocity_umap`` / ``velocity_umap_3d``
  on them;
- ``obsp['connectivities']``: a symmetric k-nearest-neighbor graph (``--k``
  neighbors a cell, spatially local, so the drawn edges are short);
- ``var``: ``--genes`` genes with a ``gene_symbols`` and a
  ``highly_variable`` column; ``X``: ``--per-cell`` stored values a cell,
  counts drawn so gene g of the first 10 marks cell type g (differential
  expression has an answer to find), the rest skewed toward low gene ids as
  real gene frequencies are; ``raw`` (``--raw``) and ``layers['counts']``
  (``--layers``) the same entries.

Cells come in runs of 4,096 of one type laid along a smooth curve, so a
cell's neighbors are its neighbors in the file, the velocity is the
curve's tangent, and a block subsample covers every type. Values are
deterministic per cell (seeded by the block), so any writer rebuilds the
same block twice (CSC's two passes).
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import time
from pathlib import Path

import numpy as np

BLOCK = 1 << 20
RUN = 4096
N_TYPES = 10
N_CLUSTERS = 300
N_DONORS = 1000
CELL_CHUNK = 1 << 16
ENTRY_CHUNK = 1 << 16

ARRAY = {"encoding-type": "array", "encoding-version": "0.2.0"}
STRINGS = {"encoding-type": "string-array", "encoding-version": "0.2.0"}
DICT = {"encoding-type": "dict", "encoding-version": "0.1.0"}


def _hash(values: np.ndarray, salt: int) -> np.ndarray:
    x = values.astype(np.uint64) * np.uint64(0x9E3779B97F4A7C15) + np.uint64(salt * 0xBF58476D1CE4E5B9 % (1 << 64))
    x ^= x >> np.uint64(31)
    x *= np.uint64(0x94D049BB133111EB)
    x ^= x >> np.uint64(29)
    return x


class Cells:
    """Every per-cell value of cells [start, end), the same on every call."""

    def __init__(self, n: int, genes: int, per_cell: int, k: int, latent: int, categories: int):
        self.n, self.genes, self.per_cell, self.k, self.latent, self.categories = n, genes, per_cell, k, latent, categories
        rng = np.random.default_rng(7)
        self.centers = rng.normal(scale=12.0, size=(N_TYPES, 3)).astype(np.float32)

    def block(self, start: int, end: int) -> dict:
        rng = np.random.default_rng([11, start])
        index = np.arange(start, end, dtype=np.int64)
        run = index // RUN
        kind = (_hash(run, 1) % N_TYPES).astype(np.int8)
        along = (index % RUN).astype(np.float32) / RUN
        # Each run a loop of radius 1-3 around its type's centre, offset by run.
        phase = (_hash(run, 2) % 6283).astype(np.float32) / 1000
        radius = 1 + (_hash(run, 3) % 2000).astype(np.float32) / 1000
        offset = ((_hash(run, 4) % 4000).astype(np.float32) / 1000 - 2)
        angle = phase + 2 * np.pi * along
        jitter = rng.normal(scale=0.05, size=(end - start, 3)).astype(np.float32)
        centre = self.centers[kind]
        umap3 = np.stack([centre[:, 0] + offset + radius * np.cos(angle),
                          centre[:, 1] - offset + radius * np.sin(angle),
                          centre[:, 2] + radius * np.sin(2 * angle) * 0.5], axis=1).astype(np.float32) + jitter
        tangent = np.stack([-np.sin(angle), np.cos(angle), np.cos(2 * angle)], axis=1).astype(np.float32) * radius[:, None] * 0.05
        out = {
            "original": index,
            "kind": kind,
            "cluster": (_hash(run, 5) % N_CLUSTERS).astype(np.int16),
            "barcode_group": (_hash(index, 6) % self.categories).astype(np.int32),
            "umap": np.ascontiguousarray(umap3[:, :2]),
            "umap3d": umap3,
            "velocity": np.ascontiguousarray(tangent[:, :2]),
            "velocity3d": tangent,
            "is_doublet": (_hash(index, 7) % 20) == 0,
            "batch_size": (_hash(run, 8) % 5000).astype(np.int32),
            "batch_mask": (_hash(index, 9) % 7) == 0,
            "passed_qc": (_hash(index, 10) % 3) != 0,
            "passed_mask": (_hash(index, 11) % 11) == 0,
            "donor": (_hash(run, 12) % N_DONORS).astype(np.int32),
        }
        score = rng.normal(size=end - start).astype(np.float32)
        score[(_hash(index, 13) % 10) == 0] = np.nan
        out["score"] = score
        if self.latent > 0:
            # Rounded to 1/64 (as a float16-trained model would): compressible.
            lat = rng.normal(size=(end - start, self.latent)).astype(np.float32)
            lat[:, :3] += umap3 / 4
            out["pca"] = np.round(lat * 64) / 64
        # X: one marker gene (the type) with a high count, the rest skewed.
        d = self.per_cell
        if d > 0:
            others = self.genes - N_TYPES
            base = (N_TYPES + (others * rng.random(end - start) ** 3)).astype(np.int64)
            step = rng.integers(1, max(2, others // d), end - start)
            cols = N_TYPES + (base[:, None] - N_TYPES + np.arange(d - 1)[None, :] * step[:, None]) % others
            cols = np.concatenate([kind.astype(np.int64)[:, None], cols], axis=1)
            cols.sort(axis=1)
            values = rng.geometric(0.4, (end - start, d)).astype(np.float32)
            values[cols == kind[:, None]] += 8
            out["indices"] = cols.astype(np.int32).ravel()
            out["data"] = values.ravel()
            out["n_counts"] = values.sum(axis=1).astype(np.float32)
        else:
            out["n_counts"] = np.zeros(end - start, np.float32)
        out["n_genes"] = np.full(end - start, d, np.int32)
        return out

    def graph_rows(self, index: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Cell i's neighbors (rows of cells, ascending) and their weights:
        i +- 1..k/2 inside its run (wrapping), symmetric."""
        half = max(1, self.k // 2)
        run_start = (index // RUN) * RUN
        run_len = np.minimum(RUN, self.n - run_start)
        offsets = np.concatenate([np.arange(-half, 0), np.arange(1, half + 1)])
        cols = run_start[:, None] + (index[:, None] - run_start[:, None] + offsets[None, :]) % run_len[:, None]
        cols.sort(axis=1)
        weights = np.exp(-np.abs(cols - index[:, None]).astype(np.float32) / half).astype(np.float32)
        return cols, np.round(weights * 256) / 256

    def graph_block(self, start: int, end: int) -> tuple[np.ndarray, np.ndarray]:
        cols, weights = self.graph_rows(np.arange(start, end, dtype=np.int64))
        return cols.astype(np.int32).ravel(), weights.ravel()


class PriorityCells:
    """The cells of ``cells`` in priority order under seed 0, as
    ``cellucid.prepare()`` writes them: file row ``r`` is cell ``order[r]``.
    A block of file rows gathers its cells from the blocks of ``cells`` that
    generate them (each cell's values are those of the file-order store)."""

    priority = True

    def __init__(self, cells: Cells):
        from cellucid.subsample import _rank_argsort, _ranks

        self.base = cells
        self.n, self.genes, self.per_cell, self.k, self.latent, self.categories = \
            cells.n, cells.genes, cells.per_cell, cells.k, cells.latent, cells.categories
        self.order = _rank_argsort(_ranks(np.arange(cells.n, dtype=np.uint32), 0)).astype(np.int64)
        self.position = np.empty(cells.n, np.int64)
        self.position[self.order] = np.arange(cells.n, dtype=np.int64)

    def block(self, start: int, end: int) -> dict:
        originals = self.order[start:end]
        rows, d = end - start, self.per_cell
        source = originals // BLOCK
        out: dict = {}
        for b in np.unique(source):
            at = np.nonzero(source == b)[0]
            generated = self.base.block(int(b) * BLOCK, min(self.n, (int(b) + 1) * BLOCK))
            local = originals[at] - int(b) * BLOCK
            for key, values in generated.items():
                per_cell = key in ("indices", "data")
                shaped = values.reshape(-1, d) if per_cell else values
                if key not in out:
                    out[key] = np.empty((rows,) + shaped.shape[1:], shaped.dtype)
                out[key][at] = shaped[local]
        for key in ("indices", "data"):
            if key in out:
                out[key] = out[key].ravel()
        return out

    def graph_block(self, start: int, end: int) -> tuple[np.ndarray, np.ndarray]:
        """File rows [start, end)'s neighbors as file rows, ascending."""
        cols, weights = self.base.graph_rows(self.order[start:end])
        cols = self.position[cols]
        order = np.argsort(cols, axis=1)
        return np.take_along_axis(cols, order, 1).astype(np.int32).ravel(), np.take_along_axis(weights, order, 1).ravel()


# --------------------------------------------------------------------------- AnnData element writers


class Hdf5Target:
    def __init__(self, path: Path):
        import h5py

        self.h5py = h5py
        self.file = h5py.File(path, "w")

    def group(self, path: str, attrs: dict):
        group = self.file.require_group(path)
        for key, value in attrs.items():
            group.attrs[key] = np.array(value, dtype=self.h5py.string_dtype()) if isinstance(value, list) and all(isinstance(v, str) for v in value) else value
        return group

    def array(self, path: str, shape, dtype, chunks, attrs: dict | None = None, strings: bool = False):
        dtype = self.h5py.string_dtype() if strings else dtype
        dataset = self.file.create_dataset(path, shape=shape, dtype=dtype, chunks=True if shape[0] > 0 else None,
                                           compression="gzip")
        dataset.attrs.update(attrs or {})
        return dataset

    def strings(self, values):
        return np.asarray(values, dtype=object)

    def node(self, path: str):
        return self.file[path or "/"]

    def close(self):
        self.file.close()


class ZarrTarget:
    def __init__(self, path: Path, *, zarr_format: int, sharded: bool):
        import zarr

        self.zarr = zarr
        self.format = zarr_format
        self.sharded = sharded
        shutil.rmtree(path, ignore_errors=True)
        self.store = path
        self.root = zarr.open_group(self.store, mode="w", zarr_format=zarr_format)
        if zarr_format == 2:
            import numcodecs

            self.compression = {"compressors": numcodecs.Blosc("zstd", 5, numcodecs.Blosc.SHUFFLE)}
        else:
            from zarr.codecs import BloscCodec

            self.compression = {"compressors": [BloscCodec(cname="zstd", clevel=5, shuffle="shuffle")]}

    def group(self, path: str, attrs: dict):
        group = self.root.require_group(path) if path not in ("/", "") else self.root
        group.attrs.update(attrs)
        return group

    def array(self, path: str, shape, dtype, chunks, attrs: dict | None = None, strings: bool = False):
        kwargs = dict(self.compression)
        if strings:
            from zarr.dtype import VariableLengthUTF8

            dtype = VariableLengthUTF8()
            if self.format == 2:
                kwargs = {"compressors": None}
        chunks = tuple(min(c, max(1, s)) for c, s in zip(chunks, shape))
        if self.sharded and not strings and shape[0] > chunks[0]:
            shard = (chunks[0] * min(64, -(-shape[0] // chunks[0])),) + tuple(chunks[1:])
            array = self.root.create_array(path, shape=shape, dtype=dtype, chunks=chunks, shards=shard, **kwargs)
        else:
            array = self.root.create_array(path, shape=shape, dtype=dtype, chunks=chunks, **kwargs)
        array.attrs.update(attrs or {})
        return array

    def strings(self, values):
        return np.asarray(values, dtype=object)

    def node(self, path: str):
        return self.root[path] if path else self.root

    def close(self):
        self.zarr.consolidate_metadata(self.store, zarr_format=self.format)


def write_anndata(target, prefix: str, cells: Cells, *, n: int, x_layout: str, raw: bool, layers: bool,
                  strings: bool, obsm: bool = True, obsp: bool = True, gene_prefix: str = "G",
                  genes: int | None = None, dense: bool = False, obs_columns: bool = True) -> None:
    """One AnnData at ``prefix`` ('' for the root, 'mod/rna' for a modality)."""
    genes = cells.genes if genes is None else genes
    p = (prefix + "/") if prefix else ""
    target.group(prefix or "/", {"encoding-type": "anndata", "encoding-version": "0.1.0"})
    priority = getattr(cells, "priority", False)
    columns = ["cell_type", "cluster", "barcode_group", "n_counts", "n_genes", "is_doublet", "batch_size",
               "passed_qc", "score"] + (["donor"] if strings else []) + (["cellucid_original_position"] if priority else [])
    if not obs_columns:
        columns, strings = [], False
    target.group(p + "obs", {"_index": "_index", "column-order": columns,
                             "encoding-type": "dataframe", "encoding-version": "0.2.0"})
    names = target.array(p + "obs/_index", (n,), None, (CELL_CHUNK,), STRINGS, strings=True)
    cat = {"encoding-type": "categorical", "encoding-version": "0.2.0", "ordered": False}
    categorical = (("cell_type", N_TYPES, "int8", "type"), ("cluster", N_CLUSTERS, "int16", "cluster"),
                   ("barcode_group", cells.categories, "int32", "bg")) if obs_columns else ()
    for name, count, dtype, label in categorical:
        target.group(p + f"obs/{name}", cat)
        target.array(p + f"obs/{name}/categories", (count,), None, (min(count, 1 << 16),), STRINGS, strings=True)[:] = \
            target.strings([f"{label} {c}" for c in range(count)])
    codes = {name: target.array(p + f"obs/{name}/codes", (n,), dtype, (CELL_CHUNK,), ARRAY)
             for name, _, dtype, _ in categorical}
    plain = {name: target.array(p + f"obs/{name}", (n,), dtype, (CELL_CHUNK,), ARRAY)
             for name, dtype in ((("n_counts", "float32"), ("n_genes", "int32"), ("is_doublet", "bool"),
                                  ("score", "float32")) + ((("cellucid_original_position", "uint32"),) if priority else ())
                                 if obs_columns else ())}
    nullable = {}
    for name, encoding, dtype in ((("batch_size", "nullable-integer", "int32"),
                                   ("passed_qc", "nullable-boolean", "bool")) if obs_columns else ()):
        target.group(p + f"obs/{name}", {"encoding-type": encoding, "encoding-version": "0.1.0"})
        nullable[name] = (target.array(p + f"obs/{name}/values", (n,), dtype, (CELL_CHUNK,), ARRAY),
                          target.array(p + f"obs/{name}/mask", (n,), "bool", (CELL_CHUNK,), ARRAY))
    donor = target.array(p + "obs/donor", (n,), None, (CELL_CHUNK,), STRINGS, strings=True) if strings else None
    target.group(p + "obsm", DICT)
    target.group(p + "obsp", DICT)
    target.group(p + "layers", DICT)
    target.group(p + "varm", DICT)
    emb = {}
    if obsm:
        emb = {"umap": target.array(p + "obsm/X_umap", (n, 2), "float32", (CELL_CHUNK, 2), ARRAY),
               "umap3d": target.array(p + "obsm/X_umap_3d", (n, 3), "float32", (CELL_CHUNK, 3), ARRAY),
               "velocity": target.array(p + "obsm/velocity_umap", (n, 2), "float32", (CELL_CHUNK, 2), ARRAY),
               "velocity3d": target.array(p + "obsm/velocity_umap_3d", (n, 3), "float32", (CELL_CHUNK, 3), ARRAY)}
        if cells.latent > 0:
            emb["pca"] = target.array(p + "obsm/X_pca", (n, cells.latent), "float32", (CELL_CHUNK // 8, cells.latent), ARRAY)
    nnz = n * cells.per_cell
    x_groups = ["X"] + (["raw/X"] if raw else []) + (["layers/counts"] if layers else [])
    sparse = {}
    if raw:
        target.group(p + "raw", {"encoding-type": "raw", "encoding-version": "0.1.0"})
    if dense:
        dense_x = target.array(p + "X", (n, genes), "float32", (CELL_CHUNK // 4, genes), ARRAY)
    elif x_layout == "csr":
        for g in x_groups:
            target.group(p + g, {"encoding-type": "csr_matrix", "encoding-version": "0.1.0", "shape": [n, genes]})
            sparse[g] = (target.array(p + g + "/data", (nnz,), "float32", (ENTRY_CHUNK,)),
                         target.array(p + g + "/indices", (nnz,), "int32", (ENTRY_CHUNK,)),
                         target.array(p + g + "/indptr", (n + 1,), "int64", (CELL_CHUNK,)))
    graph = None
    if obsp:
        edges = n * 2 * max(1, cells.k // 2)
        target.group(p + "obsp/connectivities", {"encoding-type": "csr_matrix", "encoding-version": "0.1.0", "shape": [n, n]})
        graph = (target.array(p + "obsp/connectivities/data", (edges,), "float32", (ENTRY_CHUNK,)),
                 target.array(p + "obsp/connectivities/indices", (edges,), "int32", (ENTRY_CHUNK,)),
                 target.array(p + "obsp/connectivities/indptr", (n + 1,), "int64", (CELL_CHUNK,)))
    degree = 2 * max(1, cells.k // 2)
    for start in range(0, n, BLOCK):
        end = min(n, start + BLOCK)
        b = cells.block(start, end)
        names[start:end] = np.char.add("c", b["original"].astype(str)).astype(object)
        b["cellucid_original_position"] = b["original"].astype(np.uint32)
        for name, key in (("cell_type", "kind"), ("cluster", "cluster"), ("barcode_group", "barcode_group")):
            if name in codes:
                codes[name][start:end] = b[key]
        for name in plain:
            plain[name][start:end] = b[name]
        for name, (values, mask) in nullable.items():
            values[start:end] = b[name]
            mask[start:end] = b["batch_mask" if name == "batch_size" else "passed_mask"]
        if donor is not None:
            donor[start:end] = np.char.add("donor ", b["donor"].astype(str)).astype(object)
        for key, array in emb.items():
            array[start:end] = b[key]
        if dense:
            block = np.zeros((end - start, genes), np.float32)
            rows = np.repeat(np.arange(end - start), cells.per_cell)
            keep = b["indices"] < genes
            block[rows[keep], b["indices"][keep]] = b["data"][keep]
            dense_x[start:end] = block
        for data, indices, indptr in sparse.values():
            d = cells.per_cell
            data[start * d:end * d] = b["data"]
            indices[start * d:end * d] = b["indices"]
            indptr[start:end + 1] = np.arange(start, end + 1, dtype=np.int64) * d
        if graph is not None:
            gi, gw = cells.graph_block(start, end)
            graph[0][start * degree:end * degree] = gw
            graph[1][start * degree:end * degree] = gi
            graph[2][start:end + 1] = np.arange(start, end + 1, dtype=np.int64) * degree
    if x_layout == "csc" and not dense:
        _write_csc(target, p, cells, n, genes, x_groups)
    if genes > 0:
        _write_var(target, p + "var", genes, gene_prefix)
    if raw:
        _write_var(target, p + "raw/var", genes, gene_prefix)
    if priority:
        import anndata as ad
        from cellucid.prepare_data._priority import prefix_levels

        ad.io.write_elem(target.node(prefix), "uns", {"cellucid": {
            "schema": 1, "id": "scale-priority", "name": "Scale priority",
            "priority": {"seed": 0, "specVersion": 1, "nObs": n, "levels": prefix_levels(n)}}})
    else:
        target.group(p + "uns", DICT)


def _write_var(target, path: str, genes: int, prefix: str) -> None:
    target.group(path, {"_index": "_index", "column-order": ["gene_symbols", "highly_variable"],
                        "encoding-type": "dataframe", "encoding-version": "0.2.0"})
    target.array(path + "/_index", (genes,), None, (genes,), STRINGS, strings=True)[:] = \
        target.strings([f"{prefix}{g:05d}" for g in range(genes)])
    target.array(path + "/gene_symbols", (genes,), None, (genes,), STRINGS, strings=True)[:] = \
        target.strings([f"SYM{g}" for g in range(genes)])
    target.array(path + "/highly_variable", (genes,), "bool", (genes,), ARRAY)[:] = (np.arange(genes) % 5) == 0


def _gene_major(cells: Cells, n: int, genes: int):
    """X's entries gene-major: (indptr, cell indices, values). Two passes."""
    counts = np.zeros(genes + 1, np.int64)
    for start in range(0, n, BLOCK):
        b = cells.block(start, min(n, start + BLOCK))
        counts[1:] += np.bincount(b["indices"], minlength=genes)
    indptr = np.cumsum(counts)
    rows = np.empty(int(indptr[-1]), np.int32)
    values = np.empty(int(indptr[-1]), np.float32)
    at = indptr[:-1].copy()
    for start in range(0, n, BLOCK):
        end = min(n, start + BLOCK)
        b = cells.block(start, end)
        cell = np.repeat(np.arange(start, end, dtype=np.int32), cells.per_cell)
        order = np.argsort(b["indices"], kind="stable")
        g = b["indices"][order]
        first = np.searchsorted(g, np.arange(genes))
        last = np.searchsorted(g, np.arange(genes), side="right")
        for gene in np.nonzero(last > first)[0]:
            s, e = first[gene], last[gene]
            rows[at[gene]:at[gene] + e - s] = cell[order[s:e]]
            values[at[gene]:at[gene] + e - s] = b["data"][order[s:e]]
            at[gene] += e - s
    return indptr, rows, values


def _write_csc(target, p: str, cells: Cells, n: int, genes: int, groups) -> None:
    indptr, rows, values = _gene_major(cells, n, genes)
    if getattr(cells, "priority", False):
        # Each gene's stored values among the first `levels[j]` rows (its rows ascend).
        from cellucid.prepare_data._priority import prefix_levels

        levels = prefix_levels(n)
        counts = np.stack([np.searchsorted(rows[indptr[g]:indptr[g + 1]], levels) for g in range(genes)]).astype(np.uint32)
        target.array(p + "varm/cellucid_prefix_counts", counts.shape, "uint32", (genes, 1), ARRAY)[:] = counts
    for g in groups:
        target.group(p + g, {"encoding-type": "csc_matrix", "encoding-version": "0.1.0", "shape": [n, genes]})
        target.array(p + g + "/data", values.shape, "float32", (ENTRY_CHUNK,))[:] = values
        target.array(p + g + "/indices", rows.shape, "int32", (ENTRY_CHUNK,))[:] = rows
        target.array(p + g + "/indptr", indptr.shape, "int64", (min(len(indptr), CELL_CHUNK),))[:] = indptr


# --------------------------------------------------------------------------- formats


def write_store(out: Path, fmt: str, cells: Cells, args) -> None:
    n = cells.n
    common = dict(n=n, raw=args.raw, layers=args.layers, strings=not args.no_strings)
    if args.priority:
        if not (fmt.startswith("h5ad") or fmt in ("zarr2", "zarr3", "zarr3-sharded")):
            raise SystemExit("--priority writes h5ad-* and zarr2/zarr3/zarr3-sharded stores")
        cells = PriorityCells(cells)
    if fmt.startswith("h5ad"):
        target = Hdf5Target(out)
        layout = fmt.split("-")[1]
        write_anndata(target, "", cells, x_layout="csc" if args.priority and layout != "dense" else layout,
                      dense=layout == "dense", **common)
        target.close()
    elif fmt in ("zarr2", "zarr3", "zarr3-sharded"):
        target = ZarrTarget(out, zarr_format=3 if fmt.startswith("zarr3") else 2, sharded=fmt == "zarr3-sharded")
        write_anndata(target, "", cells, x_layout="csc" if args.priority else "csr", **common)
        target.close()
    elif fmt == "zarr-zip":
        # A Zarr v2 folder zipped with its entries stored (each entry once:
        # zarr's ZipStore appends a second entry when metadata is consolidated).
        import zipfile

        folder = out.with_name(out.name + ".folder")
        target = ZarrTarget(folder, zarr_format=2, sharded=False)
        write_anndata(target, "", cells, x_layout="csr", **common)
        target.close()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for path in sorted(folder.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(folder).as_posix())
        shutil.rmtree(folder)
    elif fmt in ("h5mu", "mudata-zarr"):
        target = Hdf5Target(out) if fmt == "h5mu" else ZarrTarget(out, zarr_format=2, sharded=False)
        names = ["rna", "prot", "atac"][:args.modalities]
        widths = {"rna": cells.genes, "prot": 64, "atac": cells.genes}
        target.group("mod", {"mod-order": names})
        for name in names:
            write_anndata(target, f"mod/{name}", cells, x_layout="csr", gene_prefix=f"{name}:", genes=widths[name],
                          obsm=False, obsp=False, dense=name == "prot", obs_columns=False,
                          **{**common, "raw": False, "layers": False})
        # The cells' shared obs, embeddings, vector fields and graph at the root.
        write_anndata(target, "", cells, x_layout="none", obsm=True, obsp=True, genes=0, n=n,
                      raw=False, layers=False, strings=not args.no_strings)
        target.group("/", {"encoding-type": "MuData", "encoding-version": "0.1.0"})
        target.group("var", {"_index": "_index", "column-order": [], "encoding-type": "dataframe",
                             "encoding-version": "0.2.0"})
        target.array("var/_index", (sum(widths[m] for m in names),), None, (1 << 16,), STRINGS, strings=True)[:] = \
            target.strings([f"{m}:{g:05d}" for m in names for g in range(widths[m])])
        target.close()
    elif fmt == "loom":
        _write_loom(out, cells)
    elif fmt == "10x-h5":
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        _write_10x(out / "filtered_feature_bc_matrix.h5", cells)
        _write_analysis(out, cells, _tenx_barcode)
    elif fmt == "mtx":
        _write_mtx(out, cells)
        _write_analysis(out, cells, lambda i: f"c{i}")
    elif fmt in ("rds-sce", "rds-seurat"):
        _write_rds(out, cells, seurat=fmt == "rds-seurat")
    else:
        raise SystemExit(f"unknown format {fmt}")


def _write_loom(out: Path, cells: Cells) -> None:
    import h5py

    n, genes = cells.n, cells.genes
    with h5py.File(out, "w") as f:
        f.attrs["LOOM_SPEC_VERSION"] = "3.0.0"
        matrix = f.create_dataset("matrix", (genes, n), "float32", chunks=(64, 64), compression="gzip", fillvalue=0)
        step = max(4096, ((1 << 28) // (genes * 4)) // 64 * 64)
        for start in range(0, n, step):
            end = min(n, start + step)
            b = cells.block(start, end)
            block = np.zeros((genes, end - start), np.float32)
            cols = np.repeat(np.arange(end - start), cells.per_cell)
            block[b["indices"], cols] = b["data"]
            matrix[:, start:end] = block
        rows = f.create_group("row_attrs")
        rows.create_dataset("Gene", data=np.array([f"G{g:05d}" for g in range(genes)], dtype=h5py.string_dtype()))
        attrs = f.create_group("col_attrs")
        attrs_arrays = {"CellID": attrs.create_dataset("CellID", (n,), h5py.string_dtype(), chunks=True, compression="gzip"),
                        "cell_type": attrs.create_dataset("cell_type", (n,), h5py.string_dtype(), chunks=True, compression="gzip"),
                        "n_counts": attrs.create_dataset("n_counts", (n,), "float32", chunks=True, compression="gzip"),
                        "X_umap": attrs.create_dataset("X_umap", (n, 2), "float32", chunks=True, compression="gzip")}
        for start in range(0, n, BLOCK):
            end = min(n, start + BLOCK)
            b = cells.block(start, end)
            attrs_arrays["CellID"][start:end] = np.char.add("c", np.arange(start, end).astype(str)).astype(object)
            attrs_arrays["cell_type"][start:end] = np.char.add("type ", b["kind"].astype(str)).astype(object)
            attrs_arrays["n_counts"][start:end] = b["n_counts"]
            attrs_arrays["X_umap"][start:end] = b["umap"]
        f.create_group("layers")
        f.create_group("row_graphs")
        f.create_group("col_graphs")


def _write_10x(out: Path, cells: Cells) -> None:
    import h5py

    n, genes = cells.n, cells.genes
    with h5py.File(out, "w") as f:
        g = f.create_group("matrix")
        nnz = n * cells.per_cell
        data = g.create_dataset("data", (nnz,), "int32", chunks=(min(nnz, ENTRY_CHUNK),), compression="gzip")
        indices = g.create_dataset("indices", (nnz,), "int64", chunks=(min(nnz, ENTRY_CHUNK),), compression="gzip")
        indptr = g.create_dataset("indptr", (n + 1,), "int64", chunks=(min(n + 1, CELL_CHUNK),), compression="gzip")
        barcodes = g.create_dataset("barcodes", (n,), "S18", chunks=(min(n, CELL_CHUNK),), compression="gzip")
        g.create_dataset("shape", data=np.array([genes, n], np.int32))
        d = cells.per_cell
        for start in range(0, n, BLOCK):
            end = min(n, start + BLOCK)
            b = cells.block(start, end)
            data[start * d:end * d] = b["data"].astype(np.int32)
            indices[start * d:end * d] = b["indices"]
            indptr[start:end + 1] = np.arange(start, end + 1, dtype=np.int64) * d
            barcodes[start:end] = np.array([_tenx_barcode(i) for i in range(start, end)], dtype="S18")
        features = g.create_group("features")
        features.create_dataset("id", data=np.array([f"ENSG{g:011d}" for g in range(genes)], dtype="S15"))
        features.create_dataset("name", data=np.array([f"SYM{g}" for g in range(genes)], dtype="S10"))
        features.create_dataset("feature_type", data=np.array([b"Gene Expression"] * genes))
        features.create_dataset("genome", data=np.array([b"GRCh38"] * genes))
        features.create_dataset("_all_tag_keys", data=np.array([b"genome"]))


def _tenx_barcode(i: int) -> str:
    return f"{i:016d}-1"


def _write_analysis(out: Path, cells: Cells, barcode) -> None:
    """Cell Ranger's analysis/: a UMAP projection and graph-based clusters, as CSV."""
    umap = out / "analysis" / "umap" / "2_components"
    clusters = out / "analysis" / "clustering" / "graphclust"
    umap.mkdir(parents=True, exist_ok=True)
    clusters.mkdir(parents=True, exist_ok=True)
    with open(umap / "projection.csv", "w") as projection, open(clusters / "clusters.csv", "w") as cluster:
        projection.write("Barcode,UMAP-1,UMAP-2\n")
        cluster.write("Barcode,Cluster\n")
        for start in range(0, cells.n, BLOCK):
            end = min(cells.n, start + BLOCK)
            b = cells.block(start, end)
            names = [barcode(i) for i in range(start, end)]
            projection.write("".join(f"{name},{x:.4f},{y:.4f}\n" for name, (x, y) in zip(names, b["umap"].tolist())))
            cluster.write("".join(f"{name},{k + 1}\n" for name, k in zip(names, b["kind"].tolist())))


R_ASSEMBLE = r"""
suppressPackageStartupMessages(library(Matrix))
args <- commandArgs(trailingOnly = TRUE)
dir <- args[[1]]; out <- args[[2]]; seurat <- args[[3]] == "seurat"
n <- as.integer(args[[4]]); genes <- as.integer(args[[5]]); nnz <- as.numeric(args[[6]])
bin <- function(name, what, size, count) {
  con <- file(file.path(dir, name), "rb"); on.exit(close(con))
  readBin(con, what = what, size = size, n = count)
}
p <- bin("indptr.bin", "integer", 4, n + 1)
i <- bin("indices.bin", "integer", 4, nnz)
x <- bin("data.bin", "double", 4, nnz)
kind <- bin("kind.bin", "integer", 1, n)
umap <- matrix(bin("umap.bin", "double", 4, 2 * n), ncol = 2, byrow = TRUE)
cells <- paste0("c", seq_len(n) - 1L)
features <- sprintf("G%05d", seq_len(genes) - 1L)
counts <- new("dgCMatrix", i = i, p = p, x = x, Dim = c(genes, n), Dimnames = list(features, cells))
rm(i, x, p); invisible(gc())
cell_type <- factor(paste("type", kind), levels = paste("type", 0:9))
rownames(umap) <- cells
if (seurat) {
  colnames(umap) <- c("umap_1", "umap_2")
  object <- SeuratObject::CreateSeuratObject(counts = counts, meta.data = data.frame(cell_type = cell_type, row.names = cells))
  object[["umap"]] <- SeuratObject::CreateDimReducObject(embeddings = umap, key = "umap_", assay = "RNA")
} else {
  colnames(umap) <- c("UMAP1", "UMAP2")
  object <- SingleCellExperiment::SingleCellExperiment(assays = list(counts = counts),
    colData = S4Vectors::DataFrame(cell_type = cell_type, row.names = cells), reducedDims = list(UMAP = umap))
}
saveRDS(object, out)
"""


def _write_rds(out: Path, cells: Cells, *, seurat: bool) -> None:
    """A Seurat or SingleCellExperiment object saved by R (counts as a dgCMatrix,
    cell_type, a UMAP), assembled from the columns streamed to binary files."""
    import os
    import subprocess
    import tempfile

    n, d = cells.n, cells.per_cell
    with tempfile.TemporaryDirectory(dir=out.parent) as scratch:
        work = Path(scratch)
        with open(work / "indices.bin", "wb") as indices, open(work / "data.bin", "wb") as data, \
                open(work / "kind.bin", "wb") as kind, open(work / "umap.bin", "wb") as umap:
            for start in range(0, n, BLOCK):
                b = cells.block(start, min(n, start + BLOCK))
                indices.write(b["indices"].astype("<i4").tobytes())
                data.write(b["data"].astype("<f4").tobytes())
                kind.write(b["kind"].astype("<i1").tobytes())
                umap.write(b["umap"].astype("<f4").tobytes())
        (np.arange(n + 1, dtype=np.int64) * d).astype("<i4").tofile(work / "indptr.bin")
        (work / "assemble.R").write_text(R_ASSEMBLE)
        rscript = os.environ.get("CELLUCID_RSCRIPT", "Rscript")
        subprocess.run([rscript, str(work / "assemble.R"), str(work), str(out), "seurat" if seurat else "sce",
                        str(n), str(cells.genes), str(n * d)], check=True)


def _write_mtx(out: Path, cells: Cells) -> None:
    n, genes = cells.n, cells.genes
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    with gzip.open(out / "matrix.mtx.gz", "wt", compresslevel=4) as f:
        f.write("%%MatrixMarket matrix coordinate integer general\n")
        f.write(f"{genes} {n} {n * cells.per_cell}\n")
        for start in range(0, n, BLOCK):
            end = min(n, start + BLOCK)
            b = cells.block(start, end)
            cell = np.repeat(np.arange(start + 1, end + 1), cells.per_cell)
            lines = np.char.add(np.char.add(np.char.add((b["indices"] + 1).astype(str), " "),
                                            np.char.add(cell.astype(str), " ")), b["data"].astype(np.int32).astype(str))
            f.write("\n".join(lines.tolist()))
            f.write("\n")
    with gzip.open(out / "barcodes.tsv.gz", "wt") as f:
        for start in range(0, n, BLOCK):
            f.write("\n".join(f"c{i}" for i in range(start, min(n, start + BLOCK))))
            f.write("\n")
    with gzip.open(out / "features.tsv.gz", "wt") as f:
        f.write("\n".join(f"ENSG{g:011d}\tSYM{g}\tGene Expression" for g in range(genes)))
        f.write("\n")


def write_expectations(path: Path, cells: Cells, gene: int = 10) -> None:
    """Order-free values of every cell: gene `gene`'s sum and non-zero count, cell types' counts."""
    import json

    total, nonzero = 0.0, 0
    tally = np.zeros(N_TYPES, np.int64)
    for start in range(0, cells.n, BLOCK):
        b = cells.block(start, min(cells.n, start + BLOCK))
        tally += np.bincount(b["kind"], minlength=N_TYPES)
        if cells.per_cell > 0:
            hit = b["indices"] == gene
            total += float(b["data"][hit].astype(np.float64).sum())
            nonzero += int(hit.sum())
    path.write_text(json.dumps({"cells": cells.n, "gene": {"index": gene, "sum": total, "nonzero": nonzero},
                                "cellTypes": tally.tolist()}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("--format", required=True,
                        choices=["h5ad-csr", "h5ad-csc", "h5ad-dense", "zarr2", "zarr3", "zarr3-sharded", "zarr-zip",
                                 "h5mu", "mudata-zarr", "loom", "10x-h5", "mtx", "rds-sce", "rds-seurat"])
    parser.add_argument("--cells", type=int, default=10_000_000)
    parser.add_argument("--genes", type=int, default=30_000)
    parser.add_argument("--per-cell", type=int, default=20)
    parser.add_argument("--k", type=int, default=15)
    parser.add_argument("--latent", type=int, default=50)
    parser.add_argument("--categories", type=int, default=1_000_000)
    parser.add_argument("--modalities", type=int, default=2)
    parser.add_argument("--raw", action="store_true")
    parser.add_argument("--layers", action="store_true")
    parser.add_argument("--no-strings", action="store_true")
    parser.add_argument("--priority", action="store_true",
                        help="rows in priority order with X gene-major, as cellucid.prepare() writes")
    parser.add_argument("--expect", type=Path, default=None,
                        help="also write the order-free values `scale-app.mjs --expect` checks")
    args = parser.parse_args()
    started = time.perf_counter()
    cells = Cells(args.cells, args.genes, args.per_cell, args.k, args.latent, args.categories)
    write_store(args.out, args.format, cells, args)
    if args.expect is not None:
        write_expectations(args.expect, cells)
    size = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file()) if args.out.is_dir() else args.out.stat().st_size
    print(f"{args.format}: {args.cells:,} cells x {args.genes} genes, {size / 1e9:.2f} GB, "
          f"{time.perf_counter() - started:.0f} s")


if __name__ == "__main__":
    main()
