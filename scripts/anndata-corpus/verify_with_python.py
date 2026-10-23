"""Re-read every corpus file with the current anndata and check it against its expected values.

Proves two things: every fixture is a file anndata itself reads, and the
expected values (computed by each writer right after writing) are what the
file holds. Also re-derives the ``storage`` section from the bytes on disk.

    <latest venv>/bin/python verify_with_python.py <fixtures/anndata>

Exit status 1 if any file is unreadable or differs, unless the expected-values
file records it under ``current_anndata_differs`` / ``current_anndata_unreadable``
(old layouts the current anndata reads differently from, or cannot read at
all unlike, the release that wrote them; the README lists them).
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

import anndata

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corpus_expected as ce  # noqa: E402
from pack import unpack, unpacked  # noqa: E402
from postprocess import read_current, storage_of  # noqa: E402

warnings.simplefilter("ignore")
# zarr-python logs a failed background read (the json2 stores) besides raising it; the raise is enough.
logging.getLogger("asyncio").setLevel(logging.CRITICAL)

DOC_KEYS = ("n_obs", "n_vars", "obs", "var", "X", "layers", "obsm", "varm", "obsp", "varp", "raw", "uns_title", "uns")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        # The corpus is kept packed; it is verified unpacked, in a copy.
        root = Path(tmp) / "anndata"
        shutil.copytree(Path(sys.argv[1]).resolve(), root)
        unpack(root)
        verify(root)


def verify(root: Path) -> None:
    index = json.loads((root / "index.json").read_text(encoding="utf-8"))
    counts = {"ok": 0, "known-difference": 0, "known-unreadable": 0, "differs": 0, "unreadable": 0}
    for entry in index["fixtures"]:
        expected = json.loads((root / entry["expected"]).read_text(encoding="utf-8"))
        unreadable_reason = expected.get("current_anndata_unreadable")
        with unpacked(root / entry["path"]) as target:
            try:
                actual = ce.normalise(ce.expected_document(read_current(target)))
                storage = ce.normalise(storage_of(target))
            except Exception as error:  # noqa: BLE001
                failure = error
            else:
                failure = None
        if failure is not None:
            if unreadable_reason:
                counts["known-unreadable"] += 1
                print("KNOWN      %s: unreadable by the current anndata (recorded: %s)" % (entry["path"], unreadable_reason[:70]))
            else:
                counts["unreadable"] += 1
                print("UNREADABLE %s: %s: %s" % (entry["path"], type(failure).__name__, str(failure)[:200]))
            continue
        found = []
        for key in DOC_KEYS:
            ce.differences(expected.get(key), actual.get(key), key, found)
        ce.differences(expected["storage"], storage, "storage", found)
        known = set(expected.get("current_anndata_differs") or {})
        unexplained = [d for d in found if not any(d.startswith(k) for k in known)]
        if not found:
            counts["ok"] += 1
        elif not unexplained:
            counts["known-difference"] += 1
            print("KNOWN      %s: %d recorded difference(s)" % (entry["path"], len(found)))
        else:
            counts["differs"] += 1
            print("DIFFERS    %s (%d)" % (entry["path"], len(unexplained)))
            for line in unexplained[:6]:
                print("             " + line)
    print("anndata %s: %d fixtures, %s" % (anndata.__version__, len(index["fixtures"]),
                                          ", ".join("%s %d" % kv for kv in counts.items())))
    sys.exit(0 if counts["differs"] == 0 and counts["unreadable"] == 0 else 1)


if __name__ == "__main__":
    main()
