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
| `browser-test-ports.mjs` | The loopback ports of the browser-test servers, shared by the config, the server and the specs, and the name the app is opened at (`CELLUCID_BROWSER_TEST_APP_HOST=deployed.localhost` runs the specs as a deployed site, its workers started from their bundles). |

## Inventory and design tokens

| Script | Purpose |
| --- | --- |
| `generate-web-asset-inventory.mjs` | Builds the worker bundles (below) first, then rewrites `cellucid-web-assets.json`, stamps the build id in `index.html`, and dates `sitemap.xml` and `.well-known/security.txt` from it; writes each shipped page's import map, the `?v=` content version of every script it names and the CSP hashes of its inline scripts; `--check` verifies all of it, bundles included, and writes nothing (see `CONTRIBUTING.md`). Needs `npm ci`. |
| `build-worker-bundles.mjs` | Used by the generator: builds each entry of `WORKER_ENTRIES` (every worker, and every module a worker imports by URL) with the pinned esbuild into `assets/workers/<name>.<sha256-12>.js` plus its source map, and writes `assets/workers/scripts.js`, which a page starts each worker from (`assets/js/workers/worker-script.js`). |
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
| `generate-subsample-conformance.py` | `tests/fixtures/subsample-conformance.json`, the subsampling specification computed independently in plain Python; byte-identical copies are pinned in cellucid-python and cellucid-r (`--check` compares). |
| `generate-subsample-hdf5-fixtures.py` | `tests/fixtures/subsample/*.h5ad`: one small AnnData in every HDF5 layout a subsampled read takes a different path through (CSR, CSC, dense X; gzip, unfiltered, contiguous; earliest and latest chunk indexes). |
| `generate-outlier-quantile-fixtures.py` | Files whose `uns['cellucid']['outlierQuantiles']` `cellucid.prepare()` wrote (`tests/browser/fixtures/outliers-stored.*`, `outliers-stale.h5ad`), with the numpy reference's checksums. |
| `generate-analysis-fixtures.py` | `tests/fixtures/analysis/scanpy-reference.json`: what scanpy, SciPy and numpy compute on a small AnnData, for the analysis parity tests (pinned versions in its header). |
| `anndata-corpus/` | The AnnData reader corpus; see `anndata-corpus/README.md`. |
| `formats-corpus/` | Loom, 10x Cell Ranger HDF5 and MuData files from their own writers (`tests/formats-corpus-conformance.test.mjs`); see `formats-corpus/README.md`. |
| `rds-corpus/`, `mtx-corpus/` | R objects and MatrixMarket folders from their own producers (`tests/rds-corpus-conformance.test.mjs`); see `rds-corpus/README.md`. |

## Benchmarks

Nothing they produce is committed.

| Script | Measures |
| --- | --- |
| `benchmark-analysis.mjs` | Marker genes and differential expression on a real dataset in Chromium, over an unshaped and a shaped link (`npm run bench:analysis`). |
| `benchmark-anndata.mjs` (+ `benchmark-anndata/`) | The AnnData reader (and, with `--baseline`, an earlier revision's), on generated or given files, locally and over a simulated link (`npm run bench:anndata`). |
| `benchmark-formats.mjs` (+ `benchmark-formats/`) | Every non-AnnData format the browser reads (Loom, Cell Ranger `outs/`, MatrixMarket, Seurat and SingleCellExperiment `.rds`/`.rda`, `.h5mu`, MuData Zarr) against the same data as a Cellucid-ready `.h5ad`, on generated (`generate.py`, `generate.R`) or given files: first view, first gene, peak memory, and a stream format's pass against plain inflate (`npm run bench:formats`). |
| `benchmark-hdf5-reader.mjs` | The HDF5 reader against h5wasm (`npm run bench:hdf5`). |
| `efficiency-floor.mjs` (+ `efficiency-floor/`) | Every element the viewer reads (obs of each kind, embeddings, vector fields, graphs, X as CSR, CSC and dense, layers, raw, var, uns, stored outlier quantiles, MuData modalities), in every storage (`.h5ad` gzip/lzf/unfiltered/contiguous, Zarr v2/v3 folders and ZIPs, Zarr v3 sharded (CSR, CSC and dense X; folder and ZIP), Cellucid-ready priority files, the stores `cellucid_serve` and `serve_anndata` answer (cellucid-r from its sources, cellucid-python's `PriorityStore`), `.h5mu`, MuData Zarr, Loom, Cell Ranger `outs/`), at every share and subsampling method, over a throttled link, from a picked file, or as a copy kept in this browser (`--plan kept`: a whole download read through its page checksums): bytes, requests and time against the floor computed from the file's own layout (uncompressed chunks, as served stores hold them, priced by the bytes a read needs; `generate.py` writes the corpus, `layout.py` each file's chunk map with h5py/zarr-python, `codecs.mjs` the decoding throughput of each codec in Node, `cpu-browser.mjs` in Chromium). Scale stores (`scale.py`, streamed, up to hundreds of millions of cells; `scale-run.mjs`) check that a 10 % share costs about a tenth on every axis. `tests/efficiency-floor.test.mjs` holds the floor in CI. |
| `benchmark-real-links.mjs` | The whole app opening datasets in Chromium: real links from real hosts, files served over a simulated HTTP/1.1 or HTTP/2 link, or files of this computer picked with File… and Folder…, with each step's bytes, requests, peak memory and main-thread long tasks (and, for a progressive opening, its first view's cells and the time until every cell asked for is open); optionally against an earlier revision. `--query "&cells=1%25"` opens each link with a subsample; `--open-only` stops once it is open. |
| `render-scenarios.mjs` | Render and interaction scenarios through the render probes: frames, passes and, with `--timing`, GPU time. |
