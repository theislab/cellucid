"""Write the latent-outlier conformance fixture the web app is checked against.

``tests/fixtures/latent-outlier-conformance.json`` holds latent spaces
(float32 values, written as the exact doubles they widen to), category codes,
and the outlier quantiles of each cell as little-endian float32 bytes. The
quantiles are computed here with numpy, independently of the browser's
``assets/js/data/latent-outliers.js``, which
``tests/outlier-quantile-exact-contract.test.mjs`` checks against them bit for
bit. The writers that store quantiles are checked against byte-identical
copies (compared with this file by ``tests/shared-files-contract.test.mjs``
and each package's own tests): cellucid-python's
``tests/fixtures/latent_outlier_conformance.json`` (``prepare()``) and
cellucid-r's ``tests/testthat/fixtures/latent_outlier_conformance.json``
(``cellucid_prepare()``).

The rule, for each category with at least ``minPoints`` cells, over the latent
values as stored (float32, widened exactly to float64):

1. the centroid is the column sums, accumulated cell by cell in cell order,
   divided by the cell count;
2. a cell's distance is the square root of its squared differences from the
   centroid, accumulated column by column in column order;
3. its quantile is the number of the category's cells at that distance or
   closer, divided by the cell count, both as float32.

A cell whose latent row is not finite (NaN in any column) has no place in the
latent space: it is left out as a cell with a missing code is, adding nothing
to its category's centroid or size, and ``minPoints`` counts a category's
placed cells. Every other cell (a missing code, -1, an unplaced cell, or a
category under ``minPoints``) is NaN. A NaN latent value is written as JSON
``null``. The cases are drawn from seeded generators, so every run writes the
same bytes.

Run from the repository root::

    python scripts/generate-latent-outlier-conformance.py          # write
    python scripts/generate-latent-outlier-conformance.py --check  # compare

``--check`` exits non-zero when the committed fixture differs from what this
script computes.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

TARGET = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "latent-outlier-conformance.json"


def latent_outlier_quantiles(
    latent: np.ndarray, codes: np.ndarray, n_categories: int, min_points: int
) -> np.ndarray:
    """Per-cell outlier quantiles by the rule in the module docstring."""
    values = np.asarray(latent, dtype=np.float32)
    quantiles = np.full(values.shape[0], np.nan, dtype=np.float32)
    placed = np.isfinite(values).all(axis=1)
    for code in range(n_categories):
        members = np.nonzero((codes == code) & placed)[0]
        n = members.size
        if n < min_points:
            continue
        squared = np.zeros(n, dtype=np.float64)
        for column in range(values.shape[1]):
            column_values = values[members, column].astype(np.float64)
            # A cumulative sum adds in cell order; numpy's sum adds pairwise.
            centroid = np.cumsum(column_values)[-1] / n
            difference = column_values - centroid
            squared += difference * difference
        distances = np.sqrt(squared)
        ranks = np.searchsorted(np.sort(distances), distances, side="right")
        quantiles[members] = ranks.astype(np.float32) / np.float32(n)
    return quantiles


def case(name: str, latent: np.ndarray, codes: np.ndarray, n_categories: int, min_points: int) -> dict:
    latent = np.asarray(latent, dtype=np.float32)
    codes = np.asarray(codes)
    quantiles = latent_outlier_quantiles(latent, codes, n_categories, min_points)
    return {
        "name": name,
        "width": int(latent.shape[1]),
        # Row-major, one float32 value each, as the exact double it widens
        # to; NaN (a cell the latent space does not place) as null.
        "latent": [None if np.isnan(value) else float(value) for value in latent.reshape(-1)],
        "codes": [int(code) for code in codes],
        "nCategories": n_categories,
        "minPoints": min_points,
        "quantilesHex": quantiles.astype("<f4").tobytes().hex(),
    }


def unplaced_latent(rng: np.random.Generator) -> np.ndarray:
    """60 cells in 4 columns; some rows NaN in one column, some in every column.

    Category 0 (cells 0, 3, ...) keeps 16 of its 20 cells, category 1 keeps 14,
    and category 2 keeps 11, under ``minPoints`` 12.
    """
    latent = rng.normal(0.0, 2.0, size=(60, 4))
    for cell in (0, 9, 30, 57):
        latent[cell, 1] = np.nan
    for cell in (1, 4, 7, 10, 13, 16):
        latent[cell, :] = np.nan
    for cell in (2, 5, 8, 11, 14, 17, 20, 23, 26):
        latent[cell, 3] = np.nan
    return latent


def document() -> dict:
    rng = np.random.default_rng(20261019)
    # Pairs mirrored about a far-off centre: their distances tie exactly in
    # real arithmetic, so rounding -- the order of summation -- decides the
    # ranks. A float32 or pairwise summation gives other bytes here.
    centre = np.random.default_rng(0).normal(0.0, 1.0, size=(1, 12)) * 1e4
    offsets = np.random.default_rng(0).integers(-50, 50, size=(10, 12)).astype(np.float64) * 0.37
    mirrored = np.concatenate([centre + offsets, centre - offsets])
    cases = [
        case(
            "mirrored pairs whose ranks only the stated summation order decides",
            mirrored,
            np.zeros(len(mirrored), dtype=int),
            1,
            2,
        ),
        case(
            "ties share the larger rank; a small category and a missing code are NaN",
            np.array([[0, 0], [1, 0], [1, 0], [4, 0], [7, 7], [8, 8], [3, 3]]),
            np.array([0, 0, 0, 0, 1, 1, -1]),
            2,
            3,
        ),
        case(
            "a wide space at a large scale, where the order of summation shows",
            rng.normal(0.0, 3.0, size=(300, 9)) * 1e3 + 1e5,
            rng.integers(-1, 5, size=300),
            5,
            10,
        ),
        case(
            "one column, many exact ties",
            rng.integers(0, 4, size=(120, 1)).astype(np.float64),
            np.arange(120) % 3,
            3,
            2,
        ),
        case(
            "cells the latent space does not place (NaN rows) are left out of their category, "
            "which falls under minPoints when too few cells are placed",
            unplaced_latent(rng),
            np.arange(60) % 3,
            3,
            12,
        ),
    ]
    return {
        "_about": (
            "Latent-space outlier quantiles: float32 values widened to float64, centroid sums "
            "in cell order, squared distances in column order, the share at that distance or "
            "closer as float32; a cell whose latent row holds NaN (null here) is left out of its "
            "category. Written by scripts/generate-latent-outlier-conformance.py, "
            "which computes them with numpy, independently of the browser's implementation."
        ),
        "version": 2,
        "cases": cases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="compare with the committed fixture; write nothing")
    arguments = parser.parse_args()
    text = json.dumps(document(), indent=1) + "\n"
    if arguments.check:
        if TARGET.read_text(encoding="utf-8") != text:
            print(f"{TARGET} differs from what this script computes.", file=sys.stderr)
            return 1
        print(f"{TARGET} matches.")
        return 0
    TARGET.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
