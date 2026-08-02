"""Create the matched big-endian / little-endian H5AD byte-order fixtures.

The two files carry byte-identical *values* and differ only in the NumPy
byte-order prefix of every numeric datatype on disk. They pin the guarantee
that the browser HDF5 reader (h5wasm) converts stored data to the host byte
order, so a big-endian ``.h5ad`` opened in Cellucid yields the same numbers as
its little-endian twin.

Run from the repository root:

```bash
python scripts/generate-byte-order-h5ad-fixtures.py
```
"""

from __future__ import annotations

from pathlib import Path

import h5py
import numpy as np


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "browser" / "fixtures"
FIXTURES = {
    "<": FIXTURE_DIRECTORY / "byte-order-little-endian.h5ad",
    ">": FIXTURE_DIRECTORY / "byte-order-big-endian.h5ad",
}

CELL_COUNT = 8
GENE_COUNT = 3

CELL_NAMES = [f"cell{index}" for index in range(CELL_COUNT)]
GENE_NAMES = ["GENE_A", "GENE_B", "GENE_C"]

# Every float literal below is exactly representable in binary32 and binary64,
# so the fixture pins exact equality rather than a tolerance. Byte-swapping any
# of them produces a different finite number, never a NaN, which is precisely
# the silent-corruption case the fixture has to be able to catch.
X_DENSE = np.array(
    [
        [1.5, -2.25, 0.125],
        [96.0, 6.5, -0.5],
        [1024.0, 0.001953125, 3.75],
        [-8192.0, 0.75, 17.5],
        [0.0, 1.0, -1.0],
        [2.5, -32.0, 0.0625],
        [65536.0, -0.25, 12.0],
        [7.125, 448.0, -0.03125],
    ],
    dtype="f8",
)

UMAP_2D = np.array(
    [
        [-4.5, 2.25],
        [0.5, -3.75],
        [12.0, 0.125],
        [-0.0625, 48.0],
        [7.5, -1.5],
        [-256.0, 0.75],
        [3.25, 1024.0],
        [-0.5, -0.125],
    ],
    dtype="f8",
)

UMAP_3D = np.array(
    [
        [1.25, -2.5, 4.0],
        [-8.0, 16.5, -0.75],
        [0.5, 0.25, -128.0],
        [64.0, -0.125, 2.0],
        [-1.5, 32.0, 0.375],
        [256.0, -4.25, -6.0],
        [-0.25, 1.75, 512.0],
        [3.5, -0.0625, 0.5],
    ],
    dtype="f8",
)

# Connectivity edges as an AnnData CSR sparse matrix, exactly symmetric as the
# reader requires. The ``shape`` attribute is the numeric HDF5 *attribute* on
# this group, so the fixture exercises the attribute read path as well as the
# dataset read path.
CONNECTIVITY_DATA = np.array(
    [0.5, 0.25, 0.5, 0.75, 0.25, 1.0, 0.75, 0.125, 1.0, 0.125, 0.0625, 0.0625],
    dtype="f8",
)
CONNECTIVITY_INDICES = np.array([1, 2, 0, 3, 0, 4, 1, 5, 2, 3, 7, 6], dtype="i4")
CONNECTIVITY_INDPTR = np.array([0, 2, 4, 6, 8, 9, 10, 11, 12], dtype="i4")

# The reader carries observation fields as Float32, and rejects integers that
# Float32 cannot hold exactly, so every integer literal here is Float32-exact.
# Each is also chosen so that byte-swapping it yields a *different* in-range
# value (0x0001 -> 0x0100, 0x7F000000 -> 0x0000007F, ...): a fixture whose
# swapped form happened to equal its original would prove nothing.
OBS_NUMERIC = {
    "score_f4": ("f4", np.array(
        [1.5, -2.25, 0.125, 96.0, 6.5, -0.5, 1024.0, 0.001953125],
    )),
    "score_f8": ("f8", np.array(
        [1.5, -2.25, 0.125, 96.0, 6.5, -0.5, 1024.0, 0.001953125],
    )),
    "count_i4": ("i4", np.array(
        [1, -2, 65536, -2147483648, 16777216, 2130706432, 0, -16777216],
    )),
    "count_u4": ("u4", np.array(
        [1, 2, 65536, 4278190080, 16777216, 0, 4294967040, 256],
    )),
    "count_i2": ("i2", np.array([1, -2, 32767, -32768, 256, 0, 4660, -4660])),
    "count_u2": ("u2", np.array([1, 2, 65535, 40000, 256, 0, 4660, 43981])),
}

CELL_TYPE_CATEGORIES = ["alpha", "beta", "gamma"]
CELL_TYPE_CODES = np.array([0, 1, 2, 0, 1, 2, 0, 1], dtype="i1")

STRING_DTYPE = h5py.special_dtype(vlen=str)


def _write_string_array(parent: h5py.Group, name: str, values: list[str]) -> None:
    dataset = parent.create_dataset(
        name, data=np.array(values, dtype=object), dtype=STRING_DTYPE
    )
    dataset.attrs["encoding-type"] = "string-array"
    dataset.attrs["encoding-version"] = "0.2.0"


def _write_array(
    parent: h5py.Group, name: str, values: np.ndarray, dtype: str
) -> None:
    dataset = parent.create_dataset(name, data=values.astype(dtype), dtype=dtype)
    dataset.attrs["encoding-type"] = "array"
    dataset.attrs["encoding-version"] = "0.2.0"


def _write_fixture(path: Path, order: str) -> None:
    with h5py.File(path, "w") as handle:
        handle.attrs["encoding-type"] = "anndata"
        handle.attrs["encoding-version"] = "0.1.0"

        _write_array(handle, "X", X_DENSE, f"{order}f4")

        obs = handle.create_group("obs")
        obs.attrs["encoding-type"] = "dataframe"
        obs.attrs["encoding-version"] = "0.2.0"
        obs.attrs["_index"] = "_index"
        obs.attrs["column-order"] = np.array(
            [*OBS_NUMERIC, "cell_type"], dtype=object
        )
        _write_string_array(obs, "_index", CELL_NAMES)
        for name, (kind, values) in OBS_NUMERIC.items():
            _write_array(obs, name, values, f"{order}{kind}")

        cell_type = obs.create_group("cell_type")
        cell_type.attrs["encoding-type"] = "categorical"
        cell_type.attrs["encoding-version"] = "0.2.0"
        cell_type.attrs["ordered"] = np.bool_(False)
        _write_string_array(cell_type, "categories", CELL_TYPE_CATEGORIES)
        _write_array(cell_type, "codes", CELL_TYPE_CODES, "i1")

        var = handle.create_group("var")
        var.attrs["encoding-type"] = "dataframe"
        var.attrs["encoding-version"] = "0.2.0"
        var.attrs["_index"] = "_index"
        var.attrs["column-order"] = np.array(["gene_symbol"], dtype=object)
        _write_string_array(var, "_index", GENE_NAMES)
        _write_string_array(var, "gene_symbol", GENE_NAMES)

        obsm = handle.create_group("obsm")
        obsm.attrs["encoding-type"] = "dict"
        obsm.attrs["encoding-version"] = "0.1.0"
        _write_array(obsm, "X_umap_2d", UMAP_2D, f"{order}f4")
        _write_array(obsm, "X_umap_3d", UMAP_3D, f"{order}f8")

        obsp = handle.create_group("obsp")
        obsp.attrs["encoding-type"] = "dict"
        obsp.attrs["encoding-version"] = "0.1.0"
        connectivities = obsp.create_group("connectivities")
        connectivities.attrs["encoding-type"] = "csr_matrix"
        connectivities.attrs["encoding-version"] = "0.1.0"
        connectivities.attrs["shape"] = np.array(
            [CELL_COUNT, CELL_COUNT], dtype=f"{order}i8"
        )
        connectivities.create_dataset(
            "data", data=CONNECTIVITY_DATA.astype(f"{order}f8"), dtype=f"{order}f8"
        )
        connectivities.create_dataset(
            "indices",
            data=CONNECTIVITY_INDICES.astype(f"{order}i4"),
            dtype=f"{order}i4",
        )
        connectivities.create_dataset(
            "indptr",
            data=CONNECTIVITY_INDPTR.astype(f"{order}i4"),
            dtype=f"{order}i4",
        )

        for name in ("layers", "uns", "varm", "varp"):
            group = handle.create_group(name)
            group.attrs["encoding-type"] = "dict"
            group.attrs["encoding-version"] = "0.1.0"


MULTI_BYTE_DATASETS = (
    "X",
    "obs/score_f4",
    "obs/score_f8",
    "obs/count_i4",
    "obs/count_u4",
    "obs/count_i2",
    "obs/count_u2",
    "obsm/X_umap_2d",
    "obsm/X_umap_3d",
    "obsp/connectivities/data",
    "obsp/connectivities/indices",
    "obsp/connectivities/indptr",
)

# H5T_ORDER_LE / H5T_ORDER_BE. NumPy normalizes the host byte order to '=', so
# the recorded HDF5 datatype order is the only unambiguous check.
HDF5_ORDER = {"<": 0, ">": 1}


def main() -> None:
    for order, path in FIXTURES.items():
        _write_fixture(path, order)

    for order, path in FIXTURES.items():
        expected = HDF5_ORDER[order]
        with h5py.File(path, "r") as handle:
            for name in MULTI_BYTE_DATASETS:
                actual = handle[name].id.get_type().get_order()
                if actual != expected:
                    raise AssertionError(
                        f"{path.name}: {name} datatype order {actual} != {expected}"
                    )
            shape_order = (
                handle["obsp/connectivities"]
                .attrs.get_id("shape")
                .get_type()
                .get_order()
            )
            if shape_order != expected:
                raise AssertionError(
                    f"{path.name}: connectivities shape attribute order "
                    f"{shape_order} != {expected}"
                )


if __name__ == "__main__":
    main()
