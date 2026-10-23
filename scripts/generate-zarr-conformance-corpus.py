"""Generate the Zarr conformance corpus under tests/fixtures/zarr/.

The web app's Zarr reader (assets/js/formats/zarr) is tested value for value
against what zarr-python reads from the same stores. This script writes small
Zarr v2 and v3 stores covering every element type, codec, chunk layout, fill
value and sharding case the reader supports (and a few it refuses), and
AnnData stores written by anndata in both formats. Each store is kept once,
as `<store>.zip` (the v2 ones under their folder name, the v3 ones at the top
level, so the reader is tested on both archive layouts); the tests unpack it
in memory to read it as a picked folder and from a web host
(`tests/helpers/zarr-corpus.mjs`). Next to each it writes
`<store>.expected.json`: every node as zarr-python reads it (kind,
attributes, shape, chunk shape, fill value, every value).

Run from the repository root with the Python environment that has zarr 3,
numcodecs and anndata:

    python scripts/generate-zarr-conformance-corpus.py

Output is deterministic: rerunning it over an unchanged environment rewrites
identical bytes (ZIP timestamps are fixed, entries sorted).

Expected-value encoding (decoded by tests/zarr-format-conformance.test.mjs):
- integers of 8 bytes, and datetimes, as decimal strings; other integers and
  booleans (0/1) as numbers;
- floats as numbers, non-finite ones as "NaN", "Infinity", "-Infinity";
- strings as strings (NumPy `S` decoded as UTF-8, trailing NULs removed);
- opaque elements (`V`, complex) as one hex string per element;
- structured elements as one list of field values per element;
- attributes as JSON, with {"$bigint": "..."} for integers outside the
  JavaScript safe range and {"$float": "NaN"} for non-finite floats.
An array zarr-python cannot read, or that the reader must refuse, carries
`"error"`: a word the reader's error must mention.
"""

from __future__ import annotations

import base64
import gzip
import json
import math
import os
import shutil
import sys
import warnings
import zipfile
from pathlib import Path

import numcodecs
import numpy as np
import zarr
from zarr.codecs import (
    BloscCodec,
    BytesCodec,
    Crc32cCodec,
    GzipCodec,
    ShardingCodec,
    TransposeCodec,
    ZstdCodec,
)
from zarr.core.dtype import VariableLengthBytes

warnings.simplefilter("ignore")

# gzip headers carry a modification time; numcodecs leaves it to the clock.
# Fixing it keeps the corpus byte-for-byte reproducible.
_GzipFile = gzip.GzipFile


class _FixedTimeGzipFile(_GzipFile):
    def __init__(self, *args, **kwargs):
        kwargs["mtime"] = 0
        super().__init__(*args, **kwargs)


gzip.GzipFile = _FixedTimeGzipFile

ROOT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "zarr"
SAFE = 2**53 - 1
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
RNG = np.random.default_rng(20261022)


# ---------------------------------------------------------------------------
# Expected values


def encode_scalar(value, dtype: np.dtype):
    kind = dtype.kind
    if dtype.names:
        return [encode_scalar(value[name], dtype.fields[name][0]) for name in dtype.names]
    if dtype.subdtype is not None:
        base, _ = dtype.subdtype
        return [encode_scalar(v, base) for v in np.asarray(value).ravel()]
    if kind == "b":
        return int(bool(value))
    if kind in "iu":
        return str(int(value)) if dtype.itemsize == 8 else int(value)
    if kind in "mM":
        return str(int(np.asarray(value).view("<i8")))
    if kind == "f":
        v = float(np.float32(value)) if dtype.itemsize <= 4 else float(value)
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        return v
    if kind == "S":
        return bytes(value).rstrip(b"\0").decode("utf-8")
    if kind == "U":
        return str(value)
    if kind == "O":
        return value.decode("utf-8") if isinstance(value, bytes) else str(value)
    if kind in "Vc":
        return np.asarray(value).tobytes().hex()
    if kind == "T":
        return str(value)
    raise TypeError(f"no encoding for {dtype}")


def encode_values(array: np.ndarray):
    flat = array.reshape(-1)
    if array.dtype.names:
        return [encode_scalar(flat[i], array.dtype) for i in range(flat.size)]
    return [encode_scalar(v, array.dtype) for v in flat]


def encode_attr(value):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value if abs(value) <= SAFE else {"$bigint": str(value)}
    if isinstance(value, float):
        if math.isnan(value):
            return {"$float": "NaN"}
        if math.isinf(value):
            return {"$float": "Infinity" if value > 0 else "-Infinity"}
        return value
    if isinstance(value, (list, tuple)):
        return [encode_attr(v) for v in value]
    if isinstance(value, dict):
        return {k: encode_attr(v) for k, v in value.items()}
    if isinstance(value, np.generic):
        return encode_attr(value.item())
    raise TypeError(f"attribute of type {type(value)}")


def read_chunks(array) -> list[int]:
    return list(array.chunks)


def describe(path: Path, overrides: dict | None = None) -> dict:
    """Every node of the store at `path`, read with zarr-python."""
    overrides = overrides or {}
    root = zarr.open_group(str(path), mode="r", use_consolidated=False)
    nodes = {"/": {"kind": "group", "attrs": encode_attr(dict(root.attrs))}}

    markers = (".zarray", ".zgroup", "zarr.json")

    def visit(group, prefix):
        # Children from the files, so a node zarr-python cannot open is
        # still listed (its override says what it holds).
        directory = path / prefix.lstrip("/")
        names = sorted(child.name for child in directory.iterdir()
                       if child.is_dir() and any((child / marker).exists() for marker in markers))
        for name in names:
            node_path = f"{prefix}/{name}"
            try:
                node = group[name]
            except ValueError:
                nodes[node_path] = {"kind": "array", "attrs": {}, **overrides[node_path]}
                continue
            if isinstance(node, zarr.Group):
                nodes[node_path] = {"kind": "group", "attrs": encode_attr(dict(node.attrs))}
                visit(node, node_path)
                continue
            entry = {
                "kind": "array",
                "attrs": encode_attr(dict(node.attrs)),
                "shape": list(node.shape),
                "chunks": read_chunks(node),
                "numpy": node.dtype.str if node.dtype.names is None else str(node.dtype.descr),
            }
            override = overrides.get(node_path, {})
            if "values" in override or "error" in override:
                entry.update(override)
                nodes[node_path] = entry
                continue
            data = node[...]
            values = np.asarray(data)
            entry["values"] = encode_values(values) if values.ndim else encode_values(values.reshape(1))
            fill = node.metadata.fill_value if node.metadata.zarr_format == 3 else node.metadata.fill_value
            entry["fill"] = None if fill is None else encode_scalar(np.asarray(fill, dtype=node.dtype)[()] if node.dtype.names is None else np.asarray(fill, dtype=node.dtype), node.dtype)
            entry.update(override)
            nodes[node_path] = entry

    visit(root, "")
    return {"zarr_format": root.metadata.zarr_format, "nodes": nodes}


def write_expected(store: Path, overrides=None):
    expected = describe(store, overrides)
    target = store.with_name(store.name + ".expected.json")
    lines = [f"{json.dumps(path, ensure_ascii=False)}:{json.dumps(node, sort_keys=True, ensure_ascii=False, separators=(',', ':'))}"
             for path, node in sorted(expected["nodes"].items())]
    target.write_text('{"zarr_format":%d,"nodes":{\n%s\n}}\n' % (expected["zarr_format"], ",\n".join(lines)))


def zip_store(store: Path, target: Path, *, root_folder: bool, compression: int):
    """Zip a store deterministically: sorted entries, fixed timestamps."""
    files = sorted(p for p in store.rglob("*") if p.is_file())
    with zipfile.ZipFile(target, "w") as archive:
        if root_folder:
            info = zipfile.ZipInfo(store.name + "/", ZIP_TIME)
            info.external_attr = (0o40755 << 16) | 0x10
            archive.writestr(info, b"")
        for file in files:
            relative = file.relative_to(store).as_posix()
            name = f"{store.name}/{relative}" if root_folder else relative
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.external_attr = 0o100644 << 16
            info.compress_type = compression
            archive.writestr(info, file.read_bytes(), compress_type=compression)


def consolidate_v2(store: Path):
    """Write .zmetadata the way zarr-python does, including the hand-written
    arrays zarr-python itself cannot open."""
    metadata = {}
    for file in sorted(store.rglob("*")):
        if file.name in (".zgroup", ".zarray", ".zattrs"):
            metadata[file.relative_to(store).as_posix()] = json.loads(file.read_text())
    (store / ".zmetadata").write_text(json.dumps({"metadata": metadata, "zarr_consolidated_format": 1}, indent=4, sort_keys=True))


def fresh(path: Path) -> Path:
    if path.exists():
        shutil.rmtree(path)
    return path


# ---------------------------------------------------------------------------
# Zarr v2 cases


def v2_cases(base: Path):
    store = fresh(base / "cases.zarr")
    g = zarr.open_group(str(store), mode="w", zarr_format=2)
    g.attrs.update({"title": "v2 cases", "nan": float("nan"), "big": 2**63 - 1, "nested": {"list": [1, 2.5, "x"], "flag": True}})
    blosc = numcodecs.Blosc(cname="lz4", clevel=5, shuffle=1)

    d = g.create_group("dtypes")
    ints = np.array([0, 1, -1, 7, -128, 127, 42])
    numeric = {
        "bool": np.array([True, False, True, True, False, False, True]),
        "int8": ints.astype("i1"), "uint8": np.array([0, 1, 255, 7, 128, 3, 42], "u1"),
        "int16_le": (ints * 300).astype("<i2"), "int16_be": (ints * 300).astype(">i2"),
        "uint16_le": np.arange(7, dtype="<u2") * 9000, "uint16_be": np.arange(7, dtype=">u2") * 9000,
        "int32_le": (ints * 70000).astype("<i4"), "int32_be": (ints * 70000).astype(">i4"),
        "uint32": np.arange(7, dtype="<u4") * 600000000,
        "int64_le": np.array([0, -1, 2**62, -(2**63), 2**63 - 1, 9007199254740993, 5], "<i8"),
        "int64_be": np.array([0, -1, 2**62, -(2**63), 2**63 - 1, 9007199254740993, 5], ">i8"),
        "uint64": np.array([0, 1, 2**64 - 1, 2**63, 9007199254740993, 3, 4], "<u8"),
        "float16_le": np.array([0, 1.5, -2.25, 65504, np.nan, np.inf, 6.1e-5], "<f2"),
        "float16_be": np.array([0, 1.5, -2.25, 65504, np.nan, -np.inf, 6.1e-5], ">f2"),
        "float32_le": np.array([0, 1.5, -2.25, 3.4e38, np.nan, np.inf, 1e-45], "<f4"),
        "float32_be": np.array([0, 1.5, -2.25, 3.4e38, np.nan, -np.inf, 1e-45], ">f4"),
        "float64_le": np.array([0, 1.5, -2.25, 1.7e308, np.nan, np.inf, 5e-324], "<f8"),
        "float64_be": np.array([0, 1.5, -2.25, 1.7e308, np.nan, -np.inf, 5e-324], ">f8"),
        "datetime": np.array(["2020-01-01", "1970-01-01", "NaT", "2262-04-11", "1677-09-22", "2000-02-29", "2026-10-22"], "datetime64[ns]"),
        "bytes6": np.array([b"abc", b"", b"abcdef", b"x\x00y", b"\xc3\xbc", b"z", b"q"], "S6"),
        "unicode_le": np.array(["ab", "", "üñí", "日本", "a\U0001F600", "z", "four"], "<U4"),
        "unicode_be": np.array(["ab", "", "üñí", "日本", "a\U0001F600", "z", "four"], ">U4"),
        "void3": np.array([b"\x01\x02\x03", b"\x00\x00\x00", b"\xff\xfe\xfd", b"abc", b"\x00\x01\x00", b"xyz", b"\x10\x20\x30"], "V3"),
        "complex64": np.array([1 + 2j, 0, -1j, 3, 4, 5j, 6], "c8"),
        "struct": np.array([(1, 1.5), (2, -2.5), (3, np.nan), (4, 0), (5, 1e10), (6, -0.0), (7, 7)], dtype=[("a", "<i4"), ("b", ">f8")]),
    }
    for name, values in numeric.items():
        a = d.create_array(name, shape=values.shape, dtype=values.dtype, chunks=(3,), compressors=blosc)
        a[:] = values
    strings = ["", "a", "üñí", "日本語", "a\U0001F600b", "x" * 40, "last"]
    d.create_array("vlen_utf8", shape=(7,), dtype=str, chunks=(3,), compressors=blosc)[:] = np.array(strings, dtype=object)
    d.create_array("vlen_bytes", shape=(7,), dtype=VariableLengthBytes(), chunks=(3,), compressors=blosc)[:] = np.array([s.encode() for s in strings], dtype=object)

    c = g.create_group("codecs")
    values = (RNG.integers(-4000, 4000, size=(40, 30)) / 8).astype("<f4")
    codecs = {
        "none": None,
        "gzip": numcodecs.GZip(level=5),
        "zlib": numcodecs.Zlib(level=5),
        "blosc_lz4_shuffle": numcodecs.Blosc(cname="lz4", clevel=5, shuffle=1),
        "blosc_lz4hc_noshuffle": numcodecs.Blosc(cname="lz4hc", clevel=5, shuffle=0),
        "blosc_blosclz_bitshuffle": numcodecs.Blosc(cname="blosclz", clevel=5, shuffle=2),
        "blosc_zstd": numcodecs.Blosc(cname="zstd", clevel=3, shuffle=1),
        "blosc_zlib": numcodecs.Blosc(cname="zlib", clevel=3, shuffle=2),
        "lz4": numcodecs.LZ4(),
        "zstd": numcodecs.Zstd(level=3),
    }
    for name, codec in codecs.items():
        a = c.create_array(name, shape=values.shape, dtype=values.dtype, chunks=(16, 12), compressors=codec)
        a[:] = values
    a = c.create_array("shuffle_zlib", shape=values.shape, dtype=values.dtype, chunks=(16, 12), compressors=numcodecs.Zlib(), filters=[numcodecs.Shuffle(elementsize=4)])
    a[:] = values
    a = c.create_array("bz2", shape=(5,), dtype="<i4", chunks=(5,), compressors=numcodecs.BZ2())
    a[:] = np.arange(5)
    big = np.arange(20000, dtype="<i4") % 1000
    c.create_array("blosc_multiblock", shape=big.shape, dtype=big.dtype, chunks=(20000,), compressors=numcodecs.Blosc(cname="lz4", clevel=5, shuffle=1, blocksize=16384))[:] = big

    lay = g.create_group("layout")
    grid = np.arange(35, dtype="<i2").reshape(7, 5)
    for order in "CF":
        for sep in ".":
            lay.create_array(f"order_{order}", shape=grid.shape, dtype=grid.dtype, chunks=(3, 2), order=order, compressors=None)[:] = grid
    lay.create_array("slash_separator", shape=grid.shape, dtype=grid.dtype, chunks=(3, 2), chunk_key_encoding={"name": "v2", "separator": "/"}, compressors=blosc)[:] = grid
    cube = np.arange(4 * 5 * 6, dtype="<f8").reshape(4, 5, 6)
    lay.create_array("cube_F_slash", shape=cube.shape, dtype=cube.dtype, chunks=(3, 2, 4), order="F", chunk_key_encoding={"name": "v2", "separator": "/"}, compressors=numcodecs.Zstd())[:] = cube
    s = lay.create_array("scalar", shape=(), dtype="<f8", compressors=None)
    s[...] = 3.25
    lay.create_array("empty", shape=(0,), dtype="<i4", chunks=(4,))
    lay.create_array("empty_columns", shape=(3, 0), dtype="<f4", chunks=(2, 2))

    f = g.create_group("fill")
    a = f.create_array("int_fill_7", shape=(10,), dtype="<i2", chunks=(3,), fill_value=7, compressors=blosc)
    a[0:3] = [1, 2, 3]
    a = f.create_array("nan_fill", shape=(4, 4), dtype="<f4", chunks=(2, 2), fill_value=np.nan, compressors=None)
    a[0:2, 0:2] = 1.0
    a = f.create_array("inf_fill", shape=(6,), dtype="<f8", chunks=(2,), fill_value=np.inf)
    a[2:4] = [5, 6]
    a = f.create_array("neg_inf_fill", shape=(6,), dtype="<f4", chunks=(2,), fill_value=-np.inf)
    a[0:2] = [1, 2]
    a = f.create_array("unicode_fill", shape=(5,), dtype="<U3", chunks=(2,), fill_value="xü")
    a[0:2] = ["ab", "c"]
    a = f.create_array("bytes_fill", shape=(5,), dtype="S4", chunks=(2,), fill_value=b"zz")
    a[0:2] = [b"ab", b"c"]
    a = f.create_array("struct_fill", shape=(5,), dtype=[("a", "<i4"), ("b", "<f4")], chunks=(2,), fill_value=np.array((3, 1.5), dtype=[("a", "<i4"), ("b", "<f4")])[()])
    a[0:2] = np.array([(1, 0.5), (2, 0.25)], dtype=[("a", "<i4"), ("b", "<f4")])
    a = f.create_array("all_absent", shape=(5,), dtype="<u1", chunks=(2,), fill_value=9)

    # Written by hand: things zarr-python 3 does not write.
    hand = g.create_group("hand")
    hand_dir = store / "hand"
    overrides = {}

    def write_v2(name, meta, chunks, attrs=None):
        directory = hand_dir / name
        directory.mkdir(parents=True)
        (directory / ".zarray").write_text(json.dumps({"zarr_format": 2, "order": "C", "filters": None, "compressor": None, "dimension_separator": ".", **meta}))
        (directory / ".zattrs").write_text(json.dumps(attrs or {}))
        for key, data in chunks.items():
            (directory / key).write_bytes(data)

    sub = np.array([(1, (0.5, 1.5)), (2, (2.5, 3.5)), (3, (4.5, 5.5))], dtype=[("id", "<i4"), ("xy", "<f4", (2,))])
    write_v2("struct_subarray", {"shape": [3], "chunks": [2], "dtype": [["id", "<i4"], ["xy", "<f4", [2]]], "fill_value": None},
             {"0": sub[:2].tobytes(), "1": np.concatenate([sub[2:], np.zeros(1, sub.dtype)]).tobytes()})
    overrides["/hand/struct_subarray"] = {"values": encode_values(sub), "fill": None, "numpy": str(sub.dtype.descr), "shape": [3], "chunks": [2]}
    write_v2("null_fill_complete", {"shape": [4], "chunks": [2], "dtype": "<i4", "fill_value": None},
             {"0": np.array([1, 2], "<i4").tobytes(), "1": np.array([3, 4], "<i4").tobytes()})
    write_v2("null_fill_absent", {"shape": [4], "chunks": [2], "dtype": "<i4", "fill_value": None},
             {"0": np.array([1, 2], "<i4").tobytes()})
    overrides["/hand/null_fill_absent"] = {"error": "undefined", "partial": {"selection": [[0, 2]], "values": [1, 2]}}
    write_v2("object_fill_zero", {"shape": [3], "chunks": [3], "dtype": "|O", "fill_value": 0, "filters": [{"id": "vlen-utf8"}]},
             {"0": numcodecs.VLenUTF8().encode(np.array(["a", "b", "c"], dtype=object))})
    write_v2("bool_invalid", {"shape": [3], "chunks": [3], "dtype": "|b1", "fill_value": False}, {"0": bytes([0, 1, 2])})
    overrides["/hand/bool_invalid"] = {"error": "boolean"}
    write_v2("bytes_invalid_utf8", {"shape": [2], "chunks": [2], "dtype": "|S2", "fill_value": ""}, {"0": b"ok\xff\xfe"})
    overrides["/hand/bytes_invalid_utf8"] = {"error": "UTF-8"}
    write_v2("unicode_surrogate", {"shape": [1], "chunks": [1], "dtype": "<U1", "fill_value": ""}, {"0": np.array([0xD800], "<u4").tobytes()})
    overrides["/hand/unicode_surrogate"] = {"error": "code point"}
    overrides["/codecs/bz2"] = {"error": "bz2"}
    # zarr-python 3 reads an object fill of 0 (as anndata < 0.8 wrote it) as
    # the string "0"; it means "no particular string", read as "".
    overrides["/hand/object_fill_zero"] = {"fill": ""}
    overrides["/dtypes/complex64"] = {"values": [v.tobytes().hex() for v in numeric["complex64"]], "fill": "0000000000000000"}

    consolidate_v2(store)
    write_expected(store, overrides)
    zip_store(store, base / "cases.zarr.zip", root_folder=True, compression=zipfile.ZIP_DEFLATED)


# ---------------------------------------------------------------------------
# Zarr v3 cases


def v3_cases(base: Path):
    store = fresh(base / "cases.zarr")
    g = zarr.open_group(str(store), mode="w", zarr_format=3)
    g.attrs.update({"title": "v3 cases", "big": -(2**63), "list": [[1, 2], [3, 4]]})
    zstd = ZstdCodec(level=3)

    d = g.create_group("dtypes")
    ints = np.array([0, 1, -1, 7, -128, 127, 42])
    plain = {
        "bool": np.array([True, False, True, True, False, False, True]),
        "int8": ints.astype("i1"), "uint8": np.array([0, 1, 255, 7, 128, 3, 42], "u1"),
        "int16": (ints * 300).astype("i2"), "uint16": np.arange(7, dtype="u2") * 9000,
        "int32": (ints * 70000).astype("i4"), "uint32": np.arange(7, dtype="u4") * 600000000,
        "int64": np.array([0, -1, 2**62, -(2**63), 2**63 - 1, 9007199254740993, 5], "i8"),
        "uint64": np.array([0, 1, 2**64 - 1, 2**63, 9007199254740993, 3, 4], "u8"),
        "float16": np.array([0, 1.5, -2.25, 65504, np.nan, np.inf, 6.1e-5], "f2"),
        "float32": np.array([0, 1.5, -2.25, 3.4e38, np.nan, np.inf, 1e-45], "f4"),
        "float64": np.array([0, 1.5, -2.25, 1.7e308, np.nan, np.inf, 5e-324], "f8"),
        "datetime": np.array(["2020-01-01", "1970-01-01", "NaT", "2262-04-11", "1677-09-22", "2000-02-29", "2026-10-22"], "datetime64[ns]"),
        "bytes6": np.array([b"abc", b"", b"abcdef", b"x\x00y", b"\xc3\xbc", b"z", b"q"], "S6"),
        "unicode": np.array(["ab", "", "üñí", "日本", "a\U0001F600", "z", "four"], "<U4"),
        "raw3": np.array([b"\x01\x02\x03", b"\x00\x00\x00", b"\xff\xfe\xfd", b"abc", b"\x00\x01\x00", b"xyz", b"\x10\x20\x30"], "V3"),
        "struct": np.array([(1, 1.5), (2, -2.5), (3, np.nan), (4, 0), (5, 1e10), (6, -0.0), (7, 7)], dtype=[("a", "<i4"), ("b", "<f8")]),
    }
    for name, values in plain.items():
        d.create_array(name, shape=values.shape, dtype=values.dtype, chunks=(3,), compressors=zstd)[:] = values
    for name in ["int16", "uint32", "int64", "float16", "float32", "float64"]:
        values = plain[name]
        d.create_array(f"{name}_big_endian", shape=values.shape, dtype=values.dtype, chunks=(3,), serializer=BytesCodec(endian="big"), compressors=zstd)[:] = values
    strings = ["", "a", "üñí", "日本語", "a\U0001F600b", "x" * 40, "last"]
    d.create_array("string", shape=(7,), dtype=str, chunks=(3,), compressors=zstd)[:] = np.array(strings, dtype=object)
    d.create_array("vlen_bytes", shape=(7,), dtype=VariableLengthBytes(), chunks=(3,), compressors=zstd)[:] = np.array([s.encode() for s in strings], dtype=object)

    c = g.create_group("codecs")
    values = (RNG.integers(-4000, 4000, size=(40, 30)) / 8).astype("<f4")
    chains = {
        "bytes_only": [],
        "gzip": [GzipCodec(level=5)],
        "zstd": [ZstdCodec(level=3)],
        "zstd_checksum": [ZstdCodec(level=19, checksum=True)],
        "crc32c": [Crc32cCodec()],
        "zstd_crc32c": [ZstdCodec(level=1), Crc32cCodec()],
        "blosc_lz4_shuffle": [BloscCodec(cname="lz4", clevel=5, shuffle="shuffle", typesize=4)],
        "blosc_lz4hc_noshuffle": [BloscCodec(cname="lz4hc", clevel=5, shuffle="noshuffle", typesize=4)],
        "blosc_blosclz_bitshuffle": [BloscCodec(cname="blosclz", clevel=5, shuffle="bitshuffle", typesize=4)],
        "blosc_zstd": [BloscCodec(cname="zstd", clevel=3, shuffle="shuffle", typesize=4)],
        "blosc_zlib": [BloscCodec(cname="zlib", clevel=3, shuffle="bitshuffle", typesize=4)],
        "numcodecs_lz4": [zarr.codecs.numcodecs.LZ4()],
        "numcodecs_zlib": [zarr.codecs.numcodecs.Zlib(level=4)],
        "numcodecs_shuffle_zstd": [zarr.codecs.numcodecs.Shuffle(elementsize=4), ZstdCodec()],
    }
    for name, chain in chains.items():
        c.create_array(name, shape=values.shape, dtype=values.dtype, chunks=(16, 12), compressors=chain)[:] = values
    c.create_array("transpose", shape=values.shape, dtype=values.dtype, chunks=(16, 12), filters=[TransposeCodec(order=(1, 0))], compressors=zstd)[:] = values
    c.create_array("transpose_big_endian", shape=values.shape, dtype=values.dtype, chunks=(16, 12), filters=[TransposeCodec(order=(1, 0))], serializer=BytesCodec(endian="big"), compressors=None)[:] = values
    cube = np.arange(4 * 5 * 6, dtype="<i4").reshape(4, 5, 6)
    c.create_array("transpose_3d", shape=cube.shape, dtype=cube.dtype, chunks=(3, 2, 4), filters=[TransposeCodec(order=(2, 0, 1))], compressors=zstd)[:] = cube
    c.create_array("bz2", shape=(5,), dtype="<i4", chunks=(5,), compressors=[zarr.codecs.numcodecs.BZ2()])[:] = np.arange(5)

    s = g.create_group("sharding")
    grid = np.arange(24 * 20, dtype="<i4").reshape(24, 20)
    s.create_array("end_index", shape=grid.shape, dtype=grid.dtype, chunks=(4, 5), shards=(8, 10), compressors=zstd)[:] = grid
    s.create_array("start_index", shape=grid.shape, dtype=grid.dtype, chunks=(8, 10),
                   serializer=ShardingCodec(chunk_shape=(4, 5), codecs=[BytesCodec(), GzipCodec()], index_location="start"), compressors=None)[:] = grid
    a = s.create_array("sparse_fill", shape=grid.shape, dtype=grid.dtype, chunks=(4, 5), shards=(8, 10), fill_value=-1, compressors=zstd)
    a[0:4, 0:5] = 1
    a[12:16, 5:10] = 2
    s.create_array("edge", shape=(23, 17), dtype="<f8", chunks=(4, 5), shards=(8, 10), compressors=zstd)[:] = np.arange(23 * 17, dtype="<f8").reshape(23, 17)
    s.create_array("strings", shape=(10,), dtype=str, chunks=(3,), shards=(6,), compressors=zstd)[:] = np.array([f"s{i}" * i for i in range(10)], dtype=object)
    s.create_array("transpose_inner", shape=grid.shape, dtype=grid.dtype, chunks=(8, 10),
                   serializer=ShardingCodec(chunk_shape=(4, 5), codecs=[TransposeCodec(order=(1, 0)), BytesCodec(endian="big"), ZstdCodec()]), compressors=None)[:] = grid

    k = g.create_group("keys")
    small = np.arange(35, dtype="<i2").reshape(7, 5)
    k.create_array("default_dot", shape=small.shape, dtype=small.dtype, chunks=(3, 2), chunk_key_encoding={"name": "default", "separator": "."}, compressors=zstd)[:] = small
    k.create_array("v2_dot", shape=small.shape, dtype=small.dtype, chunks=(3, 2), chunk_key_encoding={"name": "v2", "separator": "."}, compressors=zstd)[:] = small
    k.create_array("v2_slash", shape=small.shape, dtype=small.dtype, chunks=(3, 2), chunk_key_encoding={"name": "v2", "separator": "/"}, compressors=zstd)[:] = small

    lay = g.create_group("layout")
    sc = lay.create_array("scalar", shape=(), dtype="<f8", compressors=None)
    sc[...] = -7.5
    lay.create_array("empty", shape=(0,), dtype="<i4", chunks=(4,))
    lay.create_array("cube", shape=cube.shape, dtype=cube.dtype, chunks=(3, 2, 4), compressors=zstd)[:] = cube

    f = g.create_group("fill")
    a = f.create_array("int_fill_7", shape=(10,), dtype="<i2", chunks=(3,), fill_value=7, compressors=zstd)
    a[0:3] = [1, 2, 3]
    a = f.create_array("nan_fill", shape=(4, 4), dtype="<f4", chunks=(2, 2), fill_value=np.nan, compressors=zstd)
    a[0:2, 0:2] = 1.0
    a = f.create_array("hex_fill", shape=(4,), dtype="<f4", chunks=(2,), fill_value=0.0, compressors=zstd)
    a[0:2] = [5, 6]
    a = f.create_array("unicode_fill", shape=(5,), dtype="<U3", chunks=(2,), fill_value="xü", compressors=zstd)
    a[0:2] = ["ab", "c"]
    a = f.create_array("struct_fill", shape=(5,), dtype=[("a", "<i4"), ("b", "<f4")], chunks=(2,), fill_value=np.array((3, 1.5), dtype=[("a", "<i4"), ("b", "<f4")])[()], compressors=zstd)
    a[0:2] = np.array([(1, 0.5), (2, 0.25)], dtype=[("a", "<i4"), ("b", "<f4")])

    # A float fill written as a bit pattern, as the v3 specification allows.
    hex_json = store / "fill" / "hex_fill" / "zarr.json"
    meta = json.loads(hex_json.read_text())
    meta["fill_value"] = "0x3fc00000"
    hex_json.write_text(json.dumps(meta, indent=2))

    zarr.consolidate_metadata(str(store))
    overrides = {
        "/codecs/bz2": {"error": "bz2"},
    }
    write_expected(store, overrides)
    zip_store(store, base / "cases.zarr.zip", root_folder=False, compression=zipfile.ZIP_STORED)


# ---------------------------------------------------------------------------
# AnnData stores


def anndata_object():
    import anndata as ad
    import pandas as pd
    import scipy.sparse as sp

    n_obs, n_vars = 60, 25
    rng = np.random.default_rng(7)
    counts = rng.poisson(0.6, size=(n_obs, n_vars)).astype("float32")
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical(rng.choice(["T cell", "B cell", "NK", "Mono"], n_obs)),
            "n_genes": rng.integers(100, 5000, n_obs).astype("int64"),
            "score": rng.normal(size=n_obs).astype("float32"),
            "is_doublet": rng.random(n_obs) < 0.1,
            "batch": pd.array(rng.integers(0, 3, n_obs), dtype="Int32"),
            "flag": pd.array(np.where(rng.random(n_obs) < 0.2, None, rng.random(n_obs) < 0.5), dtype="boolean"),
            "label": [f"cell-ü-{i}" for i in range(n_obs)],
        },
        index=[f"cell_{i}" for i in range(n_obs)],
    )
    obs.loc[obs.index[3], "batch"] = pd.NA
    var = pd.DataFrame({"gene_ids": [f"ENSG{i:05d}" for i in range(n_vars)], "highly_variable": rng.random(n_vars) < 0.3},
                       index=[f"Gene{i}" for i in range(n_vars)])
    adata = ad.AnnData(X=sp.csr_matrix(counts), obs=obs, var=var)
    adata.layers["dense"] = counts.astype("int32")
    adata.layers["csc"] = sp.csc_matrix(counts)
    adata.obsm["X_umap"] = rng.normal(size=(n_obs, 2)).astype("float32")
    adata.obsm["X_pca"] = rng.normal(size=(n_obs, 5))
    adata.obsp["connectivities"] = sp.random(n_obs, n_obs, density=0.05, format="csr", random_state=1, dtype="float32")
    adata.uns["title"] = "conformance"
    adata.uns["params"] = {"n_neighbors": 15, "metric": "cosine", "big": 2**62, "ratio": 0.5}
    adata.uns["colors"] = np.array(["#ff0000", "#00ff00", "#0000ff", "#123456"], dtype=object)
    adata.uns["values"] = np.arange(6, dtype="float64").reshape(2, 3)
    return adata


def anndata_stores(base: Path):
    import anndata as ad

    adata = anndata_object()
    for label, fmt, shard in [("v2", 2, False), ("v3", 3, False), ("v3-sharded", 3, True)]:
        store = fresh(base / f"{label}.zarr")
        with ad.settings.override(zarr_write_format=fmt, auto_shard_zarr_v3=shard, allow_write_nullable_strings=False):
            adata.write_zarr(str(store))
        write_expected(store)
        zip_store(store, base / f"{label}.zarr.zip", root_folder=fmt == 2, compression=zipfile.ZIP_STORED)


def main():
    print(f"zarr {zarr.__version__}, numcodecs {numcodecs.__version__}, numpy {np.__version__}")
    for directory in ["v2", "v3", "anndata"]:
        fresh(ROOT / directory).mkdir(parents=True)
    v2_cases(ROOT / "v2")
    v3_cases(ROOT / "v3")
    anndata_stores(ROOT / "anndata")
    # The folders were zipped; only the archives are kept.
    for store in sorted(ROOT.glob("*/*.zarr")):
        shutil.rmtree(store)
    total = sum(p.stat().st_size for p in ROOT.rglob("*") if p.is_file())
    count = sum(1 for p in ROOT.rglob("*") if p.is_file())
    print(f"wrote {count} files, {total / 1024:.0f} KiB under {ROOT}")


if __name__ == "__main__":
    sys.exit(main())
