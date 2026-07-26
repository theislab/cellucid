"""Create the deterministic writer-produced Zarr ZIP browser fixture."""

from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

import anndata


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "tests" / "browser" / "fixtures"
H5AD_FIXTURE = FIXTURE_DIRECTORY / "current-ui-smoke.h5ad"
ARCHIVE_FIXTURE = FIXTURE_DIRECTORY / "current-ui-smoke.zarr.zip"
ARCHIVE_ROOT = "current-ui-smoke.zarr"
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def main() -> None:
    if not H5AD_FIXTURE.is_file():
        raise FileNotFoundError(f"Missing source fixture: {H5AD_FIXTURE}")

    with tempfile.TemporaryDirectory(prefix="cellucid-zarr-fixture-") as temporary:
        temporary_directory = Path(temporary)
        store = temporary_directory / ARCHIVE_ROOT
        anndata.read_h5ad(H5AD_FIXTURE).write_zarr(store)

        staged_archive = temporary_directory / ARCHIVE_FIXTURE.name
        with zipfile.ZipFile(
            staged_archive,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for source in sorted(path for path in store.rglob("*") if path.is_file()):
                relative = source.relative_to(store).as_posix()
                info = zipfile.ZipInfo(
                    filename=f"{ARCHIVE_ROOT}/{relative}",
                    date_time=ZIP_TIMESTAMP,
                )
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                with source.open("rb") as handle:
                    archive.writestr(info, handle.read(), compresslevel=9)

        staged_archive.replace(ARCHIVE_FIXTURE)


if __name__ == "__main__":
    main()
