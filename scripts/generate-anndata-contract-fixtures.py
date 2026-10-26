"""Create the small HDF5 fixtures of the AnnData reader contract.

`tests/anndata-reader-contract.test.mjs` builds most of its AnnData stores in
memory as Zarr. What only an HDF5 file can carry is written here, by anndata
and h5py themselves, into `tests/fixtures/anndata-contract/`:

- `hdf5-storage-variants.h5ad`: categorical `ordered` stored as the boolean
  enum h5py writes for NumPy booleans (little-endian), as the same enum on a
  big-endian base (as h5py writes on a big-endian host), and as a plain
  integer; text stored as fixed-length UTF-8, fixed-length ASCII and
  variable-length ASCII next to anndata's variable-length UTF-8; a var
  dataframe with no columns (anndata writes its empty `column-order` as an
  empty float64 array).
- `chunked-gzip-dense.h5ad`: a dense X of 7 cells x 5 genes stored in gzip
  chunks of 3 x 2, so genes cross chunk and strip edges.

Run from the repository root:

```bash
python scripts/generate-anndata-contract-fixtures.py
```

The output is deterministic (no timestamps are recorded), so running it
again reproduces the same bytes.
"""

from __future__ import annotations

from pathlib import Path

import anndata as ad
import h5py
import numpy as np
import pandas as pd

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "fixtures" / "anndata-contract"

CELLS = ["cell-a", "cell-b", "cell-c"]
GENES = ["GENE_A", "GENE_B"]


def write_storage_variants(path: Path) -> None:
    obs = pd.DataFrame(
        {
            "le_true": pd.Categorical(["low", "high", "low"], categories=["low", "high"], ordered=True),
            "be_false": pd.Categorical(["x", "y", "x"], categories=["x", "y"], ordered=False),
            "be_true": pd.Categorical(["x", "y", "y"], categories=["x", "y"], ordered=True),
            "int_ordered": pd.Categorical(["p", "q", "p"], categories=["p", "q"], ordered=True),
            "utf8_vlen": ["α", "β", "γ"],
        },
        index=CELLS,
    )
    var = pd.DataFrame(index=GENES)
    adata = ad.AnnData(
        X=np.arange(6, dtype=np.float32).reshape(3, 2),
        obs=obs,
        var=var,
        obsm={"X_umap": np.array([[0.0, 1.0], [2.0, 3.0], [4.0, 6.0]], dtype=np.float32)},
    )
    adata.write_h5ad(path)

    with h5py.File(path, "r+", track_order=False) as handle:
        # `ordered` on a big-endian boolean enum: one byte, so the value is the
        # same; only the recorded byte order of the base type differs.
        for key, value in (("be_false", 0), ("be_true", 1)):
            group = handle["obs"][key]
            del group.attrs["ordered"]
            base = h5py.h5t.STD_I8BE.copy()
            enum = h5py.h5t.enum_create(base)
            enum.enum_insert(b"FALSE", 0)
            enum.enum_insert(b"TRUE", 1)
            space = h5py.h5s.create(h5py.h5s.SCALAR)
            attribute = h5py.h5a.create(group.id, b"ordered", enum, space)
            attribute.write(np.array(value, dtype=">i1"))
        # `ordered` written as an integer, as some non-anndata writers do.
        group = handle["obs"]["int_ordered"]
        del group.attrs["ordered"]
        group.attrs.create("ordered", 1, dtype=np.int64)

        # The same text in every string storage HDF5 has.
        obs_group = handle["obs"]
        texts = {
            "utf8_fixed": (["α", "β", "γ"], h5py.string_dtype("utf-8", 8)),
            "ascii_fixed": (["one", "two", "six"], h5py.string_dtype("ascii", 4)),
            "ascii_vlen": (["one", "two", "six"], h5py.string_dtype("ascii")),
        }
        for key, (values, dtype) in texts.items():
            encoded = [value.encode("utf-8") for value in values] if dtype.kind == "S" else values
            dataset = obs_group.create_dataset(key, data=np.array(encoded, dtype=dtype))
            dataset.attrs["encoding-type"] = "string-array"
            dataset.attrs["encoding-version"] = "0.2.0"
        order = list(obs_group.attrs["column-order"]) + list(texts)
        obs_group.attrs["column-order"] = np.array(order, dtype=object)


def write_chunked_gzip_dense(path: Path) -> None:
    values = (np.arange(35, dtype=np.float32) * 0.5).reshape(7, 5)
    adata = ad.AnnData(
        X=values,
        obs=pd.DataFrame(index=[f"cell-{index}" for index in range(7)]),
        var=pd.DataFrame(index=[f"GENE_{index}" for index in range(5)]),
        obsm={"X_umap": np.stack([np.arange(7.0), np.arange(7.0) ** 2], axis=1).astype(np.float32)},
    )
    adata.write_h5ad(path)
    with h5py.File(path, "r+") as handle:
        attrs = dict(handle["X"].attrs)
        del handle["X"]
        dataset = handle.create_dataset("X", data=values, chunks=(3, 2), compression="gzip", compression_opts=4)
        for key, value in attrs.items():
            dataset.attrs[key] = value


def main() -> None:
    FIXTURE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    write_storage_variants(FIXTURE_DIRECTORY / "hdf5-storage-variants.h5ad")
    write_chunked_gzip_dense(FIXTURE_DIRECTORY / "chunked-gzip-dense.h5ad")
    with h5py.File(FIXTURE_DIRECTORY / "chunked-gzip-dense.h5ad", "r") as handle:
        assert handle["X"].chunks == (3, 2) and handle["X"].compression == "gzip"
    with h5py.File(FIXTURE_DIRECTORY / "hdf5-storage-variants.h5ad", "r") as handle:
        for key in ("be_false", "be_true"):
            assert handle["obs"][key].attrs.get_id("ordered").get_type().get_super().get_order() == h5py.h5t.ORDER_BE


if __name__ == "__main__":
    main()
