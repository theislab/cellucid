"""Create the codec fixtures (`tests/fixtures/codecs/`).

- ``hdf5plugin-filters.h5``: three 12 x 5 float32 datasets in 4 x 5 chunks, each
  compressed with one of hdf5plugin's filters -- ``blosc`` (32001, a Blosc 1
  frame), ``zstd`` (32015, one zstd frame) and ``lz4`` (32004, the filter's
  block framing: an 8-byte big-endian size, a 4-byte block size, then each
  block's 4-byte length and its LZ4 block, or the block as it is). The chunks
  are written with ``write_direct_chunk``, so no plugin is needed to write
  them, and are exactly what hdf5plugin writes.
- ``bz2/`` and ``lzma/``: the same values as Zarr v2 arrays compressed with
  numcodecs' ``BZ2`` and ``LZMA`` (the xz container, numcodecs' default).
- ``blosc_zlib_*/``: the same values with numcodecs' Blosc and zlib, its
  blocks not shuffled, bit-shuffled, and byte-shuffled in blocks of 48 bytes
  (several blocks, the last shorter).
- ``hdf5plugin-bitshuffle.h5``: datasets written by h5py with hdf5plugin's
  bitshuffle filter (32008) itself, one per way it stores a chunk: its
  blocks LZ4-compressed (the default block size), zstd-compressed (a block
  of 16 elements), and as they are; elements of 1, 2, 4 and 8 bytes; chunks
  of a whole number of blocks, of a last shorter block, and of elements left
  after the last block (``bitshuffle.json`` holds each dataset's values).
- ``bitshuffle.h5ad``: a small AnnData (CSR ``X``, a categorical, an
  embedding) written by anndata with ``compression=hdf5plugin.Bitshuffle(cname="zstd")``.

Unless named, every array holds ``arange(60).reshape(12, 5) * 0.5 + 1``.

Needs hdf5plugin (and anndata, scipy, pandas for the AnnData).

Run from the repository root:

```bash
python scripts/generate-codec-fixtures.py
```
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import h5py
import numpy as np
from h5py import h5d, h5p, h5s, h5t, h5z
from numcodecs import BZ2, LZ4, LZMA, Blosc, Zstd

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "codecs"
VALUES = np.arange(60, dtype=np.float32).reshape(12, 5) * 0.5 + 1
ROWS = 4


def lz4_filter_chunk(raw: bytes, block: int = 64) -> bytes:
    """hdf5plugin's LZ4 filter framing around LZ4 blocks."""
    body = b""
    for start in range(0, len(raw), block):
        piece = raw[start : start + block]
        compressed = LZ4().encode(piece)[4:]  # numcodecs: a 4-byte LE size, then the block
        if len(compressed) >= len(piece):
            compressed = piece
        body += struct.pack(">I", len(compressed)) + compressed
    return struct.pack(">Q", len(raw)) + struct.pack(">I", block) + body


FILTERS = {
    "blosc": (32001, lambda raw: Blosc(cname="lz4", clevel=5, shuffle=Blosc.SHUFFLE).encode(raw)),
    "zstd": (32015, lambda raw: Zstd(level=3).encode(raw)),
    "lz4": (32004, lz4_filter_chunk),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with h5py.File(OUT / "hdf5plugin-filters.h5", "w") as file:
        for name, (filter_id, encode) in FILTERS.items():
            dcpl = h5p.create(h5p.DATASET_CREATE)
            dcpl.set_chunk((ROWS, VALUES.shape[1]))
            dcpl.set_filter(filter_id, h5z.FLAG_OPTIONAL, ())
            space = h5s.create_simple(VALUES.shape)
            dataset = h5d.create(file.id, name.encode(), h5t.IEEE_F32LE, space, dcpl=dcpl)
            for row in range(0, VALUES.shape[0], ROWS):
                dataset.write_direct_chunk((row, 0), encode(np.ascontiguousarray(VALUES[row : row + ROWS]).tobytes()), 0)
    for name, codec in {
        "bz2": BZ2(level=5), "lzma": LZMA(),
        # Blosc frames of zlib streams (inflated by the page's DEFLATE decoder): every way their blocks are shuffled.
        "blosc_zlib_noshuffle": Blosc(cname="zlib", clevel=5, shuffle=Blosc.NOSHUFFLE),
        "blosc_zlib_bitshuffle": Blosc(cname="zlib", clevel=5, shuffle=Blosc.BITSHUFFLE),
        "blosc_zlib_blocks": Blosc(cname="zlib", clevel=5, shuffle=Blosc.SHUFFLE, blocksize=48),
    }.items():
        folder = OUT / name
        folder.mkdir(exist_ok=True)
        (folder / ".zarray").write_text(json.dumps({
            "zarr_format": 2, "shape": list(VALUES.shape), "chunks": [ROWS, VALUES.shape[1]], "dtype": "<f4",
            "compressor": codec.get_config(), "fill_value": 0.0, "order": "C", "filters": None,
        }))
        for chunk in range(VALUES.shape[0] // ROWS):
            (folder / f"{chunk}.0").write_bytes(codec.encode(np.ascontiguousarray(VALUES[chunk * ROWS : (chunk + 1) * ROWS]).tobytes()))


def bitshuffle_values(dtype: str, count: int) -> np.ndarray:
    """Values that fill every bit plane of the type: a ramp with a large stride."""
    info = np.iinfo(dtype) if np.dtype(dtype).kind in "iu" else None
    ramp = np.arange(count, dtype=np.int64) * 2654435761
    if info is None:
        return (ramp % 100_003).astype(dtype) / 7
    span = min(int(info.max) - int(info.min) + 1, 1 << 40)
    return (ramp % span + max(int(info.min), -(span // 2))).astype(dtype)


#: name: (dtype, elements, chunk, hdf5plugin's Bitshuffle arguments)
BITSHUFFLE = {
    "lz4_f4": ("f4", 6000, 3003, {"cname": "lz4"}),
    "zstd_i8": ("i8", 1000, 333, {"nelems": 16, "cname": "zstd", "clevel": 3}),
    "none_u2": ("u2", 5000, 4100, {"cname": "none"}),
    "lz4_i1": ("i1", 20_000, 9000, {"cname": "lz4"}),
    "none_f8_blocks": ("f8", 4096, 2048, {"nelems": 256, "cname": "none"}),
}


def bitshuffle_fixtures() -> None:
    import anndata as ad
    import hdf5plugin
    import pandas as pd
    import scipy.sparse as sp

    expected = {}
    with h5py.File(OUT / "hdf5plugin-bitshuffle.h5", "w") as file:
        for name, (dtype, count, chunk, options) in BITSHUFFLE.items():
            values = bitshuffle_values(dtype, count)
            file.create_dataset(name, data=values, chunks=(chunk,), **hdf5plugin.Bitshuffle(**options))
            expected[name] = {"dtype": dtype, "sum": float(values.astype(np.float64).sum()), "first": values[:5].tolist(), "last": values[-5:].tolist()}
    rng = np.random.default_rng(0)
    adata = ad.AnnData(
        X=sp.random(500, 40, density=0.1, format="csr", dtype=np.float32, random_state=1),
        obs=pd.DataFrame({"group": pd.Categorical(rng.choice(["a", "b", "c"], 500))}, index=[f"cell{i}" for i in range(500)]),
        obsm={"X_umap": rng.normal(size=(500, 2)).astype(np.float32)},
    )
    adata.write_h5ad(OUT / "bitshuffle.h5ad", compression=hdf5plugin.Bitshuffle(cname="zstd"))
    expected["h5ad"] = {
        "column_sums": [float(v) for v in np.asarray(adata.X.sum(axis=0), dtype=np.float64).ravel()],
        "nnz": int(adata.X.nnz),
        "umap_sum": float(adata.obsm["X_umap"].astype(np.float64).sum()),
        "group_counts": {k: int(v) for k, v in adata.obs["group"].value_counts().sort_index().items()},
    }
    (OUT / "bitshuffle.json").write_text(json.dumps(expected, indent=1) + "\n")


if __name__ == "__main__":
    main()
    bitshuffle_fixtures()
