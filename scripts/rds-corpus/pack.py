"""Pack the R object and MatrixMarket corpora into one archive, the same
bytes for the same input (sorted names, a fixed date, deflate).

Usage: python -I pack.py <rds-corpus-dir> <mtx-corpus-dir> <archive.zip>
"""

import sys
import zipfile
from pathlib import Path

rds, mtx, target = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
target.parent.mkdir(parents=True, exist_ok=True)
entries = [(f"rds/{p.relative_to(rds).as_posix()}", p) for p in rds.rglob("*") if p.is_file()]
entries += [(f"mtx/{p.relative_to(mtx).as_posix()}", p) for p in mtx.rglob("*") if p.is_file()]
with zipfile.ZipFile(target, "w") as archive:
    for name, path in sorted(entries):
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, path.read_bytes())
print(f"{target}: {len(entries)} files, {target.stat().st_size} bytes")
