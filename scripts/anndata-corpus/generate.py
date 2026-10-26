"""Generate the AnnData conformance corpus under tests/fixtures/anndata/.

One virtual environment per anndata release writes its own files (write_corpus.py),
then the latest release adds the layouts other tools leave behind, fills in
expected values the old writers could not compute, records the on-disk layout
of every file and writes the index (postprocess.py).

    python scripts/anndata-corpus/generate.py --setup     # create the writer venvs (once)
    python scripts/anndata-corpus/generate.py             # write the whole corpus
    python scripts/anndata-corpus/generate.py --writer 0.12 x_csr_float32 obs_categoricals
    python scripts/anndata-corpus/generate.py --verify    # write, then run verify_with_python.py

The venvs live in $ANNDATA_CORPUS_VENVS (default: ./.anndata-corpus-venvs next to
the repository). Interpreters are looked up as python3.X on PATH, then in
~/.pyenv/versions; override with ANNDATA_CORPUS_PYTHON_3_10=/path/to/python etc.
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPOSITORY_ROOT = HERE.parents[1]
FIXTURES = REPOSITORY_ROOT / "tests" / "fixtures" / "anndata"
DEFAULT_VENVS = REPOSITORY_ROOT.parent / ".anndata-corpus-venvs"

# key, python, pins. Every pin installs from wheels on macOS arm64 except asciitree,
# a pure-Python sdist that zarr 2 depends on.
WRITERS = [
    ("0.12", "3.12", ["anndata==0.12.19", "numpy==2.5.1", "pandas==2.3.3", "h5py==3.16.0", "zarr==3.3.0",
                      "numcodecs==0.16.5", "scipy==1.18.0", "awkward==2.14.0"]),
    ("0.11", "3.12", ["anndata==0.11.4", "numpy==2.2.6", "pandas==2.2.3", "h5py==3.13.0", "zarr==2.18.7",
                      "numcodecs==0.15.1", "scipy==1.15.3"]),
    ("0.10", "3.12", ["anndata==0.10.9", "numpy==1.26.4", "pandas==2.2.3", "h5py==3.11.0", "zarr==2.18.2",
                      "numcodecs==0.12.1", "scipy==1.13.1"]),
    ("0.9", "3.11", ["anndata==0.9.2", "numpy==1.24.4", "pandas==1.5.3", "h5py==3.9.0", "zarr==2.16.1",
                     "numcodecs==0.12.1", "scipy==1.11.4"]),
    ("0.8", "3.10", ["anndata==0.8.0", "numpy==1.22.4", "pandas==1.4.4", "h5py==3.7.0", "zarr==2.11.3",
                     "numcodecs==0.12.1", "scipy==1.8.1"]),
    ("0.7", "3.10", ["anndata==0.7.8", "numpy==1.23.5", "pandas==1.5.3", "h5py==3.7.0", "zarr==2.13.3",
                     "numcodecs==0.12.1", "scipy==1.9.3"]),
    ("0.6", "3.10", ["anndata==0.6.22.post1", "numpy==1.21.6", "pandas==1.3.5", "h5py==3.7.0", "zarr==2.13.3",
                     "numcodecs==0.12.1", "scipy==1.9.3", "natsort==8.4.0"]),
]
LATEST = WRITERS[0][0]


def venv_root() -> Path:
    return Path(os.environ.get("ANNDATA_CORPUS_VENVS", DEFAULT_VENVS))


def venv_python(key: str) -> Path:
    return venv_root() / ("ad-" + key) / "bin" / "python"


def find_python(version: str) -> str:
    override = os.environ.get("ANNDATA_CORPUS_PYTHON_" + version.replace(".", "_"))
    if override:
        return override
    found = shutil.which("python" + version)
    if found:
        return found
    candidates = sorted(glob.glob(os.path.expanduser("~/.pyenv/versions/%s.*/bin/python" % version)))
    if candidates:
        return candidates[-1]
    raise SystemExit("No Python %s found; set ANNDATA_CORPUS_PYTHON_%s." % (version, version.replace(".", "_")))


def setup(keys) -> None:
    for key, python, pins in WRITERS:
        if keys and key not in keys:
            continue
        target = venv_root() / ("ad-" + key)
        if target.exists():
            print("exists  ", target)
            continue
        subprocess.run([find_python(python), "-m", "venv", str(target)], check=True)
        pip = [str(target / "bin" / "python"), "-m", "pip", "install", "-q", "--disable-pip-version-check"]
        if any(p.startswith("zarr==2") for p in pins):
            subprocess.run(pip + ["asciitree==0.3.3"], check=True)
        subprocess.run(pip + ["--only-binary", ":all:"] + pins, check=True)
        print("created ", target)


def run(python: Path, script: str, *args: str) -> None:
    if not python.exists():
        raise SystemExit("%s is missing; run generate.py --setup first." % python)
    subprocess.run([str(python), str(HERE / script), *args], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--setup", action="store_true", help="create the writer venvs and stop")
    parser.add_argument("--writer", action="append", help="only this writer key (repeatable), e.g. 0.12")
    parser.add_argument("--verify", action="store_true", help="run verify_with_python.py afterwards")
    parser.add_argument("variants", nargs="*", help="only these variants (with --writer)")
    args = parser.parse_args()
    if args.setup:
        setup(args.writer)
        return
    FIXTURES.mkdir(parents=True, exist_ok=True)
    # The writers and postprocess.py work on Zarr folders; the corpus keeps them packed.
    run(venv_python(LATEST), "pack.py", "unpack", str(FIXTURES))
    for key, _, _ in WRITERS:
        if args.writer and key not in args.writer:
            continue
        print("== anndata", key)
        run(venv_python(key), "write_corpus.py", str(FIXTURES), *args.variants)
    print("== postprocess")
    run(venv_python(LATEST), "postprocess.py", str(FIXTURES))
    if args.verify:
        print("== verify")
        run(venv_python(LATEST), "verify_with_python.py", str(FIXTURES))
    run(venv_python(LATEST), "pack.py", "pack", str(FIXTURES))


if __name__ == "__main__":
    main()
