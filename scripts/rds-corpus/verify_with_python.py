"""Read every store `materialize.mjs` wrote with anndata (or mudata for the
MuData layout) and check it against what R or scanpy read from the source
file: the stores the browser builds are real AnnData stores.

Usage: python -I verify_with_python.py <dir>   (needs anndata; mudata for multimodal stores)
"""

import json
import sys
from pathlib import Path

import anndata as ad
import numpy as np
import zarr

failures = 0
for store in sorted(Path(sys.argv[1]).glob("*.zarr")):
    expected = json.loads(Path(f"{store}.expected.json").read_text())
    try:
        encoding = zarr.open_group(str(store), mode="r").attrs.get("encoding-type", "")
        if encoding.lower() == "mudata":
            import mudata

            mdata = mudata.read_zarr(str(store))
            adata = mdata.mod[expected["modalities"][0]["name"]]
            obs_names = list(mdata.obs_names)
            obsm = mdata.obsm
        else:
            adata = ad.read_zarr(str(store))
            obs_names = list(adata.obs_names)
            obsm = adata.obsm
        assert obs_names == expected["obsNames"], "obs names"
        main = expected["modalities"][0]
        assert list(adata.var_names) == main["varNames"], "var names"
        x = adata.X
        assert abs(float(x.sum()) - main["X"]["sum"]) <= 1e-6 * max(1, abs(main["X"]["sum"])), f"X sum {x.sum()}"
        for key, values in expected["obsm"].items():
            stored = np.asarray(obsm[key])
            want = np.array([np.nan if v is None or v == "NaN" else v for v in values]).reshape(stored.shape[1], stored.shape[0]).T
            assert np.allclose(stored, want, equal_nan=True, rtol=0, atol=0), f"obsm {key}"
        print(f"ok {store.name}")
    except Exception as error:  # noqa: BLE001 - every store is checked
        failures += 1
        print(f"FAIL {store.name}: {error!r}")
sys.exit(1 if failures else 0)
