"""Write what zarr-python reads from every browser-test Zarr store.

`tests/zarr-format-fixtures.test.mjs` checks that the web app's Zarr reader
(assets/js/formats/zip + assets/js/formats/zarr) reads every array of every
`tests/browser/fixtures/*.zarr.zip` exactly as zarr-python reads it. This
script writes the reference: `tests/browser/fixtures/zarr-fixtures.expected.json`,
one entry per archive, each node in the encoding of the conformance corpus
(`scripts/generate-zarr-conformance-corpus.py`, whose `describe()` it uses),
except that an array's values are recorded as a SHA-256 digest, which keeps
the file small while still pinning every value exactly:

- numbers and booleans: the digest of the values as little-endian bytes of
  the type the reader returns them in (float16 widened to float32, booleans
  as one byte 0/1, 64-bit integers as 64-bit integers);
- strings: the digest of each string's UTF-8 bytes, each preceded by its
  length as a little-endian 32-bit integer.

Any other element type keeps its values inline.

Run from the repository root with the Python environment that has zarr 3,
numcodecs and anndata, after regenerating any of the archives:

    python scripts/generate-zarr-browser-fixture-expected.py

Output is deterministic: archives are read in name order, nodes in path order.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import zipfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parent.parent
FIXTURES = REPOSITORY / "tests" / "browser" / "fixtures"
TARGET = FIXTURES / "zarr-fixtures.expected.json"


def corpus_module():
    path = REPOSITORY / "scripts" / "generate-zarr-conformance-corpus.py"
    spec = importlib.util.spec_from_file_location("zarr_conformance_corpus", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def store_root(directory: Path) -> Path:
    """The folder of the extracted archive that holds the store's root marker."""
    markers = (".zgroup", ".zattrs", ".zmetadata", "zarr.json")
    if any((directory / marker).exists() for marker in markers):
        return directory
    folders = [child for child in directory.iterdir() if child.is_dir()]
    if len(folders) != 1:
        raise ValueError(f"{directory}: expected one root folder, found {len(folders)}")
    return folders[0]


def digest(values) -> dict | None:
    """The digest of an array's values, or None for a type kept inline."""
    import numpy as np

    flat = np.asarray(values).reshape(-1)
    kind = flat.dtype.kind
    if kind == "b":
        data = flat.astype("u1").tobytes()
    elif kind in "iu":
        data = flat.astype(flat.dtype.newbyteorder("<")).tobytes()
    elif kind == "f":
        data = flat.astype("<f8" if flat.dtype.itemsize == 8 else "<f4").tobytes()
    elif kind in "SUOT":
        parts = []
        for value in flat:
            text = bytes(value).rstrip(b"\0") if kind == "S" else (value if isinstance(value, bytes) else str(value).encode("utf-8"))
            parts.append(len(text).to_bytes(4, "little") + text)
        data = b"".join(parts)
    else:
        return None
    return {"count": int(flat.size), "sha256": hashlib.sha256(data).hexdigest()}


def with_digests(root: Path, expected: dict) -> dict:
    import zarr

    group = zarr.open_group(str(root), mode="r", use_consolidated=False)
    for path, node in expected["nodes"].items():
        if node["kind"] != "array" or "values" not in node:
            continue
        summary = digest(group[path.lstrip("/")][...])
        if summary is not None:
            del node["values"]
            node["digest"] = summary
    return expected


def main():
    corpus = corpus_module()
    archives = sorted(FIXTURES.glob("*.zarr.zip"))
    entries = []
    for archive in archives:
        with tempfile.TemporaryDirectory() as scratch:
            with zipfile.ZipFile(archive) as opened:
                opened.extractall(scratch)
            root = store_root(Path(scratch))
            expected = with_digests(root, corpus.describe(root))
        nodes = ",\n".join(
            f"{json.dumps(path, ensure_ascii=False)}:"
            f"{json.dumps(node, sort_keys=True, ensure_ascii=False, separators=(',', ':'))}"
            for path, node in sorted(expected["nodes"].items())
        )
        entries.append(
            f'{json.dumps(archive.name)}:{{"zarr_format":{expected["zarr_format"]},"nodes":{{\n{nodes}\n}}}}'
        )
    TARGET.write_text("{\n" + ",\n".join(entries) + "\n}\n")
    print(f"wrote {TARGET.relative_to(REPOSITORY)} for {len(archives)} archives")


if __name__ == "__main__":
    sys.exit(main())
