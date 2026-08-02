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

`byte-order-big-endian.h5ad` and `byte-order-little-endian.h5ad` are an
eight-cell, three-gene pair carrying identical values that differ only in the
recorded HDF5 datatype byte order of every multi-byte dataset, plus the numeric
`shape` attribute on the sparse `obsp/connectivities` group:

```bash
python scripts/generate-byte-order-h5ad-fixtures.py
```

The generator is deterministic and re-verifies the recorded byte order of each
dataset before finishing. `tests/h5ad-byte-order-contract.test.mjs` loads both
through the real `H5adDataSource` path and requires identical numbers, which
pins the guarantee that HDF5 converts stored data to the host byte order — the
reason `classifyH5WasmDtype` may discard the NumPy byte-order prefix. Every
value in the pair is chosen so that reading it in the wrong byte order produces
a *different* number, so the fixture cannot quietly stop discriminating.
