"""Pack the corpus for the repository, and unpack it again.

Two levels, so the repository holds one archive per writer instead of
seventeen thousand small files:

1. every Zarr store becomes one uncompressed ZIP (`<variant>.v2.zarr.zip`,
   the store at the top level, as zarr's own ZipStore writes it); the reader
   tests open it both as an archive and, unpacked in memory, as a picked
   folder;
2. every writer folder (`anndata-<version>/`, `emulated/`) becomes one
   deflated ZIP of its files (`anndata-<version>.zip`); `index.json` stays
   beside them, its paths still `anndata-<version>/<file>`, which the tests
   read from the writer's archive.

The ZIPs are deterministic: entries in sorted order, a fixed time and mode.

    python pack.py pack   <fixtures/anndata>
    python pack.py unpack <fixtures/anndata>
"""

from __future__ import annotations

import contextlib
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def _rewrite_index(root: Path, rename) -> None:
    index_path = root / "index.json"
    if not index_path.exists():
        return
    index = json.loads(index_path.read_text(encoding="utf-8"))
    for entry in index["fixtures"]:
        if entry["format"] == "zarr":
            entry["path"] = rename(entry["path"])
    index_path.write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def zip_store(folder: Path, target: Path, compression: int = zipfile.ZIP_STORED) -> None:
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    with zipfile.ZipFile(target, "w", compression=compression, compresslevel=9) as archive:
        for path in files:
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), date_time=ZIP_TIME)
            info.external_attr = 0o644 << 16
            info.compress_type = compression
            archive.writestr(info, path.read_bytes(), compresslevel=9)


def pack(root: Path) -> None:
    folders = sorted(p for p in root.rglob("*.zarr") if p.is_dir())
    for folder in folders:
        zip_store(folder, folder.with_name(folder.name + ".zip"))
        shutil.rmtree(folder)
    _rewrite_index(root, lambda path: path if path.endswith(".zip") else path + ".zip")
    writers = sorted(p for p in root.iterdir() if p.is_dir())
    for writer in writers:
        zip_store(writer, writer.with_name(writer.name + ".zip"), zipfile.ZIP_DEFLATED)
        shutil.rmtree(writer)
    print("packed %d Zarr stores into %d writer archives" % (len(folders), len(writers)))


def unpack(root: Path) -> None:
    for writer in sorted(p for p in root.glob("*.zip")):
        with zipfile.ZipFile(writer) as zf:
            zf.extractall(writer.with_suffix(""))
        writer.unlink()
    archives = sorted(root.rglob("*.zarr.zip"))
    for archive in archives:
        folder = archive.with_suffix("")
        shutil.rmtree(folder, ignore_errors=True)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(folder)
        archive.unlink()
    _rewrite_index(root, lambda path: path[: -len(".zip")] if path.endswith(".zip") else path)
    print("unpacked %d Zarr stores" % len(archives))


@contextlib.contextmanager
def unpacked(path: Path):
    """`path` itself, or for a packed store, the folder it unpacks to (temporary)."""
    if path.suffix != ".zip":
        yield path
        return
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp) / path.stem
        with zipfile.ZipFile(path) as zf:
            zf.extractall(folder)
        yield folder


if __name__ == "__main__":
    command, target = sys.argv[1], Path(sys.argv[2]).resolve()
    {"pack": pack, "unpack": unpack}[command](target)
