/**
 * The two short test sets, said once.
 *
 * `npm test` is every contract test and `npm run test:browser` every browser
 * spec: they are the gate. Two shorter sets answer first while code is being
 * changed:
 *
 * - `npm run test:core` runs the core contract tests: for each layer of the
 *   application, the files that run that layer's modules and say the most
 *   for their time. No file that only reads the text of other files, none
 *   that waits on a real timer, none that needs the bundles rebuilt first.
 * - `npm run test:browser:smoke` runs the smoke specs: one walk from start
 *   to export (start, open each format, color, filter, select, analyze,
 *   undo, save, export, an agent's turn), in the engine or engines named.
 *
 * What is run when (`CONTRIBUTING.md`): the two sets after a change; `npm
 * test` and every spec in Chromium when a piece of work is complete; every
 * spec in the three engines before `main` is pushed, where CI runs them too.
 *
 * `scripts/run-web-tests.mjs --core` and `playwright.config.mjs`
 * (`CELLUCID_BROWSER_SET=smoke`) read these lists, and
 * `tests/test-suites-contract.test.mjs` holds them to the tree.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The core contract tests, by layer: each name is `tests/<name>.test.mjs`. */
export const CORE_CONTRACT_TESTS = Object.freeze([
  {
    layer: 'formats and codecs',
    files: [
      'zip-format-contract', 'zarr-format-conformance', 'zarr-format-codecs', 'zarr-format-fixtures',
      'zarr-folder-reads', 'hdf5-reader-conformance', 'codec-layer-contract', 'h5ad-byte-order-contract',
      'formats-corpus-conformance', 'rds-corpus-conformance', 'rds-parser-contract',
      'matrix-market-scanner-contract', 'formats-io-contract', 'page-checks-contract', 'decoded-chunks',
      'session-gzip-codec', 'input-formats-registry',
    ],
  },
  {
    layer: 'reader and share planner',
    files: [
      'anndata-corpus-conformance', 'anndata-reader-contract', 'zarr-reader-contract',
      'legacy-anndata-contract', 'anndata-adapter-lifecycle', 'anndata-sparse-columns-contract',
      'sparse-column-index-contract', 'categorical-storage-contract', 'categorical-integration-contract',
      'connectivity-extraction-contract', 'anndata-cellucid-metadata-contract',
      'anndata-launch-defaults-contract', 'data-mapping-conformance', 'subsample-conformance',
      'subsample-auto-fit', 'gene-sample-contract', 'share-open-every-chunk-contract',
      'gene-reads-fetch-once', 'every-cell-opening-parity-contract', 'lod-priority-order',
      'cell-rows-lookups-contract', 'anndata-reader-worker-contract', 'memory-budget-contract',
      'outlier-quantile-exact-contract',
    ],
  },
  {
    layer: 'sources and viewer channel',
    files: [
      'data-source-selection-transaction', 'dataset-identity-contract', 'gene-read-every-source',
      'link-source-contract', 'anndata-catalog-contract', 'served-anndata-contract', 'served-priority-store',
      'viewer-protocol-contract', 'viewer-host-source-contract', 'viewer-host-command-handler-contract',
    ],
  },
  {
    layer: 'state and domains',
    files: [
      'state-domains-contract', 'kept-view-category-ownership', 'ui-state-exact-contract',
      'view-dimension-exact-contract', 'filter-visibility-index-contract',
      'user-defined-field-identity-contract', 'open-cells-resize-state',
      'highlight-membership-definition-contract', 'camera-state-boundaries', 'category-color-table-contract',
      'continuous-color-table-contract',
    ],
  },
  {
    layer: 'actions and history',
    files: [
      'action-catalog-contract', 'action-catalog-document-contract', 'action-history-core',
      'action-fields-contract', 'action-highlights', 'action-views-camera',
      'actions-settings-layout-analysis', 'action-dispatch-stop-contract', 'action-reads-contract',
      'dataset-open-action', 'history-v2-core', 'history-v2-restore', 'history-v2-replay-steps',
      'history-v2-concurrency', 'history-model-contract', 'history-model-schema', 'history-autosave',
      'history-golden-fixture',
    ],
  },
  {
    layer: 'session files',
    files: [
      'session-serializer-contract', 'session-history-file', 'session-share-scope',
      'session-cell-order-identity-contract', 'session-adjacent-exact-contract',
      'session-ui-controls-exact-contract', 'session-bundle-not-a-session-contract', 'library-file',
    ],
  },
  {
    layer: 'rendering math',
    files: [
      'renderer-exact-contract', 'high-perf-draw-order-contract', 'spatial-index-draw-order-contract',
      'spatial-index-lod-cpu-ownership', 'picking-spatial-query', 'camera-navigation-contract',
      'camera-default-pose-contract', 'point-sprite-contract', 'read-cell-layer',
      'ambient-frame-pacing-contract', 'full-detail-frame-cost', 'snapshot-buffer-transaction',
      'unplaced-cells',
    ],
  },
  {
    layer: 'analysis numerics',
    files: [
      'statistical-tests', 'analysis-engine-rank-kernel-identity', 'analysis-scanpy-rank-genes-parity',
      'analysis-pseudobulk-limma', 'analysis-composition-stats', 'analysis-correlation-stability',
      'expression-transform', 'analysis-compute-contract', 'analysis-engine-streaming-bounds',
      'analysis-box-statistics-identity', 'analysis-histogram-bins-identity',
      'analysis-session-results-contract',
    ],
  },
  {
    layer: 'exports',
    files: [
      'figure-export-scientific-fidelity', 'figure-export-viewer-layer-fidelity',
      'figure-export-crop-raster-parity', 'figure-export-physical-size', 'figure-export-multiview-parity',
      'figure-export-vector-field', 'cell-export-reads', 'history-exports', 'history-anndata-copy',
      'element-names-contract',
    ],
  },
  {
    layer: "agents' bridge",
    files: [
      'agent-bridge', 'agent-calls', 'agent-chat', 'agent-providers', 'agent-relay-client', 'agent-presence',
      'agent-data-guard', 'relay-oauth', 'mcp-tools-document-contract',
    ],
  },
  {
    layer: 'utils and shared files',
    files: [
      'cancellation-and-errors-contract', 'number-format-significant-contract',
      'sha256-secure-context-contract', 'debounce-contract', 'indexed-db-database', 'shared-files-contract',
      'type-check-contract', 'comment-history-contract',
    ],
  },
].map(({ layer, files }) => Object.freeze({ layer, files: Object.freeze(files) })));

/** The engines the browser specs run in (`playwright.config.mjs`, its projects). */
export const BROWSER_ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);

/**
 * The smoke specs: each name is `tests/browser/<name>.spec.mjs`. `every` runs
 * in each engine; an engine's own list holds what only that engine shows
 * (file handles kept across a reload in Chromium, Firefox's console and ARIA
 * reflection, WebKit's order of stylesheets and scripts).
 */
export const BROWSER_SMOKE = Object.freeze({
  every: Object.freeze([
    // start
    'webgl2-runtime', 'startup-defaults', 'action-catalog-coverage',
    // open
    'data-source-coverage-local', 'layout-view-formats', 'r-objects-and-mtx', 'older-anndata-files',
    'data-link-in-place', 'dataset-drop', 'subsample-control',
    // color
    'color-by-kept-view', 'gene-choice', 'uint32-categories-end-to-end',
    // filter
    'filter-legend-sync', 'outlier-filtering',
    // select
    'actions-highlights-views',
    // analyze
    'analysis-de-options', 'analysis-dotplot',
    // undo
    'actions-fields', 'history-keys', 'history-panel',
    // save
    'session-state-round-trip', 'history-session-file', 'history-autosave',
    // export
    'figure-export', 'cell-exports', 'anndata-copy', 'history-anndata-copy',
    // agent
    'agent-chat-work',
  ]),
  chromium: Object.freeze(['local-file-reopen']),
  firefox: Object.freeze(['engine-console', 'firefox-aria-reflection']),
  webkit: Object.freeze(['style-gate']),
});

/** Every core contract test file, as an absolute path, in the order of the list. */
export function coreTestFiles() {
  return CORE_CONTRACT_TESTS.flatMap(({ files }) => files.map(name => path.join(ROOT, 'tests', `${name}.test.mjs`)));
}

/** The smoke specs of one engine, as the patterns a Playwright project's `testMatch` takes. */
export function smokeSpecs(engine) {
  if (!BROWSER_ENGINES.includes(engine)) throw new RangeError(`"${engine}" is not an engine of the browser specs`);
  return [...BROWSER_SMOKE.every, ...BROWSER_SMOKE[engine]].map(name => `**/${name}.spec.mjs`);
}
