/**
 * Every size or count limit in the web app is a real one, and says why.
 *
 * A constant under assets/js whose name has MAX, MAXIMUM, LIMIT, CAP,
 * CAPACITY, BUDGET or CEILING in it (a leading CAP_ that names the Cell
 * Annotation Platform does not count), and every byte size written as
 * `N * 1024 * 1024` or `1024 * 1024` in a named constant, must appear
 * below with its class and the reason it exists. A new one fails this test
 * until someone classifies it. The classes:
 *
 * - FORMAT: fixed by a file or wire format (a u32 length, a ZIP field);
 * - PLAT: a real limit of a browser, GPU, GitHub or another platform;
 * - HOST: a bound on untrusted input, tied to what that input may declare;
 * - PERF: a cache, batch or scheduling size that decides what is kept or how
 *   work is split, never what can be opened or shown;
 * - MSG: how much of something a message quotes;
 * - UI: a visual or interaction parameter that bounds no data, or a list that
 *   keeps every item reachable another way;
 * - OWNED: a limit still to be removed, naming its owner and the inventory
 *   (cellucid-private/plans/limits-inventory.md). The owner deletes the entry
 *   with the fix. No other class takes a limit made up for convenience.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /(^|_)(MAX|MAXIMUM|LIMIT|LIMITS|CAP|CAPACITY|BUDGET|CEILING)(_|$)/;
const DECLARATION = /\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=/g;
const MIB = /\b1024\s*\*\s*1024\b/;
const CLASSES = new Set(['FORMAT', 'PLAT', 'HOST', 'PERF', 'MSG', 'UI', 'OWNED']);

const TEXT = 'Per-item contributor text in a shared annotation file; the schema in cellucid-annotation carries the same value.';
const GITHUB_BODY = 'Bounds one GitHub API response the Worker relays; GitHub caps the items of one page, so a page fits.';

/** @type {Record<string, [string, string]>} */
const ALLOWLIST = {
  'analytics/schema.js:GA4_LIMITS': ['PLAT', 'Google Analytics 4 event and parameter limits.'],
  'analytics/tracker.js:MAX_ANCESTOR_DEPTH': ['UI', 'How far up the DOM a click looks for its tracked control.'],
  'app/analysis/compute/math-utils.js:GAMMA_MAX_ITERATIONS': ['FORMAT', 'Series iterations of the incomplete gamma function; it converges far sooner.'],
  'app/analysis/compute/math-utils.js:MAX_TABULATED_DISTINCT_VALUES': ['PERF', 'Above this many distinct values a density sends raw values instead of a table.'],
  'app/analysis/compute/math-utils.js:NATIVE_SORT_MAX_LENGTH': ['PERF', 'Above this length a radix sort replaces the native sort; every value is sorted.'],
  'app/analysis/data/data-layer.js:PAGE_DATA_CACHE_MAX_BYTES': ['PERF', 'How much gathered page data stays cached; the rest is gathered again.'],
  'app/analysis/data/streaming-gene-loader.js:PAYLOAD_WINDOW_MAX': ['PERF', 'How many gene payloads a long run downloads ahead.'],
  'app/analysis/compute/worker-pool.js:DISPATCH_CLONE_BYTES_PER_TASK': ['PERF', 'Bytes copied to analysis workers per main-thread task; larger dispatches are split.'],
  'app/community-annotations/_worker-code.js:CAP_LOOKUP_LIMIT_MAX': ['UI', 'Results of one CAP lookup, ranked by relevance; a more specific term reaches any other cell type.'],
  'app/community-annotations/_worker-code.js:CAP_MARKER_TERM_MAX_CODE_POINTS': ['HOST', 'A marker search names at most 50 genes of 64 code points, comma separated.'],
  'app/community-annotations/_worker-code.js:CAP_OUTPUT_BODY_MAX_BYTES': ['PLAT', 'One gateway response stays well inside a Cloudflare Worker isolate (128 MB).'],
  'app/community-annotations/_worker-code.js:CAP_PREFLIGHT_MAX_AGE_SECONDS': ['UI', 'How long a browser may cache the CORS preflight.'],
  'app/community-annotations/_worker-code.js:CAP_REQUEST_BODY_MAX_BYTES': ['HOST', 'A lookup request is a kind, a term and a limit; anything larger is not one.'],
  'app/community-annotations/_worker-code.js:CAP_RESPONSE_BODY_MAX_BYTES': ['PLAT', 'One upstream CAP response held in a Cloudflare Worker isolate (128 MB).'],
  'app/community-annotations/_worker-code.js:CAP_TERM_MAX_CODE_POINTS': ['HOST', 'A cell-type search term; CAP labels are far shorter.'],
  'app/community-annotations/_worker-code.js:GITHUB_COLLECTION_MAX_ITEMS': ['OWNED', 'owner decision (Worker redeploy); limits-inventory §3.10: one GitHub page per Worker request.'],
  'app/community-annotations/_worker-code.js:GITHUB_COLLECTION_PAGE_MAX_BYTES': ['HOST', GITHUB_BODY],
  'app/community-annotations/_worker-code.js:GITHUB_CONTENT_RESPONSE_MAX_BYTES': ['PLAT', "GitHub's Contents API returns content as JSON only up to 1 MB, base64 encoded."],
  'app/community-annotations/_worker-code.js:GITHUB_STANDARD_RESPONSE_BODY_MAX_BYTES': ['HOST', GITHUB_BODY],
  'app/community-annotations/_worker-code.js:GITHUB_TREE_RESPONSE_MAX_BYTES': ['PLAT', 'GitHub truncates a recursive tree at 7 MB.'],
  'app/community-annotations/_worker-code.js:OAUTH_COOKIE_MAX_AGE_S': ['UI', 'How long an OAuth sign-in may take before it starts over.'],
  'app/community-annotations/_worker-code.js:OAUTH_COOKIE_MAX_SERIALIZED_BYTES': ['PLAT', 'Browsers keep a cookie of at most 4,096 bytes.'],
  'app/community-annotations/_worker-code.js:WORKER_REQUEST_BODY_MAX_BYTES': ['PLAT', 'A proxied write carries one annotation file (1 MB as JSON content) in base64.'],
  'app/community-annotations/cap-api.js:CAP_LOOKUP_LIMIT': ['UI', 'Results of one CAP lookup, ranked by relevance; a more specific term reaches any other cell type.'],
  'app/community-annotations/cap-api.js:CAP_MARKER_GENE_MAX_CODEPOINTS': ['HOST', 'One gene of a marker search, as the Worker accepts it.'],
  'app/community-annotations/cap-api.js:CAP_MARKER_TERM_MAX_CODEPOINTS': ['HOST', 'A marker search names at most 50 genes of 64 code points, comma separated.'],
  'app/community-annotations/cap-api.js:CAP_REQUEST_BODY_MAX_BYTES': ['HOST', 'The Worker refuses a larger lookup request.'],
  'app/community-annotations/cap-api.js:CAP_RESPONSE_BODY_MAX_BYTES': ['HOST', 'The Worker never returns a larger response.'],
  'app/community-annotations/cap-api.js:CAP_TERM_MAX_CODEPOINTS': ['HOST', 'The Worker refuses a longer search term.'],
  'app/community-annotations/cap-api.js:CAP_WORKER_ERROR_MAX_CODEPOINTS': ['MSG', 'A longer "error" is not a Worker sentence; the HTTP status is shown instead.'],
  'app/community-annotations/github-auth.js:DEFAULT_AUTH_RESPONSE_MAX_BYTES': ['HOST', 'Bounds one Worker auth response read into memory.'],
  'app/community-annotations/github-auth.js:GITHUB_COLLECTION_MAX_ITEMS': ['OWNED', 'owner decision (Worker redeploy); limits-inventory §3.10: one GitHub page per Worker request.'],
  'app/community-annotations/github-auth.js:WORKER_CAPABILITY_MAX_BYTES': ['HOST', 'The Worker capability document is a short fixed record.'],
  'app/community-annotations/github-sync.js:COMMUNITY_ANNOTATION_PULL_BATCH_BYTES': ['PERF', 'Changed user files are fetched and cached about this many bytes at a time; there is no total limit.'],
  'app/community-annotations/github-sync.js:GITHUB_RENAMED_FORK_LOOKUP_MAX_ITEMS': ['OWNED', 'owner decision (Worker redeploy), with the GitHub collection redesign; limits-inventory §3.10.'],
  'app/community-annotations/github-sync.js:GITHUB_RENAMED_FORK_LOOKUP_MAX_PAGES': ['OWNED', 'owner decision (Worker redeploy), with the GitHub collection redesign; limits-inventory §3.10.'],
  'app/community-annotations/github-sync.js:MAX_TREE_ITEMS': ['PLAT', 'GitHub truncates a recursive tree at 100,000 entries.'],
  'app/community-annotations/orcid-client.js:ORCID_EXPANDED_SEARCH_MAX_RESULTS': ['UI', 'Suggestions shown while typing a name; typing more reaches any ORCID record.'],
  'app/community-annotations/orcid-client.js:ORCID_RESPONSE_MAX_UTF8_BYTES': ['HOST', 'Bounds one ORCID search response for that many suggestions.'],
  'app/community-annotations/profile-identifiers.js:PROFILE_NAME_MAX_CODEPOINTS': ['HOST', TEXT],
  'app/community-annotations/session.js:MAX_COMMENT_LEN': ['HOST', TEXT],
  'app/community-annotations/session.js:MAX_EVIDENCE_LEN': ['HOST', TEXT],
  'app/community-annotations/session.js:MAX_LABEL_LEN': ['HOST', TEXT],
  'app/community-annotations/session.js:MAX_MERGE_NOTE_LEN': ['HOST', TEXT],
  'app/community-annotations/session.js:MAX_ONTOLOGY_LEN': ['HOST', 'A CURIE such as CL:0000236.'],
  'app/community-annotations/wire-contract.js:ANNOTATION_FILE_MAX_UTF8_BYTES': ['PLAT', "GitHub's Contents API returns a file's content as JSON only up to 1 MB."],
  'app/community-annotations/wire-contract.js:ANNOTATION_LIMITS': ['HOST', TEXT],
  'app/dockable-accordions.js:FLOAT_MAX_HEIGHT_PX': ['UI', 'Default height of a floating panel; it scrolls and resizes.'],
  'app/dockable-accordions.js:FLOAT_MAX_SCALE': ['UI', 'How far a floating panel may be scaled.'],
  'app/main.js:MAX_LOD_VISIBILITY_RETRIES': ['UI', 'Frames to wait for level-of-detail visibility before drawing anyway.'],
  'app/main.js:MEBIBYTE': ['UI', 'A unit, not a limit.'],
  'app/notification-center.js:MAX_TIMER_DELAY_MS': ['PLAT', 'setTimeout delays are signed 32-bit milliseconds.'],
  'app/optional-analytics.js:QUEUE_LIMIT': ['PERF', 'Telemetry queued before the analytics module loads.'],
  'app/session/bundle/format.js:MAX_FRAME_BYTES': ['FORMAT', 'A session bundle frame length is a little-endian u32.'],
  'app/session/codecs/delta-varint.js:COOPERATIVE_DECODE_BUDGET': ['PERF', 'Values decoded between yields to the interface.'],
  'app/session/contributors/user-defined-codes.js:COOPERATIVE_DECODE_BUDGET': ['PERF', 'Values decoded between yields to the interface.'],
  'app/session/dataset-state-manifest.js:MAX_MANIFEST_BYTES': ['FORMAT', 'state-snapshots.json has one valid form, 43 bytes as written.'],
  'app/sidebar-metrics.js:SIDEBAR_MAX_WIDTH_PX': ['UI', 'How wide the sidebar may be dragged.'],
  'app/ui/core/antialias-preference.js:AUTOMATIC_ANTIALIAS_CELL_LIMIT': ['PERF', 'Automatic antialiasing turns off above this many cells; the user can force it.'],
  'app/ui/core/antialias-preference.js:AUTOMATIC_ANTIALIAS_CELL_LIMIT_FLAT': ['PERF', 'Automatic antialiasing turns off above this many flat cells; the user can force it.'],
  'app/ui/modules/benchmark/camera-path.js:PHI_LIMIT': ['UI', 'Keeps the benchmark camera off the poles.'],
  'app/ui/modules/benchmark/generation-contract.js:MAX_SYNTHETIC_COUNT': ['PLAT', 'Synthetic benchmark points: 16 bytes a point reaches 4 GB, the largest ArrayBuffer every engine allocates.'],
  'app/ui/modules/benchmark/matrix-runner.js:GEOMETRY_SETTLE_FRAME_BUDGET': ['UI', 'Frames a benchmark configuration waits for its views\' spatial trees to land and be adopted before a window; a build that never lands is reported.'],
  'app/ui/modules/benchmark/pass-profiler.js:MAX_FLUSH_FRAMES': ['UI', 'Frames a benchmark pass waits for the GPU to drain.'],
  'app/ui/modules/benchmark/performance-tracker.js:OVER_BUDGET_FLAG': ['UI', 'A bit flag, not a limit.'],
  'app/ui/modules/community-annotation/github-connection-flow.js:GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS': ['OWNED', 'owner decision (Worker redeploy); limits-inventory §3.10: one GitHub page per Worker request.'],
  'app/ui/modules/figure-export/figure-export-ui.js:PREVIEW_MAX_SCAN_POINTS': ['PERF', 'Cells the framing preview scans; the export itself draws every cell.'],
  'app/ui/modules/figure-export/utils/layout.js:PANEL_LEGEND_MAX_SHARE': ['UI', 'The share of a panel a legend may take.'],
  'app/ui/modules/figure-export/utils/webgl-point-rasterizer.js:VIEWER_POINT_SIZE_MAX': ['UI', 'The largest point size the viewer draws, mirrored in export.'],
  'app/ui/modules/figure-export/utils/zip-archive.js:MAX_U16': ['FORMAT', 'A ZIP32 field is 16 bits.'],
  'app/ui/modules/figure-export/utils/zip-archive.js:MAX_U32': ['FORMAT', 'A ZIP32 field is 32 bits.'],
  'app/ui/modules/render-controls.js:FORCED_LOD_MAXIMUM': ['UI', 'The deepest level of detail the control can force.'],
  'app/utils/page-membership.js:MAX_INTERSECTION_PAGES': ['FORMAT', 'An intersection combines pages through one 32-bit membership mask.'],
  'data/categorical-storage-contract.js:MAX_CATEGORICAL_CATEGORIES': ['FORMAT', 'uint32 codes hold 4,294,967,295 categories beside the missing marker.'],
  'data/connectivity-manifest-contract.js:UINT16_CELL_CAPACITY': ['FORMAT', 'uint16 edge indices address 65,536 cells.'],
  'data/connectivity-manifest-contract.js:UINT32_CELL_CAPACITY': ['FORMAT', 'uint32 edge indices address 2^32 cells.'],
  'data/continuous-payload-diagnosis.js:NON_FINITE_EXAMPLE_LIMIT': ['MSG', 'How many offending values a diagnosis quotes; every value is checked.'],
  'data/dimension-manager.js:MIB': ['UI', 'A unit, not a limit.'],
  'data/h5ad-loader.js:SLAB_BYTES': ['PERF', 'One hyperslab read; a larger array is read in several.'],
  'data/data-loaders.js:MAX_ERROR_BODY_BYTES': ['MSG', 'How much of a failed response body an error quotes.'],
  'data/jupyter-source.js:JUPYTER_FAILURE_REASON_LIMIT': ['MSG', 'How much of a failure reason is reported to Python.'],
  'data/jupyter-source.js:MAX_SELECTION_CELL_INDEX': ['FORMAT', 'Selections travel as uint32 cell indices.'],
  'data/local-user-source.js:MAX_EAGER_GENE_VALIDATION_BYTES': ['PERF', 'Up to this many bytes gene files are length-checked at open; larger sets are checked as each gene loads.'],
  'data/local-user-source.js:MAX_EAGER_GENE_VALIDATION_FILES': ['PERF', 'Up to this many files gene files are length-checked at open; larger sets are checked as each gene loads.'],
  'data/payload-transfer-cache.js:PAYLOAD_TRANSFER_CACHE_BYTES': ['PERF', 'Compressed gene payloads kept for decoding again; others are downloaded again.'],
  'data/remote-source.js:MAX_CONNECTION_TIMEOUT_MS': ['UI', 'The longest connection timeout a user may set.'],
  'data/sparse-column-index.js:DISK_BUFFER_BUDGET_ENTRIES': ['PERF', 'Entries buffered before a spill to disk.'],
  'data/zarr-archive.js:MAX_EOCD_SEARCH_BYTES': ['FORMAT', 'The ZIP end record sits within its fixed size plus a 16-bit comment of the end.'],
  'data/zarr-archive.js:MAX_ZIP_COMMENT_BYTES': ['FORMAT', 'A ZIP comment length is 16 bits.'],
  'data/zarr-codecs.js:DEFLATE_MAX_EXPANSION': ['FORMAT', 'DEFLATE expands at most 1032 to 1, so a declared size bounds its input.'],
  'data/zarr-codecs.js:LZ4_MAX_EXPANSION': ['FORMAT', 'LZ4 expands at most 255 to 1, so a declared size bounds its input.'],
  'rendering/backdrops/backdrop-look-renderer.js:BAKE_BAND_GPU_BUDGET_MS': ['PERF', 'GPU time one bake band may cost once the GPU is measured, so frames between bands are not held behind one; bands shrink, nothing is dropped.'],
  'rendering/backdrops/backdrop-look-renderer.js:BAKE_REFINE_BUDGET_MS': ['PERF', 'A sky refines to the next level while that level is expected to land within this time at the measured GPU rate; the look shows from its first level on every GPU.'],
  'rendering/backdrops/backdrop-look-renderer.js:SLICE_BUDGET_MS': ['PERF', 'Bake work per idle slice before yielding to the page; every bake completes.'],
  'rendering/backdrops/backdrop-looks.js:BACKDROP_AMBIENT_MAX_HZ': ['UI', 'The highest rate of the optional background twinkle and drift.'],
  'rendering/backdrops/backdrop-looks.js:DARK_BAND_MAX_LSTAR': ['UI', 'How bright a dark background look may get, so the cells stay readable.'],
  'rendering/gl-errors.js:MAX_PENDING_WEBGL_ERRORS': ['MSG', 'WebGL errors kept for a report.'],
  'rendering/gl-utils.js:MAX_VERTICES_PER_DRAW': ['PERF', 'Draws are split into calls of this many vertices (Firefox caps one call); every point is drawn.'],
  'rendering/high-perf-renderer.js:MAX_ALPHA_UPLOAD_REGIONS': ['PERF', 'Above this many changed ranges one upload replaces them.'],
  'rendering/high-perf-renderer.js:MAX_CULLED_DRAW_RANGES': ['PERF', 'Above this many culled ranges the draw falls back to fewer, larger ones.'],
  'rendering/high-perf-renderer.js:MAX_CULLED_DRAW_RANGES_MULTI_DRAW': ['PERF', 'The same with multi-draw.'],
  'dev/benchmark.js:MEBIBYTE': ['UI', 'A unit, not a limit.'],
  'rendering/high-perf-renderer.js:LOD_BUILD_HEAP_FIXED_BYTES': ['PERF', 'The fixed part of the worker heap estimate for a tree build.'],
  'rendering/high-perf-renderer.js:MIB': ['UI', 'A unit, not a limit.'],
  'rendering/high-perf-renderer.js:WORKER_POSITION_SLICE_FLOATS': ['PERF', 'Positions sent to the tree worker per slice (64 MiB).'],
  'rendering/high-perf/spatial-index.js:ADAPTIVE_LOD_MAXIMUM_REDUCTION': ['PERF', 'How coarse automatic level of detail may get; zoom and forced detail show every cell.'],
  'rendering/high-perf/spatial-index.js:ADAPTIVE_LOD_POINT_BUDGET': ['PERF', 'Points automatic level of detail aims to draw; zoom and forced detail show every cell.'],
  'rendering/overlays/velocity/velocity-overlay.js:DEFAULT_VELOCITY_PARTICLE_CAPACITY': ['UI', 'Animated velocity particles drawn, not data.'],
  'rendering/overlays/velocity/velocity-overlay.js:SPAWN_BUILD_MAX_ITEMS_PER_SLICE': ['PERF', 'Items built per slice between yields.'],
  'rendering/overlays/velocity/velocity-overlay.js:SPAWN_BUILD_TIME_BUDGET_MS': ['PERF', 'Time per slice between yields.'],
  'rendering/picking.js:MAX_DRAWN_POINT_SIZE_PX': ['UI', 'The largest point size the viewer draws.'],
  'rendering/point-size-scale.js:MAXIMUM_AUTOMATIC_POINT_SIZE': ['UI', 'The largest size automatic point sizing picks.'],
  'rendering/point-size-scale.js:MAXIMUM_POINT_SIZE': ['UI', 'The largest point size.'],
  'rendering/point-size-scale.js:POINT_SIZE_SLIDER_MAXIMUM': ['UI', 'The point size slider range.'],
  'rendering/presented-camera-settlement.js:MAXIMUM_UNCHANGED_FRAMES': ['UI', 'Frames without change before the camera counts as settled.'],
  'rendering/projectiles.js:MAX_CHARGE_TIME': ['UI', 'An easter-egg animation parameter.'],
  'rendering/projectiles.js:MAX_IMPACT_FLASHES': ['UI', 'An easter-egg animation parameter.'],
  'rendering/projectiles.js:MAX_PROJECTILES': ['UI', 'An easter-egg animation parameter.'],
  'rendering/projectiles.js:MAX_SPEED_MULT': ['UI', 'An easter-egg animation parameter.'],
  'rendering/projectiles.js:MAX_VELOCITY': ['UI', 'An easter-egg animation parameter.'],
  'rendering/shaders/density-shaders.js:REDUCE_MAX_FS': ['UI', 'A shader source (a max reduction), not a limit.'],
  'rendering/shaders/high-perf-shaders.js:NO_DEPTH_MAX_DIMENSION': ['UI', 'Up to 2-D, points are drawn without depth testing.'],
  'rendering/shaders/smoke-shaders.js:MAX_SMOKE_MARCH_STEPS': ['UI', 'Ray-march steps of the smoke rendering quality.'],
  'rendering/shaders/studio-shaders.js:STUDIO_RAY_LIMIT': ['UI', 'Ray length of the studio backdrop.'],
  'rendering/smoke-cloud/gpu-noise-generator.js:DEFAULT_NOISE_BATCH_BUDGET_MS': ['PERF', 'Time per noise batch between frames.'],
  'rendering/smoke-cloud/gpu-noise-generator.js:DEFAULT_NOISE_BATCH_PIXEL_BUDGET': ['PERF', 'Pixels per noise batch between frames.'],
  'rendering/smoke-cloud/smoke-density-contract.js:MAX_SMOKE_GRID_SIZE': ['PLAT', 'An RGBA8 volume inside the guaranteed MAX_3D_TEXTURE_SIZE of 256.'],
  'rendering/smoke-cloud/smoke-density-contract.js:MAX_SMOKE_NOISE_RESOLUTION': ['PLAT', 'A noise volume inside the guaranteed MAX_3D_TEXTURE_SIZE of 256.'],
  'rendering/smoke-cloud/smoke-density.js:MAX_SPLAT_POINTS_PER_BATCH': ['PERF', 'Points splatted per batch; every point is splatted.'],
  'rendering/smoke-cloud/smoke-renderer.js:MAX_SMOKE_RESOLUTION_SCALE': ['UI', 'Smoke renders at no more than the screen resolution.'],
  'rendering/smoke-cloud/smoke-renderer.js:MAX_SMOKE_TARGET_PIXELS': ['PERF', 'Smoke renders at a lower resolution above this many pixels and is scaled up.'],
  'rendering/viewer.js:MAX_FRAME_DT': ['UI', 'The longest frame step an animation takes after a stall.'],
  'rendering/viewer.js:MAX_PITCH': ['UI', 'Keeps the free-fly camera off the poles.'],
};

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'vendor') yield* sourceFiles(full);
    } else if (entry.endsWith('.js')) {
      yield full;
    }
  }
}

function scanLimits() {
  const found = new Set();
  const base = path.join(ROOT, 'assets', 'js');
  for (const file of sourceFiles(base)) {
    const relative = path.relative(base, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(DECLARATION)) {
      const name = match[1];
      if (NAME.test(name.replace(/^CAP_/, ''))) found.add(`${relative}:${name}`);
    }
    // A byte size given a name is a size someone chose; it is classified
    // whatever the name. (Unnamed `bytes / (1024 * 1024)` only formats.)
    for (const line of text.split('\n')) {
      if (!MIB.test(line)) continue;
      const declared = /\b(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (declared !== null) found.add(`${relative}:${declared[1]}`);
    }
  }
  return found;
}

test('every size or count limit in the web app is classified with a reason', () => {
  const found = scanLimits();
  const unclassified = [...found].filter(key => !Object.hasOwn(ALLOWLIST, key)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'Classify these in tests/size-limit-allowlist-contract.test.mjs, or remove the limit.',
  );
  const stale = Object.keys(ALLOWLIST).filter(key => !found.has(key)).sort();
  assert.deepEqual(stale, [], 'Remove these entries: the limits are gone.');
});

test('every allowlist entry names a real class and its reason', () => {
  for (const [key, [kind, reason]] of Object.entries(ALLOWLIST)) {
    assert.ok(CLASSES.has(kind), `${key}: ${kind} is not a limit class`);
    assert.ok(reason.trim().length > 0, `${key}: say why the limit exists`);
    if (kind === 'OWNED') {
      assert.match(reason, /limits-inventory/, `${key}: an OWNED limit names its inventory entry`);
    }
  }
});
