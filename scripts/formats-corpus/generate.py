"""Generate the layout-view corpus: Loom, 10x Cell Ranger HDF5 and MuData.

One virtual environment per writer writes its own fixtures and what its
library reads back from them (`write_fixtures.py`); this script then packs
each writer's folder into one archive under the format's fixture folder and
writes that folder's `index.json`:

    tests/fixtures/loom/    loompy-3.0.8.zip, loompy-2.0.17.zip, index.json
    tests/fixtures/tenx/    tenx.zip (written with h5py as Cell Ranger writes, read with scanpy), index.json
    tests/fixtures/mudata/  mudata-0.4.1.zip, mudata-0.3.2.zip, mudata-0.2.4.zip, index.json

    python scripts/formats-corpus/generate.py --setup      # create the writer venvs (once)
    python scripts/formats-corpus/generate.py              # write and pack every writer
    python scripts/formats-corpus/generate.py --writer mudata-0.4.1

The venvs live in $FORMATS_CORPUS_VENVS (default: ./.formats-corpus-venvs next
to the repository). Interpreters are found as python3.X on PATH, then under
~/.pyenv/versions; FORMATS_CORPUS_PYTHON_3_11=/path/to/python overrides one.
The 10x writer copies two Cell Ranger 1.2 files from scanpy's test data
(BSD-3-Clause); `--scanpy-data` names the folder holding them (scanpy's
`tests/_data/10x_data` or a download of it).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY_ROOT = HERE.parents[1]
FIXTURES = REPOSITORY_ROOT / "tests" / "fixtures"
DEFAULT_VENVS = REPOSITORY_ROOT.parent / ".formats-corpus-venvs"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)

# name, format folder, write_fixtures.py writer, python, pins
WRITERS = [
    ("loompy-3.0.8", "loom", "loompy-3", "3.12", ["loompy==3.0.8", "numpy==2.5.4", "h5py==3.16.0", "scipy==1.18.1", "numba==0.68.0"]),
    ("loompy-2.0.17", "loom", "loompy-2", "3.11", ["loompy==2.0.17", "numpy==1.24.4", "h5py==3.9.0", "scipy==1.11.4"]),
    ("tenx", "tenx", "tenx", "3.12", ["scanpy==1.12.4", "anndata==0.13.4", "numpy==2.5.4", "h5py==3.16.0", "scipy==1.18.1"]),
    ("mudata-0.4.1", "mudata", "mudata", "3.12", ["mudata==0.4.1", "anndata==0.13.4", "numpy==2.5.4", "h5py==3.16.0", "zarr==3.4.1", "scipy==1.18.1"]),
    ("mudata-0.3.2", "mudata", "mudata", "3.12", ["mudata==0.3.2", "anndata==0.11.4", "numpy==2.2.6", "pandas==2.2.3", "h5py==3.16.0", "zarr==2.18.7", "scipy==1.18.1"]),
    ("mudata-0.2.4", "mudata", "mudata", "3.11", ["mudata==0.2.4", "anndata==0.9.2", "numpy==1.24.4", "pandas==1.5.3", "h5py==3.9.0", "zarr==2.16.1", "numcodecs==0.12.1", "scipy==1.11.4"]),
]


def venv_root() -> Path:
    return Path(os.environ.get("FORMATS_CORPUS_VENVS", DEFAULT_VENVS))


def venv_python(name: str) -> Path:
    return venv_root() / name / "bin" / "python"


def interpreter(version: str) -> str:
    override = os.environ.get(f"FORMATS_CORPUS_PYTHON_{version.replace('.', '_')}")
    if override:
        return override
    found = shutil.which(f"python{version}")
    if found:
        return found
    candidates = sorted(glob.glob(os.path.expanduser(f"~/.pyenv/versions/{version}.*/bin/python")))
    if candidates:
        return candidates[-1]
    raise SystemExit(f"No Python {version}: set FORMATS_CORPUS_PYTHON_{version.replace('.', '_')}.")


def setup() -> None:
    for name, _folder, _writer, version, pins in WRITERS:
        target = venv_root() / name
        if venv_python(name).exists():
            continue
        subprocess.run([interpreter(version), "-m", "venv", str(target)], check=True)
        subprocess.run([str(venv_python(name)), "-m", "pip", "install", "-q", *pins], check=True)
        print(f"{name}: ready")


def zip_folder(folder: Path, target: Path, compression: int) -> None:
    """A deterministic ZIP of a folder's files: sorted entries, a fixed time and mode."""
    with zipfile.ZipFile(target, "w", compression=compression, compresslevel=9) as archive:
        for path in sorted(item for item in folder.rglob("*") if item.is_file()):
            info = zipfile.ZipInfo(path.relative_to(folder).as_posix(), date_time=ZIP_TIME)
            info.external_attr = 0o644 << 16
            info.compress_type = compression
            archive.writestr(info, path.read_bytes(), compresslevel=9)


def pack(written: Path, name: str, folder: Path) -> list[dict]:
    """Pack one writer's folder: Zarr stores as stored ZIPs inside, all of it deflated."""
    entries = []
    for store in sorted(item for item in written.glob("*.zarr") if item.is_dir()):
        zip_folder(store, store.with_name(store.name + ".zip"), zipfile.ZIP_STORED)
        shutil.rmtree(store)
    for expected in sorted(written.glob("*.expected.json")):
        fixture = expected.name[: -len(".expected.json")]
        layout = "folder" if (written / fixture).is_dir() else "file"
        stored = fixture + ".zip" if fixture.endswith(".zarr") else fixture
        content = json.loads(expected.read_text(encoding="utf-8"))
        entries.append({
            "path": f"{name}/{stored}",
            "expected": f"{name}/{expected.name}",
            "layout": "zip" if stored.endswith(".zarr.zip") else layout,
            "format": content["format"],
            "refusal": content["refusal"],
        })
    zip_folder(written, folder / f"{name}.zip", zipfile.ZIP_DEFLATED)
    return entries


def generate(only: list[str], scanpy_data: Path | None) -> None:
    indexes: dict[str, list[dict]] = {}
    for folder in {item[1] for item in WRITERS}:
        index_path = FIXTURES / folder / "index.json"
        if index_path.exists():
            indexes[folder] = json.loads(index_path.read_text(encoding="utf-8"))["fixtures"]
    for name, folder, writer, _version, _pins in WRITERS:
        if only and name not in only:
            continue
        target_folder = FIXTURES / folder
        target_folder.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as temporary:
            written = Path(temporary) / name
            command = [str(venv_python(name)), "-I", str(HERE / "write_fixtures.py"), writer, str(written)]
            if writer == "tenx":
                if scanpy_data is None:
                    raise SystemExit("The 10x writer needs --scanpy-data (scanpy's tests/_data/10x_data).")
                command.append(str(scanpy_data))
            subprocess.run(command, check=True)
            entries = pack(written, name, target_folder)
        indexes[folder] = [entry for entry in indexes.get(folder, []) if not entry["path"].startswith(f"{name}/")] + entries
    for folder, entries in indexes.items():
        entries.sort(key=lambda entry: entry["path"])
        (FIXTURES / folder / "index.json").write_text(
            json.dumps({"fixtures": entries}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"{folder}: {len(entries)} fixtures")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--setup", action="store_true", help="create the writer venvs")
    parser.add_argument("--writer", action="append", default=[], help="write only this writer (repeatable)")
    parser.add_argument("--scanpy-data", type=Path, default=None, help="scanpy's tests/_data/10x_data")
    arguments = parser.parse_args()
    if arguments.setup:
        setup()
        return 0
    generate(arguments.writer, arguments.scanpy_data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
