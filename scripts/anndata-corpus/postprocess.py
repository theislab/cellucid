"""Finish the corpus with the latest anndata, after every writer has run.

1. Writes ``emulated/``: layouts other tools leave behind, made by editing or
   re-creating files the real writers produced (SeuratDisk's partial
   column-order, h5sparse markers, pre-0.6.20 compound obsm, HDF5 files
   written with libver='latest' or with creation-order tracking).
2. Fills in expected values the writer could not compute because it could
   not read its own file back: those come from the current anndata instead.
3. Records where the current anndata reads an old layout differently from
   the release that wrote it (KNOWN_CURRENT_DIFFERENCES / _UNREADABLE).
4. Adds a ``storage`` section to every expected-values file: the on-disk
   layout (dtype, shape, chunks, filters/codecs, attributes) of every node.
5. Writes ``index.json``: every fixture and every refused variant.

    <latest venv>/bin/python postprocess.py <fixtures/anndata>
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
import warnings
from pathlib import Path

import anndata
import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corpus_expected as ce  # noqa: E402

warnings.simplefilter("ignore")
# zarr-python logs a failed background read (the json2 stores) besides raising it; the raise is enough.
logging.getLogger("asyncio").setLevel(logging.CRITICAL)

EMULATED = "emulated"
DOC_KEYS = ("n_obs", "n_vars", "obs", "var", "X", "layers", "obsm", "varm", "obsp", "varp", "raw", "uns_title", "uns")

# Old layouts the current anndata reads differently from the release that wrote them. The expected
# values keep what the writing release read back; these path prefixes record where the current
# anndata disagrees, and why.
KNOWN_CURRENT_DIFFERENCES = {
    "anndata-0.6.22.post1": {
        "uns/": "anndata 0.6 stored every uns scalar as a one-element array and unwrapped it on reading; "
                "the current anndata returns the one-element array.",
        "raw/var/": "anndata 0.6 stored raw.var categoricals as integer codes in the compound raw.var dataset "
                    "with the categories in uns['<column>_categories']; the current anndata returns the codes.",
    },
}
# Old layouts the current anndata cannot read at all, although the writing release read them back.
KNOWN_CURRENT_UNREADABLE = {
    ("anndata-0.6.22.post1", "zarr"): (
        "anndata 0.6 wrote obs/var as a structured Zarr array whose string fields use the 'json2' object "
        "codec, which zarr-python 3 cannot decode.",
        {"expect": "read-or-refuse", "refuse_reason": "zarr v2 object codec 'json2' (anndata 0.6 structured obs/var)"}),
}


# ================================================================ helpers


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, document: dict) -> None:
    path.write_text(json.dumps(document, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf-8")


def read_current(path: Path):
    if path.suffix == ".h5ad":
        return anndata.read_h5ad(path)
    return anndata.read_zarr(str(path))


def writer_dirs(root: Path):
    return sorted(p for p in root.iterdir() if p.is_dir() and p.name.startswith("anndata-"))


# ================================================================ storage layout


def _json_attr(value, file=None):
    if isinstance(value, h5py.Reference):
        return {"object_reference": file[value].name if value else None}
    if isinstance(value, bytes):
        return value.decode("utf-8", "surrogateescape")
    if isinstance(value, np.ndarray):
        return [_json_attr(v, file) for v in value.tolist()] if value.dtype.kind in "OSU" else ce.enc_array_values(value)
    if isinstance(value, (list, tuple)):
        return [_json_attr(v, file) for v in value]
    if isinstance(value, (np.generic, int, float, bool)):
        return ce.enc_scalar(value)
    if isinstance(value, h5py.Empty):
        return {"empty": str(value.dtype)}
    return value


def h5_dtype(dtype: np.dtype):
    string = h5py.check_string_dtype(dtype)
    if string is not None:
        kind = "vlen-str" if string.length is None else "fixed-str[%d]" % string.length
        return "%s(%s)" % (kind, string.encoding)
    enum = h5py.check_enum_dtype(dtype)
    if enum is not None:
        return "enum(%s,%s)" % (dtype.str, ",".join("%s=%d" % kv for kv in sorted(enum.items(), key=lambda kv: kv[1])))
    vlen = h5py.check_vlen_dtype(dtype)
    if vlen is not None:
        return "vlen(%s)" % h5_dtype(vlen)
    if dtype.names:
        return [[name, h5_dtype(dtype.fields[name][0])] for name in dtype.names]
    if dtype.subdtype is not None:
        base, shape = dtype.subdtype
        return {"base": h5_dtype(base), "shape": list(shape)}
    return dtype.str


H5_LAYOUT = {h5py.h5d.COMPACT: "compact", h5py.h5d.CONTIGUOUS: "contiguous", h5py.h5d.CHUNKED: "chunked"}


def _finish(nodes: dict, path: str, entry: dict, attrs: dict) -> None:
    """Fold anndata's encoding attributes into 'encoding', drop empty fields, store under the path."""
    attrs = dict(attrs)
    if "encoding-type" in attrs:
        entry["encoding"] = "%s@%s" % (attrs.pop("encoding-type"), attrs.pop("encoding-version", "?"))
    if attrs:
        entry["attrs"] = attrs
    nodes[path] = {k: v for k, v in entry.items() if v is not None}


def h5_storage(path: Path) -> dict:
    with open(path, "rb") as raw:
        head = raw.read(9)
    nodes = {}
    out = {"superblock_version": head[8] if head[:8] == b"\x89HDF\r\n\x1a\n" else None, "nodes": nodes}
    with h5py.File(path, "r") as f:
        def node(name, obj):
            attrs = {k: _json_attr(obj.attrs[k], f) for k in sorted(obj.attrs.keys())}
            plist = obj.id.get_create_plist()
            if isinstance(obj, h5py.Group):
                entry = {"type": "group", "track_order": True if plist.get_link_creation_order() else None}
            else:
                entry = {"type": "array", "dtype": h5_dtype(obj.dtype),
                         "shape": None if obj.shape is None else list(obj.shape),
                         "layout": H5_LAYOUT.get(plist.get_layout(), str(plist.get_layout()))}
                if obj.chunks is not None:
                    entry["chunks"] = list(obj.chunks)
                if obj.maxshape is not None and obj.shape is not None and tuple(obj.maxshape) != tuple(obj.shape):
                    entry["maxshape"] = [None if m is None else int(m) for m in obj.maxshape]
                filters = []
                for i in range(plist.get_nfilters()):
                    code, _flags, values, fname = plist.get_filter(i)
                    fname = fname.decode() if isinstance(fname, bytes) else fname
                    filters.append("%s(id=%d,values=%s)" % (fname, code, list(int(v) for v in values)))
                entry["filters"] = filters or None
            _finish(nodes, "/" + name, entry, attrs)

        node("", f)
        names = []
        f.visit(names.append)
        for name in sorted(names):
            node(name, f[name])
    return out


def codec_text(codec) -> str | None:
    """A zarr v2 compressor/filter or v3 codec as 'name(key=value,...)'."""
    if codec is None:
        return None
    if "id" in codec:
        name, config = codec["id"], {k: v for k, v in codec.items() if k != "id"}
    else:
        name, config = codec["name"], dict(codec.get("configuration") or {})
    if name == "sharding_indexed":
        inner = ",".join(codec_text(c) for c in config.get("codecs", []))
        index = ",".join(codec_text(c) for c in config.get("index_codecs", []))
        return "sharding_indexed(chunk_shape=%s,codecs=[%s],index_codecs=[%s],index_location=%s)" % (
            "x".join(str(n) for n in config["chunk_shape"]), inner, index, config.get("index_location", "end"))
    return "%s(%s)" % (name, ",".join("%s=%s" % (k, json.dumps(config[k])) for k in sorted(config)))


def zarr_storage(path: Path) -> dict:
    nodes = {}
    out = {"zarr_format": None, "consolidated": False, "nodes": nodes}
    for directory in sorted([path] + [p for p in path.rglob("*") if p.is_dir()]):
        rel = "/" if directory == path else "/" + directory.relative_to(path).as_posix()
        if (directory / "zarr.json").exists():
            meta = json.loads((directory / "zarr.json").read_text())
            out["zarr_format"] = 3
            attrs = meta.get("attributes") or {}
            if directory == path and meta.get("consolidated_metadata"):
                out["consolidated"] = True
            if meta["node_type"] == "group":
                entry = {"type": "group"}
            else:
                encoding = meta["chunk_key_encoding"]
                separator = (encoding.get("configuration") or {}).get("separator", "/" if encoding["name"] == "default" else ".")
                chunk_dir = directory / "c" if encoding["name"] == "default" else directory
                entry = {
                    "type": "array", "dtype": meta["data_type"], "shape": meta["shape"],
                    "chunks": meta["chunk_grid"]["configuration"]["chunk_shape"],
                    "chunk_key_encoding": encoding["name"] + separator, "fill_value": meta["fill_value"],
                    "codecs": [codec_text(c) for c in meta["codecs"]], "dimension_names": meta.get("dimension_names"),
                    "stored_chunk_files": sum(1 for p in chunk_dir.rglob("*") if p.is_file() and p.name != "zarr.json")
                    if chunk_dir.exists() else 0,
                }
        elif (directory / ".zgroup").exists() or (directory / ".zarray").exists():
            out["zarr_format"] = 2
            attrs = json.loads((directory / ".zattrs").read_text()) if (directory / ".zattrs").exists() else {}
            if directory == path and (directory / ".zmetadata").exists():
                out["consolidated"] = True
            if not (directory / ".zarray").exists():
                entry = {"type": "group"}
            else:
                meta = json.loads((directory / ".zarray").read_text())
                entry = {"type": "array", "dtype": meta["dtype"], "shape": meta["shape"], "chunks": meta["chunks"],
                         "order": meta["order"], "fill_value": meta["fill_value"],
                         "dimension_separator": meta.get("dimension_separator"),
                         "compressor": codec_text(meta.get("compressor")),
                         "filters": [codec_text(c) for c in meta["filters"]] if meta.get("filters") else None,
                         "stored_chunk_files": sum(1 for p in directory.rglob("*")
                                                   if p.is_file() and not p.name.startswith(".z"))}
        else:
            continue
        _finish(nodes, rel, entry, attrs)
    return out


def storage_of(path: Path) -> dict:
    return h5_storage(path) if path.suffix == ".h5ad" else zarr_storage(path)


# ================================================================ emulated layouts


def copy_attrs(source, target) -> None:
    for key in source.attrs.keys():
        attr_id = source.attrs.get_id(key)
        target.attrs.create(key, source.attrs[key], dtype=attr_id.dtype)


def recreate_h5(source: Path, target: Path, **file_kwargs) -> None:
    """Rewrite every object of an HDF5 file into a new file opened with ``file_kwargs``,
    keeping each dataset's dtype, chunks, filters and maxshape."""
    track_order = file_kwargs.get("track_order")
    with h5py.File(source, "r") as src, h5py.File(target, "w", **file_kwargs) as dst:
        copy_attrs(src, dst)

        def copy_group(sg, dg):
            for name in sg.keys():
                obj = sg[name]
                if isinstance(obj, h5py.Group):
                    ng = dg.create_group(name, track_order=track_order)
                    copy_attrs(obj, ng)
                    copy_group(obj, ng)
                    continue
                if obj.shape is None:
                    nd = dg.create_dataset(name, data=h5py.Empty(obj.dtype))
                else:
                    kwargs = {"dtype": obj.dtype}
                    if obj.chunks is not None:
                        kwargs.update(chunks=obj.chunks, maxshape=obj.maxshape, compression=obj.compression,
                                      compression_opts=obj.compression_opts, shuffle=obj.shuffle,
                                      fletcher32=obj.fletcher32, scaleoffset=obj.scaleoffset)
                    nd = dg.create_dataset(name, data=obj[()], **kwargs)
                copy_attrs(obj, nd)

        copy_group(src, dst)


def emulate(root: Path) -> list:
    """Make the emulated files; returns (file, source expected file, description, covers, reader) tuples."""
    out_dir = root / EMULATED
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir()
    made = []
    w07 = root / "anndata-0.7.8"
    w06 = root / "anndata-0.6.22.post1"
    w12 = root / "anndata-0.12.19"

    # SeuratDisk Convert(): column-order lists only some of the columns present in the group.
    target = out_dir / "seuratdisk_partial_column_order.h5ad"
    shutil.copyfile(w07 / "scanpy_like.h5ad", target)
    with h5py.File(target, "r+") as f:
        f["obs"].attrs["column-order"] = np.array(["cell_type", "n_counts"], dtype=object)
    made.append((target, w07 / "scanpy_like.h5ad",
                 "anndata 0.7.8 file whose obs column-order lists only 'cell_type' and 'n_counts' while the group "
                 "holds more columns, as SeuratDisk's Convert() leaves it. anndata reads only the listed columns.",
                 ["emulated:seuratdisk", "column-order:partial", "layout:0.7"], {"expect": "read"}))

    # h5sparse-era sparse matrix: h5sparse_format / h5sparse_shape instead of encoding attributes.
    target = out_dir / "h5sparse_markers.h5ad"
    shutil.copyfile(w07 / "x_csr_float32.h5ad", target)
    with h5py.File(target, "r+") as f:
        X = f["X"]
        shape = np.array(X.attrs["shape"])
        for key in ("encoding-type", "encoding-version", "shape"):
            del X.attrs[key]
        X.attrs["h5sparse_format"] = "csr"
        X.attrs["h5sparse_shape"] = shape
    made.append((target, w07 / "x_csr_float32.h5ad",
                 "anndata 0.7.8 CSR X relabelled the h5sparse way (h5sparse_format='csr', h5sparse_shape).",
                 ["emulated:h5sparse", "X:csr", "layout:0.7"], {"expect": "read"}))

    # anndata before 0.6.20: obsm as one compound dataset with a member per embedding.
    target = out_dir / "obsm_compound_06.h5ad"
    shutil.copyfile(w06 / "obsm_plain.h5ad", target)
    with h5py.File(target, "r+") as f:
        members = {k: f["obsm"][k][()] for k in f["obsm"].keys()}
        del f["obsm"]
        n = next(iter(members.values())).shape[0]
        records = np.zeros(n, dtype=[(k, v.dtype, (v.shape[1],)) for k, v in members.items()])
        for k, v in members.items():
            records[k] = v
        f.create_dataset("obsm", data=records)
    made.append((target, w06 / "obsm_plain.h5ad",
                 "anndata 0.6.22 file with obsm rewritten as one compound dataset (one member per embedding), "
                 "the layout of anndata before 0.6.20.",
                 ["emulated:obsm-compound", "layout:0.6"], {"expect": "read"}))

    # HDF5 written with libver='latest': version-2 object headers, new-style groups, and chunk indexes
    # chosen by maxshape (single chunk / fixed array / extensible array / version-2 B-tree).
    for name, description in [
        ("scanpy_like", "the Scanpy-like object"),
        ("x_dense_h5_chunk_square", "dense X in 16x16 chunks (fixed-array chunk index)"),
        ("x_dense_h5_resizable", "dense X with two unlimited dimensions (version-2 B-tree chunk index)"),
        ("x_csr_h5_chunked_gzip", "gzip CSR X with resizable 1-D arrays (extensible-array chunk index)"),
    ]:
        target = out_dir / ("libver_latest_%s.h5ad" % name)
        recreate_h5(w12 / (name + ".h5ad"), target, libver="latest")
        made.append((target, w12 / (name + ".h5ad"),
                     "anndata 0.12.19 file re-created object by object with h5py libver='latest': %s." % description,
                     ["emulated:libver-latest", "h5:superblock-v3"], {"expect": "read"}))

    target = out_dir / "track_order_scanpy_like.h5ad"
    recreate_h5(w12 / "scanpy_like.h5ad", target, track_order=True)
    made.append((target, w12 / "scanpy_like.h5ad",
                 "anndata 0.12.19 Scanpy-like file re-created with track_order=True on the file and every group "
                 "(creation-order indexed links).",
                 ["emulated:track-order"], {"expect": "read"}))
    return made


# ================================================================ README matrix

FORMAT_LABEL = {"h5ad": "h5ad", "zarr2": "v2", "zarr3": "v3"}
MATRIX_START = "<!-- variant-matrix:start (written by postprocess.py) -->"
MATRIX_END = "<!-- variant-matrix:end -->"


def _reader_text(reader: dict) -> str:
    if reader["expect"] == "read":
        return "read exactly"
    if reader["expect"] == "refuse":
        return "refuse, naming %s" % reader["refuse_reason"]
    return "read exactly, or refuse naming %s" % reader["refuse_reason"]


def write_readme_matrix(root: Path, readme: Path) -> None:
    """Regenerate the variant tables of README.md from what is actually in the corpus."""
    writers = writer_dirs(root)
    writers.sort(key=lambda p: [int(x) for x in p.name.split("-")[1].split(".")[:2]], reverse=True)
    rows = {}
    for directory in writers:
        attempts = load(directory / "_writer.json")["attempts"]
        for attempt in attempts:
            row = rows.setdefault(attempt["variant"], {"description": attempt["description"], "covers": attempt["covers"],
                                                       "cells": {}, "reader": None, "notes": set()})
            label = FORMAT_LABEL[attempt["format"]]
            cell = row["cells"].setdefault(directory.name, [])
            if attempt["status"] == "writer-refused":
                cell.append("~~%s~~" % label)
                continue
            cell.append(label)
            doc = load(directory / (attempt["file"] + ".expected.json"))
            if directory.name.startswith("anndata-0.12") or row["reader"] is None:
                row["reader"] = _reader_text(doc["reader"]) if not doc.get("current_anndata_unreadable") else row["reader"]
            short = directory.name.replace("anndata-", "")
            if doc.get("current_anndata_differs"):
                row["notes"].add("%s %s: current anndata differs at %s" % (
                    short, label, ", ".join("`%s`" % k for k in sorted(doc["current_anndata_differs"]))))
            if doc.get("current_anndata_unreadable"):
                row["notes"].add("%s %s: %s" % (short, label, _reader_text(doc["reader"])))
    counts = ["| Writer | h5ad | Zarr v2 | Zarr v3 | refused attempts |", "|---|---|---|---|---|"]
    for directory in writers + [root / EMULATED]:
        names = [p.name for p in directory.glob("*.expected.json")]
        refused = 0
        if (directory / "_writer.json").exists():
            refused = sum(1 for a in load(directory / "_writer.json")["attempts"] if a["status"] == "writer-refused")
        counts.append("| %s | %d | %d | %d | %d |" % (
            directory.name, sum(n.endswith(".h5ad.expected.json") for n in names),
            sum(n.endswith(".v2.zarr.expected.json") for n in names),
            sum(n.endswith(".v3.zarr.expected.json") for n in names), refused))
    total_bytes = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    # As committed (pack.py): one archive per writer, beside index.json.
    archives = sum(1 for p in root.iterdir() if p.is_dir())
    counts += ["", "%d fixtures, %.1f MB unpacked, kept as %d writer archives and index.json." % (
        sum(1 for _ in root.rglob("*.expected.json")), total_bytes / 1e6, archives), ""]
    header = "| Variant | What it holds | " + " | ".join(d.name.replace("anndata-", "") for d in writers) + " | Reader must |"
    lines = counts + [header, "|" + "---|" * (len(writers) + 3)]
    for name in sorted(rows):
        row = rows[name]
        cells = [" ".join(row["cells"].get(d.name, [])) or "" for d in writers]
        reader = row["reader"] or "n/a: every writer refused"
        if row["notes"]:
            reader += "; " + "; ".join(sorted(row["notes"]))
        lines.append("| `%s` | %s | %s | %s |" % (name, row["description"].replace("|", "\\|"), " | ".join(cells), reader))
    lines += ["", "Emulated layouts (`emulated/`, made from real writer output by `postprocess.py`):", "",
              "| File | What it is | Reader must |", "|---|---|---|"]
    for expected_path in sorted((root / EMULATED).glob("*.expected.json")):
        doc = load(expected_path)
        lines.append("| `%s` | %s | %s |" % (doc["file"], doc["description"], _reader_text(doc["reader"])))
    text = readme.read_text(encoding="utf-8") if readme.exists() else MATRIX_START + "\n" + MATRIX_END + "\n"
    start, end = text.index(MATRIX_START) + len(MATRIX_START), text.index(MATRIX_END)
    readme.write_text(text[:start] + "\n\n" + "\n".join(lines) + "\n\n" + text[end:], encoding="utf-8")


# ================================================================ main


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    current = anndata.__version__

    # 1. emulated layouts
    for target, source, description, covers, reader in emulate(root):
        source_doc = load(source.parent / (source.name + ".expected.json"))
        header = {
            "schema": ce.SCHEMA_VERSION, "file": target.name, "format": "h5ad", "zarr_format": None,
            "writer": {"tool": "emulated", "base_writer": source_doc["writer"], "base_file":
                       "%s/%s" % (source.parent.name, source.name)},
            "variant": target.name[: -len(".h5ad")], "description": description, "covers": covers, "reader": reader,
        }
        try:
            document = ce.expected_document(read_current(target))
            header["expected_source"] = "read back by the current anndata (%s)" % current
        except Exception as error:  # noqa: BLE001
            document = {k: v for k, v in source_doc.items() if k in (
                "n_obs", "n_vars", "obs", "var", "X", "layers", "obsm", "varm", "obsp", "varp", "raw", "uns_title", "uns")}
            header["expected_source"] = ("values of the base file (the edit does not change them); "
                                         "anndata %s cannot read this file: %s: %s" % (current, type(error).__name__, error))
        header.update(document)
        dump(target.parent / (target.name + ".expected.json"), header)
        print("emulated", target.name, "-", header["expected_source"][:60])

    # 2. expected values the writer could not compute
    for directory in writer_dirs(root):
        for expected_path in sorted(directory.glob("*.expected.json")):
            doc = load(expected_path)
            if doc.get("expected_source"):
                continue
            target = directory / doc["file"]
            try:
                document = ce.expected_document(read_current(target))
            except Exception as error:  # noqa: BLE001
                doc["expected_source"] = None
                doc["current_anndata_error"] = "%s: %s" % (type(error).__name__, error)
                print("UNREADABLE", directory.name, doc["file"], doc["current_anndata_error"][:100])
            else:
                doc["expected_source"] = "read back by the current anndata (%s); the writer could not read it: %s" % (
                    current, doc.get("writer_readback_error"))
                doc.update(document)
                print("filled  ", directory.name, doc["file"])
            dump(expected_path, doc)

    # 3. where the current anndata reads an old layout differently (or not at all)
    for directory in writer_dirs(root):
        prefixes = KNOWN_CURRENT_DIFFERENCES.get(directory.name, {})
        for expected_path in sorted(directory.glob("*.expected.json")):
            doc = load(expected_path)
            doc.pop("current_anndata_differs", None)
            doc.pop("current_anndata_unreadable", None)
            unreadable = KNOWN_CURRENT_UNREADABLE.get((directory.name, doc["format"]))
            if not prefixes and not unreadable:
                continue
            try:
                current_doc = ce.normalise(ce.expected_document(read_current(directory / doc["file"])))
            except Exception:  # noqa: BLE001
                if unreadable:
                    doc["current_anndata_unreadable"] = unreadable[0]
                    doc["reader"] = unreadable[1]
                dump(expected_path, doc)
                continue
            found = []
            for key in DOC_KEYS:
                ce.differences(doc.get(key), current_doc.get(key), key, found)
            matched = {k: v for k, v in prefixes.items() if any(line.startswith(k) for line in found)}
            if matched:
                doc["current_anndata_differs"] = matched
            dump(expected_path, doc)

    # 4. storage section + 5. index
    index = {"schema": ce.SCHEMA_VERSION, "fixtures": [], "refused": []}
    for directory in writer_dirs(root) + [root / EMULATED]:
        for expected_path in sorted(directory.glob("*.expected.json")):
            doc = load(expected_path)
            doc.pop("storage", None)
            doc["storage"] = storage_of(directory / doc["file"])
            dump(expected_path, doc)
            index["fixtures"].append({
                "path": "%s/%s" % (directory.name, doc["file"]),
                "expected": "%s/%s" % (directory.name, expected_path.name),
                "writer": directory.name, "variant": doc["variant"], "format": doc["format"],
                "zarr_format": doc["zarr_format"], "reader": doc["reader"], "covers": doc["covers"],
            })
        summary = directory / "_writer.json"
        if summary.exists():
            for attempt in load(summary)["attempts"]:
                if attempt["status"] == "writer-refused":
                    index["refused"].append({"writer": directory.name, "variant": attempt["variant"],
                                             "format": attempt["format"], "error": attempt["error"]})
    (root / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("index: %d fixtures, %d refused attempts" % (len(index["fixtures"]), len(index["refused"])))
    write_readme_matrix(root, Path(__file__).resolve().parent / "README.md")


if __name__ == "__main__":
    main()
