# Scripts

Maintenance scripts of the web app. Run them from the repository root; each
script's header documents its arguments. The Python generators run with the
repository's Python environment (anndata, h5py, zarr), except where a header
names a pinned one.

## Test runners

| Script | Purpose |
| --- | --- |
| `run-web-tests.mjs` | The contract suite: every `tests/*.test.mjs` under `node --test` (`npm test`). |
| `run-browser-shard-bounded.mjs` | One Playwright shard with bounded output and a timeout (`npm run test:browser:bounded`, CI). |
| `serve-browser-tests.mjs` | The static server the Playwright config starts for the browser tests. |
| `browser-test-ports.mjs` | The loopback ports of the browser-test servers, shared by the config, the server and the specs. |

## Inventory and design tokens

| Script | Purpose |
| --- | --- |
| `generate-web-asset-inventory.mjs` | Rewrites `cellucid-web-assets.json` and stamps the build id in `index.html`; `--check` verifies it (see `CONTRIBUTING.md`). |
| `validate-tokens.js` | Every design-token `var(--...)` resolves to a defined custom property. |
| `validate-token-types.js` | `types/design-tokens.d.ts` agrees with the token definitions. |

## Fixture generators

Each writes committed fixtures that a named test reads; rerun one when the
fixture it owns has to change.

| Script | Writes |
| --- | --- |
| `generate-anndata-contract-fixtures.py` | HDF5-only AnnData fixtures of `tests/anndata-reader-contract.test.mjs`. |
| `generate-cellucid-ready-fixtures.py` | Small Cellucid-ready AnnData files (`uns['cellucid']`) under `tests/fixtures/cellucid-ready/`. |
| `generate-browser-catalog-fixtures.py` | The browser tests' dataset catalogs and the datasets they list. |
| `generate-data-mapping-fixtures.py` | The data-mapping browser fixtures (`tests/browser/data-mapping.spec.mjs`). |
| `generate-byte-order-h5ad-fixtures.py` | Matched big- and little-endian `.h5ad` fixtures. |
| `generate-legacy-anndata-fixtures.py` | `.h5ad` files written by anndata 0.6 and 0.7 themselves (pinned environments in its header). |
| `generate-legacy-anndata-twin.py` | The current-layout twins those anndata 0.6/0.7 files must read the same as. |
| `generate-zarr-browser-fixture.py` | The Zarr ZIP twin of `tests/browser/fixtures/current-ui-smoke.h5ad`. |
| `generate-zarr-browser-fixture-expected.py` | What zarr-python reads from every browser-test Zarr store (`zarr-fixtures.expected.json`). |
| `generate-zarr-conformance-corpus.py` | The Zarr v2/v3 conformance corpus under `tests/fixtures/zarr/`. |
| `generate-hdf5-conformance-corpus.py` | The HDF5 conformance corpus the HDF5 reader is checked against (with h5wasm as the oracle). |
| `generate-latent-outlier-conformance.py` | `tests/fixtures/latent-outlier-conformance.json`, computed independently with numpy. |
| `anndata-corpus/` | The AnnData reader corpus; see `anndata-corpus/README.md`. |

## Benchmarks

Nothing they produce is committed.

| Script | Measures |
| --- | --- |
| `benchmark-anndata.mjs` (+ `benchmark-anndata/`) | The AnnData reader against an earlier revision's, on generated files, locally and over a simulated link (`npm run bench:anndata`). |
| `benchmark-hdf5-reader.mjs` | The HDF5 reader against h5wasm (`npm run bench:hdf5`). |
| `benchmark-real-links.mjs` | The whole app opening real linked datasets from real hosts in Chromium, optionally against an earlier revision. |
| `render-scenarios.mjs` | Render and interaction scenarios through the render probes: frames, passes and, with `--timing`, GPU time. |
