"""Turn an AnnData object into the expected-values document of the corpus.

Shared by every writer environment (anndata 0.6.22 to 0.12, Python 3.10 to
3.12, numpy 1.21 to 2.x, pandas 1.3 to 2.x), so it sticks to APIs all of them
have. The same function is applied by ``verify_with_python.py`` to the file as
the current anndata reads it, and the two documents must agree.

The JSON schema is described in README.md ("Expected-values JSON").
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
import pandas as pd

SCHEMA_VERSION = 1
# Arrays with more elements than this are summarised instead of listed.
FULL_LIMIT = 1000
SAFE_INT = 2**53 - 1
# numpy dtype kinds that hold strings ('T' is numpy 2's StringDType)
STRING_KINDS = "OSUT"


# ---------------------------------------------------------------- scalars


def enc_float(value):
    value = float(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def enc_int(value):
    value = int(value)
    return value if -SAFE_INT <= value <= SAFE_INT else str(value)


def enc_scalar(value):
    """One numpy/python scalar in the JSON encoding used everywhere."""
    if value is None:
        return None
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return enc_int(value)
    if isinstance(value, (float, np.floating)):
        return enc_float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "surrogateescape")
    if isinstance(value, str):
        return value
    return {"repr": repr(value)}


def enc_array_values(arr: np.ndarray):
    """Flattened values of a numeric/bool/string ndarray (C order)."""
    flat = np.asarray(arr).reshape(-1)
    kind = flat.dtype.kind
    if kind == "b":
        return [bool(v) for v in flat]
    if kind in "iu":
        return [enc_int(v) for v in flat]
    if kind in "fc":
        return [enc_float(v) for v in flat]
    return [enc_scalar(v) for v in flat]


def strings_sha256(values) -> str:
    """sha256 over (uint32 LE UTF-8 byte length, UTF-8 bytes) per item; null = length 0xFFFFFFFF."""
    digest = hashlib.sha256()
    for value in values:
        if value is None:
            digest.update((0xFFFFFFFF).to_bytes(4, "little"))
            continue
        data = str(value).encode("utf-8", "surrogatepass")
        digest.update(len(data).to_bytes(4, "little"))
        digest.update(data)
    return digest.hexdigest()


def list_or_summary(values: list):
    """A list in full, or a summary when longer than FULL_LIMIT."""
    if len(values) <= FULL_LIMIT:
        return values
    out = {"count": len(values), "first5": values[:5], "last5": values[-5:]}
    if all(v is None or isinstance(v, str) for v in values):
        out["sha256_strings"] = strings_sha256(values)
    return out


# ---------------------------------------------------------------- matrices


def f64_sha256(dense: np.ndarray) -> str:
    """sha256 of the values as float64 little-endian, C order, every NaN as 0x7FF8000000000000."""
    values = np.ascontiguousarray(np.asarray(dense, dtype=np.float64))
    values = np.where(np.isnan(values), np.float64("nan"), values).astype("<f8")
    bits = values.view("<u8").copy()
    bits[np.isnan(values)] = 0x7FF8000000000000
    return hashlib.sha256(bits.tobytes()).hexdigest()


def _dense_of(matrix):
    from scipy import sparse

    if sparse.issparse(matrix):
        return np.asarray(matrix.toarray())
    return np.asarray(matrix)


def _matrix_format(matrix) -> str:
    from scipy import sparse

    if sparse.issparse(matrix):
        fmt = matrix.getformat()
        return fmt
    return "dense"


def enc_matrix(matrix) -> dict:
    """Shape, storage format, statistics and sampled values of a 1-D/2-D array or sparse matrix."""
    from scipy import sparse

    out = {"format": _matrix_format(matrix)}
    is_sparse = sparse.issparse(matrix)
    if is_sparse and out["format"] not in ("csr", "csc"):
        matrix = matrix.tocsr()
    data_dtype = matrix.dtype
    out["dtype"] = str(np.dtype(data_dtype))
    dense = _dense_of(matrix)
    out["shape"] = [int(s) for s in dense.shape]
    if is_sparse:
        out["nnz_stored"] = int(matrix.data.shape[0])
    values64 = dense.astype(np.float64) if dense.dtype.kind in "biuf" else None
    if values64 is None:
        out["values"] = enc_array_values(dense)
        return out
    finite = values64[np.isfinite(values64)]
    not_nan = values64[~np.isnan(values64)]
    out["stats"] = {
        "count_nonzero": int(np.count_nonzero(values64)),
        "n_nan": int(np.isnan(values64).sum()),
        "n_posinf": int(np.isposinf(values64).sum()),
        "n_neginf": int(np.isneginf(values64).sum()),
        "n_negzero": int(np.sum((values64 == 0) & np.signbit(values64))),
        "min": enc_scalar(dense.reshape(-1)[~np.isnan(values64.reshape(-1))].min()) if not_nan.size else None,
        "max": enc_scalar(dense.reshape(-1)[~np.isnan(values64.reshape(-1))].max()) if not_nan.size else None,
        "fsum": enc_float(math.fsum(finite.tolist())),
    }
    out["sha256_f64"] = f64_sha256(values64)
    if dense.size <= FULL_LIMIT:
        out["values"] = enc_array_values(dense)
        return out
    flat = dense.reshape(-1)
    out["first5"] = enc_array_values(flat[:5])
    out["last5"] = enc_array_values(flat[-5:])
    if dense.ndim == 2:
        n_rows, n_cols = dense.shape
        rows = sorted({0, n_rows // 2, n_rows - 1})
        cols = sorted({0, n_cols // 2, n_cols - 1})
        empty_rows = np.flatnonzero(~np.any(values64 != 0, axis=1))
        empty_cols = np.flatnonzero(~np.any(values64 != 0, axis=0))
        if empty_rows.size:
            rows = sorted(set(rows) | {int(empty_rows[0])})
        if empty_cols.size:
            cols = sorted(set(cols) | {int(empty_cols[0])})
        out["rows"] = {str(r): enc_array_values(dense[r]) for r in rows}
        out["cols"] = {str(c): enc_array_values(dense[:, c]) for c in cols}
    return out


# ---------------------------------------------------------------- dataframes


def _nullable_kind(dtype) -> str | None:
    name = str(dtype)
    if name in ("Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64"):
        return "nullable-integer"
    if name in ("Float32", "Float64"):
        return "nullable-float"
    if name == "boolean":
        return "nullable-boolean"
    if name.startswith("string"):
        return "nullable-string"
    return None


def _values_of_series(series: pd.Series) -> list:
    return [enc_scalar(v) if not _is_missing(v) else None for v in series.tolist()]


def _is_missing(value) -> bool:
    if value is None or value is pd.NA or value is pd.NaT:
        return True
    return False


def enc_categories(categories: pd.Index) -> dict:
    values = np.asarray(categories)
    kind = values.dtype.kind
    if kind in STRING_KINDS and all(isinstance(v, (str, bytes)) for v in values):
        kind_name = "string"
    elif kind == "b":
        kind_name = "bool"
    elif kind in "iu":
        kind_name = "integer"
    elif kind == "f":
        kind_name = "float"
    elif kind == "O" and all(isinstance(v, (bool, np.bool_)) for v in values):
        kind_name = "bool"
    else:
        kind_name = "object:" + values.dtype.str
    return {"kind": kind_name, "dtype": str(categories.dtype), "values": list_or_summary(enc_array_values(values))}


def enc_column(series: pd.Series) -> dict:
    dtype = series.dtype
    if isinstance(dtype, pd.CategoricalDtype):
        codes = np.asarray(series.cat.codes)
        return {
            "kind": "categorical",
            "ordered": bool(dtype.ordered),
            "categories": enc_categories(dtype.categories),
            "codes": list_or_summary([int(c) for c in codes]),
        }
    nullable = _nullable_kind(dtype)
    if nullable is not None:
        return {"kind": nullable, "dtype": str(dtype), "values": list_or_summary(_values_of_series(series))}
    values = np.asarray(series)
    if values.dtype.kind == "b":
        return {"kind": "bool", "dtype": "bool", "values": list_or_summary(enc_array_values(values))}
    if values.dtype.kind in "iuf":
        return {"kind": "numeric", "dtype": str(values.dtype), "values": list_or_summary(enc_array_values(values))}
    if values.dtype.kind in STRING_KINDS:
        items = series.tolist()
        if all(_is_missing(v) or isinstance(v, (str, bytes)) or (isinstance(v, float) and math.isnan(v)) for v in items):
            out = [None if (_is_missing(v) or isinstance(v, float)) else enc_scalar(v) for v in items]
            return {"kind": "string", "dtype": str(values.dtype), "values": list_or_summary(out)}
    return {"kind": "other", "dtype": str(dtype), "values": list_or_summary([repr(v) for v in series.tolist()])}


def enc_dataframe(df: pd.DataFrame) -> dict:
    index = [enc_scalar(v) for v in df.index.tolist()]
    return {
        "n_rows": int(df.shape[0]),
        "index_name": None if df.index.name is None else str(df.index.name),
        "index": list_or_summary(index),
        "columns": [dict(name=str(name), **enc_column(df[name])) for name in df.columns],
    }


# ---------------------------------------------------------------- uns and mappings


def enc_value(value) -> dict:
    """A typed tree for uns-like values."""
    from scipy import sparse

    if isinstance(value, dict) or (hasattr(value, "keys") and hasattr(value, "__getitem__") and not isinstance(value, (pd.DataFrame, np.ndarray))):
        return {"t": "dict", "v": {str(k): enc_value(value[k]) for k in value.keys()}}
    if isinstance(value, pd.DataFrame):
        return {"t": "dataframe", "v": enc_dataframe(value)}
    if sparse.issparse(value):
        return {"t": "sparse", "v": enc_matrix(value)}
    if isinstance(value, (str, bytes)):
        return {"t": "str", "v": enc_scalar(value)}
    if isinstance(value, (bool, np.bool_)):
        return {"t": "bool", "v": bool(value)}
    if isinstance(value, (int, float, np.integer, np.floating)):
        # Only the kind: whether a 0-d dataset comes back as a numpy or a Python scalar is the
        # reader's choice; the stored dtype is in the storage section.
        return {"t": "num", "kind": "int" if isinstance(value, (int, np.integer)) else "float", "v": enc_scalar(value)}
    if value is None:
        return {"t": "none"}
    if isinstance(value, (list, tuple)):
        try:
            value = np.asarray(value)
        except Exception:  # noqa: BLE001 - ragged lists stay "other"
            return {"t": "other", "type": type(value).__name__}
    if isinstance(value, np.ndarray):
        if value.dtype.names:
            fields = {}
            for name in value.dtype.names:
                column = np.asarray(value[name])
                fields[name] = {"dtype": column.dtype.str, "values": list_or_summary(enc_array_values(column))}
            return {"t": "records", "shape": [int(s) for s in value.shape], "fields": fields}
        if value.dtype.kind in STRING_KINDS:
            return {"t": "strings", "shape": [int(s) for s in value.shape],
                    "v": list_or_summary(enc_array_values(value))}
        if value.ndim == 0:
            return {"t": "num0d", "dtype": str(value.dtype), "v": enc_scalar(value[()])}
        if value.size <= FULL_LIMIT:
            return {"t": "array", "dtype": str(value.dtype), "shape": [int(s) for s in value.shape],
                    "v": enc_array_values(value)}
        return {"t": "array", "dtype": str(value.dtype), "v": enc_matrix(value)}
    return {"t": "other", "type": type(value).__module__ + "." + type(value).__name__}


def enc_aligned(value) -> dict:
    """An obsm/varm/obsp/varp/layers entry."""
    from scipy import sparse

    if isinstance(value, pd.DataFrame):
        return {"t": "dataframe", "v": enc_dataframe(value)}
    if sparse.issparse(value) or isinstance(value, np.ndarray):
        return {"t": "matrix", "v": enc_matrix(value)}
    try:
        return {"t": "matrix", "v": enc_matrix(np.asarray(value))}
    except Exception:  # noqa: BLE001
        return {"t": "other", "type": type(value).__module__ + "." + type(value).__name__}


def enc_mapping(mapping) -> dict:
    if mapping is None:
        return {}
    keys = list(mapping.keys())
    return {str(k): enc_aligned(mapping[k]) for k in keys}


def _uns_title(uns):
    if uns is None or "title" not in uns:
        return None
    title = uns["title"]
    if isinstance(title, np.ndarray):
        title = title.reshape(-1)[0] if title.size == 1 else title.tolist()
    return enc_scalar(title) if not isinstance(title, list) else title


def expected_document(adata) -> dict:
    """Every value the reader is checked against, from an in-memory AnnData."""
    X = adata.X
    raw = adata.raw
    doc = {
        "n_obs": int(adata.n_obs),
        "n_vars": int(adata.n_vars),
        "obs": enc_dataframe(adata.obs),
        "var": enc_dataframe(adata.var),
        "X": None if X is None else enc_matrix(X),
        "layers": enc_mapping(getattr(adata, "layers", None)),
        "obsm": enc_mapping(getattr(adata, "obsm", None)),
        "varm": enc_mapping(getattr(adata, "varm", None)),
        "obsp": enc_mapping(getattr(adata, "obsp", None)),
        "varp": enc_mapping(getattr(adata, "varp", None)),
        "raw": None,
        "uns_title": _uns_title(adata.uns),
        "uns": enc_value(dict(adata.uns))["v"] if adata.uns is not None else {},
    }
    if raw is not None:
        doc["raw"] = {
            "n_vars": int(raw.n_vars),
            "var": enc_dataframe(raw.var),
            "X": None if raw.X is None else enc_matrix(raw.X),
            "varm": enc_mapping(getattr(raw, "varm", None)),
        }
    return doc


# ---------------------------------------------------------------- comparison


def normalise(value):
    """The value as it reads back from JSON (tuples become lists, and so on)."""
    import json

    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def differences(expected, actual, path="", out=None):
    """Every place two expected-values trees differ, as 'path: what' lines."""
    import json as _json

    out = [] if out is None else out
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in list(expected) + [k for k in actual if k not in expected]:
            if key not in expected or key not in actual:
                out.append("%s/%s: %s" % (path, key, "missing in file" if key not in actual else "unexpected"))
            else:
                differences(expected[key], actual[key], "%s/%s" % (path, key), out)
    elif isinstance(expected, list) and isinstance(actual, list) and len(expected) == len(actual):
        for i, (a, b) in enumerate(zip(expected, actual, strict=True)):
            differences(a, b, "%s[%d]" % (path, i), out)
    elif type(expected) is not type(actual) or expected != actual:
        out.append("%s: expected %s, read %s" % (path, _json.dumps(expected, ensure_ascii=False)[:80],
                                                 _json.dumps(actual, ensure_ascii=False)[:80]))
    return out
