# Browser AnnData fixtures

`current-ui-smoke.h5ad` is the 120-cell, six-gene direct-H5AD fixture used by
the visible file-picker acceptance.

`current-ui-smoke.zarr.zip` is generated from that H5AD with the AnnData Zarr
writer and a deterministic ZIP container:

```bash
python scripts/generate-zarr-browser-fixture.py
```

The archive contains one `current-ui-smoke.zarr/` root and fixed ZIP metadata,
so identical Zarr writer output produces identical archive bytes.
