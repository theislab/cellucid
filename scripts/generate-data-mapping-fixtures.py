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
  and ``X_pca``, plus ``velocity_umap_2d`` bound to ``X_umap``.
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
  ``X_broken`` embedding with a NaN at cell 5, and vectors: the default
  ``velocity_umap_2d``, scVelo-style ``velocity_tsne`` for ``X_tsne`` and
  ``velocity_pca`` as wide as ``X_pca``.
- ``data-mapping-crowded.h5ad``: many embeddings, as a segmentation export has
  them, with no default UMAP: three 2-column ``X_umap_scale*_latents`` (the
  guess turns them on), two 3-column arrays (``X_tsne_scale0_latents`` and
  ``spatial``), an integer 4-column ``coordinates`` and six wide latent and
  PCA arrays, plus a layer and a neighbour graph. The sidebar layout, the
  dimension choice of a narrow array and the sidebar's scroll position are
  tested on it (``tests/browser/data-mapping-layout.spec.mjs``).

Every array is drawn from a seeded generator around three clusters, so the
files are the same on every run.

``data-mapping-full.expected.json`` records what ``cellucid-python`` itself
computes from ``data-mapping-full.h5ad`` -- per neighbour graph the canonical
edges (as SHA-256 digests of their little-endian bytes) or the reason the
graph is refused -- so the browser's readers are tested against the server's
own output (cross-path parity). It needs ``cellucid`` installed. Run from the
repository root:

```bash
python scripts/generate-data-mapping-fixtures.py
```
"""

from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

import hashlib
import json

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
    adata.obsm["velocity_umap_2d"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
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
    adata.obsm["velocity_umap_2d"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
    adata.obsm["velocity_tsne"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 2)).astype(np.float32)
    adata.obsm["velocity_pca"] = rng.normal(0.0, 0.3, size=(CELL_COUNT, 6)).astype(np.float32)
    adata.obsp["connectivities"] = symmetric_graph(rng, labels, 6)
    adata.obsp["scvi_connectivities"] = symmetric_graph(rng, labels, 4)
    distances = symmetric_graph(rng, labels, 5)
    adata.obsp["distances"] = sparse.triu(distances, k=1).tocsr()
    return adata


def digest(values: np.ndarray, dtype: str) -> str:
    """SHA-256 of one array's little-endian bytes in ``dtype``."""
    return hashlib.sha256(np.ascontiguousarray(values, dtype=dtype).tobytes()).hexdigest()


def full_expectations(adata: anndata.AnnData) -> dict:
    """What cellucid-python serves from the full fixture, for parity tests."""
    from cellucid.connectivity_contract import validate_connectivity_edges

    graphs: dict[str, dict] = {}
    for key in adata.obsp:
        try:
            edges = validate_connectivity_edges(adata.obsp[key], n_cells=adata.n_obs)
        except ValueError as error:
            graphs[key] = {"refused": "symmetric" in str(error)}
            continue
        graphs[key] = {
            "n_edges": int(edges.n_edges),
            "max_neighbors": int(edges.max_neighbors),
            "sources": digest(edges.sources, "<u4"),
            "destinations": digest(edges.destinations, "<u4"),
            "weights": digest(edges.weights, "<f8"),
        }
    return {
        "n_obs": int(adata.n_obs),
        "knn": graphs,
        "genes": gene_expectations(adata),
        **latent_and_vector_expectations(adata),
    }


# Vector bindings the parity tests read: (vector key, its columns, embedding
# key, the embedding's columns).
FULL_VECTOR_BINDINGS = (
    ("velocity_umap_2d", (0, 1), "X_umap", (0, 1)),
    ("velocity_tsne", (0, 1), "X_tsne", (0, 1)),
    ("velocity_pca", (2, 3), "X_pca", (2, 3)),
    ("velocity_pca", (0, 1, 2), "X_pca", (0, 1, 2)),
)


def latent_and_vector_expectations(adata: anndata.AnnData) -> dict:
    """Outlier quantiles per latent space and categorical field, and vector payloads, as served."""
    from cellucid import AnnDataAdapter
    from cellucid.anndata_mapping import MappingLoadError

    adapter = AnnDataAdapter(adata, dataset_name="full", dataset_id="full")
    try:
        catalog = adapter.get_mapping_candidates()
        keys = [item["key"] for item in catalog["obsm"]]
        obs_keys = adapter.get_obs_keys()
        categorical = [
            index for index, key in enumerate(obs_keys) if adapter.get_obs_field_kind(key) == "category"
        ]
        latent: dict[str, dict] = {}
        for index, item in enumerate(catalog["obsm"]):
            if not item["usable"]:
                continue
            outcomes: dict[str, str] = {}
            for field_index in categorical:
                try:
                    payload = adapter.get_mapped_outliers(index, field_index)
                except MappingLoadError as error:
                    outcomes = {"refused": error.reason}
                    break
                outcomes[obs_keys[field_index]] = hashlib.sha256(payload).hexdigest()
            latent[item["key"]] = outcomes
        vectors: dict[str, str] = {}
        for vector_key, vector_columns, embedding_key, embedding_columns in FULL_VECTOR_BINDINGS:
            payload = adapter.get_mapped_vectors(
                keys.index(vector_key), vector_columns, keys.index(embedding_key), embedding_columns
            )
            name = f"{vector_key}@{embedding_key}[{','.join(map(str, embedding_columns))}]"
            vectors[name] = hashlib.sha256(payload).hexdigest()
        return {"latent": latent, "vectors": vectors}
    finally:
        adapter.close()


def gene_expectations(adata: anndata.AnnData) -> dict:
    """Per gene route: the unique names and each gene's float32 digest, as served."""
    from cellucid import AnnDataAdapter

    adapter = AnnDataAdapter(adata, dataset_name="full", dataset_id="full")
    try:
        catalog = adapter.get_mapping_candidates()
        axes = ["X", "raw", *(f"layer-{index}" for index in range(len(catalog["layers"])))]
        routes: dict[str, dict] = {}
        for axis in axes:
            columns = catalog["raw"]["var"]["columns"] if axis == "raw" else catalog["var"]["columns"]
            for names in ["index", *(f"column-{k}" for k, column in enumerate(columns) if column["usable"])]:
                manifest = adapter.get_mapped_var_manifest(axis, names)
                gene_names = [name for _index, name in manifest["fields"]]
                digests = [
                    hashlib.sha256(adapter.get_mapped_gene_values(axis, names, index)).hexdigest()
                    for index in range(len(gene_names))
                ]
                routes[f"{axis}/{names}"] = {
                    "names": gene_names,
                    "name_set": manifest["gene_name_sets"][0],
                    "values": digests,
                }
        return routes
    finally:
        adapter.close()


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


def main() -> None:
    guess = guess_fixture()
    guess.write_h5ad(FIXTURE_DIRECTORY / "data-mapping-guess.h5ad")
    write_zarr_zip(guess, FIXTURE_DIRECTORY / "data-mapping-guess.zarr.zip", "data-mapping-guess.zarr")
    wide_fixture().write_h5ad(FIXTURE_DIRECTORY / "data-mapping-wide.h5ad")
    multi_fixture().write_h5ad(FIXTURE_DIRECTORY / "data-mapping-multi.h5ad")
    representations_fixture().write_h5ad(
        FIXTURE_DIRECTORY / "data-mapping-representations.h5ad", compression="gzip"
    )
    crowded_fixture().write_h5ad(FIXTURE_DIRECTORY / "data-mapping-crowded.h5ad")
    full = full_fixture()
    full.write_h5ad(FIXTURE_DIRECTORY / "data-mapping-full.h5ad")
    write_zarr_zip(full, FIXTURE_DIRECTORY / "data-mapping-full.zarr.zip", "data-mapping-full.zarr")
    (FIXTURE_DIRECTORY / "data-mapping-full.expected.json").write_text(
        json.dumps(full_expectations(full), indent=2, sort_keys=True) + "\n"
    )


if __name__ == "__main__":
    main()
