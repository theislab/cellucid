"""Write the browser tests' dataset catalogs: Cellucid-ready AnnData files with
``uns['cellucid']`` and the ``datasets.json`` (schema 2) that lists them.

- ``tests/browser/fixtures/catalog/``: the default sample catalog of the
  browser tests, one dataset ``current-ui`` (``current-ui.h5ad``), built from
  ``current-ui-smoke.h5ad``, and beside it, unlisted, ``current-ui-vector.h5ad``
  (the same cells with a vector field on their UMAP).
- ``tests/browser/fixtures/demo-catalog/``: three synthetic datasets as zipped
  Zarr stores, the deterministic synthetic examples of
  ``cellucid-demo-custom-datasets``.
- ``tests/browser/fixtures/forms-catalog/``: one dataset in each form a
  catalog lists -- ``.h5ad``, ``.zarr.zip`` and a Zarr store folder
  (``forms-zarr.zarr/``, the one Zarr folder of the browser tests, which the
  folder picker and folder drops read too) -- each under its own id.
- ``tests/browser/fixtures/uint32-categories.h5ad``: the current-ui dataset
  with 70,000 ``cell_type`` categories.
- ``tests/browser/fixtures/broken-catalogs/``: one catalog per way a catalog
  cannot be read (a missing, truncated or corrupt file, an id the file does
  not state, a truncated ``datasets.json``, a catalog without ``schema``).

Every file is written deterministically: a second run gives the same bytes.

Run from the repository root::

    python scripts/generate-browser-catalog-fixtures.py
"""

from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from pathlib import Path

import anndata
import numpy as np
import pandas as pd
import zarr
from scipy import sparse

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "browser" / "fixtures"
CATALOG = FIXTURES / "catalog"
DEMO_CATALOG = FIXTURES / "demo-catalog"
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)
SOURCE = {
    "name": "Cellucid deterministic synthetic examples",
    "url": "https://github.com/theislab/cellucid-demo-custom-datasets",
}


def _cellucid(dataset_id, name, description, defaults, source=SOURCE):
    return {
        "schema": 1,
        "id": dataset_id,
        "name": name,
        "description": description,
        "source": dict(source),
        "defaults": defaults,
    }


def _categorical(values, categories):
    return pd.Categorical(values, categories=categories, ordered=True)


def _graph(n_cells, edges):
    matrix = np.zeros((n_cells, n_cells), dtype=np.float64)
    for source, destination, weight in edges:
        if not 0 <= source < destination < n_cells or matrix[source, destination] != 0:
            raise ValueError("Synthetic edges must be unique with source < destination.")
        matrix[source, destination] = weight
        matrix[destination, source] = weight
    return sparse.csr_matrix(matrix)


def _var(symbols, prefix):
    return pd.DataFrame(
        {"gene_id": [f"{prefix}{position + 1:06d}" for position in range(len(symbols))]},
        index=pd.Index(list(symbols)),
    )


def _write_stored_zip(source: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(f"{source.name}/{path.relative_to(source).as_posix()}", date_time=ZIP_EPOCH)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def current_ui() -> anndata.AnnData:
    """The 120-cell, six-gene fixture, named by gene symbols, with a latent
    space for outlier quantiles."""
    smoke = anndata.read_h5ad(FIXTURES / "current-ui-smoke.h5ad")
    X = smoke.X.toarray() if sparse.issparse(smoke.X) else np.asarray(smoke.X)
    obs = smoke.obs[["score", "cell_type"]].copy()
    var = pd.DataFrame(index=pd.Index(["GAPDH", "ACTB", "CD3E", "MS4A1", "NKG7", "LYZ"]))
    adata = anndata.AnnData(X=sparse.csc_matrix(X.astype(np.float32)), obs=obs, var=var)
    adata.obsm["X_umap_2d"] = np.asarray(smoke.obsm["X_umap_2d"], dtype=np.float32)
    adata.obsm["latent_space"] = np.asarray(smoke.obsm["X_pca"], dtype=np.float32)
    adata.uns["cellucid"] = _cellucid(
        "current-ui",
        "Current UI fixture",
        "Browser CI fixture",
        {"latentKey": "latent_space"},
        source={"name": "Cellucid browser CI"},
    )
    return adata


def trajectory_1d() -> anndata.AnnData:
    n_cells = 48
    index = np.arange(n_cells, dtype=np.float32)
    pseudotime = index / np.float32(n_cells - 1)
    wobble = ((np.arange(n_cells) % 4) - 1.5).astype(np.float32) / np.float32(80)
    embedding = (np.float32(2) * pseudotime - np.float32(1) + wobble)[:, None]
    stage_categories = ["early", "transition", "committed", "mature"]
    replicate_categories = ["replicate-a", "replicate-b"]
    activity = (
        np.float32(0.25) + np.float32(0.6) * pseudotime
        + (np.arange(n_cells) % 3).astype(np.float32) / np.float32(30)
    )
    obs = pd.DataFrame(
        {
            "stage": _categorical([stage_categories[min(v // 12, 3)] for v in range(n_cells)], stage_categories),
            "replicate": _categorical([replicate_categories[v % 2] for v in range(n_cells)], replicate_categories),
            "pseudotime": pseudotime,
            "transcriptional_activity": activity,
        },
        index=[f"trajectory-cell-{value:03d}" for value in range(n_cells)],
    )
    center_peak = np.float32(1) - np.abs(np.float32(2) * pseudotime - np.float32(1))
    saw = (np.arange(n_cells) % 8).astype(np.float32) / np.float32(7)
    expression = np.column_stack([
        np.float32(6) * (np.float32(1) - pseudotime),
        np.float32(1) + np.float32(7) * center_peak,
        np.float32(6) * pseudotime,
        np.float32(2) + np.float32(2) * saw,
        np.float32(1) + activity,
        np.float32(0.5) + np.float32(3) * pseudotime * pseudotime,
    ]).astype(np.float32)
    genes = ["SYN_EARLY", "SYN_TRANSITION", "SYN_MATURE", "SYN_SAWTOOTH", "SYN_ACTIVITY", "SYN_LATE"]
    edges = [(s, s + 1, 1.0) for s in range(n_cells - 1)] + [(s, s + 2, 0.5) for s in range(n_cells - 2)]
    velocity = (np.float32(0.07) + (np.arange(n_cells) % 5).astype(np.float32) / np.float32(500))[:, None]
    adata = anndata.AnnData(X=sparse.csc_matrix(expression), obs=obs, var=_var(genes, "SYNT"))
    adata.obsm["X_trajectory"] = embedding.astype(np.float32)
    adata.obsm["velocity_trajectory"] = velocity.astype(np.float32)
    adata.obsm["X_latent"] = np.column_stack([pseudotime, activity]).astype(np.float32)
    adata.obsp["connectivities"] = _graph(n_cells, edges)
    adata.uns["cellucid"] = _cellucid(
        "synthetic-trajectory-1d",
        "Synthetic trajectory — 1D",
        "A synthetic 48-cell progression for learning planar 1D navigation, pseudotime "
        "coloring, gene trends, connectivity, and a velocity-style overlay.",
        {"embedding1d": "X_trajectory", "latentKey": "X_latent", "centroidMinPoints": 6},
    )
    return adata


def cell_types_2d() -> anndata.AnnData:
    n_groups, per_group = 3, 24
    n_cells = n_groups * per_group
    centers = np.asarray([[-0.70, -0.35], [0.65, -0.25], [0.00, 0.68]], dtype=np.float32)
    offsets = np.asarray(
        [[np.float32(i % 6 - 2.5) / np.float32(18), np.float32(i // 6 - 1.5) / np.float32(12)] for i in range(per_group)],
        dtype=np.float32,
    )
    embedding = np.vstack([centers[g] + offsets for g in range(n_groups)]).astype(np.float32)
    cell_type_categories = ["type-a", "type-b", "type-c"]
    batch_categories = ["batch-1", "batch-2", "batch-3"]
    quality = np.float32(0.72) + (np.arange(n_cells) % 9).astype(np.float32) / np.float32(50)
    library = np.float32(900) + (np.arange(n_cells) % 12).astype(np.float32) * np.float32(35)
    obs = pd.DataFrame(
        {
            "cell_type": _categorical([cell_type_categories[i // per_group] for i in range(n_cells)], cell_type_categories),
            "batch": _categorical([batch_categories[i % 3] for i in range(n_cells)], batch_categories),
            "quality_score": quality,
            "library_size": library,
        },
        index=[f"island-cell-{value:03d}" for value in range(n_cells)],
    )
    group = np.repeat(np.arange(n_groups), per_group)
    local = np.tile(np.arange(per_group), n_groups).astype(np.float32)
    expression = np.column_stack([
        np.where(group == 0, np.float32(8), np.float32(1)) + local / np.float32(48),
        np.where(group == 1, np.float32(8), np.float32(1)) + local / np.float32(48),
        np.where(group == 2, np.float32(8), np.float32(1)) + local / np.float32(48),
        np.float32(2) + (local % 6) / np.float32(3),
        np.float32(1) + quality,
        np.float32(1) + library / np.float32(500),
        np.float32(0.5) + embedding[:, 0] * embedding[:, 0],
        np.float32(0.5) + embedding[:, 1] * embedding[:, 1],
    ]).astype(np.float32)
    marker_scores = np.column_stack([
        expression[:, 0] - expression[:, 1] + expression[:, 3] / np.float32(4),
        expression[:, 2] - (expression[:, 0] + expression[:, 1]) / np.float32(2) + expression[:, 4],
    ]).astype(np.float32)
    genes = ["SYN_MARKER_A", "SYN_MARKER_B", "SYN_MARKER_C", "SYN_SHARED", "SYN_QUALITY", "SYN_LIBRARY", "SYN_AXIS_X", "SYN_AXIS_Y"]
    edges = []
    for g in range(n_groups):
        start = g * per_group
        for i in range(per_group):
            current = start + i
            right = start + (i // 6) * 6 + ((i + 1) % 6)
            down = start + ((i + 6) % per_group)
            for neighbor, weight in ((right, 1.0), (down, 0.5)):
                source, destination = sorted((current, neighbor))
                if (source, destination, weight) not in edges:
                    edges.append((source, destination, weight))
    adata = anndata.AnnData(X=sparse.csc_matrix(expression), obs=obs, var=_var(genes, "SYNC"))
    adata.obsm["X_islands"] = embedding
    adata.obsm["X_marker_scores"] = marker_scores
    adata.obsp["connectivities"] = _graph(n_cells, edges)
    adata.uns["cellucid"] = _cellucid(
        "synthetic-cell-types-2d",
        "Synthetic cell-type islands — 2D",
        "Three synthetic 2D populations for learning categorical and continuous coloring, "
        "marker genes, filtering, highlighting, and weighted connectivity.",
        {"embedding2d": "X_islands", "latentKey": "X_islands", "centroidMinPoints": 6},
    )
    return adata


def development_3d() -> anndata.AnnData:
    per_lineage = 48
    n_cells = per_lineage * 2
    local = np.tile(np.arange(per_lineage), 2).astype(np.float32)
    progress = local / np.float32(per_lineage - 1)
    lineage_code = np.repeat(np.asarray([-1, 1], dtype=np.float32), per_lineage)
    centered = np.float32(2) * progress - np.float32(1)
    embedding = np.column_stack([
        centered,
        lineage_code * (np.float32(0.18) + np.float32(0.72) * progress),
        lineage_code * centered * centered + np.float32(0.12) * centered,
    ]).astype(np.float32)
    lineage_categories = ["lineage-left", "lineage-right"]
    timepoint_categories = ["t0", "t1", "t2", "t3"]
    condition_categories = ["control", "stimulated"]
    response = (np.float32(0.2) + np.float32(0.65) * progress + np.where(lineage_code > 0, np.float32(0.08), np.float32(0))).astype(np.float32)
    obs = pd.DataFrame(
        {
            "lineage": _categorical([lineage_categories[i // per_lineage] for i in range(n_cells)], lineage_categories),
            "timepoint": _categorical([timepoint_categories[min((i % per_lineage) // 12, 3)] for i in range(n_cells)], timepoint_categories),
            "condition": _categorical([condition_categories[(i // 8) % 2] for i in range(n_cells)], condition_categories),
            "differentiation_score": progress,
            "response_score": response,
        },
        index=[f"development-cell-{value:03d}" for value in range(n_cells)],
    )
    left = (lineage_code < 0).astype(np.float32)
    right = (lineage_code > 0).astype(np.float32)
    triangular = np.float32(1) - np.abs(np.float32(2) * progress - np.float32(1))
    expression = np.column_stack([
        np.float32(7) * (np.float32(1) - progress),
        np.float32(1) + np.float32(6) * triangular,
        np.float32(1) + np.float32(7) * progress,
        np.float32(1) + np.float32(6) * left * progress,
        np.float32(1) + np.float32(6) * right * progress,
        np.float32(1) + response,
        np.float32(1) + embedding[:, 0] * embedding[:, 0],
        np.float32(1) + np.abs(embedding[:, 1]),
        np.float32(1) + np.abs(embedding[:, 2]),
        np.float32(1) + (local % 7) / np.float32(3),
    ]).astype(np.float32)
    genes = ["SYN_PROGENITOR", "SYN_COMMITMENT", "SYN_DIFFERENTIATED", "SYN_LEFT_FATE", "SYN_RIGHT_FATE",
             "SYN_RESPONSE", "SYN_CURVATURE_X", "SYN_BRANCH_Y", "SYN_BRANCH_Z", "SYN_LOCAL_PHASE"]
    edges = []
    for lineage in range(2):
        start = lineage * per_lineage
        edges += [(s, s + 1, 1.0) for s in range(start, start + per_lineage - 1)]
        edges += [(s, s + 2, 0.5) for s in range(start, start + per_lineage - 2)]
    edges.append((0, per_lineage, 0.25))
    velocity = np.column_stack([
        np.full(n_cells, np.float32(0.05), dtype=np.float32),
        lineage_code * np.float32(0.018),
        lineage_code * centered * np.float32(0.05) + np.float32(0.003),
    ]).astype(np.float32)
    adata = anndata.AnnData(X=sparse.csc_matrix(expression), obs=obs, var=_var(genes, "SYND"))
    adata.obsm["X_branches"] = embedding
    adata.obsm["velocity_branches"] = velocity
    adata.obsp["connectivities"] = _graph(n_cells, edges)
    adata.uns["cellucid"] = _cellucid(
        "synthetic-development-3d",
        "Synthetic branching development — 3D",
        "A synthetic two-lineage 3D progression for orbit navigation, temporal metadata, "
        "fate markers, graph context, and a velocity-style vector field.",
        {"embedding3d": "X_branches", "latentKey": "X_branches", "centroidMinPoints": 6},
    )
    return adata


def _write_catalog(folder: Path, default: str, datasets: list[dict]) -> None:
    (folder / "datasets.json").write_text(
        json.dumps({"schema": 2, "default": default, "datasets": datasets}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _write_zarr_folder(adata: anndata.AnnData, target: Path) -> None:
    # anndata writes Zarr v2 here; the empty groups it adds (`layers`,
    # `obsp`, `varm`, `varp`) are dropped, as optional, and the folder gets
    # consolidated metadata (`.zmetadata`), which a folder on a web host is
    # opened by.
    adata.write_zarr(target)
    for name in ("layers", "obsp", "varm", "varp"):
        shutil.rmtree(target / name)
    zarr.consolidate_metadata(str(target))


def _write_zarr_zip(adata: anndata.AnnData, target: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="cellucid-zarr-") as temporary:
        store = Path(temporary) / target.name.removesuffix(".zip")
        adata.write_zarr(store)
        _write_stored_zip(store, target)


def _renamed(adata: anndata.AnnData, dataset_id: str, name: str) -> anndata.AnnData:
    renamed = adata.copy()
    renamed.uns["cellucid"] = {**adata.uns["cellucid"], "id": dataset_id, "name": name}
    return renamed


def folder_dataset() -> anndata.AnnData:
    """The trajectory dataset reduced to what the Zarr-folder specs read: a
    dense X, one categorical and one continuous obs column, its embedding and
    ``uns['cellucid']``. Every array is one chunk, so the folder stays a few
    dozen files."""
    full = trajectory_1d()
    adata = anndata.AnnData(
        X=np.asarray(full.X.toarray(), dtype=np.float32),
        obs=full.obs[["stage", "pseudotime"]].copy(),
        var=pd.DataFrame(index=full.var_names.copy()),
    )
    adata.obsm["X_trajectory"] = np.asarray(full.obsm["X_trajectory"], dtype=np.float32)
    adata.uns["cellucid"] = {
        "schema": 1,
        "id": "forms-zarr",
        "name": "Forms — Zarr folder",
        "defaults": {"embedding1d": "X_trajectory"},
    }
    return adata


def uint32_categories() -> anndata.AnnData:
    """The current-ui fixture with a 70,000-category `cell_type`: more than
    uint16 codes carry. Its labels sit on both sides of 65,535 so that a
    16-bit copy of a code names another category: gamma at 0, alpha at 65,536
    (whose 16 bits are gamma's 0) and beta at 69,999; every other category is
    `zz-<code>` and holds no cell. The first five gamma cells are missing."""
    adata = current_ui()
    placement = {"gamma": 0, "alpha": 65_536, "beta": 69_999}
    inventory = [f"zz-{code:06d}" for code in range(70_000)]
    for label, code in placement.items():
        inventory[code] = label
    labels = adata.obs["cell_type"].astype(str).to_numpy(dtype=object)
    labels[np.flatnonzero(labels == "gamma")[:5]] = None
    adata.obs["cell_type"] = pd.Categorical(labels, categories=inventory)
    adata.uns["cellucid"] = {**adata.uns["cellucid"], "id": "uint32-categories", "name": "uint32 categories"}
    return adata


def main() -> None:
    broken = FIXTURES / "broken-catalogs"
    forms = FIXTURES / "forms-catalog"
    for folder in (CATALOG, DEMO_CATALOG, forms, broken):
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)

    current = current_ui()
    current.write_h5ad(CATALOG / "current-ui.h5ad")
    _write_catalog(CATALOG, "current-ui", [{"id": "current-ui", "path": "current-ui.h5ad"}])
    # Beside it, unlisted: the same cells with a vector field on their UMAP
    # (`velocity_umap_2d`, bound by default), which a spec lists in the
    # catalog it serves.
    vector = _renamed(current, "current-ui-vector", "Current UI vector fixture")
    # Every cell moves 0.01 along x and, by its index mod 3, 0, 0.0025 or
    # 0.005 along y.
    cells = np.arange(vector.n_obs)
    vector.obsm["velocity_umap_2d"] = np.stack(
        [np.full(vector.n_obs, 0.01), (cells % 3) * 0.0025], axis=1
    ).astype(np.float32)
    vector.write_h5ad(CATALOG / "current-ui-vector.h5ad")

    demo = {
        "synthetic-cell-types-2d": cell_types_2d(),
        "synthetic-development-3d": development_3d(),
        "synthetic-trajectory-1d": trajectory_1d(),
    }
    for dataset_id, adata in demo.items():
        _write_zarr_zip(adata, DEMO_CATALOG / f"{dataset_id}.zarr.zip")
    _write_catalog(DEMO_CATALOG, "synthetic-cell-types-2d", [
        {"id": dataset_id, "path": f"{dataset_id}.zarr.zip"} for dataset_id in demo
    ])

    # One dataset in each form a catalog lists. The folder is the one Zarr
    # store folder of the browser tests: the folder picker and folder drops
    # read it too.
    trajectory = demo["synthetic-trajectory-1d"]
    _renamed(trajectory, "forms-h5ad", "Forms — .h5ad").write_h5ad(forms / "forms-h5ad.h5ad")
    _write_zarr_zip(_renamed(trajectory, "forms-zarr-zip", "Forms — Zarr ZIP"), forms / "forms-zarr-zip.zarr.zip")
    _write_zarr_folder(folder_dataset(), forms / "forms-zarr.zarr")
    _write_catalog(forms, "forms-h5ad", [
        {"id": "forms-h5ad", "path": "forms-h5ad.h5ad"},
        {"id": "forms-zarr-zip", "path": "forms-zarr-zip.zarr.zip"},
        {"id": "forms-zarr", "path": "forms-zarr.zarr/"},
    ])

    uint32_categories().write_h5ad(FIXTURES / "uint32-categories.h5ad", compression="gzip")

    # Catalogs that cannot be read, each for one reason.
    good = (forms / "forms-h5ad.h5ad").read_bytes()
    cases = {
        "missing-file": ([{"id": "forms-h5ad", "path": "forms-h5ad.h5ad"}], {}),
        "truncated-file": ([{"id": "forms-h5ad", "path": "forms-h5ad.h5ad"}], {"forms-h5ad.h5ad": good[:2048]}),
        "corrupt-file": ([{"id": "forms-h5ad", "path": "forms-h5ad.h5ad"}], {"forms-h5ad.h5ad": bytes(2048)}),
        "mismatched-id": ([{"id": "another-id", "path": "forms-h5ad.h5ad"}], {"forms-h5ad.h5ad": good}),
    }
    for label, (datasets, files) in cases.items():
        folder = broken / label
        folder.mkdir()
        _write_catalog(folder, datasets[0]["id"], datasets)
        for name, data in files.items():
            (folder / name).write_bytes(data)
    (broken / "truncated-catalog").mkdir()
    (broken / "truncated-catalog" / "datasets.json").write_text('{"schema": 2, "default": "current-ui", "datas', encoding="utf-8")
    (broken / "schemaless-catalog").mkdir()
    (broken / "schemaless-catalog" / "datasets.json").write_text(
        json.dumps({"default": "current-ui", "datasets": [{"id": "current-ui", "path": "current-ui.h5ad"}]}, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
