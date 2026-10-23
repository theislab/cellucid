"""Write the HDF5 files the browser's HDF5 reader is checked against.

Each file exercises one part of the format that a real `.h5ad` may use, as
written by the HDF5 library itself (through h5py), so the bytes are the
library's own rather than an imitation. `tests/hdf5-reader-conformance.test.mjs`
reads every object of every file with the reader and with h5wasm (the HDF5 C
library compiled to WebAssembly) and requires the same answer.

    python scripts/generate-hdf5-conformance-corpus.py

The output is deterministic for a given h5py/HDF5 build: no timestamps are
stored (track_times=False) and every value comes from fixed seeds.

Where h5wasm cannot answer (half floats; filters it does not bundle), the
values h5py wrote are recorded in `expected-values.json` instead. Features
h5py has no Python API for (shared object header messages, non-default
B-tree 'K' values, the N-bit filter) are set through the HDF5 library h5py
itself loads, with ctypes.
"""

from __future__ import annotations

import contextlib
import ctypes
import json
import math
from pathlib import Path

import h5py
import numpy as np

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CORPUS = REPOSITORY_ROOT / "tests" / "fixtures" / "hdf5"


def hdf5_library() -> ctypes.CDLL:
    """The HDF5 C library h5py is linked against (for settings h5py does not expose)."""
    directory = Path(h5py.__file__).parent
    candidates = sorted(p for p in [*directory.glob(".dylibs/libhdf5.*"), *directory.parent.glob("h5py.libs/libhdf5-*"),
                                    *directory.parent.glob("h5py.libs/libhdf5.*")] if "_hl" not in p.name)
    if not candidates:
        raise SystemExit("Cannot find the HDF5 library bundled with h5py.")
    return ctypes.CDLL(str(candidates[0]))


def json_number(value: float) -> float | str:
    """A float for JSON, with the values JSON cannot hold spelled out."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0 and math.copysign(1, value) < 0:
        return "-0"
    return value


def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def dataset(group, name, data=None, **options):
    options.setdefault("track_times", False)
    return group.create_dataset(name, data=data, **options)


EXPECTED: dict[str, list] = {}


def numeric_kinds(group, *, chunks=None, compression=None, shuffle=False, fletcher32=False, prefix=""):
    """One dataset per numeric dtype (both byte orders) under one storage.

    Every call draws the same values (seed 1), so the same dataset name holds
    the same values in every group whatever its storage.
    """
    r = rng(1)
    for dtype in ("<i1", "<i2", "<i4", "<i8", "<u1", "<u2", "<u4", "<u8", "<f2", "<f4", "<f8",
                  ">i2", ">i4", ">i8", ">u4", ">f4", ">f8"):
        if dtype.endswith(("f2", "f4", "f8")):
            values = (r.standard_normal(1000) * 1000).astype(dtype)
            values[3] = np.nan
            values[4] = np.inf
            values[5] = -np.inf
            values[6] = -0.0
            if dtype == "<f2":
                EXPECTED["numeric/le_f2"] = [json_number(float(v)) for v in values]
        else:
            info = np.iinfo(np.dtype(dtype))
            values = r.integers(info.min, info.max, 1000, dtype=np.dtype(dtype).newbyteorder("="), endpoint=True)
            values[0], values[1] = info.min, info.max
            values = values.astype(dtype)
        dataset(group, f"{prefix}{dtype.replace('<', 'le_').replace('>', 'be_')}", values,
                chunks=chunks, compression=compression, shuffle=shuffle, fletcher32=fletcher32)


def text_kinds(group):
    words = ["", "a", "B cell", "naïve T", "日本語", "x" * 300, "end"]
    strings = np.array(words * 20, dtype=object)
    dataset(group, "vlen_utf8", strings, dtype=h5py.string_dtype("utf-8"))
    dataset(group, "vlen_ascii", np.array(["a", "bb", "", "ccc"] * 25, dtype=object), dtype=h5py.string_dtype("ascii"))
    dataset(group, "vlen_utf8_chunked_gzip", strings, dtype=h5py.string_dtype("utf-8"), chunks=(16,), compression="gzip")
    dataset(group, "fixed_ascii", np.array([b"abc", b"", b"abcdefgh", b"z"] * 10, dtype="S8"))
    utf8 = h5py.h5t.C_S1.copy()
    utf8.set_size(9)
    utf8.set_cset(h5py.h5t.CSET_UTF8)
    h5py.h5d.create(group.id, b"fixed_utf8", utf8, h5py.h5s.create_simple((30,))).write(
        h5py.h5s.ALL, h5py.h5s.ALL, np.array([s.encode() for s in ("é", "ab", "日本")] * 10, dtype="S9"), mtype=utf8)
    dataset(group, "vlen_utf8_scalar", "a scalar title", dtype=h5py.string_dtype("utf-8"))
    dataset(group, "fixed_scalar", np.bytes_(b"fixed"))


def compound_kinds(group):
    simple = np.dtype([("x", "<f4"), ("y", "<f4"), ("label", "S6"), ("n", "<i8")])
    rows = np.zeros(50, dtype=simple)
    rows["x"] = np.arange(50) / 3
    rows["y"] = -np.arange(50)
    rows["label"] = [f"r{i}".encode() for i in range(50)]
    rows["n"] = np.arange(50) * 10**12
    dataset(group, "compound", rows)
    with_array = np.dtype([("embedding", "<f4", (3,)), ("code", "<u1"), ("name", h5py.string_dtype("utf-8"))])
    rows = np.zeros(20, dtype=with_array)
    rows["embedding"] = np.arange(60, dtype="<f4").reshape(20, 3)
    rows["code"] = np.arange(20) % 7
    rows["name"] = [f"cell-{i}" for i in range(20)]
    dataset(group, "compound_array_vlen", rows)
    dataset(group, "compound_chunked_gzip", rows, chunks=(7,), compression="gzip")


def enum_kinds(group):
    boolean = h5py.enum_dtype({"FALSE": 0, "TRUE": 1}, basetype="i1")
    dataset(group, "bool_enum", (np.arange(100) % 3 == 0).astype("i1"), dtype=boolean)
    dataset(group, "numpy_bool", np.arange(100) % 4 == 0)
    colours = h5py.enum_dtype({"red": 0, "green": 5, "blue": 200}, basetype="u1")
    dataset(group, "enum_u1", np.array([0, 5, 200, 5] * 10, dtype="u1"), dtype=colours)
    dataset(group, "bool_scalar", np.bool_(True))


def opaque_and_references(group, f):
    dataset(group, "opaque", np.frombuffer(bytes(range(40)), dtype="V4"))
    refs = dataset(group, "object_references", shape=(3,), dtype=h5py.ref_dtype)
    refs[0] = f.ref
    refs[1] = f["nested"].ref
    refs[2] = f["nested/deeper/deepest/leaf"].ref


def links_and_names(f):
    """Soft links (absolute, relative, dangling), a hard-link cycle, UTF-8 names, committed types."""
    f["dangling"] = h5py.SoftLink("/nowhere/at/all")
    f["nested/relative_link"] = h5py.SoftLink("deeper/deepest/leaf")
    f["soft_to_group"] = h5py.SoftLink("/nested/deeper")
    cycle = f.create_group("cycle")
    cycle.create_group("a")
    cycle["a/up"] = cycle
    names = f.create_group("naïve")
    dataset(names, "日本語", np.arange(4, dtype="<i2"))
    names.attrs["größe"] = "ü"
    f["named_float"] = np.dtype("<f4")
    named = f.create_dataset("uses_named_type", data=np.arange(6, dtype="<f4"), dtype=f["named_float"], track_times=False)
    named.attrs.create("named_attribute", np.arange(3, dtype="<f4"), dtype=f["named_float"])


def array_kinds(group):
    array_type = h5py.h5t.array_create(h5py.h5t.STD_I32LE, (2, 3))
    h5py.h5d.create(group.id, b"array_dtype", array_type, h5py.h5s.create_simple((4,))).write(
        h5py.h5s.ALL, h5py.h5s.ALL, np.arange(24, dtype="<i4"), mtype=array_type)
    dataset(group, "vlen_int", np.array([np.arange(n, dtype="<i4") for n in (0, 1, 5, 2)], dtype=object),
            dtype=h5py.vlen_dtype(np.dtype("<i4")))


def shapes(group):
    dataset(group, "scalar_f8", np.float64(2.5))
    dataset(group, "scalar_i8", np.int64(-7))
    dataset(group, "empty_1d", np.zeros(0, dtype="<f4"))
    dataset(group, "empty_2d_chunked", np.zeros((0, 4), dtype="<f4"), chunks=(8, 4), maxshape=(None, 4))
    dataset(group, "null_space", shape=None, dtype="<f4")
    r = rng(2)
    dataset(group, "dense_2d", r.standard_normal((37, 11)).astype("<f4"))
    dataset(group, "dense_2d_chunked_edges", r.standard_normal((101, 23)).astype("<f4"), chunks=(10, 4), compression="gzip")
    dataset(group, "dense_2d_row_chunks", r.standard_normal((64, 9)).astype("<f8"), chunks=(16, 9), compression="gzip", shuffle=True)
    dataset(group, "dense_3d", r.integers(0, 100, (5, 6, 7)).astype("<i2"), chunks=(2, 3, 4))


def fill_values(group):
    sparse = dataset(group, "unwritten_chunks_fill", shape=(100,), dtype="<f4", chunks=(10,), fillvalue=-1.5)
    sparse[20:30] = np.arange(10, dtype="<f4")
    dataset(group, "unwritten_contiguous", shape=(10,), dtype="<i4", fillvalue=7)
    unwritten = dataset(group, "unwritten_default_fill", shape=(30,), dtype="<u2", chunks=(8,))
    unwritten[0:3] = [1, 2, 3]


def attributes(node, *, many=False, huge=False):
    node.attrs["encoding-type"] = "csr_matrix"
    node.attrs["encoding-version"] = "0.1.0"
    node.attrs["shape"] = np.array([10, 20], dtype="<i8")
    node.attrs["scalar_float"] = np.float32(1.25)
    node.attrs["fixed_bytes"] = np.bytes_(b"bytes")
    node.attrs["vlen_list"] = np.array(["obs", "var", "naïve"], dtype=h5py.string_dtype("utf-8"))
    node.attrs["bool"] = np.bool_(False)
    node.attrs["empty_list"] = np.array([], dtype=h5py.string_dtype("utf-8"))
    node.attrs.create("ordered", True, dtype=h5py.enum_dtype({"FALSE": 0, "TRUE": 1}, basetype="i1"))
    if many:
        for i in range(30):
            node.attrs[f"attr_{i:02d}"] = i
    if huge:
        node.attrs["column-order"] = np.array([f"column_{i:05d}" for i in range(9000)], dtype=h5py.string_dtype("utf-8"))
        node.attrs["huge_numeric"] = np.arange(40000, dtype="<f8")


def write_layout_family(f):
    """Groups, attributes and every storage the library writes by default."""
    groups = f.create_group("groups")
    for i in range(300):
        groups.create_group(f"g{i:03d}")
    groups["g000"].attrs["marker"] = 1
    nested = f.create_group("nested/deeper/deepest")
    dataset(nested, "leaf", np.arange(5))
    f["soft_link"] = h5py.SoftLink("/nested/deeper/deepest/leaf")
    f["hard_link"] = nested["leaf"]
    attributes(f)
    numeric_kinds(f.create_group("contiguous"))
    numeric_kinds(f.create_group("chunked"), chunks=(64,))
    numeric_kinds(f.create_group("gzip"), chunks=(100,), compression="gzip")
    numeric_kinds(f.create_group("gzip_shuffle"), chunks=(128,), compression="gzip", shuffle=True)
    numeric_kinds(f.create_group("fletcher32"), chunks=(256,), fletcher32=True, compression="gzip")
    numeric_kinds(f.create_group("lzf"), chunks=(200,), compression="lzf", shuffle=True)
    compact = f.create_group("compact_layout")
    space = h5py.h5s.create_simple((6,))
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_layout(h5py.h5d.COMPACT)
    h5py.h5d.create(compact.id, b"compact_i4", h5py.h5t.STD_I32LE, space, dcpl).write(
        h5py.h5s.ALL, h5py.h5s.ALL, np.arange(6, dtype="<i4"))
    many_chunks = f.create_group("many_chunks")
    dataset(many_chunks, "btree_levels", np.arange(20000, dtype="<i2"), chunks=(4,))
    dataset(many_chunks, "btree_levels_gzip", np.arange(20000, dtype="<i4") * 3, chunks=(4,), compression="gzip")
    text_kinds(f.create_group("text"))
    compound_kinds(f.create_group("compound"))
    enum_kinds(f.create_group("enum"))
    array_kinds(f.create_group("array"))
    shapes(f.create_group("shapes"))
    fill_values(f.create_group("fill"))
    with_attrs = dataset(f, "with_many_attributes", np.arange(3))
    attributes(with_attrs, many=True)
    opaque_and_references(f.create_group("opaque"), f)
    links_and_names(f)


def write_latest_family(f, *, paged_extensible=False):
    """The latest format: new-style groups, dense storage, every chunk index."""
    compact = f.create_group("compact_links")
    for i in range(5):
        dataset(compact, f"d{i}", np.arange(i + 1))
    dense = f.create_group("dense_links")
    for i in range(2500):
        dense.create_group(f"member_{i:04d}")
    tracked = f.create_group("tracked_order", track_order=True)
    for name in ("zeta", "alpha", "mid", "beta"):
        dataset(tracked, name, np.arange(2))
    tracked_dense = f.create_group("tracked_order_dense", track_order=True)
    for i in range(40):
        tracked_dense.create_group(f"t{39 - i:02d}")
    attributes(f, many=True, huge=True)
    with_attrs = dataset(f, "dense_attributes", np.arange(3))
    attributes(with_attrs, many=True, huge=True)
    numeric_kinds(f.create_group("contiguous"))
    numeric_kinds(f.create_group("gzip"), chunks=(100,), compression="gzip")
    index = f.create_group("chunk_index")
    r = rng(3)
    values = r.standard_normal(60000).astype("<f4")
    # Single chunk: chunk = current = maximum shape.
    dataset(index, "single_chunk", values[:500], chunks=(500,))
    dataset(index, "single_chunk_gzip", values[:500], chunks=(500,), compression="gzip")
    # Implicit: early allocation, no filter, fixed maximum shape.
    space = h5py.h5s.create_simple((1000,))
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_chunk((64,))
    dcpl.set_alloc_time(h5py.h5d.ALLOC_TIME_EARLY)
    h5py.h5d.create(index.id, b"implicit", h5py.h5t.IEEE_F32LE, space, dcpl).write(
        h5py.h5s.ALL, h5py.h5s.ALL, values[:1000])
    # Fixed array: fixed maximum shape, unpaged and paged (> 1024 chunks).
    dataset(index, "fixed_array", values[:4000], chunks=(100,))
    dataset(index, "fixed_array_gzip", values[:4000], chunks=(100,), compression="gzip")
    if paged_extensible:
        dataset(index, "fixed_array_paged", values[:30000], chunks=(8,), compression="gzip")
    dataset(index, "fixed_array_2d", r.integers(0, 1000, (300, 50)).astype("<i4"), chunks=(7, 6))
    # Extensible array: one unlimited dimension.
    dataset(index, "extensible_array", values[:3000], chunks=(100,), maxshape=(None,))
    # Many super blocks, filtered entries (in the older format: a deep chunk B-tree).
    dataset(index, "extensible_array_gzip", values[:12000] if not paged_extensible else values, chunks=(4,), maxshape=(None,), compression="gzip")
    dataset(index, "extensible_array_2d", r.standard_normal((500, 12)).astype("<f8"), chunks=(9, 5), maxshape=(None, 12), compression="gzip", shuffle=True)
    # Version 2 B-tree: more than one unlimited dimension.
    dataset(index, "btree_v2", r.integers(0, 50, (400, 60)).astype("<i2"), chunks=(9, 7), maxshape=(None, None))
    dataset(index, "btree_v2_gzip", r.standard_normal((300, 40)).astype("<f4"), chunks=(5, 5), maxshape=(None, None), compression="gzip")
    partial = dataset(index, "extensible_unwritten", shape=(1000,), dtype="<i4", chunks=(50,), maxshape=(None,), fillvalue=-9)
    partial[100:160] = np.arange(60)
    partial2 = dataset(index, "btree_v2_unwritten", shape=(100, 100), dtype="<f4", chunks=(10, 10), maxshape=(None, None), fillvalue=0.5)
    partial2[10:30, 40:60] = 1.0
    # Unlimited second dimension: entries are numbered with it slowest.
    dataset(index, "extensible_array_last_unlimited", r.integers(0, 9, (13, 40)).astype("<i4"), chunks=(4, 6), maxshape=(13, None))
    if paged_extensible:
        # Data blocks are paged past 1024 entries, which the default geometry
        # reaches beyond 131,076 chunks: one-byte chunks keep this small. The
        # last data block is written in part, so some pages stay unwritten.
        paged = dataset(index, "extensible_array_paged", shape=(140_000,), dtype="<u1", chunks=(1,), maxshape=(None,), fillvalue=7)
        values = (np.arange(140_000) % 251).astype("<u1")
        paged[:132_000] = values[:132_000]
        paged[135_000:136_000] = values[135_000:136_000]
    text_kinds(f.create_group("text"))
    compound_kinds(f.create_group("compound"))
    enum_kinds(f.create_group("enum"))
    shapes(f.create_group("shapes"))


def create_file(path: Path, *, libver, shared_messages=False, chunk_k=None, group_k=None) -> h5py.File:
    """A new file with file-creation settings h5py has no keyword for."""
    lib = hdf5_library()
    fcpl = h5py.h5p.create(h5py.h5p.FILE_CREATE)
    if shared_messages:
        # One index for every shareable message type, sharing from 8 bytes.
        assert lib.H5Pset_shared_mesg_nindexes(ctypes.c_int64(fcpl.id), ctypes.c_uint(1)) >= 0
        assert lib.H5Pset_shared_mesg_index(ctypes.c_int64(fcpl.id), ctypes.c_uint(0), ctypes.c_uint(0x1F), ctypes.c_uint(8)) >= 0
    if chunk_k is not None:
        assert lib.H5Pset_istore_k(ctypes.c_int64(fcpl.id), ctypes.c_uint(chunk_k)) >= 0
    if group_k is not None:
        assert lib.H5Pset_sym_k(ctypes.c_int64(fcpl.id), ctypes.c_uint(group_k[0]), ctypes.c_uint(group_k[1])) >= 0
    fapl = h5py.h5p.create(h5py.h5p.FILE_ACCESS)
    fapl.set_libver_bounds(*libver)
    return h5py.File(h5py.h5f.create(bytes(path), h5py.h5f.ACC_TRUNC, fcpl=fcpl, fapl=fapl))


def write_shared_messages(f):
    """Messages stored once in the shared message heap and referenced from many headers."""
    for i in range(6):
        d = dataset(f, f"same_type_{i}", np.arange(40, dtype=">f8") * i, chunks=(8,), compression="gzip")
        d.attrs["shared_text"] = "an attribute every dataset carries"
        d.attrs["shared_numbers"] = np.arange(12, dtype="<i4")
    many = dataset(f, "chunk_tree", np.arange(3000, dtype="<i4"), chunks=(2,))
    many.attrs["note"] = "1500 chunks under a B-tree with K = 8"
    group = f.create_group("group")
    for i in range(12):
        group.create_group(f"child_{i:02d}").attrs["shared_text"] = "an attribute every dataset carries"


def write_btree_k(f):
    """Non-default 'K' values in the superblock (version 1): small, deep B-trees."""
    group = f.create_group("many_links")
    for i in range(200):
        group.create_group(f"link_{i:03d}")
    dataset(f, "chunk_tree", np.arange(4000, dtype="<f4"), chunks=(3,))


def write_unsupported(f, directory: Path):
    """Features the reader refuses, each only when the object is read."""
    lib = hdf5_library()
    f["elsewhere"] = h5py.ExternalLink("default-format.h5", "/contiguous/le_i4")
    dataset(f, "present", np.arange(3))
    source = dataset(f, "vds_source", np.arange(20, dtype="<i4"))
    layout = h5py.VirtualLayout(shape=(20,), dtype="<i4")
    layout[:] = h5py.VirtualSource(source)
    f.create_virtual_dataset("virtual", layout, fillvalue=-1)
    dataset(f, "scaleoffset", np.arange(100, dtype="<i4"), chunks=(10,), scaleoffset=0)
    space = h5py.h5s.create_simple((100,))
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_chunk((10,))
    assert lib.H5Pset_nbit(ctypes.c_int64(dcpl.id)) >= 0
    h5py.h5d.create(f.id, b"nbit", h5py.h5t.STD_I32LE, space, dcpl).write(
        h5py.h5s.ALL, h5py.h5s.ALL, np.arange(100, dtype="<i4"))
    # HDF5 resolves the external file against the working directory.
    with contextlib.chdir(directory):
        dataset(f, "external_storage", np.arange(10, dtype="<i4"), external=[("unsupported-features-external.bin", 0, 40)])


def main() -> None:
    CORPUS.mkdir(parents=True, exist_ok=True)
    with h5py.File(CORPUS / "default-format.h5", "w", track_order=False) as f:
        write_layout_family(f)
    with h5py.File(CORPUS / "latest-format.h5", "w", libver="latest") as f:
        write_latest_family(f, paged_extensible=True)
    with h5py.File(CORPUS / "v18-format.h5", "w", libver=("v108", "v108")) as f:
        write_latest_family(f)
    with h5py.File(CORPUS / "userblock.h5", "w", userblock_size=512) as f:
        dataset(f, "after_userblock", np.arange(10))
        attributes(f)
    with create_file(CORPUS / "shared-messages.h5", libver=(h5py.h5f.LIBVER_V18, h5py.h5f.LIBVER_V18),
                     shared_messages=True, chunk_k=8, group_k=(4, 2)) as f:
        write_shared_messages(f)
    with create_file(CORPUS / "btree-k.h5", libver=(h5py.h5f.LIBVER_EARLIEST, h5py.h5f.LIBVER_V18),
                     chunk_k=4, group_k=(2, 2)) as f:
        write_btree_k(f)
    (CORPUS / "external-link.h5").unlink(missing_ok=True)
    with h5py.File(CORPUS / "unsupported-features.h5", "w", libver="latest") as f:
        write_unsupported(f, CORPUS)
    (CORPUS / "expected-values.json").write_text(json.dumps(EXPECTED, indent=0) + "\n")
    for path in sorted(CORPUS.iterdir()):
        print(f"{path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
