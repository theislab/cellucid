"""Create the small Cellucid-ready AnnData fixtures of the web contract tests.

A Cellucid-ready AnnData file is a standard AnnData file with what it says
about itself for Cellucid in ``uns['cellucid']`` (schema, id, name,
description, citation, source, launch defaults). The tests read it through the
browser's own AnnData reader:

- ``tests/anndata-cellucid-metadata-contract.test.mjs`` (what the adapter
  takes from ``uns['cellucid']``, and what it refuses);
- ``tests/local-demo-source-contract.test.mjs`` and
  ``tests/link-source-contract.test.mjs`` (a dataset catalog of these files);
- ``tests/local-user-source-transaction.test.mjs`` (a picked Zarr folder).

Written into ``tests/fixtures/cellucid-ready/``:

- ``ready.h5ad``: six cells, three genes, a categorical ``cluster``, a
  continuous ``score``, ``obsm['X_umap']`` (2 columns) and ``obsm['X_pca']``
  (3 columns), ``uns['title']`` and a complete ``uns['cellucid']``, including
  a ``session`` record the viewer never reads;
- ``ready.zarr.zip``: the same data as an AnnData Zarr v2 store with
  consolidated metadata, zipped with fixed ZIP metadata; tests that need the
  store as a folder (``ready.zarr/``, picked or on a web host) unpack it in
  memory;
- ``unknown-key.h5ad``: the same data whose ``uns['cellucid']`` has a key the
  viewer does not know;
- ``other-id.h5ad``: the same data stating another id (``other-dataset``).

Run from the repository root:

```bash
python scripts/generate-cellucid-ready-fixtures.py
```
"""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd
import zarr

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "fixtures" / "cellucid-ready"
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)

CELLUCID = {
    "schema": 1,
    "id": "tiny-ready",
    "name": "Tiny ready dataset",
    "description": "Six cells written for the Cellucid web contract tests.",
    "citation": {"text": "Doe et al. 2026", "url": "https://doi.org/10.0000/tiny"},
    "source": {"name": "Example lab", "url": "https://example.org/tiny"},
    "defaults": {"embedding2d": "X_umap", "obsKeys": ["cluster"], "centroidMinPoints": 2},
    "session": {"manifest": {"note": "a session applied in Python"}},
}


def build(cellucid: dict) -> ad.AnnData:
    cells = [f"cell-{index}" for index in range(6)]
    obs = pd.DataFrame(
        {
            "cluster": pd.Categorical(["a", "b", "a", "b", "a", "b"], categories=["a", "b"]),
            "score": np.linspace(0.0, 1.0, 6, dtype=np.float32),
        },
        index=cells,
    )
    var = pd.DataFrame(index=["GENE_A", "GENE_B", "GENE_C"])
    x = np.arange(18, dtype=np.float32).reshape(6, 3)
    adata = ad.AnnData(X=x, obs=obs, var=var)
    adata.obsm["X_umap"] = np.array(
        [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], dtype=np.float32
    )
    adata.obsm["X_pca"] = np.arange(18, dtype=np.float32).reshape(6, 3) / 3
    adata.uns["title"] = "Tiny title"
    adata.uns["cellucid"] = cellucid
    return adata


def zip_folder(folder: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(folder.rglob("*")):
            if path.is_dir():
                continue
            info = zipfile.ZipInfo(
                f"{folder.name}/{path.relative_to(folder).as_posix()}",
                date_time=ZIP_TIMESTAMP,
            )
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())


def main() -> None:
    FIXTURE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    build(CELLUCID).write_h5ad(FIXTURE_DIRECTORY / "ready.h5ad")

    # The store is kept once, zipped; tests that need it as a folder (a
    # picked folder, a folder on a web host) unpack it in memory
    # (`tests/helpers/zarr-corpus.mjs`).
    with tempfile.TemporaryDirectory(prefix="cellucid-ready-") as temporary:
        folder = Path(temporary) / "ready.zarr"
        build(CELLUCID).write_zarr(folder)
        zarr.consolidate_metadata(str(folder))
        zip_folder(folder, FIXTURE_DIRECTORY / "ready.zarr.zip")

    unknown = {**CELLUCID, "colour": "blue"}
    build(unknown).write_h5ad(FIXTURE_DIRECTORY / "unknown-key.h5ad")
    build({**CELLUCID, "id": "other-dataset"}).write_h5ad(FIXTURE_DIRECTORY / "other-id.h5ad")


if __name__ == "__main__":
    main()
