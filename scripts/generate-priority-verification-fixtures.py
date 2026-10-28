"""Create the priority-order fixtures of the web contract tests.

Files ``cellucid.prepare()`` writes in priority order, and the same files
read with anndata, changed, and written again with anndata -- what a person
does to a Cellucid-ready file -- so the reader's verification of
``uns['cellucid']['priority']`` (``assets/js/data/anndata/priority-layout.js``)
is tested on stores real writers made, not hand-made ones
(``tests/priority-verification-contract.test.mjs``). Each cell's obs name is
``cell<original position>``.

Written into ``tests/fixtures/priority/``, each a Zarr v2 store zipped with
fixed ZIP metadata:

- ``written.zarr.zip``: 300 cells in priority order under seed 7, as written;
- ``resaved-seed0.zarr.zip``: written under seed 0, then read and written
  again with anndata (on zarr 3: the seed's chunk is left out, its
  ``fill_value`` null);
- ``dropped.zarr.zip``: one cell removed (the record names 300 cells);
- ``sorted.zarr.zip``: the cells sorted by obs name (the record's cell count
  holds, its order does not);
- ``no-column.zarr.zip``: ``obs['cellucid_original_position']`` removed (the
  record still describes the cells);
- ``column-only.zarr.zip``: ``uns['cellucid']['priority']`` removed, the
  column kept;
- ``newer-spec.zarr.zip``: the record's ``specVersion`` set to 2.

Run from the repository root with the Python environment that has
cellucid-python, anndata and zarr 3:

    python scripts/generate-priority-verification-fixtures.py
"""

from __future__ import annotations

import shutil
import tempfile
import warnings
import zipfile
from pathlib import Path

import anndata as ad
import numpy as np
import pandas as pd
from scipy import sparse

import cellucid

warnings.simplefilter("ignore")

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "fixtures" / "priority"
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
N_CELLS = 300


def zip_folder(folder: Path, target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(item for item in folder.rglob("*") if item.is_file()):
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), ZIP_TIMESTAMP)
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())


def prepared(folder: Path, seed: int) -> Path:
    rng = np.random.default_rng(1)
    x = sparse.random(N_CELLS, 3, density=0.4, format="csc", dtype=np.float32, random_state=1)
    x.data = np.round(x.data * 10) + 1
    obs = pd.DataFrame(
        {"cluster": pd.Categorical([f"c{i % 3}" for i in range(N_CELLS)])},
        index=[f"cell{i}" for i in range(N_CELLS)],
    )
    path = folder / f"prepared-{seed}.zarr"
    cellucid.prepare(
        path, format="zarr", zarr_format=2, embeddings={"X_umap": rng.normal(size=(N_CELLS, 2)).astype(np.float32)},
        obs=obs, gene_expression=x, var=pd.DataFrame(index=["g0", "g1", "g2"]),
        dataset_id="priority", dataset_name="Priority", priority_seed=seed, force=True,
    )
    return path


def main() -> None:
    if FIXTURE_DIRECTORY.exists():
        shutil.rmtree(FIXTURE_DIRECTORY)
    FIXTURE_DIRECTORY.mkdir(parents=True)
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        written = prepared(folder, 7)
        zip_folder(written, FIXTURE_DIRECTORY / "written.zarr.zip")
        stores = {}
        stores["resaved-seed0"] = ad.read_zarr(prepared(folder, 0))
        adata = ad.read_zarr(written)
        keep = np.ones(N_CELLS, dtype=bool)
        keep[150] = False
        stores["dropped"] = adata[keep].copy()
        stores["sorted"] = adata[np.argsort(adata.obs_names.to_numpy(), kind="stable")].copy()
        no_column = adata.copy()
        del no_column.obs["cellucid_original_position"]
        stores["no-column"] = no_column
        column_only = adata.copy()
        del column_only.uns["cellucid"]["priority"]
        stores["column-only"] = column_only
        newer = adata.copy()
        newer.uns["cellucid"]["priority"]["specVersion"] = 2
        stores["newer-spec"] = newer
        for name, data in stores.items():
            target = folder / f"{name}.zarr"
            with ad.settings.override(zarr_write_format=2):
                data.write_zarr(target)
            zip_folder(target, FIXTURE_DIRECTORY / f"{name}.zarr.zip")
    for path in sorted(FIXTURE_DIRECTORY.iterdir()):
        print(f"wrote {path.relative_to(REPOSITORY_ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
