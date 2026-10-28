"""Write the fixtures of the analysis-under-subsample differential tests.

Every analysis computes on the cells open. These fixtures hold one synthetic
dataset written by ``cellucid.prepare()`` twice, and what numpy, SciPy and
pandas compute on exactly the cells each opening keeps, so the web app's
analyses can be compared with an independent reference on every way cells
can be open (``tests/analysis-subsample-differential.test.mjs`` through the
reader and the analysis kernels, ``tests/browser/analysis-subsample-differential.spec.mjs``
through the app's analysis windows):

- ``tests/fixtures/subsample-analysis/given.zarr.zip``: the cells as given
  (``priority_seed=None``);
- ``tests/fixtures/subsample-analysis/priority.zarr.zip``: the same cells in
  priority order (``priority_seed=0``), with the original position column;
- ``tests/fixtures/subsample-analysis/served.zarr.zip``: every key of the
  store cellucid-python serves for the AnnData object (``show_anndata``,
  ``serve_anndata``, the widget: ``cellucid._served_store.PriorityStore``),
  stored uncompressed in a zip, as the browser reads it over the viewer
  channel. (R serves the same bytes: ``test-served-cross-language.R``.)
- ``tests/fixtures/subsample-analysis/served-r.zarr.zip``: every key of the
  store cellucid-r serves for the same object (``cellucid_view()``,
  ``cellucid_serve()``: ``.serve_object``), run directly from the R sources
  (``CELLUCID_R_SOURCE``, default ``../cellucid-r``; ``CELLUCID_RSCRIPT``,
  default ``Rscript``), as the browser reads it.
- ``tests/fixtures/subsample-analysis/reference.json``: per opening, the kept
  cells (``cellucid.subsample_cells``, original positions, ascending) and the
  reference of each analysis on them; ``reference.json.sha256`` catches a
  hand edit.

The data: 1,200 cells x 24 genes. ``obs``: ``cell_type`` (``T``, ``B``,
``Mono``, ``NK``, ``rare`` of 6 cells, ``single`` of one cell, ``unused`` of
none), ``batch`` (4), ``condition`` (2), ``sample`` (8, nested in
condition), ``score`` (float, NaN for one cell in twenty). ``X`` is CSR,
zero-inflated, every value a multiple of 1/4 up to 4 (dyadic: float32 holds
it exactly and every sum here is exact in float32 and float64); ``RARE1`` is
non-zero only in ``rare`` cells (a gene a subsample can leave with no
non-zero) and ``EMPTY`` nowhere. ``var``: the index is Ensembl-style ids
(``ENSG…``), ``var['feature_name']`` the symbols the viewer shows (as a
CELLxGENE file): an id crosses every boundary, the symbol beside it. ``obsm``: ``X_umap`` (2-D), ``X_pca``
(8-D, the latent space, outlier quantiles stored for it), ``velocity_umap``
(a vector field). ``obsp['connectivities']``: five neighbours a cell,
symmetrised.

The openings (``OPENINGS``): every cell of each file; uniform at the file's
seed (on the priority file, a prefix) and at another seed; a smaller uniform
at the file seed (a progressive opening mid-growth, and the in-place lowered
share: nested in the larger one), and the first view of a progressive
opening of the larger one; blocks; stratified proportional and
balanced; spatial; one and two cells; the stores Python and R serve.

Beside each opening's analyses, what the app shows on it: the cells each
filter keeps (``FILTERS``: categories hidden, a range of a continuous obs
column, a range of a gene, and all three at once; a range keeps
``min <= value <= max``, a missing value never), Quick insights over every
open cell, and the Detailed view's summary of a page of the ``T`` cells and
of the rest of the open cells.

Run from the repository root, with cellucid-python installed (the
repository environment)::

    python scripts/generate-subsample-analysis-fixtures.py

R and its ``pkgload``, ``Matrix`` and ``jsonlite`` packages must be
installed (with a compiler for the package's native code).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

import cellucid
import numpy as np
import pandas as pd
from scipy import sparse, stats

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "subsample-analysis"
N_CELLS = 1200
TYPES = ["T", "B", "Mono", "NK", "rare", "single", "unused"]
TYPE_SIZES = [426, 380, 240, 147, 6, 1, 0]
GENES = [f"G{i}" for i in range(20)] + ["RARE1", "EMPTY", "MT-CO1", "HBB"]
GENE_IDS = [f"ENSG{i:011d}" for i in range(len(GENES))]
MIN_POINTS = 10
R_SOURCE = Path(os.environ.get("CELLUCID_R_SOURCE", ROOT.parent / "cellucid-r"))
RSCRIPT = os.environ.get("CELLUCID_RSCRIPT", "Rscript")

# Each opening: the file, the request the app is given (as its link and the
# reader take it), and the arguments of cellucid.subsample_cells that keep
# the same cells (None: every cell).
OPENINGS = [
    ("all-given", "given", None, None),
    ("all-priority", "priority", None, None),
    ("uniform-file-seed", "priority", {"method": "uniform", "k": 300, "seed": 0}, {"n_cells": 300, "method": "uniform", "seed": 0}),
    ("uniform-file-seed-given", "given", {"method": "uniform", "k": 300, "seed": 0}, {"n_cells": 300, "method": "uniform", "seed": 0}),
    ("uniform-mid-growth", "priority", {"method": "uniform", "k": 150, "seed": 0}, {"n_cells": 150, "method": "uniform", "seed": 0}),
    # The first view of a progressive opening of 300 cells whose showing is
    # measured slow: the square root of 300, rounded up (`progressivePlan`).
    ("uniform-first-view", "priority", {"method": "uniform", "k": 18, "seed": 0}, {"n_cells": 18, "method": "uniform", "seed": 0}),
    ("uniform-other-seed", "priority", {"method": "uniform", "k": 300, "seed": 17}, {"n_cells": 300, "method": "uniform", "seed": 17}),
    ("blocks", "given", {"method": "blocks", "k": 320, "seed": 3, "blockSize": 64}, {"n_cells": 320, "method": "blocks", "seed": 3, "block_size": 64}),
    ("stratified-proportional", "priority", {"method": "stratified", "k": 240, "seed": 5, "field": "cell_type", "allocation": "proportional"},
     {"n_cells": 240, "method": "stratified", "seed": 5, "groupby": "cell_type", "allocation": "proportional"}),
    ("stratified-balanced", "given", {"method": "stratified", "k": 120, "seed": 9, "field": "cell_type", "allocation": "balanced"},
     {"n_cells": 120, "method": "stratified", "seed": 9, "groupby": "cell_type", "allocation": "balanced"}),
    # The same, by the field as text (a Loom column, a table beside a matrix,
    # a Cell Ranger clustering): its labels made categories in code-point
    # order, as the specification says of plain values.
    ("stratified-balanced-text", "given", {"method": "stratified", "k": 120, "seed": 9, "field": "cell_type", "allocation": "balanced"},
     {"n_cells": 120, "method": "stratified", "seed": 9, "groupby": "cell_type:text", "allocation": "balanced"}),
    ("spatial", "priority", {"method": "spatial", "k": 200, "seed": 2, "embedding": "X_umap", "gridSize": 8},
     {"n_cells": 200, "method": "spatial", "seed": 2, "basis": "X_umap", "grid_size": 8}),
    ("served-all", "served", None, None),
    ("served-uniform", "served", {"method": "uniform", "k": 300, "seed": 0}, {"n_cells": 300, "method": "uniform", "seed": 0}),
    ("served-r-all", "served-r", None, None),
    ("served-r-uniform", "served-r", {"method": "uniform", "k": 300, "seed": 0}, {"n_cells": 300, "method": "uniform", "seed": 0}),
    ("one-cell", "priority", {"method": "uniform", "k": 1, "seed": 4}, {"n_cells": 1, "method": "uniform", "seed": 4}),
    ("two-cells", "given", {"method": "uniform", "k": 2, "seed": 4}, {"n_cells": 2, "method": "uniform", "seed": 4}),
]

# What each analysis is asked.
DE_PAIRS = [("T", "B"), ("Mono", "rare")]
DOTPLOT_GENES = ["G0", "G3", "G7", "RARE1", "EMPTY"]
CORRELATION_PAIRS = [("G0", "G1"), ("G2", "G5"), ("G0", "score"), ("RARE1", "G3")]
SIGNATURE = ["G0", "G4", "G9", "RARE1"]
# What each filter keeps visible: the categories of cell_type left shown, a
# range of score, a range of a gene (at least the given value).
FILTERS = {
    "shownTypes": ["T", "NK", "rare", "single"],
    "score": [-0.5, 1.0],
    "gene": "G3",
    "geneAtLeast": 1.0,
}
# The Detailed view's variables.
DETAILED = {"continuous": ["score", "G3"], "categorical": "batch"}


def synthetic_adata():
    import anndata as ad

    rng = np.random.default_rng(20261027)
    type_codes = np.repeat(np.arange(len(TYPES)), TYPE_SIZES)
    rng.shuffle(type_codes)
    n_genes = len(GENES)
    # Mean expression (in quarter units) of each gene in each type.
    levels = rng.integers(0, 9, size=(len(TYPES), n_genes))
    rare_gene = GENES.index("RARE1")
    empty_gene = GENES.index("EMPTY")
    levels[:, rare_gene] = 0
    levels[TYPES.index("rare"), rare_gene] = 12
    levels[:, empty_gene] = 0
    quarters = rng.poisson(levels[type_codes])
    quarters = np.minimum(quarters, 16)
    dropout = rng.random(quarters.shape) < 0.45
    quarters[dropout] = 0
    quarters[:, rare_gene] = np.where(type_codes == TYPES.index("rare"), np.maximum(quarters[:, rare_gene], 1), 0)
    quarters[:, empty_gene] = 0
    X = sparse.csr_matrix((quarters / 4).astype(np.float32))

    batch = rng.integers(0, 4, N_CELLS)
    sample = rng.integers(0, 8, N_CELLS)
    condition = (sample >= 4).astype(np.int64)
    score = rng.normal(0.0, 1.0, N_CELLS)
    score[rng.random(N_CELLS) < 0.05] = np.nan
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical.from_codes(type_codes, TYPES),
            "batch": pd.Categorical.from_codes(batch, ["b0", "b1", "b2", "b3"]),
            "condition": pd.Categorical.from_codes(condition, ["ctrl", "stim"]),
            "sample": pd.Categorical.from_codes(sample, [f"s{i}" for i in range(8)]),
            "score": score.astype(np.float32),
        },
        index=[f"cell{i:04d}" for i in range(N_CELLS)],
    )
    centres = rng.normal(0.0, 5.0, size=(len(TYPES), 8))
    pca = (centres[type_codes] + rng.normal(0.0, 1.0, size=(N_CELLS, 8))).astype(np.float32)
    umap = (pca[:, :2] + rng.normal(0.0, 0.3, size=(N_CELLS, 2))).astype(np.float32)
    velocity = rng.normal(0.0, 0.2, size=(N_CELLS, 2)).astype(np.float32)
    # Five nearest neighbours in the latent space, weights by distance.
    distances = ((pca[:, None, :] - pca[None, :, :]) ** 2).sum(axis=2)
    np.fill_diagonal(distances, np.inf)
    neighbours = np.argsort(distances, axis=1, kind="stable")[:, :5]
    rows = np.repeat(np.arange(N_CELLS), 5)
    weights = (1.0 / (1.0 + np.sqrt(distances[rows, neighbours.ravel()]))).astype(np.float32)
    graph = sparse.csr_matrix((weights, (rows, neighbours.ravel())), shape=(N_CELLS, N_CELLS))
    # Symmetric, as a neighbour graph is stored: the larger weight of a pair.
    graph = graph.maximum(graph.T).tocsr()
    adata = ad.AnnData(X=X, obs=obs, var=pd.DataFrame({"feature_name": GENES}, index=GENE_IDS))
    adata.obsm["X_umap"] = umap
    adata.obsm["X_pca"] = pca
    adata.obsm["velocity_umap"] = velocity
    adata.obsp["connectivities"] = graph
    return adata


def kept_cells(adata, arguments):
    if arguments is None:
        return np.arange(adata.n_obs, dtype=np.int64)
    arguments = dict(arguments)
    if arguments.get("groupby") is not None:
        name, _, kind = arguments["groupby"].partition(":")
        arguments["groupby"] = adata.obs[name] if kind == "" else adata.obs[name].astype(str).to_numpy(dtype=object)
    if arguments.get("basis") is not None:
        arguments["basis"] = adata.obsm[arguments["basis"]]
    return cellucid.subsample_cells(adata, **arguments)


def column(adata, cells, gene):
    if gene == "score":
        return adata.obs["score"].to_numpy(dtype=np.float32)[cells]
    j = GENES.index(gene)
    return np.asarray(adata.X[cells, j].todense(), dtype=np.float32).ravel()


def filter_reference(adata, cells, codes):
    """The open cells each filter leaves visible, as original positions,
    ascending: categories hidden on ``cell_type``; ``score`` in a range;
    a gene at least a value (up to the open cells' largest); all three."""
    shown = np.isin(codes[cells], [TYPES.index(name) for name in FILTERS["shownTypes"]])
    score = column(adata, cells, "score")
    low, high = FILTERS["score"]
    # Compared as the app compares: the stored float32 value with the bound
    # (a double); a missing value is never in a range.
    in_score = (score >= low) & (score <= high)
    in_gene = column(adata, cells, FILTERS["gene"]) >= FILTERS["geneAtLeast"]
    return {
        "category": cells[shown].tolist(),
        "continuous": cells[in_score].tolist(),
        "gene": cells[in_gene].tolist(),
        "combined": cells[shown & in_score & in_gene].tolist(),
    }


def top_categories(names, codes):
    """Quick insights' most frequent categories: up to five with a cell,
    by count, a tie in category order."""
    counts = np.bincount(codes, minlength=len(names))
    order = sorted((index for index in range(len(names)) if counts[index] > 0), key=lambda index: (-counts[index], index))
    return [{"name": names[index], "count": int(counts[index])} for index in order[:5]]


def summary(values):
    """Count, mean, median, extremes, population standard deviation and the
    quartile positions ``floor(0.25 count)`` and ``floor(0.75 count)`` of
    the ascending order, over the values that are not missing."""
    values = np.asarray(values, dtype=np.float64)
    finite = np.sort(values[np.isfinite(values)])
    count = len(finite)
    out = {"count": count, "missing": int(len(values) - count)}
    if count == 0:
        return out
    out.update({
        "mean": float(finite.mean()),
        "median": float(np.median(finite)),
        "min": float(finite[0]),
        "max": float(finite[-1]),
        "std": float(finite.std()),
        "q1": float(finite[count // 4]),
        "q3": float(finite[(3 * count) // 4]),
    })
    return out


def quick_reference(adata, cells, codes):
    """Quick insights over every open cell: the first two categorical obs
    fields' most frequent categories and the continuous one's summary."""
    batch = adata.obs["batch"].cat
    return {
        "cell_type": top_categories(TYPES, codes[cells]),
        "batch": top_categories(list(batch.categories), batch.codes.to_numpy()[cells]),
        "score": summary(column(adata, cells, "score")),
    }


def detailed_reference(adata, cells, codes):
    """The Detailed view's summary of two pages: the open ``T`` cells, and
    the rest of the open cells."""
    is_t = codes[cells] == TYPES.index("T")
    pages = {"T": cells[is_t], "rest": cells[~is_t]}
    batch = adata.obs["batch"].cat
    out = {}
    for name, page in pages.items():
        entry = {"cells": len(page)}
        for variable in DETAILED["continuous"]:
            entry[variable] = summary(column(adata, page, variable))
        counts = np.bincount(batch.codes.to_numpy()[page], minlength=len(batch.categories))
        entry[DETAILED["categorical"]] = {category: int(counts[i]) for i, category in enumerate(batch.categories)}
        out[name] = entry
    return out


def f(value):
    """A float as JSON keeps it: null for NaN."""
    value = float(value)
    return None if np.isnan(value) else value


def mann_whitney(a, b):
    """U and p as the app's `exact` convention states them: SciPy's exact
    distribution when both sides are under 50 and untied, else the normal
    approximation with tie and continuity correction."""
    joined = np.concatenate([a, b])
    tied = len(np.unique(joined)) < len(joined)
    method = "exact" if len(a) < 50 and len(b) < 50 and not tied else "asymptotic"
    result = stats.mannwhitneyu(a, b, alternative="two-sided", method=method, use_continuity=True)
    return float(result.statistic), float(result.pvalue), method


def de_reference(adata, cells, codes):
    out = []
    for name_a, name_b in DE_PAIRS:
        in_a = cells[codes[cells] == TYPES.index(name_a)]
        in_b = cells[codes[cells] == TYPES.index(name_b)]
        genes = []
        for gene in GENES:
            a = column(adata, in_a, gene).astype(np.float64)
            b = column(adata, in_b, gene).astype(np.float64)
            row = {
                "gene": gene,
                "nA": len(a),
                "nB": len(b),
                "pctA": f(100 * np.count_nonzero(a) / len(a)) if len(a) else None,
                "pctB": f(100 * np.count_nonzero(b) / len(b)) if len(b) else None,
            }
            if len(a) >= 2 and len(b) >= 2:
                row["meanA"] = float(a.sum() / len(a))
                row["meanB"] = float(b.sum() / len(b))
                row["log2FoldChange"] = f(np.log2((np.expm1(row["meanA"]) + 1e-9) / (np.expm1(row["meanB"]) + 1e-9)))
                u, p, method = mann_whitney(a, b)
                row["U"] = min(u, len(a) * len(b) - u)
                row["pWilcox"] = f(p)
                row["wilcoxMethod"] = method
                if a.var() > 0 or b.var() > 0:
                    t = stats.ttest_ind(a, b, equal_var=False)
                    row["t"] = f(t.statistic)
                    row["pT"] = f(t.pvalue)
            genes.append(row)
        out.append({"a": name_a, "b": name_b, "genes": genes})
    return out


def markers_reference(adata, cells, codes):
    """One group against the rest of the open cells, rank sums as scanpy's
    `wilcoxon` (no tie correction): z and its two-sided normal p. A group or
    rest of under two cells is not tested (the app's rule) and not listed."""
    out = {}
    open_codes = codes[cells]
    for code, name in enumerate(TYPES):
        n1 = int(np.count_nonzero(open_codes == code))
        n2 = len(cells) - n1
        if n1 < 2 or n2 < 2:
            continue
        rows = []
        for gene in GENES:
            values = column(adata, cells, gene).astype(np.float64)
            ranks = stats.rankdata(values)
            rank_sum = ranks[open_codes == code].sum()
            n = n1 + n2
            z = (rank_sum - n1 * (n + 1) / 2) / np.sqrt(n1 * n2 * (n + 1) / 12)
            rows.append({"gene": gene, "score": f(z), "p": f(2 * stats.norm.sf(abs(z)))})
        out[name] = {"n": n1, "genes": rows}
    return out


def dotplot_reference(adata, cells, codes):
    out = {}
    open_codes = codes[cells]
    for gene in DOTPLOT_GENES:
        values = column(adata, cells, gene).astype(np.float64)
        per_type = []
        for code in range(len(TYPES)):
            in_type = values[open_codes == code]
            per_type.append({"size": len(in_type), "sum": float(in_type.sum()), "expressing": int(np.count_nonzero(in_type > 0))})
        out[gene] = per_type
    return out


def composition_reference(adata, cells, codes):
    batch = adata.obs["batch"].cat.codes.to_numpy()[cells]
    table = np.zeros((len(TYPES), 4), dtype=np.int64)
    np.add.at(table, (codes[cells], batch), 1)
    return table.tolist()


def correlation_reference(adata, cells):
    out = []
    for x_name, y_name in CORRELATION_PAIRS:
        x = column(adata, cells, x_name).astype(np.float64)
        y = column(adata, cells, y_name).astype(np.float64)
        finite = np.isfinite(x) & np.isfinite(y)
        x, y = x[finite], y[finite]
        entry = {"x": x_name, "y": y_name, "n": int(len(x))}
        if len(x) >= 3 and x.std() > 0 and y.std() > 0:
            entry["pearson"] = f(stats.pearsonr(x, y).statistic)
            entry["spearman"] = f(stats.spearmanr(x, y).statistic)
        out.append(entry)
    return out


def signature_reference(adata, cells):
    """Mean of the signature's values, accumulated in float32 gene by gene
    (sums of quarters: exact), divided once, rounded to float32; by original
    position."""
    total = np.zeros(len(cells), dtype=np.float32)
    for gene in SIGNATURE:
        total = (total + column(adata, cells, gene)).astype(np.float32)
    return [float(np.float32(value / np.float32(len(SIGNATURE)))) for value in total]


def graph_reference(adata, cells):
    """The neighbour graph on the kept cells (the induced subgraph): its
    undirected edges as pairs of original positions, ``p < q``, one
    ``p,q`` line each in ascending order, by SHA-256; and its largest weight."""
    graph = adata.obsp["connectivities"].tocoo()
    kept = np.zeros(adata.n_obs, dtype=bool)
    kept[cells] = True
    inside = kept[graph.row] & kept[graph.col] & (graph.row < graph.col)
    pairs = sorted(zip(graph.row[inside].tolist(), graph.col[inside].tolist()))
    lines = "".join(f"{p},{q}\n" for p, q in pairs)
    weights = graph.data[kept[graph.row] & kept[graph.col]]
    return {
        "edges": len(pairs),
        "pairsSha256": hashlib.sha256(lines.encode("ascii")).hexdigest(),
        "maxWeight": float(weights.max()) if len(weights) else None,
    }


def outlier_rule():
    """The independent numpy rule of the latent outlier quantiles
    (``scripts/generate-latent-outlier-conformance.py``)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("conformance", ROOT / "scripts" / "generate-latent-outlier-conformance.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.latent_outlier_quantiles


def float32_sha(values) -> str:
    return hashlib.sha256(np.ascontiguousarray(values, dtype="<f4").tobytes()).hexdigest()


def overlay_reference(adata, cells, codes, rule):
    """By original position, ascending: the velocity vectors of the kept
    cells; the outlier quantiles of ``cell_type`` in ``X_pca`` that
    ``prepare()`` stores (every cell's, gathered: they describe the whole
    dataset) and that the rule gives on the kept cells alone (what a file
    storing none gets: an estimate)."""
    latent = adata.obsm["X_pca"]
    whole = rule(latent, codes, len(TYPES), MIN_POINTS)
    return {
        "velocitySha256": float32_sha(adata.obsm["velocity_umap"][cells]),
        "outliersStoredSha256": float32_sha(whole[cells]),
        "outliersOpenSha256": float32_sha(rule(latent[cells], codes[cells], len(TYPES), MIN_POINTS)),
    }


R_SERVE = r"""
args <- commandArgs(trailingOnly = TRUE)
suppressMessages(pkgload::load_all(args[[1]], quiet = TRUE, export_all = FALSE, helpers = FALSE))
input <- jsonlite::fromJSON(args[[2]], simplifyVector = TRUE)
n <- length(input$cells)
m <- length(input$genes)
# Cells x genes, as a caller gives it.
x <- Matrix::sparseMatrix(i = input$indices + 1L, p = input$indptr, x = input$data, dims = c(m, n),
                          dimnames = list(input$genes, input$cells))
x <- methods::as(Matrix::t(x), "CsparseMatrix")
obs <- data.frame(row.names = input$cells)
for (name in names(input$obs)) {
  column <- input$obs[[name]]
  obs[[name]] <- if (!is.null(column$categories)) {
    factor(column$categories[column$codes + 1L], levels = column$categories)
  } else {
    as.numeric(ifelse(is.na(column$values), NaN, column$values))
  }
}
obsm <- lapply(input$obsm, function(values) matrix(as.numeric(values), nrow = n))
graph <- Matrix::sparseMatrix(i = input$graph$i + 1L, p = input$graph$p, x = input$graph$x, dims = c(n, n))
given <- list(
  gene_expression = x, obs = obs, var = data.frame(feature_name = input$symbols, row.names = input$genes),
  embeddings = obsm[c("X_umap", "X_pca")], vector_fields = list(velocity = list(X_umap = obsm$velocity_umap)),
  connectivities = graph, dataset_id = "subsample-analysis-served-r", dataset_name = "Subsample analysis"
)
viewer <- new.env()
cellucid:::.serve_object(viewer, NULL, given, "Subsample analysis", quiet = TRUE, cache_bytes = 268435456)
for (key in viewer$store$keys) {
  path <- file.path(args[[3]], key)
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  writeBin(cellucid:::.store_get(viewer$store, key), path)
}
"""


def write_zip(path: Path, entries) -> None:
    """Every key, uncompressed, in key order, with a fixed time: the bytes
    depend on the store alone."""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        for key, data in sorted(entries):
            archive.writestr(zipfile.ZipInfo(key, date_time=(1980, 1, 1, 0, 0, 0)), data)


def r_served(adata, path: Path) -> None:
    """The store cellucid-r serves for the object, run from its sources."""
    X = adata.X.tocsr()
    graph = adata.obsp["connectivities"].tocsc()
    obs = {}
    for name in adata.obs.columns:
        values = adata.obs[name]
        if isinstance(values.dtype, pd.CategoricalDtype):
            obs[name] = {"categories": list(values.cat.categories), "codes": values.cat.codes.tolist()}
        else:
            obs[name] = {"values": [None if np.isnan(v) else float(v) for v in values.to_numpy(dtype=np.float64)]}
    given = {
        "cells": list(adata.obs_names), "genes": list(adata.var_names), "symbols": list(adata.var["feature_name"]),
        "indptr": X.indptr.tolist(), "indices": X.indices.tolist(), "data": X.data.astype(np.float64).tolist(),
        "obs": obs, "obsm": {key: np.asarray(value, dtype=np.float64).T.ravel().tolist() for key, value in adata.obsm.items()},
        "graph": {"p": graph.indptr.tolist(), "i": graph.indices.tolist(), "x": graph.data.astype(np.float64).tolist()},
    }
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        (scratch / "given.json").write_text(json.dumps(given), encoding="utf-8")
        (scratch / "serve.R").write_text(R_SERVE, encoding="utf-8")
        subprocess.run([RSCRIPT, str(scratch / "serve.R"), str(R_SOURCE), str(scratch / "given.json"), str(scratch / "store")], check=True)
        store = scratch / "store"
        write_zip(path, [(file.relative_to(store).as_posix(), file.read_bytes()) for file in store.rglob("*") if file.is_file()])


CLASSES = OUT / "classes"

R_OBJECTS = r"""
args <- commandArgs(trailingOnly = TRUE)
input <- jsonlite::fromJSON(args[[1]], simplifyVector = TRUE)
n <- length(input$cells)
m <- length(input$genes)
# Genes x cells, as both objects hold their matrices.
x <- Matrix::sparseMatrix(i = input$indices + 1L, p = input$indptr, x = input$data, dims = c(m, n),
                          dimnames = list(input$genes, input$cells))
obs <- data.frame(row.names = input$cells)
for (name in names(input$obs)) {
  column <- input$obs[[name]]
  obs[[name]] <- if (!is.null(column$categories)) {
    factor(column$categories[column$codes + 1L], levels = column$categories)
  } else {
    as.numeric(ifelse(is.na(column$values), NaN, column$values))
  }
}
obsm <- lapply(input$obsm, function(values) {
  out <- matrix(as.numeric(values), nrow = n)
  rownames(out) <- input$cells
  out
})
graph <- Matrix::sparseMatrix(i = input$graph$i + 1L, p = input$graph$p, x = input$graph$x, dims = c(n, n),
                              dimnames = list(input$cells, input$cells))
sce <- SingleCellExperiment::SingleCellExperiment(
  assays = list(counts = x), colData = S4Vectors::DataFrame(obs, check.names = FALSE),
  reducedDims = list(umap = obsm$X_umap, pca = obsm$X_pca)
)
SingleCellExperiment::colPair(sce, "connectivities") <- methods::as(graph, "TsparseMatrix")
saveRDS(sce, args[[2]])
seurat <- SeuratObject::CreateSeuratObject(counts = x, meta.data = obs)
seurat <- SeuratObject::SetAssayData(seurat, layer = "data", new.data = x)
colnames(obsm$X_umap) <- c("umap_1", "umap_2")
colnames(obsm$X_pca) <- paste0("pca_", seq_len(ncol(obsm$X_pca)))
seurat[["umap"]] <- SeuratObject::CreateDimReducObject(embeddings = obsm$X_umap, key = "umap_", assay = "RNA")
seurat[["pca"]] <- SeuratObject::CreateDimReducObject(embeddings = obsm$X_pca, key = "pca_", assay = "RNA")
seurat[["connectivities"]] <- SeuratObject::as.Graph(graph)
saveRDS(seurat, args[[3]])
"""


def given_object(adata):
    """The object as JSON for R: its matrix, obs, obsm and graph."""
    X = adata.X.tocsr()
    graph = adata.obsp["connectivities"].tocsc()
    obs = {}
    for name in adata.obs.columns:
        values = adata.obs[name]
        if isinstance(values.dtype, pd.CategoricalDtype):
            obs[name] = {"categories": list(values.cat.categories), "codes": values.cat.codes.tolist()}
        else:
            obs[name] = {"values": [None if np.isnan(v) else float(v) for v in values.to_numpy(dtype=np.float64)]}
    return {
        "cells": list(adata.obs_names), "genes": list(adata.var_names), "symbols": list(adata.var["feature_name"]),
        "indptr": X.indptr.tolist(), "indices": X.indices.tolist(), "data": X.data.astype(np.float64).tolist(),
        "obs": obs, "obsm": {key: np.asarray(value, dtype=np.float64).T.ravel().tolist() for key, value in adata.obsm.items()},
        "graph": {"p": graph.indptr.tolist(), "i": graph.indices.tolist(), "x": graph.data.astype(np.float64).tolist()},
    }


def zip_folder(folder: Path, path: Path) -> None:
    write_zip(path, [(file.relative_to(folder).as_posix(), file.read_bytes()) for file in folder.rglob("*") if file.is_file()])


def write_loom(adata, path: Path) -> None:
    """A Loom 3.0.0 file as loompy writes one: the matrix genes x cells,
    obs as column attributes (categories as their labels), each obsm array
    one column attribute of a row per cell, the graph as a column graph."""
    import h5py

    graph = adata.obsp["connectivities"].tocoo()
    with h5py.File(path, "w") as f:
        f.create_dataset("matrix", data=np.asarray(adata.X.todense(), dtype=np.float32).T, chunks=(8, 64), compression="gzip")
        f.create_group("layers")
        rows = f.create_group("row_attrs")
        rows.create_dataset("Gene", data=np.array(adata.var_names, dtype="S"))
        rows.create_dataset("feature_name", data=np.array(adata.var["feature_name"], dtype="S"))
        cols = f.create_group("col_attrs")
        cols.create_dataset("CellID", data=np.array(adata.obs_names, dtype="S"))
        for name in adata.obs.columns:
            values = adata.obs[name]
            if isinstance(values.dtype, pd.CategoricalDtype):
                cols.create_dataset(name, data=np.array(values.astype(str), dtype="S"))
            else:
                cols.create_dataset(name, data=values.to_numpy(dtype=np.float32))
        for key, value in adata.obsm.items():
            cols.create_dataset(key, data=np.asarray(value, dtype=np.float32))
        graphs = f.create_group("col_graphs").create_group("connectivities")
        graphs.create_dataset("a", data=graph.row.astype(np.int64))
        graphs.create_dataset("b", data=graph.col.astype(np.int64))
        graphs.create_dataset("w", data=graph.data.astype(np.float32))
        f.create_group("row_graphs")
        attrs = f.create_group("attrs")
        attrs.create_dataset("LOOM_SPEC_VERSION", data=np.array(b"3.0.0"))


def write_matrix_market(adata, folder: Path) -> None:
    """A Cell Ranger 2 style folder: the matrix features x cells, its
    features and barcodes, and a table of the cells (obs and the UMAP)."""
    from scipy.io import mmwrite

    folder.mkdir(parents=True, exist_ok=True)
    mmwrite(str(folder / "matrix.mtx"), sparse.csr_matrix(adata.X).T.tocoo().astype(np.float64), precision=6)
    (folder / "features.tsv").write_text("".join(f"{i}\t{s}\tGene Expression\n" for i, s in zip(adata.var_names, adata.var["feature_name"])), encoding="utf-8")
    (folder / "barcodes.tsv").write_text("".join(f"{c}\n" for c in adata.obs_names), encoding="utf-8")
    umap = adata.obsm["X_umap"]
    lines = ["barcode\tcell_type\tbatch\tscore\tUMAP_1\tUMAP_2"]
    for i, cell in enumerate(adata.obs_names):
        score = adata.obs["score"].iloc[i]
        lines.append("\t".join([cell, str(adata.obs["cell_type"].iloc[i]), str(adata.obs["batch"].iloc[i]),
                                  "" if np.isnan(score) else repr(float(score)), repr(float(umap[i, 0])), repr(float(umap[i, 1]))]))
    (folder / "cells.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_tenx_outs(adata, folder: Path) -> None:
    """A Cell Ranger outs/ folder: the filtered matrix .h5 and Cell Ranger's
    analysis beside it (UMAP and PCA projections, clusterings named
    cell_type and batch)."""
    import h5py

    analysis = folder / "analysis"
    (analysis / "umap" / "2_components").mkdir(parents=True, exist_ok=True)
    (analysis / "pca" / "8_components").mkdir(parents=True, exist_ok=True)
    X = sparse.csc_matrix(adata.X.T)  # features x cells, column (cell) compressed
    with h5py.File(folder / "filtered_feature_bc_matrix.h5", "w") as f:
        matrix = f.create_group("matrix")
        matrix.create_dataset("barcodes", data=np.array(adata.obs_names, dtype="S"))
        matrix.create_dataset("data", data=X.data.astype(np.float32))
        matrix.create_dataset("indices", data=X.indices.astype(np.int64))
        matrix.create_dataset("indptr", data=X.indptr.astype(np.int64))
        matrix.create_dataset("shape", data=np.array(X.shape, dtype=np.int32))
        features = matrix.create_group("features")
        features.create_dataset("id", data=np.array(adata.var_names, dtype="S"))
        features.create_dataset("name", data=np.array(adata.var["feature_name"], dtype="S"))
        features.create_dataset("feature_type", data=np.array(["Gene Expression"] * adata.n_vars, dtype="S"))
        features.create_dataset("genome", data=np.array(["GRCh38"] * adata.n_vars, dtype="S"))
        features.create_dataset("_all_tag_keys", data=np.array([b"genome"]))
    def table(path, header, rows):
        path.write_text(header + "\n" + "".join(",".join(row) + "\n" for row in rows), encoding="utf-8")
    cells = list(adata.obs_names)
    umap, pca = adata.obsm["X_umap"], adata.obsm["X_pca"]
    table(analysis / "umap" / "2_components" / "projection.csv", "Barcode,UMAP-1,UMAP-2",
          [[c, repr(float(umap[i, 0])), repr(float(umap[i, 1]))] for i, c in enumerate(cells)])
    table(analysis / "pca" / "8_components" / "projection.csv", "Barcode," + ",".join(f"PC-{j + 1}" for j in range(pca.shape[1])),
          [[c, *(repr(float(v)) for v in pca[i])] for i, c in enumerate(cells)])
    for name in ("cell_type", "batch"):
        (analysis / "clustering" / name).mkdir(parents=True, exist_ok=True)
        table(analysis / "clustering" / name / "clusters.csv", "Barcode,Cluster",
              [[c, str(adata.obs[name].iloc[i])] for i, c in enumerate(cells)])


def format_classes(adata) -> None:
    """The same cells in every format and matrix kind the app opens
    (`tests/analysis-subsample-differential.test.mjs`, "every class"), each
    in the cells' given order, so every reference applies to each."""
    import shutil

    import anndata as ad
    import mudata as md

    if CLASSES.exists():
        shutil.rmtree(CLASSES)
    CLASSES.mkdir(parents=True)
    h5 = {"compression": "gzip"}
    adata.write_h5ad(CLASSES / "csr.h5ad", **h5)
    csc = adata.copy()
    csc.X = sparse.csc_matrix(adata.X)
    csc.write_h5ad(CLASSES / "csc.h5ad", **h5)
    dense = adata.copy()
    dense.X = np.asarray(adata.X.todense(), dtype=np.float32)
    dense.write_h5ad(CLASSES / "dense.h5ad", **h5)
    # The expression in a layer and in raw, X another matrix (twice it).
    layered = adata.copy()
    layered.layers["counts"] = adata.X.copy()
    layered.X = adata.X * 2
    layered.write_h5ad(CLASSES / "layer.h5ad", **h5)
    with_raw = adata.copy()
    with_raw.raw = adata.copy()
    with_raw.X = adata.X * 2
    with_raw.write_h5ad(CLASSES / "raw.h5ad", **h5)
    with tempfile.TemporaryDirectory() as scratch:
        scratch = Path(scratch)
        with ad.settings.override(zarr_write_format=3):
            adata.write_zarr(scratch / "v3.zarr")
        zip_folder(scratch / "v3.zarr", CLASSES / "v3.zarr.zip")
        with ad.settings.override(zarr_write_format=2):
            adata.write_zarr(scratch / "v2.zarr")
        shutil.copytree(scratch / "v2.zarr", CLASSES / "v2.zarr")
        # MuData: the expression a modality of every cell, a second one of some.
        rna = ad.AnnData(X=adata.X.copy(), var=adata.var.copy(), obs=pd.DataFrame(index=adata.obs_names))
        prot = ad.AnnData(X=np.asarray(adata.X[:, :3].todense(), dtype=np.float32)[::2], obs=pd.DataFrame(index=adata.obs_names[::2]),
                          var=pd.DataFrame(index=["P1", "P2", "P3"]))
        mdata = md.MuData({"rna": rna, "prot": prot})
        for name in adata.obs.columns:
            mdata.obs[name] = adata.obs[name].to_numpy() if not isinstance(adata.obs[name].dtype, pd.CategoricalDtype) else adata.obs[name].values
        for key, value in adata.obsm.items():
            mdata.obsm[key] = value
        mdata.obsp["connectivities"] = adata.obsp["connectivities"]
        mdata.write_h5mu(CLASSES / "mudata.h5mu")
        mdata.write_zarr(scratch / "mudata.zarr")
        zip_folder(scratch / "mudata.zarr", CLASSES / "mudata.zarr.zip")
        (scratch / "given.json").write_text(json.dumps(given_object(adata)), encoding="utf-8")
        (scratch / "objects.R").write_text(R_OBJECTS, encoding="utf-8")
        subprocess.run([RSCRIPT, str(scratch / "objects.R"), str(scratch / "given.json"), str(CLASSES / "sce.rds"), str(CLASSES / "seurat.rds")], check=True)
    write_loom(adata, CLASSES / "cells.loom")
    write_matrix_market(adata, CLASSES / "mtx")
    write_tenx_outs(adata, CLASSES / "outs")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    adata = synthetic_adata()
    common = {"dataset_name": "Subsample analysis", "latent_key": "X_pca", "force": True}
    cellucid.prepare(OUT / "given.zarr.zip", format="zarr.zip", data=adata, dataset_id="subsample-analysis-given",
                     priority_seed=None, **common)
    cellucid.prepare(OUT / "priority.zarr.zip", format="zarr.zip", data=adata, dataset_id="subsample-analysis-priority",
                     priority_seed=0, **common)
    from cellucid._served_store import PriorityStore

    store = PriorityStore.of_anndata(adata)
    try:
        write_zip(OUT / "served.zarr.zip", [(key, store.get(key)) for key in store.stored_keys()])
    finally:
        store.close()
    r_served(adata, OUT / "served-r.zarr.zip")
    format_classes(adata)
    codes = adata.obs["cell_type"].cat.codes.to_numpy()
    rule = outlier_rule()
    openings = []
    for name, file, request, arguments in OPENINGS:
        cells = kept_cells(adata, arguments)
        openings.append({
            "name": name,
            "file": f"{file}.zarr.zip",
            "request": None if request is None else {"mode": "subsample", **request},
            "kept": cells.tolist(),
            "composition": composition_reference(adata, cells, codes),
            "dotplot": dotplot_reference(adata, cells, codes),
            "de": de_reference(adata, cells, codes),
            "markers": markers_reference(adata, cells, codes),
            "correlation": correlation_reference(adata, cells),
            "signature": signature_reference(adata, cells),
            "graph": graph_reference(adata, cells),
            "overlays": overlay_reference(adata, cells, codes, rule),
            "filters": filter_reference(adata, cells, codes),
            "quick": quick_reference(adata, cells, codes),
            "detailed": detailed_reference(adata, cells, codes),
        })
    reference = {
        "_about": "What numpy, SciPy and pandas compute on the cells each opening keeps; "
        "written by scripts/generate-subsample-analysis-fixtures.py.",
        "versions": {
            "cellucid": cellucid.__version__,
            "numpy": np.__version__,
            "scipy": __import__("scipy").__version__,
            "pandas": pd.__version__,
        },
        "files": {name: sha(OUT / name) for name in ("given.zarr.zip", "priority.zarr.zip", "served.zarr.zip", "served-r.zarr.zip")},
        "classFiles": {file.relative_to(CLASSES).as_posix(): sha(file) for file in sorted(CLASSES.rglob("*")) if file.is_file()},
        "nObs": N_CELLS,
        "types": TYPES,
        "batches": ["b0", "b1", "b2", "b3"],
        "genes": GENES,
        "geneIds": GENE_IDS,
        "minPoints": MIN_POINTS,
        "dePairs": DE_PAIRS,
        "dotplotGenes": DOTPLOT_GENES,
        "signature": SIGNATURE,
        "filterSpec": FILTERS,
        "detailedSpec": DETAILED,
        "typeOfCell": codes.tolist(),
        "openings": openings,
    }
    text = json.dumps(reference, separators=(",", ":"), allow_nan=False) + "\n"
    path = OUT / "reference.json"
    path.write_text(text, encoding="utf-8")
    (OUT / "reference.json.sha256").write_text(
        f"{hashlib.sha256(text.encode('utf-8')).hexdigest()}  reference.json\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
