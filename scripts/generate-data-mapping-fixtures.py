"""Create the data-mapping browser fixtures.

Three small AnnData files exercise how the browser chooses and changes the
embeddings it plots (`tests/browser/data-mapping.spec.mjs`):

- ``data-mapping-guess.h5ad`` (and ``data-mapping-guess.zarr.zip``): no UMAP.
  ``X_umap_old`` ranks first for the best guess but holds a NaN at cell 17, so
  the guess skips it and shows ``X_tsne`` in 2D. ``obsm`` also holds a force
  layout, a wide ``X_pca``, a DataFrame and a sparse array, which the panel
  lists as unusable with their reasons.
- ``data-mapping-wide.h5ad``: only a wide ``X_pca`` (and a DataFrame), so the
  guess shows its columns 0 and 1 in 2D.
- ``data-mapping-multi.h5ad``: ``X_umap`` (the default 2D embedding), ``X_tsne``
  and ``X_pca``, plus ``velocity_umap`` bound to ``X_umap``.
- ``data-mapping-representations.h5ad`` (12,000 cells, enough for spatial
  trees and LOD): two 3D embeddings (``X_umap_3d``, the default, and
  ``X_phate``), two 2D ones (``X_umap_2d``, the default, and ``X_tsne``), a
  10-column ``X_pca`` and ``velocity_umap_2d`` bound to ``X_umap_2d``
  (``tests/browser/multi-representation.spec.mjs``).
- ``data-mapping-full.h5ad`` (and ``data-mapping-full.zarr.zip``): every other
  mapping group. Three neighbour graphs -- ``connectivities``,
  ``scvi_connectivities`` and an asymmetric ``distances`` that must be
  refused. An Ensembl var index with a ``gene_symbols`` column holding a
  duplicate and an empty value, a categorical ``feature_type`` and two columns
  that cannot name genes. ``X``, the layers ``counts`` and ``log1p``, and a
  ``raw`` with its own, wider var axis. ``X_scVI`` as a latent space, an
  ``X_broken`` embedding with a NaN at cell 5, and vectors named the way
  scVelo names them, each bound by default to the embedding it is named for:
  ``velocity_umap`` for ``X_umap``, ``velocity_tsne`` for ``X_tsne`` and
  ``velocity_pca``, as wide as ``X_pca``.
- ``data-mapping-crowded.h5ad``: many embeddings, as a segmentation export has
  them, with no default UMAP: three 2-column ``X_umap_scale*_latents`` (the
  guess turns them on), two 3-column arrays (``X_tsne_scale0_latents`` and
  ``spatial``), an integer 4-column ``coordinates`` and six wide latent and
  PCA arrays, plus a layer and a neighbour graph, and the colours Scanpy
  keeps for ``cell_type`` (``uns['cell_type_colors']``). The sidebar layout,
  the dimension choice of a narrow array and the sidebar's scroll position are
  tested on it (``tests/browser/data-mapping-layout.spec.mjs``); so are the
  embedding, camera, point size and palette a file opens with after another
  dataset (``tests/browser/dataset-switch-opening-view.spec.mjs``).

Every array is drawn from a seeded generator around three clusters, so the
files are the same on every run.

``data-mapping-full.expected.json`` records what the browser must read from
``data-mapping-full.h5ad`` and its Zarr ZIP, computed here with numpy and
scipy, independently of the browser's code. Digests are SHA-256 of
little-endian bytes. The rules are the ones ``cellucid-python``'s AnnData
server applied, ported here so the expectations need no ``cellucid``:

- ``knn``, per ``obsp`` graph: refused when it is not exactly symmetric;
  otherwise its edges, each unordered pair once as ``source < destination``
  sorted by source then destination (stored zeros are not edges), the most
  edges at any one cell, the largest weight, and every weight divided by the
  largest as float32 (``strength``).
- ``genes``, per expression matrix (``X``, ``raw``, ``layer-{k}``) and name
  source (the var index or ``column-{k}``, every var column that can name
  genes): the unique names and the make-unique record, and every gene's
  values as float32.
- ``latent``, per usable ``obsm`` array and categorical obs field: the outlier
  quantiles by the rule of ``scripts/generate-latent-outlier-conformance.py``
  (imported from it, one implementation), or the reason the array is refused.
- ``vectors``, per binding: the vector array at its columns, scaled by the
  bound embedding's normalization (``2 / largest column range``), as float32.

Run from the repository root:

```bash
python scripts/generate-data-mapping-fixtures.py          # write
python scripts/generate-data-mapping-fixtures.py --check  # compare
```

``--check`` writes nothing and exits non-zero when any fixture on disk
differs from what this script writes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import numbers
import sys
import tempfile
import zipfile
from collections.abc import Callable, Sequence
from pathlib import Path

import anndata
import numpy as np
import pandas as pd
from scipy import sparse

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "browser" / "fixtures"
CELL_COUNT = 300
REPRESENTATION_CELL_COUNT = 12_000
GENES = ["CD3E", "MS4A1", "LYZ", "NKG7", "PPBP"]
CLUSTERS = ["T cells", "B cells", "Monocytes"]
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def clustered(rng: np.random.Generator, labels: np.ndarray, width: int, spread: float) -> np.ndarray:
    """Points around one centre per cluster, ``width`` columns wide."""
    centres = rng.normal(0.0, 6.0, size=(len(CLUSTERS), width))
    return (centres[labels] + rng.normal(0.0, spread, size=(len(labels), width))).astype(np.float32)


def base_anndata(rng: np.random.Generator) -> tuple[anndata.AnnData, np.ndarray]:
    labels = np.arange(CELL_COUNT) % len(CLUSTERS)
    expression = rng.gamma(2.0, 1.0, size=(CELL_COUNT, len(GENES))).astype(np.float32)
    obs = pd.DataFrame(
        {"cell_type": pd.Categorical([CLUSTERS[label] for label in labels], categories=CLUSTERS)},
        index=[f"cell{index}" for index in range(CELL_COUNT)],
    )
    var = pd.DataFrame(index=GENES)
    return anndata.AnnData(X=expression, obs=obs, var=var), labels


def guess_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261019)
    adata, labels = base_anndata(rng)
    umap_old = clustered(rng, labels, 2, 0.8)
    umap_old[17, 1] = np.nan
    adata.obsm["X_umap_old"] = umap_old
    adata.obsm["X_tsne"] = clustered(rng, labels, 2, 1.0)
    adata.obsm["X_draw_graph_fa"] = clustered(rng, labels, 2, 1.5)
    adata.obsm["X_pca"] = clustered(rng, labels, 8, 1.2)
    adata.obsm["obs_table"] = pd.DataFrame(
        {"a": np.arange(CELL_COUNT, dtype=np.float32)}, index=adata.obs_names
    )
    adata.obsm["X_sparse"] = sparse.csr_matrix(clustered(rng, labels, 4, 1.0))
    return adata


def wide_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261020)
    adata, labels = base_anndata(rng)
    adata.obsm["X_pca"] = clustered(rng, labels, 8, 1.2)
    adata.obsm["obs_table"] = pd.DataFrame(
        {"a": np.arange(CELL_COUNT, dtype=np.float32)}, index=adata.obs_names
    )
    return adata


def multi_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261021)
    adata, labels = base_anndata(rng)
    adata.obsm["X_umap"] = clustered(rng, labels, 2, 0.8)
    adata.obsm["X_tsne"] = clustered(rng, labels, 2, 1.0)
    adata.obsm["X_pca"] = clustered(rng, labels, 6, 1.2)
    adata.obsm["velocity_umap"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
    return adata


def representations_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261022)
    labels = np.arange(REPRESENTATION_CELL_COUNT) % len(CLUSTERS)
    expression = rng.gamma(2.0, 1.0, size=(REPRESENTATION_CELL_COUNT, len(GENES))).astype(np.float32)
    obs = pd.DataFrame(
        {"cell_type": pd.Categorical([CLUSTERS[label] for label in labels], categories=CLUSTERS)},
        index=[f"cell{index}" for index in range(REPRESENTATION_CELL_COUNT)],
    )
    adata = anndata.AnnData(X=expression, obs=obs, var=pd.DataFrame(index=GENES))
    adata.obsm["X_umap_3d"] = clustered(rng, labels, 3, 0.8)
    adata.obsm["X_phate"] = clustered(rng, labels, 3, 1.2)
    adata.obsm["X_umap_2d"] = clustered(rng, labels, 2, 0.8)
    adata.obsm["X_tsne"] = clustered(rng, labels, 2, 1.0)
    adata.obsm["X_pca"] = clustered(rng, labels, 10, 1.2)
    adata.obsm["velocity_umap_2d"] = rng.normal(0.0, 0.3, size=(REPRESENTATION_CELL_COUNT, 2)).astype(np.float32)
    return adata


FULL_GENE_IDS = [f"ENSG{index:011d}" for index in range(1, 7)]
FULL_GENE_SYMBOLS = ["CD3E", "MS4A1", "LYZ", "LYZ", "", "NKG7"]
FULL_RAW_GENE_IDS = [*FULL_GENE_IDS, "ENSG00000000007", "ENSG00000000008"]
FULL_RAW_GENE_SYMBOLS = [*FULL_GENE_SYMBOLS, "PPBP", "GNLY"]


def crowded_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261023)
    adata, labels = base_anndata(rng)
    adata.layers["counts"] = np.round(adata.X * 3.0).astype(np.float32)
    adata.obsm["coordinates"] = np.round(clustered(rng, labels, 4, 40.0)).astype(np.int64)
    for scale, width in enumerate((12, 6, 6)):
        adata.obsm[f"X_pca_scale{scale}_latents"] = clustered(rng, labels, width, 1.2)
    for scale, width in enumerate((10, 10, 8)):
        adata.obsm[f"scale{scale}_latents"] = clustered(rng, labels, width, 1.5)
    adata.obsm["X_tsne_scale0_latents"] = clustered(rng, labels, 3, 1.0)
    adata.obsm["spatial"] = clustered(rng, labels, 3, 2.0)
    for scale in range(3):
        adata.obsm[f"X_umap_scale{scale}_latents"] = clustered(rng, labels, 2, 0.8)
    adata.obsp["connectivities"] = symmetric_graph(rng, labels, 6)
    # As ``sc.pl.umap(adata, color="cell_type")`` leaves it: one colour per
    # category, none of them one Cellucid would pick.
    adata.uns["cell_type_colors"] = np.array(["#8c564b", "#17becf", "#bcbd22"], dtype=object)
    return adata


def symmetric_graph(rng: np.random.Generator, labels: np.ndarray, neighbours: int) -> sparse.csr_matrix:
    """A symmetric, zero-diagonal kNN-style graph within each cluster."""
    rows: list[int] = []
    columns: list[int] = []
    for cell in range(len(labels)):
        same = np.flatnonzero(labels == labels[cell])
        for other in rng.choice(same[same != cell], size=neighbours, replace=False):
            rows.append(cell)
            columns.append(int(other))
    graph = sparse.csr_matrix(
        (rng.uniform(0.2, 1.0, size=len(rows)), (rows, columns)),
        shape=(len(labels), len(labels)),
    )
    graph = graph.maximum(graph.T).tocsr()
    graph.setdiag(0)
    graph.eliminate_zeros()
    return graph.astype(np.float32)


def full_fixture() -> anndata.AnnData:
    rng = np.random.default_rng(20261022)
    labels = np.arange(CELL_COUNT) % len(CLUSTERS)
    counts = rng.poisson(3.0, size=(CELL_COUNT, len(FULL_RAW_GENE_IDS))).astype(np.int32)
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical([CLUSTERS[label] for label in labels], categories=CLUSTERS),
            "batch": pd.Categorical([f"b{index % 2}" for index in range(CELL_COUNT)]),
        },
        index=[f"cell{index}" for index in range(CELL_COUNT)],
    )
    var = pd.DataFrame(
        {
            "gene_symbols": FULL_GENE_SYMBOLS,
            "feature_type": pd.Categorical(["Gene Expression"] * len(FULL_GENE_IDS)),
            "highly_variable": [True, False, True, False, True, False],
            "dispersions": np.linspace(0.5, 2.0, len(FULL_GENE_IDS)),
        },
        index=FULL_GENE_IDS,
    )
    raw = anndata.AnnData(
        X=sparse.csr_matrix(counts.astype(np.float32)),
        obs=obs.copy(),
        var=pd.DataFrame({"gene_symbols": FULL_RAW_GENE_SYMBOLS}, index=FULL_RAW_GENE_IDS),
    )
    subset = counts[:, : len(FULL_GENE_IDS)]
    adata = anndata.AnnData(
        X=np.log1p(subset.astype(np.float32) * 2.0).astype(np.float32),
        obs=obs,
        var=var,
    )
    adata.raw = raw
    adata.layers["counts"] = sparse.csr_matrix(subset)
    adata.layers["log1p"] = np.log1p(subset.astype(np.float32)).astype(np.float32)
    adata.obsm["X_umap"] = clustered(rng, labels, 2, 0.8)
    adata.obsm["X_tsne"] = clustered(rng, labels, 2, 1.0)
    adata.obsm["X_pca"] = clustered(rng, labels, 6, 1.2)
    adata.obsm["X_scVI"] = clustered(rng, labels, 10, 1.5)
    broken = clustered(rng, labels, 2, 1.0)
    broken[5, 0] = np.nan
    adata.obsm["X_broken"] = broken
    adata.obsm["velocity_umap"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
    adata.obsm["velocity_tsne"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
    adata.obsm["velocity_pca"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 6)).astype(np.float32)
    adata.obsp["connectivities"] = symmetric_graph(rng, labels, 6)
    adata.obsp["scvi_connectivities"] = symmetric_graph(rng, labels, 4)
    distances = symmetric_graph(rng, labels, 5)
    adata.obsp["distances"] = sparse.triu(distances, k=1).tocsr()
    return adata


# ---------------------------------------------------------------------------
# The expectations of data-mapping-full.expected.json: a numpy reference of
# the rules the browser must follow, independent of the browser's code.
# ---------------------------------------------------------------------------

# Categories with fewer cells than this get no outlier quantiles.
CENTROID_MIN_POINTS = 10

# Vector bindings the parity tests read: (vector key, its columns, embedding
# key, the embedding's columns).
FULL_VECTOR_BINDINGS = (
    ("velocity_umap", (0, 1), "X_umap", (0, 1)),
    ("velocity_tsne", (0, 1), "X_tsne", (0, 1)),
    ("velocity_pca", (2, 3), "X_pca", (2, 3)),
    ("velocity_pca", (0, 1, 2), "X_pca", (0, 1, 2)),
)


def latent_outlier_rule() -> Callable[[np.ndarray, np.ndarray, int, int], np.ndarray]:
    """``latent_outlier_quantiles`` of ``generate-latent-outlier-conformance.py``: one rule, one copy."""
    path = Path(__file__).with_name("generate-latent-outlier-conformance.py")
    spec = importlib.util.spec_from_file_location("latent_outlier_conformance", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.latent_outlier_quantiles


def digest(values: np.ndarray, dtype: str) -> str:
    """SHA-256 of one array's little-endian bytes in ``dtype``."""
    return hashlib.sha256(np.ascontiguousarray(values, dtype=dtype).tobytes()).hexdigest()


def float32_values(values: np.ndarray, *, label: str) -> np.ndarray:
    """Real values that stay finite and nonzero as float32, as float32."""
    array = np.asarray(values)
    if array.dtype.kind not in "iuf" or not np.isfinite(array).all():
        raise ValueError(f"{label} is not finite and real.")
    with np.errstate(over="ignore", invalid="ignore"):
        narrowed = array.astype(np.float32)
    if not np.isfinite(narrowed).all() or np.any((array != 0) & (narrowed == 0)):
        raise ValueError(f"{label} is outside the float32 range.")
    return narrowed


def value_defect(values: np.ndarray) -> str | None:
    """The first value of an array (rows are cells) that cannot be read, as the browser words it."""
    array = np.asarray(values)
    if array.dtype.kind not in "iuf":
        return "not a numeric array"
    if array.ndim == 1:
        array = array.reshape(-1, 1)
    with np.errstate(over="ignore", invalid="ignore"):
        finite = np.isfinite(array)
        if not finite.all():
            row = int(np.argwhere(~finite)[0][0])
            value = float(array[row][~finite[row]][0])
            kind = "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
            return f"{kind} at cell {row}"
        narrowed = array.astype(np.float32)
        bad = ~np.isfinite(narrowed) | ((array != 0) & (narrowed == 0))
        if bad.any():
            return f"not representable as float32 at cell {int(np.argwhere(bad)[0][0])}"
    return None


# -- knn ---------------------------------------------------------------------


def knn_expectation(matrix: object, n_cells: int) -> dict:
    """One ``obsp`` graph's canonical edges, or its refusal.

    A graph must be square over the cells, real, finite, non-negative, with a
    zero diagonal, and exactly symmetric in topology and weight; one that is
    not symmetric is refused (never repaired). Stored zeros are not edges. Each
    edge is its pair with ``source < destination``, sorted by source, then
    destination; ``max_neighbors`` is the most edges at any one cell.
    """
    graph = sparse.csr_matrix(matrix)
    if graph.shape != (n_cells, n_cells):
        raise ValueError(f"graph shape {graph.shape} is not ({n_cells}, {n_cells})")
    weights = graph.data.astype(np.float64)
    if graph.dtype.kind not in "iufb" or not np.isfinite(weights).all() or (weights < 0).any():
        raise ValueError("graph weights must be real, finite and non-negative")
    graph = graph.copy()
    graph.sum_duplicates()
    graph.eliminate_zeros()
    if graph.diagonal().any():
        raise ValueError("graph diagonal must be zero")
    if (graph != graph.T).nnz:
        return {"refused": True}
    upper = sparse.triu(graph, k=1).tocoo()
    sources = upper.row.astype(np.int64)
    destinations = upper.col.astype(np.int64)
    weights = upper.data.astype(np.float64)
    order = np.lexsort((destinations, sources))
    sources, destinations, weights = sources[order], destinations[order], weights[order]
    degrees = np.bincount(sources, minlength=n_cells) + np.bincount(destinations, minlength=n_cells)
    largest = float(weights.max()) if weights.size else 0.0
    return {
        "n_edges": int(sources.size),
        "max_neighbors": int(degrees.max()),
        "sources": digest(sources, "<u4"),
        "destinations": digest(destinations, "<u4"),
        # What the web app's edge payload carries: the largest weight and
        # every weight relative to it, rounded to float32 for rendering.
        "max_weight": largest,
        "strength": digest((weights / largest).astype(np.float32) if weights.size else weights, "<f4"),
    }


# -- genes -------------------------------------------------------------------


def var_column_usable(column: pd.Series) -> bool:
    """Whether a var column can name genes: not floating-point, not true/false."""
    return column.dtype.kind not in "fb"


def is_missing_name(value: object) -> bool:
    """``None``, ``""``, NaN, and pandas' missing values."""
    if value is None:
        return True
    if isinstance(value, str):
        return value == ""
    if isinstance(value, float):
        return math.isnan(value)
    return type(value).__name__ in {"NAType", "NaTType"}


def gene_name_text(value: object) -> str | None:
    """A var value as a gene name (Python ``str()``), or None when it is missing."""
    if is_missing_name(value):
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool | np.bool_):
        return "True" if value else "False"
    if isinstance(value, numbers.Integral):
        return str(int(value))
    if isinstance(value, numbers.Real):
        number = float(value)
        return None if math.isnan(number) else str(number)
    raise TypeError(f"a gene name must be text or a number, got {type(value).__name__}")


def make_unique_names(names: Sequence[str | None], index: Sequence[str]) -> tuple[list[str], list[list[str]], int]:
    """anndata's ``make_index_unique`` rule, after empty names take the index name.

    Returns the unique names, every ``[from, to]`` renaming in order, and the
    count of names taken from the index. The first occurrence keeps its name;
    each later one becomes ``name-k``, ``k`` counting up per name and skipping
    any name already present or produced.
    """
    filled: list[str] = []
    from_index = 0
    for position, name in enumerate(names):
        if is_missing_name(name):
            filled.append(index[position])
            from_index += 1
        else:
            filled.append(str(name))
    taken = set(filled)
    seen: set[str] = set()
    counters: dict[str, int] = {}
    unique: list[str] = []
    renamed: list[list[str]] = []
    for name in filled:
        if name not in seen:
            seen.add(name)
            unique.append(name)
            continue
        while True:
            counters[name] = counters.get(name, 0) + 1
            candidate = f"{name}-{counters[name]}"
            if candidate not in taken:
                break
        taken.add(candidate)
        unique.append(candidate)
        renamed.append([name, candidate])
    return unique, renamed, from_index


def gene_expectations(adata: anndata.AnnData) -> dict:
    """Per expression matrix and name source: the unique names, their record, each gene's float32 digest."""
    axes: list[tuple[str, object, pd.DataFrame]] = [("X", adata.X, adata.var)]
    if adata.raw is not None:
        axes.append(("raw", adata.raw.X, adata.raw.var))
    # Layers are numbered by their position in the file's key order.
    axes += [(f"layer-{index}", adata.layers[key], adata.var) for index, key in enumerate(adata.layers)]
    routes: dict[str, dict] = {}
    for axis, matrix, var in axes:
        index = [str(name) for name in var.index]
        dense = matrix.toarray() if sparse.issparse(matrix) else np.asarray(matrix)
        values = [
            digest(float32_values(dense[:, gene], label=f"{axis} gene {gene}"), "<f4")
            for gene in range(dense.shape[1])
        ]
        sources: list[tuple[str, str | None]] = [("index", None)]
        sources += [
            (f"column-{position}", str(key))
            for position, key in enumerate(var.columns)
            if var_column_usable(var[key])
        ]
        for names, source in sources:
            raw_names = index if source is None else [gene_name_text(value) for value in var[source].tolist()]
            unique, renamed, from_index = make_unique_names(raw_names, index)
            routes[f"{axis}/{names}"] = {
                "names": unique,
                "gene_names": {
                    "source": source,
                    "filled_from_index": from_index,
                    "renamed": renamed,
                },
                "values": values,
            }
    return routes


# -- latent ------------------------------------------------------------------


def usable_obsm_keys(adata: anndata.AnnData) -> list[str]:
    """``obsm`` arrays a mapping can use: dense, numeric, one row per cell, one or two dimensions."""
    usable = []
    for key in adata.obsm:
        value = adata.obsm[key]
        if not isinstance(value, np.ndarray):
            continue  # a DataFrame or a sparse array
        has_columns = value.ndim == 1 or (value.ndim == 2 and value.shape[1] >= 1)
        if has_columns and value.shape[0] == adata.n_obs and value.dtype.kind in "iuf":
            usable.append(str(key))
    return usable


def is_categorical_field(series: pd.Series) -> bool:
    """Categories, true/false values, strings and objects are categorical; numbers are continuous."""
    if isinstance(series.dtype, pd.CategoricalDtype) or pd.api.types.is_bool_dtype(series):
        return True
    if pd.api.types.is_numeric_dtype(series):
        return False
    return pd.api.types.is_string_dtype(series) or pd.api.types.is_object_dtype(series)


def latent_expectations(adata: anndata.AnnData) -> dict:
    """Per usable ``obsm`` array and categorical obs field, the outlier-quantile digest or the refusal."""
    quantiles_of = latent_outlier_rule()
    fields = [key for key in adata.obs.columns if is_categorical_field(adata.obs[key])]
    latent: dict[str, dict] = {}
    for key in usable_obsm_keys(adata):
        values = np.asarray(adata.obsm[key])
        values = values.reshape(-1, 1) if values.ndim == 1 else values
        defect = value_defect(values)
        if defect is not None:
            latent[key] = {"refused": defect}
            continue
        values = float32_values(values, label=f"obsm[{key!r}]")
        outcomes: dict[str, str] = {}
        for field in fields:
            categorical = adata.obs[field].astype("category")
            codes = categorical.cat.codes.to_numpy(dtype=np.int32)
            quantiles = quantiles_of(values, codes, len(categorical.cat.categories), CENTROID_MIN_POINTS)
            outcomes[str(field)] = digest(quantiles, "<f4")
        latent[key] = outcomes
    return latent


# -- vectors -----------------------------------------------------------------


def vector_expectations(adata: anndata.AnnData) -> dict:
    """Per binding, the digest of the vector payload as float32.

    A vector array binds to an embedding's columns when it is as wide as the
    embedding's array and read at the same columns, or exactly as wide as the
    embedding's dimension and read whole. Its values are multiplied, in
    float64, by the embedding's normalization factor -- 2 over the largest
    range of the embedding's selected columns -- and rounded once to float32.
    """
    vectors: dict[str, str] = {}
    for vector_key, vector_columns, embedding_key, embedding_columns in FULL_VECTOR_BINDINGS:
        vector = np.asarray(adata.obsm[vector_key])
        embedding = np.asarray(adata.obsm[embedding_key])
        dimension = len(embedding_columns)
        same_columns = vector.shape[1] == embedding.shape[1] and vector_columns == embedding_columns
        whole = vector.shape[1] == dimension and vector_columns == tuple(range(dimension))
        if not (same_columns or whole):
            raise ValueError(f"{vector_key} cannot be bound to {embedding_key} at {vector_columns}")
        if value_defect(embedding[:, embedding_columns]) or value_defect(vector[:, vector_columns]):
            raise ValueError(f"{vector_key} at {embedding_key} reads a value that is not finite")
        selected = embedding[:, embedding_columns].astype(np.float64)
        largest_range = float((selected.max(axis=0) - selected.min(axis=0)).max())
        if largest_range <= 0:
            raise ValueError(f"{embedding_key} has no coordinate variation")
        scaled = vector[:, vector_columns].astype(np.float64) * (2.0 / largest_range)
        name = f"{vector_key}@{embedding_key}[{','.join(map(str, embedding_columns))}]"
        vectors[name] = digest(scaled.astype(np.float32), "<f4")
    return vectors


def full_expectations(adata: anndata.AnnData) -> dict:
    """What the browser must read from the full fixture, for the parity tests."""
    return {
        "n_obs": int(adata.n_obs),
        "knn": {str(key): knn_expectation(adata.obsp[key], int(adata.n_obs)) for key in adata.obsp},
        "genes": gene_expectations(adata),
        "latent": latent_expectations(adata),
        "vectors": vector_expectations(adata),
    }


def write_zarr_zip(adata: anndata.AnnData, target: Path, root: str) -> None:
    """Write one AnnData Zarr v2 store into a ZIP with fixed entry metadata."""
    with tempfile.TemporaryDirectory(prefix="cellucid-data-mapping-") as temporary:
        store = Path(temporary) / root
        with anndata.settings.override(zarr_write_format=2):
            adata.write_zarr(store)
        staged = Path(temporary) / target.name
        with zipfile.ZipFile(staged, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for source in sorted(path for path in store.rglob("*") if path.is_file()):
                info = zipfile.ZipInfo(
                    filename=f"{root}/{source.relative_to(store).as_posix()}",
                    date_time=ZIP_TIMESTAMP,
                )
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, source.read_bytes(), compresslevel=9)
        staged.replace(target)


def write_fixtures(directory: Path) -> list[Path]:
    """Write every fixture into ``directory``; return their paths."""
    targets: list[Path] = []

    def target(name: str) -> Path:
        targets.append(directory / name)
        return targets[-1]

    guess = guess_fixture()
    guess.write_h5ad(target("data-mapping-guess.h5ad"))
    write_zarr_zip(guess, target("data-mapping-guess.zarr.zip"), "data-mapping-guess.zarr")
    wide_fixture().write_h5ad(target("data-mapping-wide.h5ad"))
    multi_fixture().write_h5ad(target("data-mapping-multi.h5ad"))
    representations_fixture().write_h5ad(target("data-mapping-representations.h5ad"), compression="gzip")
    crowded_fixture().write_h5ad(target("data-mapping-crowded.h5ad"))
    full = full_fixture()
    full.write_h5ad(target("data-mapping-full.h5ad"))
    write_zarr_zip(full, target("data-mapping-full.zarr.zip"), "data-mapping-full.zarr")
    target("data-mapping-full.expected.json").write_text(
        json.dumps(full_expectations(full), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return targets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="compare with the fixtures on disk; write nothing")
    arguments = parser.parse_args()
    if not arguments.check:
        write_fixtures(FIXTURE_DIRECTORY)
        return 0
    with tempfile.TemporaryDirectory(prefix="cellucid-data-mapping-check-") as temporary:
        differing = [
            written.name
            for written in write_fixtures(Path(temporary))
            if not (FIXTURE_DIRECTORY / written.name).is_file()
            or (FIXTURE_DIRECTORY / written.name).read_bytes() != written.read_bytes()
        ]
    if differing:
        for name in differing:
            print(f"{FIXTURE_DIRECTORY / name} differs from what this script writes.", file=sys.stderr)
        return 1
    print(f"Every data-mapping fixture in {FIXTURE_DIRECTORY} matches.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
