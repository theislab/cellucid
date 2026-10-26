"""Write the corpus files of one anndata release, with the expected values of each.

Runs inside one writer environment (see generate.py, which sets them up and
calls this script with each). Every file is written by that environment's own
anndata; the expected values are computed from the file as the same anndata
reads it straight back (corpus_expected.expected_document).

    <venv>/bin/python write_corpus.py <fixtures/anndata>

Variants anndata refuses to write are recorded, with the error, in
``<writer>/_writer.json`` instead of failing the run.
"""

from __future__ import annotations

import gzip
import json
import re
import shutil
import sys
import time
import traceback
import warnings
from contextlib import contextmanager
from pathlib import Path

import anndata
import numpy as np
import pandas as pd
from scipy import sparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corpus_expected as ce  # noqa: E402

warnings.simplefilter("ignore")


class _ZeroClock:
    """gzip streams (numcodecs GZip, zarr v3 gzip) carry a modification time; pin it to 0 so every run
    writes the same bytes."""

    def __getattr__(self, name):
        return getattr(time, name)

    @staticmethod
    def time():
        return 0.0


gzip.time = _ZeroClock()

ANNDATA_VERSION = anndata.__version__
V = tuple(int(x) for x in re.match(r"(\d+)\.(\d+)", ANNDATA_VERSION).groups())
LATEST = V >= (0, 12)
WRITER = "anndata-" + ANNDATA_VERSION
ALL_FORMATS = ("h5ad", "zarr2", "zarr3") if LATEST else ("h5ad", "zarr2")
FILE_SUFFIX = {"h5ad": ".h5ad", "zarr2": ".v2.zarr", "zarr3": ".v3.zarr"}


def package_versions() -> dict:
    out = {"python": "%d.%d.%d" % sys.version_info[:3]}
    for name in ("anndata", "numpy", "pandas", "scipy", "h5py", "zarr", "numcodecs"):
        try:
            module = __import__(name)
            out[name] = module.__version__
        except Exception:  # noqa: BLE001
            out[name] = None
    return out


# ================================================================ data helpers


def rng(seed):
    return np.random.default_rng(seed)


def names(prefix, n):
    return ["%s-%03d" % (prefix, i) for i in range(n)]


def small_obs(n_obs, seed=1):
    r = rng(seed)
    return pd.DataFrame(
        {
            "cell_type": pd.Categorical(np.array(["B", "T", "NK"])[np.arange(n_obs) % 3], categories=["B", "NK", "T"]),
            "score": quantized(r, n_obs, 1.0).astype(np.float32),
        },
        index=names("cell", n_obs),
    )


def small_var(n_vars, seed=2):
    return pd.DataFrame(
        {"gene_symbol": ["G%d" % i for i in range(n_vars)], "highly_variable": np.arange(n_vars) % 2 == 0},
        index=names("gene", n_vars),
    )


def quantized(r, shape, scale=10.0):
    """Random multiples of 1/16 in [0, scale): exact in float16/32/64 and short in JSON."""
    return np.floor(r.random(shape) * scale * 16) / 16


def float_matrix(n_obs, n_vars, seed, dtype=np.float32, density=0.4):
    """Random multiples of 1/16 with ~60% zeros, row 5 and column 3 all zero."""
    r = rng(seed)
    values = quantized(r, (n_obs, n_vars)) * (r.random((n_obs, n_vars)) < density)
    if n_obs > 5:
        values[5, :] = 0
    if n_vars > 3:
        values[:, 3] = 0
    return values.astype(dtype)


def int_matrix(n_obs, n_vars, seed, dtype, low=1, high=10, density=0.4):
    r = rng(seed)
    values = r.integers(low, high, size=(n_obs, n_vars)) * (r.random((n_obs, n_vars)) < density)
    if n_obs > 5:
        values[5, :] = 0
    if n_vars > 3:
        values[:, 3] = 0
    return values.astype(dtype)


def make(X=None, obs=None, var=None, **kw):
    """AnnData with the given parts, keeping X's dtype on writers whose default casts to float32."""
    kw = {k: v for k, v in kw.items() if v is not None}
    raw = kw.pop("raw", None)
    if V < (0, 7) and ("obsp" in kw or "varp" in kw):
        raise RuntimeError("anndata %s does not support obsp/varp (added in 0.7)" % ANNDATA_VERSION)
    if V < (0, 8) and X is not None:
        kw["dtype"] = X.dtype
    adata = anndata.AnnData(X=X, obs=obs, var=var, **kw)
    if raw is not None:
        adata.raw = raw
    return adata


def default_adata(X, n_obs=None, n_vars=None, **kw):
    n_obs = X.shape[0] if X is not None else n_obs
    n_vars = X.shape[1] if X is not None else n_vars
    kw.setdefault("uns", {"title": "corpus"})
    kw.setdefault("obs", small_obs(n_obs))
    kw.setdefault("var", small_var(n_vars))
    return make(X=X, **kw)


def messy_sparse(fmt, n_obs=60, n_vars=20, seed=11, unsorted=False, duplicates=False, explicit_zeros=False,
                 empty_edges=False, dtype=np.float32):
    """A CSR/CSC matrix with the requested irregularities, built from (data, indices, indptr) directly."""
    dense = np.round(float_matrix(n_obs, n_vars, seed, np.float64)) + 0.0
    if empty_edges:
        dense[0, :] = 0
        dense[-1, :] = 0
        dense[:, 0] = 0
        dense[:, -1] = 0
    major = dense if fmt == "csr" else dense.T
    data, indices, indptr = [], [], [0]
    for row in major:
        entries = [(j, row[j]) for j in np.flatnonzero(row)]
        if duplicates:
            split = []
            for j, value in entries:
                if value >= 2:
                    half = float(np.floor(value / 2))
                    split.append((j, half))
                    split.append((j, value - half))
                else:
                    split.append((j, value))
            entries = split
            if len(entries) > 2:
                # one non-adjacent duplicate too
                j, value = entries[0]
                entries[0] = (j, value - 1.0) if value >= 2 else (j, value)
                if value >= 2:
                    entries.append((j, 1.0))
        if explicit_zeros:
            zeros = [j for j in range(major.shape[1]) if row[j] == 0][:2]
            entries += [(j, 0.0) for j in zeros]
        if unsorted:
            entries = entries[::-1]
        for j, value in entries:
            indices.append(j)
            data.append(value)
        indptr.append(len(indices))
    cls = sparse.csr_matrix if fmt == "csr" else sparse.csc_matrix
    return cls((np.asarray(data, dtype=dtype), np.asarray(indices, dtype=np.int32),
                np.asarray(indptr, dtype=np.int32)), shape=dense.shape)


def special_floats64():
    return np.array([np.nan, np.inf, -np.inf, -0.0, 1e40, -1e40, 5e-324, 1e-310, 1.7976931348623157e308,
                     -1.7976931348623157e308, 1.0, 0.1], dtype=np.float64)


def special_floats32():
    f32 = np.finfo(np.float32)
    return np.array([np.nan, np.inf, -np.inf, -0.0, f32.max, -f32.max, 1e-45, f32.tiny, 1.0, 0.1], dtype=np.float32)


def special_floats16():
    return np.array([65504, -65504, 5.960464477539063e-08, 6.103515625e-05, np.nan, np.inf, -np.inf, -0.0,
                     1.0, 0.0999755859375], dtype=np.float16)


def with_specials(matrix, specials):
    out = matrix.copy()
    flat = out.reshape(-1)
    positions = np.linspace(0, flat.size - 1, specials.size).astype(int)
    flat[positions] = specials
    return out


# ================================================================ variants


class Variant:
    def __init__(self, name, build, description, covers, formats=None, reader=None,
                 settings=None, write_kwargs=None, x_kwargs=None):
        self.name = name
        self.build = build
        self.description = description
        self.covers = covers
        self.formats = formats or ("h5ad", "zarr2", "zarr3")
        self.reader = reader or {"expect": "read"}
        self.settings = settings or {}
        self.write_kwargs = write_kwargs or {}
        # format -> dataset_kwargs for X, written with anndata's write_elem after the rest of the file
        self.x_kwargs = x_kwargs


VARIANTS = []


def variant(*args, **kwargs):
    def register(build):
        VARIANTS.append(Variant(kwargs.pop("name", build.__name__), build, *args, **kwargs))
        return build
    return register


# ---------------------------------------------------------------- realistic


@variant("Scanpy-style object: CSR X, counts layer, raw with more genes, embeddings, graphs, rank_genes_groups.",
         ["X:csr", "layers", "raw", "obsm", "varm", "obsp", "uns", "categorical", "ordered-categorical"])
def scanpy_like():
    n_obs, n_vars, n_raw = 80, 30, 45
    r = rng(7)
    raw_counts = int_matrix(n_obs, n_raw, 8, np.float32, 1, 30)
    raw_var = pd.DataFrame(
        {"gene_ids": ["ENSG%011d" % i for i in range(n_raw)], "feature_types": pd.Categorical(["Gene Expression"] * n_raw),
         "n_cells": np.count_nonzero(raw_counts, axis=0).astype(np.int64)},
        index=["GENE%d" % i for i in range(n_raw)],
    )
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical(np.array(["B cell", "T cell", "Monocyte"])[np.arange(n_obs) % 3],
                                        categories=["B cell", "Monocyte", "T cell"]),
            "batch": pd.Categorical(np.where(np.arange(n_obs) % 10 == 0, None, np.array(["a", "b"])[np.arange(n_obs) % 2]),
                                    categories=["a", "b"]),
            "stage": pd.Categorical(np.array(["early", "mid", "late"])[np.arange(n_obs) % 3],
                                    categories=["early", "mid", "late"], ordered=True),
            "n_counts": raw_counts.sum(axis=1).astype(np.int64),
            "percent_mito": r.random(n_obs).astype(np.float32),
            "is_doublet": np.arange(n_obs) % 17 == 0,
            "barcode": ["AAAC%06d-1" % i for i in range(n_obs)],
        },
        index=names("cell", n_obs),
    )
    keep = np.arange(0, n_raw, 3)[:n_vars] if n_raw // 3 >= n_vars else np.arange(n_vars)
    log = np.log1p(raw_counts[:, keep]).astype(np.float32)
    raw = make(X=sparse.csr_matrix(raw_counts), obs=obs.copy(), var=raw_var)
    var = raw_var.iloc[keep].copy()
    var["highly_variable"] = np.arange(n_vars) % 2 == 0
    var["means"] = log.mean(axis=0).astype(np.float64)
    angle = np.arange(n_obs) / n_obs * 2 * np.pi
    graph = sparse.csr_matrix(
        (np.ones(n_obs * 2, dtype=np.float32),
         (np.repeat(np.arange(n_obs), 2),
          np.concatenate([[(i + 1) % n_obs, (i - 1) % n_obs] for i in range(n_obs)]))),
        shape=(n_obs, n_obs))
    groups = ["B cell", "Monocyte", "T cell"]
    names_rec = np.rec.fromarrays([np.array(["GENE%d" % (i * 3 + g) for i in range(5)]) for g in range(3)], names=groups)
    scores_rec = np.rec.fromarrays([r.random(5).astype(np.float32) for _ in groups], names=groups)
    uns = {
        "title": "Scanpy-like corpus object",
        "cell_type_colors": np.array(["#1f77b4", "#ff7f0e", "#2ca02c"], dtype=object),
        "neighbors": {"params": {"n_neighbors": 15, "method": "umap", "metric": "euclidean"}},
        "rank_genes_groups": {"params": {"groupby": "cell_type", "method": "wilcoxon"},
                              "names": names_rec, "scores": scores_rec},
    }
    kw = dict(
        X=sparse.csr_matrix(log), obs=obs, var=var, uns=uns,
        obsm={"X_pca": r.random((n_obs, 20)).astype(np.float32),
              "X_umap": (np.column_stack([np.cos(angle), np.sin(angle)]) * (1 + np.arange(n_obs) % 3)[:, None]).astype(np.float32)},
        varm={"PCs": r.random((n_vars, 20)).astype(np.float64)},
        layers={"counts": sparse.csr_matrix(raw_counts[:, keep])},
        raw=raw,
    )
    if V >= (0, 7):
        kw["obsp"] = {"connectivities": graph, "distances": graph.astype(np.float64) * 2.5}
    return make(**kw)


# ---------------------------------------------------------------- X: presence and dtypes


@variant("No X at all: shape comes from obs/var; one layer holds the values.", ["X:absent", "layers"])
def x_absent():
    n_obs, n_vars = 40, 12
    return make(X=None, obs=small_obs(n_obs), var=small_var(n_vars), uns={"title": "no X"},
                layers={"counts": float_matrix(n_obs, n_vars, 3)})


DENSE_DTYPES = {
    "float16": lambda: float_matrix(60, 20, 21, np.float16),
    "float32": lambda: float_matrix(60, 20, 21, np.float32),
    "float64": lambda: float_matrix(60, 20, 21, np.float64),
    "int8": lambda: with_specials(int_matrix(60, 20, 22, np.int8, -9, 10), np.array([-128, 127], np.int8)),
    "int16": lambda: with_specials(int_matrix(60, 20, 22, np.int16, -9, 10), np.array([-32768, 32767], np.int16)),
    "int32": lambda: with_specials(int_matrix(60, 20, 22, np.int32), np.array([-2147483648, 2147483647], np.int32)),
    "int64": lambda: with_specials(int_matrix(60, 20, 22, np.int64), np.array([-(2**63), 2**63 - 1, 2**53 + 1, 2**40], np.int64)),
    "uint8": lambda: with_specials(int_matrix(60, 20, 22, np.uint8), np.array([255], np.uint8)),
    "uint16": lambda: with_specials(int_matrix(60, 20, 22, np.uint16), np.array([65535], np.uint16)),
    "uint32": lambda: with_specials(int_matrix(60, 20, 22, np.uint32), np.array([4294967295], np.uint32)),
    "uint64": lambda: with_specials(int_matrix(60, 20, 22, np.uint64), np.array([2**64 - 1, 2**53 + 1], np.uint64)),
    "bool": lambda: float_matrix(60, 20, 21, np.float32) > 0,
}

for _dtype, _builder in DENSE_DTYPES.items():
    VARIANTS.append(Variant(
        "x_dense_" + _dtype, (lambda b=_builder: default_adata(b())),
        "Dense X of dtype %s (integer variants include the dtype's extreme values)." % _dtype,
        ["X:dense", "dtype:" + _dtype],
))


@variant("Dense float32 X with NaN, +inf, -inf, -0.0, float32 max/min-subnormal.", ["X:dense", "special-values"])
def x_dense_special_float32():
    return default_adata(with_specials(float_matrix(60, 20, 23, np.float32), special_floats32()))


@variant("Dense float64 X with NaN, +-inf, -0.0, +-1e40, subnormals and float64 max.", ["X:dense", "special-values"])
def x_dense_special_float64():
    return default_adata(with_specials(float_matrix(60, 20, 24, np.float64), special_floats64()))


@variant("Dense float16 X with 65504, subnormals, NaN, +-inf, -0.0.", ["X:dense", "dtype:float16", "special-values"])
def x_dense_float16_extremes():
    return default_adata(with_specials(float_matrix(60, 20, 25, np.float16), special_floats16()))


@variant("Dense int64 counts far beyond float32 precision (2^40, 2^53+1, 2^62).", ["X:dense", "dtype:int64", "huge-counts"])
def x_dense_int64_huge_counts():
    X = int_matrix(60, 20, 26, np.int64) * np.int64(2**40)
    return default_adata(with_specials(X, np.array([2**53 + 1, 2**53 - 1, 2**62, 9007199254740993], np.int64)))


@variant("Dense big-endian float32 X (written from a '>f4' array).", ["X:dense", "byte-order:big"])
def x_dense_bigendian():
    return default_adata(float_matrix(60, 20, 27, np.float32).astype(">f4"))


@variant("Dense X with a single row and a single column (1 x 1).", ["X:dense", "shape:1x1"])
def x_dense_1x1():
    return default_adata(np.array([[2.5]], dtype=np.float32))


# ---------------------------------------------------------------- X: dense storage layouts


def _layout(name, formats, kwargs_by_format, description, covers, reader=None, settings=None):
    VARIANTS.append(Variant(
        name, lambda: default_adata(float_matrix(70, 24, 31, np.float32, density=0.25)),
        description, ["X:dense"] + covers, formats=formats, reader=reader, settings=settings,
        x_kwargs=lambda k=kwargs_by_format: k))


def _zarr2_codecs():
    import numcodecs
    return numcodecs


def _zarr3_codecs():
    import zarr.codecs
    return zarr.codecs


if LATEST:
    _layout("x_dense_h5_contiguous", ("h5ad",), {"h5ad": {}}, "Dense X, contiguous HDF5 layout (anndata default).",
            ["h5:contiguous"])
    _layout("x_dense_h5_chunk_rows", ("h5ad",), {"h5ad": {"chunks": (16, 24)}}, "Dense X chunked in row blocks of 16 (last block partial).",
            ["h5:chunked"])
    _layout("x_dense_h5_chunk_cols", ("h5ad",), {"h5ad": {"chunks": (70, 5)}},
            "Dense X chunked in narrow column strips (5 wide; last strip partial).", ["h5:chunked"])
    _layout("x_dense_h5_chunk_square", ("h5ad",), {"h5ad": {"chunks": (16, 16)}},
            "Dense X in 16x16 chunks; edge chunks are partial.", ["h5:chunked"])
    _layout("x_dense_h5_resizable", ("h5ad",), {"h5ad": {"chunks": (16, 16), "maxshape": (None, None)}},
            "Dense X chunked with unlimited maxshape in both dimensions.", ["h5:chunked", "h5:maxshape-unlimited"])
    _layout("x_dense_h5_gzip", ("h5ad",), {"h5ad": {"chunks": (32, 8), "compression": "gzip", "compression_opts": 6}},
            "Dense X, gzip level 6.", ["h5:gzip"])
    _layout("x_dense_h5_gzip_shuffle", ("h5ad",),
            {"h5ad": {"chunks": (32, 8), "compression": "gzip", "shuffle": True}},
            "Dense X, shuffle + gzip.", ["h5:gzip", "h5:shuffle"])
    _layout("x_dense_h5_lzf", ("h5ad",), {"h5ad": {"chunks": (32, 8), "compression": "lzf"}},
            "Dense X, LZF (h5py's built-in filter; scanpy writes it).", ["h5:lzf"])
    _layout("x_dense_h5_fletcher32", ("h5ad",), {"h5ad": {"chunks": (32, 8), "fletcher32": True}},
            "Dense X with the Fletcher-32 checksum filter.", ["h5:fletcher32"])
    _layout("x_dense_h5_scaleoffset", ("h5ad",), {"h5ad": {"chunks": (32, 8), "scaleoffset": 3}},
            "Dense float X with the lossy scale-offset filter (3 decimal digits kept).", ["h5:scaleoffset"],
            reader={"expect": "read-or-refuse", "refuse_reason": "HDF5 scale-offset filter (id 6)"})

    def _z2(**kwargs):
        return {"zarr2": kwargs}

    def _z2c(builder):
        return lambda: _z2(chunks=(32, 8), compressor=builder(_zarr2_codecs()))

    for _name, _desc, _make_kwargs, _reader in [
        ("chunk_rows", "row blocks of 16", lambda: _z2(chunks=(16, 24)), None),
        ("chunk_cols", "narrow 5-wide column strips", lambda: _z2(chunks=(70, 5)), None),
        ("chunk_square", "16x16 chunks with partial edges", lambda: _z2(chunks=(16, 16)), None),
        ("uncompressed", "no compressor", lambda: _z2(chunks=(32, 8), compressor=None), None),
        ("blosc_lz4", "Blosc lz4 + byte shuffle", _z2c(lambda c: c.Blosc(cname="lz4", clevel=5, shuffle=c.Blosc.SHUFFLE)), None),
        ("blosc_lz4hc", "Blosc lz4hc", _z2c(lambda c: c.Blosc(cname="lz4hc", clevel=5, shuffle=c.Blosc.SHUFFLE)), None),
        ("blosc_zstd", "Blosc zstd + bit shuffle", _z2c(lambda c: c.Blosc(cname="zstd", clevel=3, shuffle=c.Blosc.BITSHUFFLE)), None),
        ("blosc_zlib", "Blosc zlib, no shuffle", _z2c(lambda c: c.Blosc(cname="zlib", clevel=5, shuffle=c.Blosc.NOSHUFFLE)), None),
        ("blosc_blosclz", "Blosc blosclz", _z2c(lambda c: c.Blosc(cname="blosclz", clevel=5, shuffle=c.Blosc.SHUFFLE)), None),
        ("gzip", "GZip level 5", _z2c(lambda c: c.GZip(level=5)), None),
        ("zlib", "Zlib level 5", _z2c(lambda c: c.Zlib(level=5)), None),
        ("zstd", "Zstd level 3", _z2c(lambda c: c.Zstd(level=3)), None),
        ("lz4", "numcodecs LZ4 (not inside Blosc)", _z2c(lambda c: c.LZ4()),
         {"expect": "read-or-refuse", "refuse_reason": "zarr codec 'lz4'"}),
        ("bz2", "BZ2", _z2c(lambda c: c.BZ2(level=5)), {"expect": "read-or-refuse", "refuse_reason": "zarr codec 'bz2'"}),
        ("lzma", "LZMA", _z2c(lambda c: c.LZMA()), {"expect": "read-or-refuse", "refuse_reason": "zarr codec 'lzma'"}),
        ("order_f", "Fortran (column-major) chunk order", lambda: _z2(chunks=(32, 8), order="F"), None),
        ("shuffle_filter", "Shuffle filter + Zlib compressor",
         lambda: _z2(chunks=(32, 8), filters=[_zarr2_codecs().Shuffle(elementsize=4)], compressor=_zarr2_codecs().Zlib(level=1)),
         {"expect": "read-or-refuse", "refuse_reason": "zarr filter 'shuffle'"}),
        ("fill_nan", "fill_value NaN, so all-NaN chunks are not stored", lambda: _z2(chunks=(16, 8), fill_value=float("nan")), None),
    ]:
        VARIANTS.append(Variant(
            "x_dense_z2_" + _name, lambda: default_adata(float_matrix(70, 24, 31, np.float32, density=0.25)),
            "Dense X in zarr v2: %s." % _desc, ["X:dense", "zarr2:" + _name], formats=("zarr2",),
            reader=_reader, x_kwargs=_make_kwargs))

    def _fill_nan_build():
        X = float_matrix(70, 24, 31, np.float32, density=0.25)
        X[16:48, 8:16] = np.nan
        return default_adata(X)
    VARIANTS[-1].build = _fill_nan_build

    @variant("Dense X in zarr v2 with all-zero chunks that zarr does not store (absent chunks = fill_value 0).",
             ["X:dense", "zarr:missing-chunks"], formats=("zarr2", "zarr3"),
             x_kwargs=lambda: {"zarr2": {"chunks": (16, 8)}, "zarr3": {"chunks": (16, 8)}})
    def x_dense_missing_chunks():
        X = float_matrix(70, 24, 32, np.float32)
        X[16:48, :] = 0
        X[:, 8:16] = 0
        return default_adata(X)

    def _z3(**kwargs):
        return {"zarr3": kwargs}

    def _z3c(builder):
        return lambda: _z3(chunks=(32, 8), compressors=builder(_zarr3_codecs()))

    for _name, _desc, _make_kwargs, _reader in [
        ("chunk_rows", "row blocks of 16", lambda: _z3(chunks=(16, 24)), None),
        ("chunk_cols", "narrow 5-wide column strips", lambda: _z3(chunks=(70, 5)), None),
        ("chunk_square", "16x16 chunks with partial edges", lambda: _z3(chunks=(16, 16)), None),
        ("uncompressed", "no compressor", lambda: _z3(chunks=(32, 8), compressors=None), None),
        ("blosc_lz4", "Blosc lz4 + shuffle", _z3c(lambda c: c.BloscCodec(cname="lz4", clevel=5, shuffle="shuffle")), None),
        ("blosc_zstd", "Blosc zstd + bitshuffle", _z3c(lambda c: c.BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")), None),
        ("gzip", "gzip level 5", _z3c(lambda c: c.GzipCodec(level=5)), None),
        ("zstd", "zstd level 3", _z3c(lambda c: c.ZstdCodec(level=3)), None),
        ("crc32c", "zstd followed by a crc32c checksum", _z3c(lambda c: [c.ZstdCodec(level=3), c.Crc32cCodec()]), None),
        ("bigendian", "bytes codec with big-endian byte order",
         lambda: _z3(chunks=(32, 8), serializer=_zarr3_codecs().BytesCodec(endian="big")), None),
        ("sharded", "16x8 chunks inside 32x16 shards (sharding_indexed codec; edge shards partial)",
         lambda: _z3(chunks=(16, 8), shards=(32, 16)), None),
        ("sharded_gzip", "sharded, inner chunks gzip-compressed",
         lambda: _z3(chunks=(16, 8), shards=(32, 16), compressors=_zarr3_codecs().GzipCodec(level=5)), None),
        ("fill_nan", "fill_value NaN, so all-NaN chunks are not stored", lambda: _z3(chunks=(16, 8), fill_value=float("nan")), None),
    ]:
        VARIANTS.append(Variant(
            "x_dense_z3_" + _name, lambda: default_adata(float_matrix(70, 24, 31, np.float32, density=0.25)),
            "Dense X in zarr v3: %s." % _desc, ["X:dense", "zarr3:" + _name], formats=("zarr3",),
            reader=_reader, x_kwargs=_make_kwargs))
    VARIANTS[-1].build = _fill_nan_build

    @variant("Small object (CSR X, dense layer, strings, categorical, obsm) written with "
             "anndata.settings.auto_shard_zarr_v3 = True: every array, strings included, is sharded.",
             ["zarr3:auto-shard", "X:csr"],
             formats=("zarr3",), settings={"auto_shard_zarr_v3": True})
    def zarr3_auto_shard():
        obs = small_obs(60)
        obs["barcode"] = ["AAAC-%02d" % i for i in range(60)]
        return default_adata(sparse.csr_matrix(float_matrix(60, 20, 55)), obs=obs,
                             obsm={"X_umap": float_matrix(60, 2, 56)}, layers={"dense": float_matrix(60, 20, 57)})


# ---------------------------------------------------------------- X: sparse


def _sparse_variant(name, build, description, covers, settings=None, x_kwargs=None, formats=None):
    VARIANTS.append(Variant(name, build, description, covers, settings=settings,
                            x_kwargs=x_kwargs, formats=formats))


_sparse_variant("x_csr_float32", lambda: default_adata(sparse.csr_matrix(float_matrix(60, 20, 41))),
                "CSR X, float32 data, int32 indptr/indices.", ["X:csr", "dtype:float32"])
_sparse_variant("x_csc_float32", lambda: default_adata(sparse.csc_matrix(float_matrix(60, 20, 41))),
                "CSC X, float32 data, int32 indptr/indices.", ["X:csc", "dtype:float32"])
_sparse_variant("x_csr_float64", lambda: default_adata(sparse.csr_matrix(float_matrix(60, 20, 42, np.float64))),
                "CSR X, float64 data.", ["X:csr", "dtype:float64"])
_sparse_variant("x_csr_int32", lambda: default_adata(sparse.csr_matrix(int_matrix(60, 20, 43, np.int32, 1, 1000))),
                "CSR X, int32 counts.", ["X:csr", "dtype:int32"])
_sparse_variant("x_csr_int64_huge", lambda: default_adata(sparse.csr_matrix(
    with_specials(int_matrix(60, 20, 44, np.int64), np.array([2**53 + 1, 2**62, 2**63 - 1], np.int64)))),
                "CSR X, int64 counts including 2^53+1, 2^62 and int64 max.", ["X:csr", "dtype:int64", "huge-counts"])
_sparse_variant("x_csr_uint16", lambda: default_adata(sparse.csr_matrix(int_matrix(60, 20, 45, np.uint16, 1, 65535))),
                "CSR X, uint16 data.", ["X:csr", "dtype:uint16"])
_sparse_variant("x_csr_bool", lambda: default_adata(sparse.csr_matrix(float_matrix(60, 20, 46) > 0)),
                "CSR X, bool data.", ["X:csr", "dtype:bool"])
_sparse_variant("x_csc_float64", lambda: default_adata(sparse.csc_matrix(float_matrix(60, 20, 47, np.float64))),
                "CSC X, float64 data.", ["X:csc", "dtype:float64"])


def _index64(fmt):
    m = getattr(sparse, fmt + "_matrix")(float_matrix(60, 20, 48))
    m.indices = m.indices.astype(np.int64)
    m.indptr = m.indptr.astype(np.int64)
    return default_adata(m)


_sparse_variant("x_csr_index_int64", lambda: _index64("csr"), "CSR X with int64 indptr and int64 indices.",
                ["X:csr", "index:int64"])
_sparse_variant("x_csc_index_int64", lambda: _index64("csc"), "CSC X with int64 indptr and int64 indices.",
                ["X:csc", "index:int64"])
if LATEST:
    _sparse_variant("x_csr_indptr_int64", lambda: default_adata(sparse.csr_matrix(float_matrix(60, 20, 49))),
                    "CSR X with int64 indptr and int32 indices (write_elem indptr_dtype).", ["X:csr", "index:mixed"],
                    x_kwargs=lambda: {f: {"indptr_dtype": "int64"} for f in ALL_FORMATS})
    _sparse_variant("x_csr_indices_uint8", lambda: default_adata(sparse.csr_matrix(float_matrix(60, 20, 50))),
                    "CSR X with uint8 indices (settings.write_csr_csc_indices_with_min_possible_dtype).",
                    ["X:csr", "index:unsigned"], settings={"write_csr_csc_indices_with_min_possible_dtype": True})
    _sparse_variant("x_csc_indices_uint16", lambda: default_adata(sparse.csc_matrix(float_matrix(300, 20, 51, density=0.1))),
                    "CSC X over 300 cells with uint16 indices (minimum-dtype setting).", ["X:csc", "index:unsigned"],
                    settings={"write_csr_csc_indices_with_min_possible_dtype": True})
_sparse_variant("x_csr_unsorted", lambda: default_adata(messy_sparse("csr", unsorted=True)),
                "CSR X with column indices in descending order inside each row.", ["X:csr", "sparse:unsorted"])
_sparse_variant("x_csc_unsorted", lambda: default_adata(messy_sparse("csc", unsorted=True)),
                "CSC X with row indices in descending order inside each column.", ["X:csc", "sparse:unsorted"])
_sparse_variant("x_csr_duplicates", lambda: default_adata(messy_sparse("csr", duplicates=True)),
                "CSR X with duplicate (row, col) entries, adjacent and not; they must be summed.",
                ["X:csr", "sparse:duplicates"])
_sparse_variant("x_csc_duplicates", lambda: default_adata(messy_sparse("csc", duplicates=True)),
                "CSC X with duplicate entries; they must be summed.", ["X:csc", "sparse:duplicates"])
_sparse_variant("x_csr_explicit_zeros", lambda: default_adata(messy_sparse("csr", explicit_zeros=True)),
                "CSR X with explicitly stored 0.0 values.", ["X:csr", "sparse:explicit-zeros"])
_sparse_variant("x_csr_empty_edges", lambda: default_adata(messy_sparse("csr", empty_edges=True)),
                "CSR X whose first/last rows and first/last columns are empty.", ["X:csr", "sparse:empty-rows-cols"])
_sparse_variant("x_csc_empty_edges", lambda: default_adata(messy_sparse("csc", empty_edges=True)),
                "CSC X whose first/last rows and first/last columns are empty.", ["X:csc", "sparse:empty-rows-cols"])
_sparse_variant("x_csr_all_irregular", lambda: default_adata(messy_sparse(
    "csr", unsorted=True, duplicates=True, explicit_zeros=True, empty_edges=True)),
                "CSR X: unsorted + duplicates + explicit zeros + empty edge rows/columns together.",
                ["X:csr", "sparse:unsorted", "sparse:duplicates", "sparse:explicit-zeros"])
_sparse_variant("x_csr_nnz0", lambda: default_adata(sparse.csr_matrix((60, 20), dtype=np.float32)),
                "CSR X with no stored entries (nnz = 0).", ["X:csr", "sparse:nnz0"])
_sparse_variant("x_csc_nnz0", lambda: default_adata(sparse.csc_matrix((60, 20), dtype=np.float32)),
                "CSC X with no stored entries (nnz = 0).", ["X:csc", "sparse:nnz0"])


def _sparse_special(fmt, dtype, specials):
    dense = float_matrix(60, 20, 52, dtype)
    m = getattr(sparse, fmt + "_matrix")(dense)
    positions = np.linspace(0, m.data.size - 1, specials.size).astype(int)
    m.data[positions] = specials
    return default_adata(m)


_sparse_variant("x_csr_special_float32", lambda: _sparse_special("csr", np.float32, special_floats32()),
                "CSR X float32 with stored NaN, +-inf, -0.0 and float32 extremes.", ["X:csr", "special-values"])
_sparse_variant("x_csc_special_float64", lambda: _sparse_special("csc", np.float64, special_floats64()),
                "CSC X float64 with stored NaN, +-inf, -0.0, +-1e40, subnormals.", ["X:csc", "special-values"])

if LATEST:
    _sparse_variant("x_csr_h5_chunked_gzip", lambda: default_adata(sparse.csr_matrix(float_matrix(70, 24, 53))),
                    "CSR X in HDF5 with 64-element chunks and gzip.", ["X:csr", "h5:gzip", "h5:chunked"],
                    formats=("h5ad",), x_kwargs=lambda: {"h5ad": {"chunks": (64,), "compression": "gzip"}})
    _sparse_variant("x_csc_h5_lzf", lambda: default_adata(sparse.csc_matrix(float_matrix(70, 24, 54))),
                    "CSC X in HDF5 with 50-element chunks and LZF.", ["X:csc", "h5:lzf", "h5:chunked"],
                    formats=("h5ad",), x_kwargs=lambda: {"h5ad": {"chunks": (50,), "compression": "lzf"}})
    _sparse_variant("x_csr_z2_chunked_blosc", lambda: default_adata(sparse.csr_matrix(float_matrix(70, 24, 53))),
                    "CSR X in zarr v2 with 64-element chunks and Blosc zstd.", ["X:csr", "zarr2:blosc_zstd"],
                    formats=("zarr2",), x_kwargs=lambda: {"zarr2": {"chunks": (64,), "compressor": _zarr2_codecs().Blosc(
                        cname="zstd", clevel=3, shuffle=_zarr2_codecs().Blosc.SHUFFLE)}})
    _sparse_variant("x_csr_z3_sharded", lambda: default_adata(sparse.csr_matrix(float_matrix(70, 24, 53))),
                    "CSR X in zarr v3 with 64-element chunks inside 256-element shards.", ["X:csr", "zarr3:sharded"],
                    formats=("zarr3",), x_kwargs=lambda: {"zarr3": {"chunks": (64,), "shards": (256,)}})


# ---------------------------------------------------------------- shapes


@variant("Zero cells: obs has 0 rows, var 20; X dense 0 x 20.", ["shape:0-obs"])
def shape_0_obs():
    return make(X=np.zeros((0, 20), np.float32), obs=small_obs(0), var=small_var(20), uns={"title": "0 cells"})


@variant("Zero cells with CSR X (0 x 20, indptr = [0]).", ["shape:0-obs", "X:csr"])
def shape_0_obs_csr():
    return make(X=sparse.csr_matrix((0, 20), dtype=np.float32), obs=small_obs(0), var=small_var(20))


@variant("Zero genes: var has 0 rows, X dense 30 x 0.", ["shape:0-vars"])
def shape_0_vars():
    return make(X=np.zeros((30, 0), np.float32), obs=small_obs(30), var=small_var(0))


@variant("Zero genes with CSC X (30 x 0).", ["shape:0-vars", "X:csc"])
def shape_0_vars_csc():
    return make(X=sparse.csc_matrix((30, 0), dtype=np.float32), obs=small_obs(30), var=small_var(0))


# ---------------------------------------------------------------- layers and raw


@variant("Layers of every storage form: dense float32/int64/bool, CSR int32, CSC float64, special values.",
         ["layers", "X:csr"])
def layers_mixed():
    n_obs, n_vars = 60, 20
    return default_adata(
        sparse.csr_matrix(float_matrix(n_obs, n_vars, 61)),
        layers={
            "dense_f32": float_matrix(n_obs, n_vars, 62),
            "dense_i64": int_matrix(n_obs, n_vars, 63, np.int64, 1, 100000),
            "dense_bool": float_matrix(n_obs, n_vars, 64) > 0,
            "counts_csr": sparse.csr_matrix(int_matrix(n_obs, n_vars, 65, np.int32, 1, 50)),
            "csc_f64": sparse.csc_matrix(float_matrix(n_obs, n_vars, 66, np.float64)),
            "special_f32": with_specials(float_matrix(n_obs, n_vars, 67), special_floats32()),
        })


@variant("raw with CSR raw.X over more genes than X, raw.var with extra categorical/numeric columns; X dense.",
         ["raw", "raw:more-genes", "X:dense"])
def raw_sparse_more_genes():
    n_obs, n_raw = 60, 30
    counts = int_matrix(n_obs, n_raw, 71, np.float32, 1, 20)
    raw_var = pd.DataFrame({"gene_ids": ["ENSG%011d" % i for i in range(n_raw)],
                            "chromosome": pd.Categorical(np.array(["1", "2", "X"])[np.arange(n_raw) % 3]),
                            "n_cells": np.count_nonzero(counts, axis=0).astype(np.int32)},
                           index=["GENE%d" % i for i in range(n_raw)])
    raw = make(X=sparse.csr_matrix(counts), obs=small_obs(n_obs), var=raw_var)
    keep = np.arange(0, n_raw, 2)
    var = raw_var.iloc[keep][["gene_ids"]].copy()
    return make(X=np.log1p(counts[:, keep]), obs=small_obs(n_obs), var=var, raw=raw, uns={"title": "raw"})


@variant("raw with dense raw.X (same genes as X); X CSR.", ["raw", "raw:dense", "X:csr"])
def raw_dense():
    counts = int_matrix(60, 20, 72, np.float32, 1, 20)
    raw = make(X=counts, obs=small_obs(60), var=small_var(20))
    return make(X=sparse.csr_matrix(np.log1p(counts)), obs=small_obs(60), var=small_var(20), raw=raw)


# ---------------------------------------------------------------- obs / var columns

N_DF = 12


def df_adata(obs=None, var=None, n_obs=N_DF, n_vars=4):
    obs = obs if obs is not None else small_obs(n_obs)
    var = var if var is not None else small_var(n_vars)
    return make(X=float_matrix(obs.shape[0], var.shape[0], 81), obs=obs, var=var, uns={"title": "dataframe"})


def _numeric_frame(n, seed):
    r = rng(seed)
    cols = {}
    for dtype in ("int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"):
        info = np.iinfo(dtype)
        values = r.integers(0, 100, n).astype(dtype)
        values[0] = info.min
        values[1] = info.max
        cols[dtype] = values
    for dtype in ("float16", "float32", "float64"):
        cols[dtype] = (r.random(n) * 100).astype(dtype)
    cols["bool"] = np.arange(n) % 3 == 0
    return cols


@variant("obs and var columns of every numeric dtype int8..uint64, float16/32/64, bool (with dtype extremes).",
         ["obs:numeric", "var:numeric", "dtype:all-numeric"])
def obs_numeric_dtypes():
    obs = pd.DataFrame(_numeric_frame(N_DF, 82), index=names("cell", N_DF))
    var = pd.DataFrame(_numeric_frame(6, 83), index=names("gene", 6))
    return df_adata(obs, var)


@variant("Float obs columns with NaN, +-inf, -0.0, 1e40, subnormals, float16 extremes, all-NaN columns.",
         ["obs:float", "special-values"])
def obs_float_special():
    n = 12
    obs = pd.DataFrame({
        "f64_special": special_floats64(),
        "f32_special": np.concatenate([special_floats32(), [2.5, 3.5]]).astype(np.float32),
        "f16_special": np.concatenate([special_floats16(), [2.5, 3.5]]).astype(np.float16),
        "all_nan_f64": np.full(n, np.nan),
        "all_nan_f32": np.full(n, np.nan, dtype=np.float32),
    }, index=names("cell", n))
    var = pd.DataFrame({"f64_special": [np.nan, -0.0, np.inf, 1e40]}, index=names("gene", 4))
    return df_adata(obs, var)


@variant("Integer obs columns beyond 2^53: int64 min/max, 2^53+1, uint64 max.", ["obs:int64", "obs:uint64", "huge-ints"])
def obs_int_extremes():
    obs = pd.DataFrame({
        "i64": np.array([-(2**63), 2**63 - 1, 2**53 + 1, -(2**53 + 1), 2**53, 0, 1, -1, 2**62, 12345678901234567,
                         -12345678901234567, 7], dtype=np.int64),
        "u64": np.array([2**64 - 1, 2**63, 2**53 + 1, 0, 1, 2, 3, 4, 5, 6, 7, 8], dtype=np.uint64),
    }, index=names("cell", 12))
    return df_adata(obs)


@variant("String obs/var columns: all values distinct (stay strings), including unicode.",
         ["obs:string", "var:string"])
def obs_strings():
    obs = small_obs(N_DF)
    obs["barcode"] = ["AAAC-%02d" % i for i in range(N_DF)]
    obs["label_unicode"] = ["Zelle %d äöü αβ 細胞" % i for i in range(N_DF)]
    var = small_var(4)
    var["description"] = ["gene number %d" % i for i in range(4)]
    return df_adata(obs, var)


@variant("String column edge cases: empty string, 10 000-character string, emoji, combining marks, RTL, whitespace.",
         ["obs:string", "strings:edge"])
def obs_strings_edge():
    values = ["", "x" * 10000, "\U0001F9EC\U0001F52C emoji", "é combining", "שלום rtl",
              "  spaces  ", "tab\tand\nnewline", "quote\"back\\slash", "nan", "None", "0", "été"]
    obs = small_obs(N_DF)
    obs["edge"] = values
    return df_adata(obs)


@variant("String column containing an embedded NUL character.", ["obs:string", "strings:nul"])
def obs_string_nul():
    obs = small_obs(N_DF)
    obs["with_nul"] = ["a\x00b"] + ["v%d" % i for i in range(N_DF - 1)]
    return df_adata(obs)


@variant("Repeated strings written with convert_strings_to_categoricals=False, so they stay a string array.",
         ["obs:string"], write_kwargs={"convert_strings_to_categoricals": False})
def obs_strings_not_categorical():
    obs = small_obs(N_DF)
    obs["repeated"] = np.array(["x", "y", "z"])[np.arange(N_DF) % 3]
    return df_adata(obs)


@variant("Repeated strings that anndata converts to a categorical on write (default behaviour).",
         ["obs:categorical", "strings-to-categoricals"])
def obs_strings_converted():
    obs = small_obs(N_DF)
    obs["repeated"] = np.array(["x", "y", "z"])[np.arange(N_DF) % 3]
    var = small_var(4)
    var["chrom"] = ["1", "1", "2", "2"]
    return df_adata(obs, var)


@variant("Categoricals: unordered, ordered, missing codes (-1), unused categories, single category, all missing.",
         ["obs:categorical", "ordered-categorical", "categorical:missing", "categorical:unused"])
def obs_categoricals():
    n = N_DF
    obs = pd.DataFrame({
        "plain": pd.Categorical(np.array(["a", "b", "c"])[np.arange(n) % 3]),
        "ordered": pd.Categorical(np.array(["low", "mid", "high"])[np.arange(n) % 3],
                                  categories=["low", "mid", "high"], ordered=True),
        "with_missing": pd.Categorical([None if i % 4 == 0 else "ab"[i % 2] for i in range(n)], categories=["a", "b"]),
        "unused_categories": pd.Categorical(np.array(["a", "b"])[np.arange(n) % 2], categories=["a", "b", "never", "unused"]),
        "single": pd.Categorical(["only"] * n),
        "all_missing": pd.Categorical([None] * n, categories=["p", "q"]),
    }, index=names("cell", n))
    var = small_var(4)
    var["kind"] = pd.Categorical(["coding", "coding", "lnc", "coding"])
    return df_adata(obs, var)


@variant("Categorical labels: empty string, literal 'nan', unicode, 300-character label, whitespace.",
         ["obs:categorical", "categorical:labels"])
def obs_cat_labels():
    cats = ["", "nan", "細胞 \U0001F9EC", "L" * 300, " padded "]
    obs = small_obs(N_DF)
    obs["labels"] = pd.Categorical(np.array(cats, dtype=object)[np.arange(N_DF) % 5], categories=cats)
    return df_adata(obs)


@variant("Numeric categories: int (incl. > 2^53), float (incl. -0.0) categories.", ["obs:categorical", "categorical:numeric"])
def obs_cat_numeric():
    obs = small_obs(N_DF)
    obs["int_cats"] = pd.Categorical(np.array([1, 5, 2**53 + 1, -7])[np.arange(N_DF) % 4])
    obs["float_cats"] = pd.Categorical(np.array([-0.0, 1.5, 2.25])[np.arange(N_DF) % 3])
    obs["int_cats_missing"] = pd.Categorical([None if i % 5 == 0 else (i % 3) * 10 for i in range(N_DF)], categories=[0, 10, 20])
    return df_adata(obs)


@variant("Boolean categories (categories [False, True]).", ["obs:categorical", "categorical:bool"])
def obs_cat_bool():
    obs = small_obs(N_DF)
    obs["bool_cats"] = pd.Categorical(np.arange(N_DF) % 2 == 0)
    return df_adata(obs)


@variant("Categorical with 200 categories, so the codes are stored as int16.", ["obs:categorical", "categorical:int16-codes"])
def obs_cat_wide_int16():
    n = 60
    cats = ["cat%03d" % i for i in range(200)]
    obs = small_obs(n)
    obs["wide"] = pd.Categorical(np.array(cats)[(np.arange(n) * 7) % 200], categories=cats)
    obs.loc[obs.index[0], "wide"] = cats[199]
    return df_adata(obs, n_obs=n)


@variant("Categorical with 32 769 categories, so the codes are stored as int32.", ["obs:categorical", "categorical:int32-codes"])
def obs_cat_wide_int32():
    n = 60
    cats = ["%05d" % i for i in range(32769)]
    obs = small_obs(n)
    codes = (np.arange(n) * 661) % 32769
    codes[0] = 32768
    codes[1] = 32767
    codes[2] = -1
    obs["wide"] = pd.Categorical.from_codes(codes, categories=cats)
    return df_adata(obs, n_obs=n)


@variant("Nullable integer columns (Int8..Int64, UInt8..UInt64) with and without NA.",
         ["obs:nullable-integer"])
def obs_nullable_int():
    obs = small_obs(N_DF)
    for name in ("Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64"):
        values = [None if i % 4 == 1 else i * 3 for i in range(N_DF)]
        obs["nullable_" + name] = pd.array(values, dtype=name)
    obs["Int64_no_na"] = pd.array(list(range(N_DF)), dtype="Int64")
    obs["Int64_all_na"] = pd.array([None] * N_DF, dtype="Int64")
    return df_adata(obs)


@variant("Nullable boolean column with NA.", ["obs:nullable-boolean"])
def obs_nullable_bool():
    obs = small_obs(N_DF)
    obs["flag"] = pd.array([None if i % 4 == 1 else i % 2 == 0 for i in range(N_DF)], dtype="boolean")
    obs["flag_no_na"] = pd.array([i % 2 == 0 for i in range(N_DF)], dtype="boolean")
    return df_adata(obs)


@variant("Nullable string column (pandas StringDtype) with NA, written with settings.allow_write_nullable_strings and "
         "convert_strings_to_categoricals=False where the writer has them (otherwise it becomes a categorical).",
         ["obs:nullable-string"], settings={"allow_write_nullable_strings": True},
         write_kwargs={"convert_strings_to_categoricals": False})
def obs_nullable_string():
    obs = small_obs(N_DF)
    obs["name"] = pd.array([None if i % 4 == 1 else "s%d" % i for i in range(N_DF)], dtype="string")
    return df_adata(obs)


@variant("Nullable float column (pandas Float64) with NA.", ["obs:nullable-float"])
def obs_nullable_float():
    obs = small_obs(N_DF)
    obs["maybe"] = pd.array([None if i % 4 == 1 else i * 0.5 for i in range(N_DF)], dtype="Float64")
    return df_adata(obs)


def _object_variant(name, column, description):
    def build():
        obs = small_obs(N_DF)
        obs[name] = column()
        return df_adata(obs)
    VARIANTS.append(Variant("obs_object_" + name, build, description, ["obs:object"]))


_object_variant("mixed_int_str", lambda: pd.Series([1, "a", 2, "b"] * 3, dtype=object, index=names("cell", N_DF)).values,
                "Object column mixing ints and strings.")
_object_variant("datetime", lambda: pd.date_range("2020-01-01", periods=N_DF, freq="D").values,
                "datetime64 column.")
_object_variant("timedelta", lambda: pd.to_timedelta(np.arange(N_DF), unit="h").values, "timedelta64 column.")
_object_variant("nested_lists", lambda: pd.Series([[i, i + 1] for i in range(N_DF)], index=names("cell", N_DF)).values,
                "Object column holding lists.")
_object_variant("bytes", lambda: np.array([b"b%d" % i for i in range(N_DF)], dtype=object), "Object column holding bytes.")


@variant("obs and var with no columns at all.", ["obs:no-columns", "var:no-columns"])
def obs_no_columns():
    return make(X=float_matrix(N_DF, 4, 84), obs=pd.DataFrame(index=names("cell", N_DF)),
                var=pd.DataFrame(index=names("gene", 4)))


# ---------------------------------------------------------------- indexes and column names


@variant("Index values that look like integers ('0', '1', ...) for obs and var.", ["index:int-like"])
def index_int_like():
    obs = small_obs(N_DF)
    obs.index = [str(i) for i in range(N_DF)]
    var = small_var(4)
    var.index = [str(i) for i in range(4)]
    return df_adata(obs, var)


@variant("obs/var built with a RangeIndex; anndata converts the index to strings.", ["index:range"])
def index_range():
    obs = small_obs(N_DF).reset_index(drop=True)
    var = small_var(4).reset_index(drop=True)
    return make(X=float_matrix(N_DF, 4, 85), obs=obs, var=var)


@variant("Duplicate obs names and duplicate var names.", ["index:duplicates"])
def index_duplicates():
    obs = small_obs(N_DF)
    obs.index = ["c%d" % (i // 2) for i in range(N_DF)]
    var = small_var(4)
    var.index = ["GAPDH", "ACTB", "GAPDH", "MT-CO1"]
    return df_adata(obs, var)


@variant("Unicode and emoji index values.", ["index:unicode"])
def index_unicode():
    obs = small_obs(N_DF)
    obs.index = ["細胞-%d-\U0001F9EC" % i for i in range(N_DF)]
    var = small_var(4)
    var.index = ["Gène-%d" % i for i in range(4)]
    return df_adata(obs, var)


@variant("Index containing empty strings (one in var, two in obs).", ["index:empty-strings", "index:duplicates"])
def index_empty_strings():
    obs = small_obs(N_DF)
    obs.index = ["" if i in (2, 7) else "c%d" % i for i in range(N_DF)]
    var = small_var(4)
    var.index = ["g0", "", "g2", "g3"]
    return df_adata(obs, var)


@variant("Named indexes (obs.index.name = 'cell_id', var.index.name = 'gene_id'): the index is stored under that name.",
         ["index:named"])
def index_named():
    obs = small_obs(N_DF)
    obs.index.name = "cell_id"
    var = small_var(4)
    var.index.name = "gene_id"
    return df_adata(obs, var)


@variant("Index named like a column whose values equal the index (anndata accepts this).",
         ["index:named", "column:same-as-index"])
def index_name_equals_column():
    obs = small_obs(N_DF)
    obs.index.name = "cell_id"
    obs["cell_id"] = obs.index.values.copy()
    return df_adata(obs)


@variant("Index named like a column with different values (anndata refuses this).", ["index:named", "column:same-as-index"])
def index_name_equals_column_different():
    obs = small_obs(N_DF)
    obs.index.name = "cell_type"
    return df_adata(obs)


@variant("A column literally named '_index'.", ["column:_index"])
def column_named_underscore_index():
    obs = small_obs(N_DF)
    obs["_index"] = ["x%d" % i for i in range(N_DF)]
    return df_adata(obs)


@variant("Column names with spaces, dots, unicode, digits only, '__categories', a leading dash.",
         ["column:unusual-names"])
def column_names_unusual():
    obs = small_obs(N_DF)
    for i, name in enumerate(["with space", "dot.ted", "ünicode 細胞", "123", "__categories", "-dash",
                              "percent%", "colon:name"]):
        obs[name] = np.arange(N_DF, dtype=np.int32) + i
    return df_adata(obs)


@variant("A column name containing '/'.", ["column:slash"])
def column_name_slash():
    obs = small_obs(N_DF)
    obs["a/b"] = np.arange(N_DF, dtype=np.int32)
    return df_adata(obs)


# ---------------------------------------------------------------- obsm / varm / obsp / varp


@variant("obsm: float32 width 2, float64 width 3, float32 width 50, int32, CSR, a dataframe, special values; varm likewise.",
         ["obsm", "varm", "obsm:sparse", "obsm:dataframe"])
def obsm_varm_variants():
    n_obs, n_vars = 60, 20
    r = rng(91)
    special = with_specials(quantized(r, (n_obs, 2)).astype(np.float32), special_floats32())
    obsm = {
        "X_umap": quantized(r, (n_obs, 2)).astype(np.float32),
        "X_3d": quantized(r, (n_obs, 3)) - 5,
        "X_pca": (quantized(r, (n_obs, 50)) - 5).astype(np.float32),
        "X_int": r.integers(-5, 5, (n_obs, 4)).astype(np.int32),
        "X_sparse": sparse.csr_matrix(float_matrix(n_obs, 10, 92)),
        "X_special": special,
        "X_df": pd.DataFrame({"a": np.arange(n_obs, dtype=np.float64), "b": pd.Categorical(np.array(["u", "v"])[np.arange(n_obs) % 2])},
                             index=names("cell", n_obs)),
    }
    varm = {
        "PCs": quantized(r, (n_vars, 5)) - 5,
        "sparse": sparse.csc_matrix(float_matrix(n_vars, 6, 93)),
        "df": pd.DataFrame({"w": np.arange(n_vars, dtype=np.int64)}, index=names("gene", n_vars)),
    }
    return default_adata(float_matrix(n_obs, n_vars, 94), obsm=obsm, varm=varm)


@variant("obsm entries that are only plain arrays (no sparse/dataframe), for every writer.", ["obsm", "varm"])
def obsm_plain():
    r = rng(95)
    return default_adata(float_matrix(60, 20, 96), obsm={"X_umap": quantized(r, (60, 2)).astype(np.float32),
                                                        "X_pca": quantized(r, (60, 50)).astype(np.float32)},
                         varm={"PCs": quantized(r, (20, 3))})


@variant("A 1-D array assigned to obsm (anndata stores it as an n x 1 matrix).", ["obsm:1d"])
def obsm_1d():
    return default_adata(float_matrix(60, 20, 97), obsm={"one_d": np.arange(60, dtype=np.float32)})


@variant("An awkward array in obsm (anndata's awkward-array encoding).", ["obsm:awkward"],
         reader={"expect": "refuse", "refuse_reason": "awkward-array encoding in obsm"})
def obsm_awkward():
    import awkward as ak
    ragged = ak.Array([[float(j) for j in range(i % 4)] for i in range(60)])
    return default_adata(float_matrix(60, 20, 98), obsm={"ragged": ragged, "X_umap": np.zeros((60, 2), np.float32)})


@variant("obsp: symmetric CSR connectivities, CSR distances, CSC graph, dense matrix; varp dense and CSR.",
         ["obsp", "varp", "obsp:csc", "obsp:dense"])
def obsp_varp_variants():
    n_obs, n_vars = 60, 20
    r = rng(99)
    rows = np.repeat(np.arange(n_obs), 3)
    cols = (rows + np.tile([1, 2, 5], n_obs)) % n_obs
    weights = quantized(r, rows.size, 1.0).astype(np.float32)
    conn = sparse.csr_matrix((weights, (rows, cols)), shape=(n_obs, n_obs))
    conn = (conn + conn.T).tocsr()
    dist = sparse.csr_matrix((quantized(r, rows.size, 4.0) + 1, (rows, cols)), shape=(n_obs, n_obs))
    return default_adata(
        float_matrix(n_obs, n_vars, 100),
        obsp={"connectivities": conn, "distances": dist, "graph_csc": conn.tocsc(),
              "dense": quantized(r, (n_obs, n_obs)).astype(np.float32)},
        varp={"corr": quantized(r, (n_vars, n_vars), 1.0), "sparse": sparse.csr_matrix(float_matrix(n_vars, n_vars, 101))},
    )


# ---------------------------------------------------------------- uns


@variant("uns: title, nested dicts, numeric scalars, string array, numeric arrays, colours list, empty dict.",
         ["uns", "uns:nested", "uns:arrays"])
def uns_basic():
    uns = {
        "title": "Uns basic é",
        "nested": {"level1": {"level2": {"value": 3, "name": "deep"}}, "empty": {}},
        "int_scalar": 42,
        "np_int32": np.int32(-7),
        "float_scalar": 2.5,
        "str_array": np.array(["alpha", "beta", "gamma"], dtype=object),
        "int_array": np.arange(6, dtype=np.int64),
        "float_matrix": np.arange(6, dtype=np.float32).reshape(2, 3),
        "cell_type_colors": ["#1f77b4", "#ff7f0e", "#2ca02c"],
        "one_element": np.array([5.0]),
    }
    return default_adata(float_matrix(30, 10, 111), uns=uns)


@variant("uns: bool scalars (Python and numpy).", ["uns:bool"])
def uns_bool():
    return default_adata(float_matrix(30, 10, 112), uns={"title": "bools", "flag_true": True, "flag_np_false": np.bool_(False),
                                                        "bool_array": np.array([True, False, True])})


@variant("uns: special numeric scalars and arrays (NaN, inf, -0.0, 1e40, int64 max) and unicode keys.",
         ["uns:special-values"])
def uns_special():
    return default_adata(float_matrix(30, 10, 113), uns={
        "title": "special", "nan": np.nan, "inf": np.inf, "neg_zero": -0.0, "big": 1e40, "i64max": np.int64(2**63 - 1),
        "u64max": np.uint64(2**64 - 1), "specials": special_floats64(), "ünicode key": "value \U0001F9EC",
        "empty_string": "",
    })


@variant("uns: rank_genes_groups-style structured (record) arrays.", ["uns:recarray"])
def uns_recarray():
    r = rng(114)
    groups = ["0", "1", "2"]
    rec_names = np.rec.fromarrays([np.array(["g%d_%d" % (g, i) for i in range(4)]) for g in range(3)], names=groups)
    rec_scores = np.rec.fromarrays([r.random(4).astype(np.float32) for _ in groups], names=groups)
    rec_pvals = np.rec.fromarrays([r.random(4) for _ in groups], names=groups)
    return default_adata(float_matrix(30, 10, 115), uns={
        "title": "recarray",
        "rank_genes_groups": {"params": {"groupby": "leiden", "method": "t-test", "reference": "rest"},
                              "names": rec_names, "scores": rec_scores, "pvals": rec_pvals}})


@variant("uns: a dataframe and a sparse matrix.", ["uns:dataframe", "uns:sparse"])
def uns_dataframe():
    df = pd.DataFrame({"x": [1.5, 2.5, 3.5], "y": pd.Categorical(["a", "b", "a"])}, index=["r0", "r1", "r2"])
    return default_adata(float_matrix(30, 10, 116), uns={"title": "uns dataframe", "table": df,
                                                        "mat": sparse.csr_matrix(np.eye(3, dtype=np.float32))})


@variant("uns: title stored as a one-element string array (as older writers leave it).", ["uns:title-array"])
def uns_title_array():
    return default_adata(float_matrix(30, 10, 117), uns={"title": np.array(["Title in an array"], dtype=object)})


# ================================================================ writing

# What the older writers write. The latest release writes every variant; older releases write the
# variants whose on-disk layout differs between releases, in three tiers:
#  - CORE (h5ad and Zarr v2): every release from 0.6 to 0.11;
#  - CURRENT_ENCODING_EXTRA (h5ad): also 0.8 (first release of the current encoding) and 0.11 (last
#    before 0.12) - 0.9 and 0.10 write these elements with the same encodings, so they write CORE only;
#  - LEGACY_EXTRA (h5ad): also 0.6 and 0.7, whose layouts differ the most.
CORE_VARIANTS = {
    "scanpy_like", "x_absent", "x_dense_float32", "x_csr_float32", "x_csc_float32", "shape_0_obs",
    "raw_sparse_more_genes", "obs_numeric_dtypes", "obs_strings_edge", "obs_categoricals", "obs_cat_numeric",
    "obs_nullable_int", "obs_nullable_bool", "obs_nullable_string", "index_named", "uns_basic", "uns_recarray",
}
CURRENT_ENCODING_EXTRA = {
    "obs_cat_wide_int16", "obs_float_special", "obs_int_extremes", "index_duplicates", "obsm_varm_variants",
    "obsp_varp_variants", "uns_dataframe", "uns_title_array", "layers_mixed",
}
LEGACY_EXTRA = {
    "x_dense_int64", "x_csr_duplicates", "x_csr_special_float32", "shape_0_vars", "obs_strings_converted",
    "obs_no_columns", "obsm_plain",
}


def writes_variant(name: str, fmt: str) -> bool:
    if LATEST:
        return True
    if fmt != "h5ad" or V in ((0, 9), (0, 10)):
        return name in CORE_VARIANTS
    if V in ((0, 8), (0, 11)):
        return name in CORE_VARIANTS | CURRENT_ENCODING_EXTRA
    return name in CORE_VARIANTS | CURRENT_ENCODING_EXTRA | LEGACY_EXTRA


@contextmanager
def settings_override(values):
    if not values:
        yield
        return
    with anndata.settings.override(**values):
        yield


def applicable_settings(values: dict) -> dict:
    """The settings this anndata has; older releases simply lack the opt-ins and write their own way."""
    settings = getattr(anndata, "settings", None)
    if settings is None or not hasattr(settings, "override"):
        return {}
    return {k: v for k, v in values.items() if k in dir(settings)}


def write_elem_func():
    if hasattr(anndata, "io") and hasattr(anndata.io, "write_elem"):
        return anndata.io.write_elem
    from anndata.experimental import write_elem
    return write_elem


def applicable_write_kwargs(v: Variant, fmt: str) -> dict:
    """The write_h5ad/write_zarr keyword arguments this anndata accepts."""
    import inspect

    method = anndata.AnnData.write_h5ad if fmt == "h5ad" else anndata.AnnData.write_zarr
    accepted = inspect.signature(method).parameters
    return {k: val for k, val in v.write_kwargs.items() if k in accepted}


def write_variant(v: Variant, fmt: str, path: Path) -> None:
    adata = v.build()
    x_kwargs = v.x_kwargs() if v.x_kwargs else None
    x_value = None
    if x_kwargs is not None:
        x_value = adata.X
        adata.X = None
    settings = applicable_settings(v.settings)
    if LATEST and fmt in ("zarr2", "zarr3"):
        settings["zarr_write_format"] = 2 if fmt == "zarr2" else 3
        if fmt == "zarr3":
            settings.setdefault("auto_shard_zarr_v3", False)
    with settings_override(settings):
        write_kwargs = applicable_write_kwargs(v, fmt)
        if fmt == "h5ad":
            adata.write_h5ad(path, **write_kwargs)
        elif V < (0, 7):
            adata.write_zarr(path, None, **write_kwargs)  # 0.6 takes chunks positionally
        else:
            adata.write_zarr(path, **write_kwargs)
        if x_kwargs is not None:
            write_elem = write_elem_func()
            kwargs = dict(x_kwargs[fmt])
            if fmt == "h5ad":
                import h5py
                with h5py.File(path, "r+") as f:
                    write_elem(f, "X", x_value, dataset_kwargs=kwargs)
            else:
                import zarr
                group = zarr.open_group(str(path), mode="r+", **({"use_consolidated": False} if LATEST else {}))
                write_elem(group, "X", x_value, dataset_kwargs=kwargs)
                zarr.consolidate_metadata(str(path))


def read_back(fmt: str, path: Path):
    if fmt == "h5ad":
        return anndata.read_h5ad(path)
    return anndata.read_zarr(str(path))


def remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def clean_error(text: str, out: Path) -> str:
    text = re.sub(r" at 0x[0-9a-f]+", "", text.replace(str(out), "<writer-dir>"))
    return " ".join(text.split())


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    only = set(sys.argv[2:])
    out = root / WRITER
    if out.exists() and not only:
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    attempts = []
    for v in VARIANTS:
        if only and v.name not in only:
            continue
        for fmt in v.formats:
            if fmt not in ALL_FORMATS or not writes_variant(v.name, fmt):
                continue
            fname = v.name + FILE_SUFFIX[fmt]
            path = out / fname
            expected_path = out / (fname + ".expected.json")
            remove(path)
            remove(expected_path)
            record = {"variant": v.name, "format": fmt, "file": fname, "description": v.description,
                      "covers": v.covers}
            try:
                write_variant(v, fmt, path)
            except Exception as error:  # noqa: BLE001 - a refusal is a result
                remove(path)
                record["status"] = "writer-refused"
                record["error"] = clean_error("%s: %s" % (type(error).__name__, error), out)[:400]
                attempts.append(record)
                print("refused  %-40s %-6s %s" % (v.name, fmt, record["error"][:100]))
                continue
            try:
                document = ce.expected_document(read_back(fmt, path))
            except Exception as error:  # noqa: BLE001
                record["status"] = "written-unreadable-by-writer"
                record["error"] = clean_error("%s: %s" % (type(error).__name__, error), out)[:400]
                traceback.print_exc()
                document = None
            else:
                record["status"] = "written"
            header = {
                "schema": ce.SCHEMA_VERSION,
                "file": fname,
                "format": "h5ad" if fmt == "h5ad" else "zarr",
                "zarr_format": {"zarr2": 2, "zarr3": 3}.get(fmt),
                "writer": {"tool": "anndata", "version": ANNDATA_VERSION, "settings": applicable_settings(v.settings) or None,
                           "write_kwargs": applicable_write_kwargs(v, fmt) or None},
                "variant": v.name,
                "description": v.description,
                "covers": v.covers,
                "reader": v.reader,
                "expected_source": "read back by the writer (anndata %s)" % ANNDATA_VERSION,
            }
            if document is None:
                header["expected_source"] = None
                header["writer_readback_error"] = record["error"]
            else:
                header.update(document)
            expected_path.write_text(json.dumps(header, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n",
                                     encoding="utf-8")
            attempts.append(record)
            print("%-8s %-40s %-6s" % (record["status"][:8], v.name, fmt))
    summary_path = out / "_writer.json"
    previous = []
    if only and summary_path.exists():
        previous = [a for a in json.loads(summary_path.read_text())["attempts"]
                    if a["variant"] not in only]
    summary = {"writer": WRITER, "packages": package_versions(),
               "attempts": sorted(previous + attempts, key=lambda a: (a["variant"], a["format"]))}
    summary_path.write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
