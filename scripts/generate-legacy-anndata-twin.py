"""Write the current-layout twin of the legacy AnnData fixtures.

Run with a current anndata after `generate-legacy-anndata-fixtures.py`.
Current anndata reads the 0.7 and 0.6 layouts itself, so each twin holds
exactly the data its legacy fixtures hold, in the layout Cellucid's reader validates
strictly; the legacy contract test requires every legacy fixture to read the
same as this twin, value for value.
"""

from __future__ import annotations

from pathlib import Path

import anndata

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "browser" / "fixtures"


def main() -> None:
    for legacy, twin in (
        ("legacy-0.7-csr.h5ad", "legacy-twin-current.h5ad"),
        ("legacy-0.6.h5ad", "legacy-0.6-twin-current.h5ad"),
    ):
        anndata.read_h5ad(FIXTURES / legacy).write_h5ad(FIXTURES / twin)


if __name__ == "__main__":
    main()
