"""Write the stored-outlier-quantile fixtures the web app is checked against.

``cellucid.prepare(latent_key=...)`` (cellucid-python) stores every
categorical obs field's outlier quantiles in ``uns['cellucid']['outlierQuantiles']``;
the browser reads them instead of computing them. These files are written by
that writer, so the tests read exactly what it writes:

- ``tests/browser/fixtures/outliers-stored.h5ad`` and
  ``outliers-stored.zarr.zip``: 600 cells around four clusters, a 12-column
  latent space ``X_scVI`` (the stored one), a 2D ``X_umap`` and a 6-column
  ``X_pca`` (stored for neither, so computed), and obs columns ``cell_type``
  (4 categories), ``batch`` (3), ``rare`` (no category of 10 cells, so not
  stored) and ``doublet`` (a boolean).
- ``tests/browser/fixtures/outliers-stale.h5ad``: the same file with the
  categories of ``cell_type`` changed after it was written (the codes of two
  categories swapped for 50 cells), as editing obs with h5py or anndata
  would leave it: its stored quantiles no longer fit, so they are computed.
- ``tests/browser/fixtures/outliers-stored.expected.json``: the SHA-256 of
  each field's quantiles in each latent space, computed by the independent
  numpy reference (``scripts/generate-latent-outlier-conformance.py``), never
  by the writer under test.

Run from the repository root, with cellucid-python installed::

    python scripts/generate-outlier-quantile-fixtures.py
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
from pathlib import Path

import cellucid
import h5py
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "browser" / "fixtures"
N_CELLS = 600
MIN_POINTS = 10


def _reference():
    spec = importlib.util.spec_from_file_location(
        "conformance", ROOT / "scripts" / "generate-latent-outlier-conformance.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.latent_outlier_quantiles


def _inputs() -> dict:
    rng = np.random.default_rng(20261023)
    cluster = rng.integers(0, 4, N_CELLS)
    centres = rng.normal(0.0, 6.0, size=(4, 12))
    latent = centres[cluster] + rng.normal(0.0, 1.0, size=(N_CELLS, 12))
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical.from_codes(cluster, ["T", "B", "NK", "Mono"]),
            "batch": pd.Categorical(rng.choice(["b1", "b2", "b3"], N_CELLS)),
            "rare": pd.Categorical([f"r{i % 75}" for i in range(N_CELLS)]),
            "doublet": rng.random(N_CELLS) > 0.9,
            "score": rng.normal(size=N_CELLS),
        },
        index=[f"cell{i}" for i in range(N_CELLS)],
    )
    return {
        "embeddings": {
            "X_umap": latent[:, :2] + rng.normal(0.0, 0.1, size=(N_CELLS, 2)),
            "X_scVI": latent,
            "X_pca": latent[:, ::2],
        },
        "dataset_id": "outliers-stored",
        "dataset_name": "Outliers stored",
        "obs": obs,
        "latent_key": "X_scVI",
    }


def _codes(column: pd.Series) -> tuple[np.ndarray, int]:
    if isinstance(column.dtype, pd.CategoricalDtype):
        return column.cat.codes.to_numpy().astype(np.int64), len(column.cat.categories)
    return column.to_numpy().astype(np.int64), 2


def main() -> None:
    reference = _reference()
    arguments = _inputs()
    h5ad = cellucid.prepare(FIXTURES / "outliers-stored.h5ad", format="h5ad", force=True, **arguments)
    cellucid.prepare(FIXTURES / "outliers-stored.zarr.zip", format="zarr.zip", force=True, **arguments)

    stale = FIXTURES / "outliers-stale.h5ad"
    shutil.copyfile(h5ad, stale)
    with h5py.File(stale, "r+") as file:
        codes = file["obs/cell_type/codes"][...]
        changed = np.flatnonzero(codes < 2)[:50]
        codes[changed] = 1 - codes[changed]
        file["obs/cell_type/codes"][...] = codes

    obs = arguments["obs"]
    expected: dict = {}
    for key, values in arguments["embeddings"].items():
        latent = np.asarray(values, dtype=np.float32)
        expected[key] = {}
        for field in ("cell_type", "batch", "rare", "doublet"):
            codes, n = _codes(obs[field])
            quantiles = reference(latent, codes, n, MIN_POINTS).astype("<f4")
            expected[key][field] = hashlib.sha256(quantiles.tobytes()).hexdigest()
    (FIXTURES / "outliers-stored.expected.json").write_text(
        json.dumps(
            {
                "_about": "SHA-256 of each field's outlier quantiles (little-endian float32, NaN where "
                "none) in each latent space, by the numpy reference; written by "
                "scripts/generate-outlier-quantile-fixtures.py.",
                "minPoints": MIN_POINTS,
                "stored": ["cell_type", "batch", "doublet"],
                "quantiles": expected,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
