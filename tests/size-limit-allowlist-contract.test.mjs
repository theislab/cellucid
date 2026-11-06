/**
 * Every size or count limit in the web app is a real one, and says why.
 *
 * A constant under assets/js (or the agent relay Worker, relay/) whose name has MAX, MAXIMUM, LIMIT, CAP,
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
 *
 * A cap can also be written inline, as a bare number where a value is bounded,
 * with no name to find. INLINE_ALLOWLIST classifies those the same way, keyed
 * `<file>:<form> <literal>` (one entry covers every use of that literal in that
 * form in that file). Five forms are scanned (whole-line comments are not):
 *
 * - a numeric literal argument of `Math.min(...)`;
 * - a numeric literal as the last argument (the upper bound) of a `clamp*(...)`
 *   call;
 * - a numeric literal (or a quoted one, as an HTML attribute value) as the value
 *   of a `max`, `maximum`, `maxlength`, `limit` or `cap` property, or of a
 *   property named `max...`, `maximum...`, `...Limit`, `...Cap`, `...Max`;
 * - the same names as a default parameter value (`{ max = 2048 } = {}`);
 * - an HTML `max`/`maxlength` attribute (`max="50"`, `.max = 50`,
 *   `setAttribute('maxlength', 120)`).
 *
 * A bound of 0 or 1 is a sign or a fraction, not a size, and is not listed.
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


/** @type {Record<string, [string, string]>} */
const ALLOWLIST = {
  'analytics/schema.js:GA4_LIMITS': ['PLAT', 'Google Analytics 4 event and parameter limits.'],
  'analytics/tracker.js:MAX_ANCESTOR_DEPTH': ['UI', 'How far up the DOM a click looks for its tracked control.'],
  'app/analysis/compute/math-utils.js:GAMMA_MAX_ITERATIONS': ['FORMAT', 'Series iterations of the incomplete gamma function; it converges far sooner.'],
  'app/analysis/compute/math-utils.js:MAX_TABULATED_DISTINCT_VALUES': ['PERF', 'Above this many distinct values a density sends raw values instead of a table.'],
  'app/analysis/compute/math-utils.js:NATIVE_SORT_MAX_LENGTH': ['PERF', 'Above this length a radix sort replaces the native sort; every value is sorted.'],
  'app/analysis/compute/worker-pool.js:DISPATCH_CLONE_BYTES_PER_TASK': ['PERF', 'Bytes copied to analysis workers per main-thread task; larger dispatches are split.'],
  'app/history/value-parts.js:MAX_VALUE_TEXT': ['PLAT', 'V8\'s longest string (2^29 - 24 characters): a stored value whose parts expand past it could be neither hashed nor written as text, so it is refused before it is expanded.'],
  'app/session/history-file.js:CHUNK_TEXT_CHARS': ['PERF', 'Where a session file\'s JSON chunks (steps, parts, values) are cut into pieces, far below V8\'s longest string; decides how many chunks a file has, never how much it may hold.'],
  'app/exports/cell-exports.js:SPOOL_SEGMENT_BYTES': ['PERF', 'Bytes an export spool gathers before writing them as one private-storage file; decides how many files an export writes, never how large it may be.'],
  'app/agent/bridge/relay-client.js:RECONNECT_DELAY_CEILING_MS': ['UI', 'The longest wait between reconnections to the agent relay; coming back online or showing the tab retries at once.'],
  'app/agent/chat/agent-loop.js:RETRY_CEILING_MS': ['UI', 'The longest wait before a chat turn calls its model again after too many requests, an overloaded provider or a dropped connection; the turn waits until it goes through or the person stops it, and coming back online tries at once.'],
  'app/agent/bridge/relay-protocol.js:RESULT_IMAGE_MAX_SIDE': ['PLAT', 'Claude\'s documented largest image (8000 × 8000 px); a larger picture is left out of a tool result with a sentence, never sent to be refused.'],
  'app/agent/bridge/relay-protocol.js:RESULT_IMAGE_MAX_BYTES': ['PLAT', 'Claude\'s documented largest image (10 MB, read as base64 text); a larger picture is left out of a tool result with a sentence, never sent to be refused.'],
  'relay/clients.js:CLIENT_DOCUMENT_MAX_BYTES': ['HOST', "A client metadata document fetched from an address anyone can give; the Client ID Metadata Document draft recommends 5 KB at most (Claude's and ChatGPT's are under 600 bytes)."],
  'relay/clients.js:CLIENT_ID_MAX_CHARS': ['PLAT', 'A registered client id travels in the authorization URL, and Cloudflare refuses a URL above 16 KB.'],
  'relay/mcp.js:MCP_BODY_MAX_BYTES': ['HOST', 'One MCP request carries one tool call written by a model, a few hundred kilobytes at most.'],
  'relay/oauth.js:OAUTH_BODY_MAX_BYTES': ['HOST', 'An OAuth registration or token request is a handful of fields; a larger body is not one.'],
  'app/community-annotations/_worker-code.js:CAP_LOOKUP_LIMIT_MAX': ['UI', 'Results of one CAP lookup, ranked by relevance; a more specific term reaches any other cell type.'],
  'app/community-annotations/_worker-code.js:CAP_MARKER_TERM_MAX_CODE_POINTS': ['HOST', 'A marker search names at most 50 genes of 64 code points, comma separated.'],
  'app/community-annotations/_worker-code.js:CAP_OUTPUT_BODY_MAX_BYTES': ['PLAT', 'One gateway response stays well inside a Cloudflare Worker isolate (128 MB).'],
  'app/community-annotations/_worker-code.js:CAP_REQUEST_BODY_MAX_BYTES': ['HOST', 'A lookup request is a kind, a term and a limit; anything larger is not one.'],
  'app/community-annotations/_worker-code.js:CAP_RESPONSE_BODY_MAX_BYTES': ['PLAT', 'One upstream CAP response held in a Cloudflare Worker isolate (128 MB).'],
  'app/community-annotations/_worker-code.js:CAP_TERM_MAX_CODE_POINTS': ['HOST', 'A cell-type search term; CAP labels are far shorter.'],
  'app/community-annotations/_worker-code.js:OAUTH_COOKIE_MAX_AGE_S': ['UI', 'How long an OAuth sign-in may take before it starts over.'],
  'app/community-annotations/_worker-code.js:OAUTH_COOKIE_MAX_SERIALIZED_BYTES': ['PLAT', 'Browsers keep a cookie of at least 4,096 bytes, name, value and attributes together (RFC 6265 6.1); a longer return address comes back to the page with the reason.'],
  'app/community-annotations/_worker-code.js:PREFLIGHT_MAX_AGE_SECONDS': ['PLAT', "Chromium keeps a CORS preflight answer at most 2 hours (Firefox 24): the longest every engine honours; it bounds no data."],
  'app/community-annotations/_worker-code.js:WORKER_REQUEST_BODY_MAX_BYTES': ['HOST', 'A request body is held in the isolate (128 MB, shared) before it is checked; the largest one Cellucid sends is one 1,000,000-byte file in base64 (1,333,336 bytes) in its JSON envelope, and a /graphql/blobs body of this size names about 30,000 objects.'],
  'app/community-annotations/cap-api.js:CAP_LOOKUP_LIMIT': ['UI', 'Results of one CAP lookup, ranked by relevance; a more specific term reaches any other cell type.'],
  'app/community-annotations/cap-api.js:CAP_MARKER_GENE_MAX_CODEPOINTS': ['HOST', 'One gene of a marker search, as the Worker accepts it.'],
  'app/community-annotations/cap-api.js:CAP_MARKER_TERM_MAX_CODEPOINTS': ['HOST', 'A marker search names at most 50 genes of 64 code points, comma separated.'],
  'app/community-annotations/cap-api.js:CAP_REQUEST_BODY_MAX_BYTES': ['HOST', 'The Worker refuses a larger lookup request.'],
  'app/community-annotations/cap-api.js:CAP_TERM_MAX_CODEPOINTS': ['HOST', 'The Worker refuses a longer search term.'],
  'app/community-annotations/cap-api.js:CAP_WORKER_ERROR_MAX_CODEPOINTS': ['MSG', 'A longer "error" is not a Worker sentence; the HTTP status is shown instead.'],
  'app/community-annotations/orcid-client.js:ORCID_EXPANDED_SEARCH_MAX_RESULTS': ['UI', 'Suggestions shown while typing a name; typing more reaches any ORCID record.'],
  'app/community-annotations/orcid-client.js:ORCID_RESPONSE_MAX_UTF8_BYTES': ['HOST', 'Bounds one ORCID search response for that many suggestions.'],
  'app/community-annotations/wire-contract.js:ANNOTATION_FILE_MAX_UTF8_BYTES': ['PLAT', "GitHub's Contents API returns a file's content as JSON only up to 1 MB."],
  'app/community-annotations/wire-contract.js:ANNOTATION_JSON_MAX_DEPTH': ['PLAT', "The repository validator's JSON reader (Python's json) recurses once per level and stops at the interpreter's recursion limit (1000 by default); both validators refuse deeper JSON with one sentence, and no valid annotation file nests deeper than 7 levels."],
  'app/main.js:MAX_LOD_VISIBILITY_RETRIES': ['UI', 'Frames to wait for level-of-detail visibility before drawing anyway.'],
  'app/main.js:MEBIBYTE': ['UI', 'A unit, not a limit.'],
  'app/notification-center.js:MAX_TIMER_DELAY_MS': ['PLAT', 'setTimeout delays are signed 32-bit milliseconds.'],
  'data/sources/auth/token-store.js:MAX_TIMER_DELAY_MS': ['PLAT', 'setTimeout delays are signed 32-bit milliseconds.'],
  'app/optional-analytics.js:QUEUE_LIMIT': ['PERF', 'Telemetry queued before the analytics module loads.'],
  'app/session/bundle/format.js:MAX_FRAME_BYTES': ['FORMAT', 'A session bundle frame length is a little-endian u32.'],
  'app/session/codecs/cell-set.js:COOPERATIVE_DECODE_BUDGET': ['PERF', 'Cells decoded between yields to the interface.'],
  'app/sidebar-metrics.js:SIDEBAR_MAX_WIDTH_PX': ['UI', 'How wide the sidebar may be dragged.'],
  'app/ui/core/antialias-preference.js:AUTOMATIC_ANTIALIAS_CELL_LIMIT': ['PERF', 'Automatic antialiasing turns off above this many cells; the user can force it.'],
  'app/ui/core/antialias-preference.js:AUTOMATIC_ANTIALIAS_CELL_LIMIT_FLAT': ['PERF', 'Automatic antialiasing turns off above this many flat cells; the user can force it.'],
  'app/ui/modules/benchmark/camera-path.js:PHI_LIMIT': ['UI', 'Keeps the benchmark camera off the poles.'],
  'app/ui/modules/benchmark/generation-contract.js:MAX_SYNTHETIC_COUNT': ['PLAT', 'Synthetic benchmark points: 16 bytes a point reaches 4 GB, the largest ArrayBuffer every engine allocates.'],
  'app/ui/modules/benchmark/matrix-runner.js:GEOMETRY_SETTLE_FRAME_BUDGET': ['UI', 'Frames a benchmark configuration waits for its views\' spatial trees to land and be adopted before a window; a build that never lands is reported.'],
  'app/ui/modules/benchmark/pass-profiler.js:MAX_FLUSH_FRAMES': ['UI', 'Frames a benchmark pass waits for the GPU to drain.'],
  'app/ui/modules/benchmark/performance-tracker.js:OVER_BUDGET_FLAG': ['UI', 'A bit flag, not a limit.'],
  'app/ui/modules/figure-export/figure-export-ui.js:PREVIEW_MAX_SCAN_POINTS': ['PERF', 'Cells the framing preview scans; the export itself draws every cell.'],
  'app/ui/modules/figure-export/utils/layout.js:PANEL_LEGEND_MAX_SHARE': ['UI', 'The share of a panel a legend may take.'],
  'app/ui/modules/figure-export/renderers/svg-point-markup.js:MARKUP_BUFFER_BYTES': ['PERF', 'Vector point markup encoded per reused buffer before it becomes a Blob part; every point is written.'],
  'formats/zip/writer.js:UINT16_MAX': ['FORMAT', 'A ZIP field of 16 bits; an entry count past it is written in the ZIP64 end record, never refused.'],
  'formats/zip/writer.js:UINT32_MAX': ['FORMAT', 'A ZIP field of 32 bits; a size or offset past it is written in a ZIP64 field, never refused.'],
  'formats/zip/writer.js:DIRECTORY_SEGMENT_BYTES': ['PERF', 'Bytes of each segment the central directory is packed into as entries are added; any number of entries is written.'],
  'data/anndata/write/acknowledged-sink.js:COPY_BATCH_BYTES': ['PERF', 'Bytes of a copy gathered into one message to the page, so a copy is not a message per chunk; any size is written.'],
  'app/ui/modules/figure-export/utils/zip-archive.js:CRC_SLICE_BYTES': ['PERF', 'Bytes of a batch ZIP entry checksummed per main-thread task; every byte is checksummed.'],
  'app/ui/modules/figure-export/utils/webgl-point-rasterizer.js:VIEWER_POINT_SIZE_MAX': ['UI', 'The largest point size the viewer draws, mirrored in export.'],
  'app/utils/page-membership.js:MAX_INTERSECTION_PAGES': ['FORMAT', 'An intersection combines pages through one 32-bit membership mask.'],
  'data/subsample.js:MAX_CELLS': ['FORMAT', 'Cell positions and subsample seeds are uint32 (the subsampling specification).'],
  'data/categorical-storage-contract.js:MAX_CATEGORICAL_CATEGORIES': ['FORMAT', 'uint32 codes hold 4,294,967,295 categories beside the missing marker.'],
  'data/connectivity-summary-contract.js:UINT32_CELL_CAPACITY': ['FORMAT', 'uint32 edge indices address 2^32 cells.'],
  'data/continuous-payload-diagnosis.js:NON_FINITE_EXAMPLE_LIMIT': ['MSG', 'How many offending values a diagnosis quotes; every value is checked.'],
  'data/dimension-manager.js:MIB': ['UI', 'A unit, not a limit.'],
  'data/sources/providers/github.js:LFS_POINTER_MAX_BYTES': ['FORMAT', 'The Git LFS specification keeps a pointer file under 1024 bytes; a larger file is content, not a pointer.'],
  'data/anndata/reader.js:FLOAT_DTYPE_MAX': ['FORMAT', 'The largest finite value of each IEEE float type a matrix is stored in: a cell total its log1p undone implies past it refutes uns[\'log1p\'] (no data held it).'],
  'data/anndata/values.js:SLAB_BYTES': ['PERF', 'Decoded bytes per row slab of a long read; a larger array is read in several slabs.'],
  'data/anndata/prefix-column-index.js:SLAB_ENTRIES': ['PERF', 'Entries of one slab of a gene index\'s work: the least a first index segment covers; any matrix is indexed, in as many segments as it takes.'],
  'data/viewer-protocol.js:VIEWER_COMMAND_ERROR_REASON_LIMIT': ['MSG', 'How much of a failed command\'s reason the viewer reports to the host.'],
  'data/sparse-column-index.js:DISK_BUFFER_BUDGET_ENTRIES': ['PERF', 'Entries buffered before a spill to disk.'],
  'data/sparse-column-index.js:KEPT_PIECE_BYTES': ['PERF', 'Bytes of a kept gene index written between yields to the reader thread.'],
  'data/anndata/transcode/space.js:MEMORY_DOWNLOAD_BATCH_BYTES': ['PERF', 'Bytes of a whole-file download gathered before they join its Blob where the browser gives the page no storage; any file size is downloaded, in as many batches as it takes.'],
  'data/anndata/transcode/zarr-writer.js:CHUNK_BYTES': ['PERF', 'Bytes of one chunk of a transcoded array: each chunk is one range of what the pass kept, read on demand; any array length is chunked, never limited.'],
  'formats/io/hosts.js:MAX_QUIET_MS': ['PLAT', 'RFC 6298 (2.5) lets a retransmission timer be held to 60 s at most: the longest a file whose host stopped answering is left unasked before one request asks again; it bounds no data.'],
  'formats/io/decode-pool.js:DECODE_WORKER_BYTES': ['PERF', 'Measured memory of one decode worker; with the decode-worker budget it sizes the pool, never what is decoded.'],
  'formats/hdf5/writer.js:BTREE_LEAF_MAX_RECORDS': ['FORMAT', 'A version 2 B-tree node counts its records with a uint16; the writer refuses, never truncates, an object of more attributes than one dense-storage leaf names.'],
  'formats/hdf5/writer.js:HEAP_MAX_OBJECTS': ['FORMAT', 'A global heap collection numbers its objects with a uint16, 0 the free space; more strings take more collections.'],
  'formats/hdf5/writer.js:MESSAGE_MAX_BYTES': ['FORMAT', 'A version 2 object header message gives its size as a uint16; a larger attribute goes to dense storage, and any other message past it is refused, never wrapped.'],
  'formats/rds/bzip2.js:MAX_CODE_LENGTH': ['FORMAT', 'A bzip2 Huffman code is at most 20 bits (bzip2 BZ_MAX_CODE_LEN).'],
  'formats/rds/bzip2.js:MAX_GROUPS': ['FORMAT', 'A bzip2 block has 2 to 6 Huffman tables (bzip2 BZ_N_GROUPS).'],
  'formats/rds/bzip2.js:MAX_SELECTORS': ['FORMAT', 'bzip2 uses at most 18,002 table selectors of a block (BZ_MAX_SELECTORS); more are read and passed over, as bzip2 1.0.8 does.'],
  'formats/rds/stream.js:STREAM_PIECE_BYTES': ['PERF', 'Bytes of one read of a file streamed once from the start (a few run ahead); the whole file is read, in as many pieces as it takes.'],
  'formats/rds/xdr.js:RANGE_WINDOW_BYTES': ['PERF', 'Bytes of one read of an uncompressed R file\'s structure; large payloads are jumped over, so a window holds names and attributes.'],
  'formats/rds/xz.js:POS_STATES_MAX': ['FORMAT', 'LZMA has at most 16 position states (pb <= 4).'],
  'formats/zarr/codecs/blosc.js:LZ4_MAX_EXPANSION': ['HOST', 'LZ4 expands at most 255 to 1, so a frame may not declare more than that of its input.'],
  'formats/zarr/codecs/javascript/blosc.js:BLOSCLZ_MAX_DISTANCE': ['FORMAT', 'blosclz encodes long-distance matches past this offset.'],
  'formats/zarr/codecs/javascript/blosc.js:LZ4_MAX_EXPANSION': ['HOST', 'LZ4 expands at most 255 to 1, so a frame may not declare more than that of its input.'],
  'formats/zarr/codecs/javascript/blosc.js:MAX_SPLITS': ['FORMAT', 'Blosc splits a block into per-byte streams only for elements of at most 16 bytes.'],
  'formats/zarr/codecs/javascript/zstd.js:MAX_BLOCK_BYTES': ['FORMAT', 'A Zstandard block holds at most 128 KiB (RFC 8878 Block_Maximum_Size).'],
  'formats/zarr/stores/common.js:LOCAL_MERGED_READ_BYTES': ['PERF', 'Ranges of one file on this computer (a picked folder\'s file, a kept copy\'s blob) asked for together are read in slices up to this long; a longer range is read whole. Measured: merging saves a read\'s fixed cost, a longer slice delays decoding its first chunk.'],
  'formats/zip/archive.js:DEFLATE_MAX_EXPANSION': ['HOST', 'DEFLATE expands at most 1032 to 1, so an entry may not declare more than that of its compressed size.'],
  'formats/zip/archive.js:MAX_COMMENT_BYTES': ['FORMAT', 'A ZIP comment length is 16 bits, so the end record sits within its fixed size plus that of the end.'],
  'formats/zip/archive.js:UINT16_MAX': ['FORMAT', 'A ZIP32 field is 16 bits; all ones defers to the ZIP64 record.'],
  'formats/zip/archive.js:UINT32_MAX': ['FORMAT', 'A ZIP32 field is 32 bits; all ones defers to the ZIP64 record.'],
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
  'rendering/full-detail-frame-cost.js:INTERACTIVE_FRAME_BUDGET_MS': ['UI', 'The frame time that keeps moving the view smooth (30 fps), against which a frame of every cell is measured; it decides only whether level of detail and culling start on, and either can be turned off.'],
  'rendering/high-perf/lod-levels.js:ADAPTIVE_LOD_MAXIMUM_REDUCTION': ['PERF', 'How coarse automatic level of detail may get; zoom and forced detail show every cell.'],
  'rendering/high-perf/lod-levels.js:ADAPTIVE_LOD_POINT_BUDGET': ['PERF', 'Points automatic level of detail aims to draw; zoom and forced detail show every cell.'],
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
  'utils/large-arrays.js:MEMORY_MAX_BYTES': ['PLAT', 'A 32-bit WebAssembly memory holds 65,536 pages of 64 KiB; every engine refuses one more (measured).'],
  'utils/radix-order.js:MAX_DIGIT_BITS': ['PERF', 'The widest digit a radix pass sorts by (65,536 counters); a wider key takes another pass, every key is sorted.'],
};

const PERCENT = "A percentage: 100 is all of it.";
const PROGRESS_99 = "A progress percentage held at 99 until the work completes.";
const CONTROL_RANGE = "A control's range: a visual or interaction setting, not data.";
const PLOT_LAYOUT = "A plot's layout in pixels or points: a visual setting, not data.";
const EXPORT_LAYOUT = "A figure's layout in pixels or points: a visual setting, not data; every cell is exported.";
const SHADER_LOOK = "A shader's visual parameter, not data.";
const COLOR_BYTE = "An 8-bit color channel.";
const UINT32 = "A uint32 (a subsample seed is uint32; the subsampling specification).";
const VEC3 = "A 3-D vector has three components.";
const DIGITS = "A double has at most 17 significant decimal digits.";

/** @type {Record<string, [string, string]>} */
const INLINE_ALLOWLIST = {
  'analytics/schema.js:max: 86_400_000': ['HOST', 'A Web Vitals or long-task metric of the page; one of more than a day (86,400,000 ms) is not a measurement.'],
  'app/actions/definitions/camera.js:maxItems: 3': ['FORMAT', VEC3],
  'app/actions/definitions/camera.js:maximum: 100': ['UI', 'The transition speed scale, 1 (very slow) to 100 (very fast).'],
  'app/actions/definitions/filters.js:maximum: 0xffffffff': ['FORMAT', UINT32],
  'app/actions/definitions/highlights.js:maxItems: 2': ['FORMAT', 'A comparison of two pages names two pages.'],
  'app/actions/definitions/mapping.js:maximum: 0xffffffff': ['FORMAT', UINT32],
  'app/actions/definitions/params.js:maxItems: 3': ['FORMAT', 'An embedding is drawn in one to three dimensions, one column each.'],
  'app/actions/definitions/reads.js:maxItems: 3': ['FORMAT', VEC3],
  'app/actions/definitions/reads.js:maximum: 20000': ['UI', "A plot picture's width in pixels, as the figure export allows; a picture size, not data."],
  'app/agent/chat/ask.js:max: 5': ['UI', 'Choices one question of the in-app agent offers; the person can always answer in their own words.'],
  'app/analysis/options/de-options.js:max: 100': ['FORMAT', PERCENT],
  'app/analysis/options/marker-options.js:max: 100': ['FORMAT', PERCENT],
  'app/analysis/plots/layout-engine.js:Math.min 3': ['UI', 'Columns of a multi-page plot grid; more pages take more rows.'],
  'app/analysis/plots/types/boxplot.js:max: 100': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/boxplot.js:max: 12': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/densityplot.js:max: 100': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/dotplot.js:Math.min 28': ['UI', PLOT_LAYOUT],
  'app/analysis/plots/types/dotplot.js:max: 140': ['UI', PLOT_LAYOUT],
  'app/analysis/plots/types/gene-heatmap.js:Math.min 10': ['UI', PLOT_LAYOUT],
  'app/analysis/plots/types/gene-heatmap.js:Math.min 22': ['UI', PLOT_LAYOUT],
  'app/analysis/plots/types/gene-heatmap.js:Math.min 220': ['UI', PLOT_LAYOUT],
  'app/analysis/plots/types/gene-heatmap.js:max: 6': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/histogram.js:max: 100': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/pieplot.js:Math.min 3': ['UI', 'Columns of a multi-page plot grid; more pages take more rows.'],
  'app/analysis/plots/types/pieplot.js:max: 20': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/pieplot.js:maxCategories: 10': ['UI', 'Slices a pie draws before it groups the rest into one "Other" slice, which keeps their total.'],
  'app/analysis/plots/types/scatterplot.js:Math.min 500': ['UI', 'Points drawn as SVG marks over the density layer, which itself draws every cell.'],
  'app/analysis/plots/types/scatterplot.js:max: 12': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/violinplot.js:max: 10': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/violinplot.js:max: 100': ['UI', CONTROL_RANGE],
  'app/analysis/plots/types/volcanoplot.js:max: 12': ['UI', CONTROL_RANGE],
  'app/analysis/shared/color-utils.js:Math.min 255': ['FORMAT', COLOR_BYTE],
  'app/analysis/shared/lru-cache.js:maxSize = 100': ['PERF', 'Entries an analysis cache keeps by default; an evicted result is computed again.'],
  'app/analysis/stats/multi-variable-analysis.js:maxRank = 1500': ['FORMAT', "UCell's published default rank cutoff (Andreatta & Carmona, 2021), a parameter of the score the caller may set."],
  'app/analysis/ui/analysis-types/dotplot-ui.js:Math.min 640': ['UI', PLOT_LAYOUT],
  'app/analysis/ui/analysis-types/genes-panel-ui.js:Math.min 560': ['UI', PLOT_LAYOUT],
  'app/analysis/ui/analysis-types/genes-panel-ui.js:maxPctRef: 100': ['FORMAT', PERCENT],
  'app/analysis/ui/analysis-types/quick-insights-ui.js:maxListHeight: 240': ['UI', 'The height of a scrolling list in pixels; every item stays reachable.'],
  'app/analysis/ui/components/multi-select-dropdown.js:maxListHeight = 240': ['UI', 'The height of a scrolling list in pixels; every item stays reachable.'],
  'app/analysis/ui/components/options.js:Math.min 6': ['MSG', 'Decimals a numeric option shows for its step.'],
  'app/community-annotations/cap-api.js:Math.min 250': ['UI', 'Ranks a longer matching label lower, by at most 250 points; it orders results and drops none.'],
  'app/community-annotations/cap-api.js:limit = 10': ['UI', 'Results of one CAP lookup, ranked by relevance; a more specific term reaches any other cell type.'],
  'app/community-annotations/scope-lock.js:max: 24': ['FORMAT', 'A UTC instant with milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ) is 24 characters.'],
  'app/community-annotations/scope-lock.js:max: 36': ['FORMAT', 'A UUID is 36 characters.'],
  'app/history/model.js:maxItems: 2': ['FORMAT', 'A pair has two items.'],
  'app/jobs/cancellable-job.js:Math.min 100': ['FORMAT', PERCENT],
  'app/main.js:clamp 1000': ['UI', "The connectivity slider's lowest edge count (1% of the edges, held between 100 and 1,000); its top is every edge."],
  'app/read-progress-notifications.js:Math.min 100': ['FORMAT', PERCENT],
  'app/session/bundle/writer.js:maximum: 0xffff_ffff': ['FORMAT', 'A session bundle frame length is a little-endian u32.'],
  'app/session/session-context.js:maximum: 3': ['FORMAT', 'A view is drawn in one to three dimensions.'],
  'app/ui/modules/benchmark/matrix-runner.js:maxFrames = 240': ['UI', 'Frames a benchmark step waits for its condition before it reports it unmet.'],
  'app/ui/modules/cinematic-camera/index.js:maximum: 100': ['UI', CONTROL_RANGE],
  'app/ui/modules/cinematic-camera/transport-bar.js:max="1000"': ['UI', "The timeline scrubber's resolution, 1,000 steps over any duration."],
  'app/ui/modules/cinematic-camera/transport-bar.js:maximum: 1000': ['UI', "The timeline scrubber's resolution, 1,000 steps over any duration."],
  'app/ui/modules/community-annotation/controls-panel.js:max: 100': ['FORMAT', 'The consensus threshold slider in percent: a threshold is a fraction from -1 to 1.'],
  'app/ui/modules/community-annotation/github-connection-flow.js:Math.min 4': ['UI', 'The steps of the connection walkthrough.'],
  'app/ui/modules/figure-export/components/centroid-overlay.js:Math.min 2.5': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/components/orientation-indicator.js:Math.min 160': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/components/orientation-indicator.js:clamp 10': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/components/orientation-indicator.js:clamp 18': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/components/orientation-indicator.js:clamp 48': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/components/orientation-indicator.js:clamp 90': ['FORMAT', 'An elevation angle lies within ±90 degrees.'],
  'app/ui/modules/figure-export/figure-export-ui.js:clamp 20000': ['UI', "A figure's size in pixels per side; a picture size, not data: every cell is drawn at any size."],
  'app/ui/modules/figure-export/figure-export-ui.js:clamp 22': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/figure-export-ui.js:clamp 30': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/figure-export-ui.js:clamp 36': ['UI', EXPORT_LAYOUT],
  "app/ui/modules/figure-export/figure-export-ui.js:max: '20000'": ['UI', "A figure's size in pixels per side; a picture size, not data: every cell is drawn at any size."],
  "app/ui/modules/figure-export/figure-export-ui.js:max: '24'": ['UI', EXPORT_LAYOUT],
  "app/ui/modules/figure-export/figure-export-ui.js:max: '36'": ['UI', EXPORT_LAYOUT],
  "app/ui/modules/figure-export/figure-export-ui.js:max: '48'": ['UI', EXPORT_LAYOUT],
  "app/ui/modules/figure-export/figure-export-ui.js:max: '5000000'": ['PERF', 'Points a reduced export keeps; the full-detail export draws every cell.'],
  'app/ui/modules/figure-export/renderers/png-renderer.js:Math.min 140': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/renderers/png-renderer.js:Math.min 240': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/renderers/png-renderer.js:clamp 22': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/renderers/svg-renderer.js:Math.min 140': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/renderers/svg-renderer.js:Math.min 240': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/renderers/svg-renderer.js:clamp 22': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/utils/color-utils.js:Math.min 255': ['FORMAT', COLOR_BYTE],
  'app/ui/modules/figure-export/utils/density-reducer.js:clamp 512': ['PERF', 'The grid of a density-reduced export; the full-detail export draws every cell.'],
  'app/ui/modules/figure-export/utils/layout.js:Math.min 64': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/utils/layout.js:Math.min 80': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/figure-export/utils/layout.js:clamp 12': ['UI', EXPORT_LAYOUT],
  'app/ui/modules/gene-read-control.js:Math.min 100': ['FORMAT', PERCENT],
  'app/ui/modules/gene-read-control.js:Math.min 99': ['UI', PROGRESS_99],
  'app/ui/modules/legend/range-bounds.js:Math.min 17': ['FORMAT', DIGITS],
  'app/ui/modules/navigation-settings.js:maximum: 100': ['UI', CONTROL_RANGE],
  'app/ui/modules/navigation-settings.js:maximum: 30': ['UI', CONTROL_RANGE],
  'app/ui/modules/navigation-settings.js:maximum: 500': ['UI', CONTROL_RANGE],
  'app/ui/modules/outlier-filter-control.js:Math.min 100': ['FORMAT', PERCENT],
  'app/ui/modules/render-controls.js:max="100"': ['MSG', "Quotes the point-size slider's expected attributes in an error message."],
  'app/ui/modules/session-sections.js:Math.min 99': ['UI', PROGRESS_99],
  'app/ui/modules/subsample-control.js:Math.min 0xffffffff': ['FORMAT', UINT32],
  'app/ui/modules/subsample-control.js:Math.min 100': ['FORMAT', PERCENT],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 0.1': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 0.5': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 0.995': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 1.5': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 100': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 1500': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 2': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 3': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 30': ['UI', CONTROL_RANGE],
  'app/ui/modules/velocity-overlay-controls.js:maximum: 500': ['UI', CONTROL_RANGE],
  'app/ui/modules/visualization-reset.js:maximum: 100': ['UI', CONTROL_RANGE],
  'app/ui/modules/visualization-reset.js:maximum: 30': ['UI', CONTROL_RANGE],
  'app/ui/modules/visualization-reset.js:maximum: 500': ['UI', CONTROL_RANGE],
  'app/utils/state-validator.js:Math.min 100': ['PERF', 'A spot check of the first 100 cell indices; nothing calls validateCellIndices (reported as dead code).'],
  'data/anndata/progressive-open.js:Math.min 3': ['FORMAT', 'The first view is drawn in at most three dimensions; this estimates what that view reads.'],
  'data/anndata/transcode/r-object.js:Math.min 16': ['FORMAT', "The bytes of an R file's signature, read to tell a compressed file from a plain one."],
  'data/categorical-storage-contract.js:maxCategories: 255': ['FORMAT', 'uint8 codes hold 255 categories beside the missing marker.'],
  'data/categorical-storage-contract.js:maxCategories: 4_294_967_295': ['FORMAT', 'uint32 codes hold 4,294,967,295 categories beside the missing marker.'],
  'data/categorical-storage-contract.js:maxCategories: 65_535': ['FORMAT', 'uint16 codes hold 65,535 categories beside the missing marker.'],
  'data/column-forms.js:Math.min 1024': ['PERF', 'The first capacity of a growing array; it grows to any size.'],
  'data/opening-progress.js:Math.min 100': ['FORMAT', PERCENT],
  'data/opening-progress.js:Math.min 99': ['UI', PROGRESS_99],
  'data/palettes.js:clamp 0.72': ['UI', "A generated color's lightness range: a visual setting, not data."],
  'data/palettes.js:clamp 0.82': ['UI', "A generated color's saturation range: a visual setting, not data."],
  'data/read-activity-log.js:Math.min 100': ['FORMAT', PERCENT],
  'dev/benchmark.js:Math.min 0.12': ['UI', 'A synthetic benchmark dataset parameter (a developer tool).'],
  'dev/benchmark.js:Math.min 0.35': ['UI', 'A synthetic benchmark dataset parameter (a developer tool).'],
  'dev/benchmark.js:Math.min 0.9': ['UI', 'A synthetic benchmark dataset parameter (a developer tool).'],
  'dev/benchmark.js:Math.min 100': ['FORMAT', PERCENT],
  'dev/benchmark.js:Math.min 45': ['UI', 'A synthetic benchmark dataset parameter (a developer tool).'],
  'dev/benchmark.js:Math.min 50': ['MSG', 'How many storage keys a benchmark report lists (a developer tool).'],
  'formats/hdf5/binary.js:Math.min 4': ['FORMAT', 'The low 32-bit word of an HDF5 integer field.'],
  'formats/hdf5/fractal-heap.js:Math.min 8': ['FORMAT', 'An HDF5 heap id offset is at most 8 bytes.'],
  'formats/hdf5/superblock.js:Math.min 256': ['FORMAT', 'The largest HDF5 superblock (version 0/1 with 8-byte sizes) is under 128 bytes; 256 reads any one whole.'],
  'formats/hdf5/writer.js:maxDirectBlockBytes: 65536': ['FORMAT', 'The fractal heap parameters libhdf5 itself writes for an attribute heap; any attribute is written.'],
  'formats/hdf5/writer.js:maxHeapBits: 40': ['FORMAT', 'The fractal heap parameters libhdf5 itself writes for an attribute heap; any attribute is written.'],
  'formats/hdf5/writer.js:maxManagedBytes: 4096': ['FORMAT', 'The fractal heap parameters libhdf5 itself writes for an attribute heap; any attribute is written.'],
  'formats/io/byte-source.js:maxRequestBytes: 32': ['PERF', 'Bytes of one ranged request (in MiB); a longer read is split.'],
  'formats/io/byte-source.js:maxRequestBytes: 8': ['PERF', 'Bytes of one ranged request (in MiB); a longer read is split.'],
  'formats/rds/index.js:Math.min 16': ['FORMAT', "The bytes of an R file's signature, read to tell its compression."],
  'formats/zarr/open.js:Math.min 16': ['PERF', 'Zarr chunks decoded at once, from the hardware concurrency; every chunk is decoded.'],
  'relay/authorize-page.js:Math.min 30000': ['UI', 'The longest wait in milliseconds before the authorization page asks the relay again; it keeps asking.'],
  'rendering/backdrops/backdrop-look-renderer.js:Math.min 0.1': ['UI', 'The longest step of the backdrop clock after a stall, in seconds.'],
  'rendering/backdrops/backdrop-look-renderer.js:Math.min 1023': ['UI', "The last bin of the backdrop's 1,024-bin brightness histogram."],
  'rendering/backdrops/backdrop-look-renderer.js:Math.min 64': ['UI', "The backdrop's largest point size, within the GPU's point size range."],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 0.32': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 0.42': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 0.95': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 1.4': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 1.5': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-look-shaders.js:clamp 2.0': ['UI', SHADER_LOOK],
  'rendering/backdrops/backdrop-looks.js:Math.min 31': ['FORMAT', 'The last index of a 32-step quantised color grid.'],
  'rendering/backdrops/backdrop-looks.js:maxSamples = 65536': ['PERF', "Colors sampled to find a backdrop's dominant colors; a sample of the cells, which stay drawn."],
  'rendering/high-perf/spatial-index.js:maxResults = 64': ['UI', 'Points one radius query returns; only the projectiles easter egg asks, and every cell stays drawn and pickable.'],
  'rendering/highlight-renderer.js:Math.min 0.5': ['UI', 'A highlight ring width: a visual setting, not data.'],
  'rendering/highlight-renderer.js:Math.min 1.5': ['UI', 'A highlight halo strength: a visual setting, not data.'],
  'rendering/overlays/velocity/velocity-overlay.js:Math.min 0.05': ['UI', 'The longest step of the velocity animation after a stall, in seconds.'],
  'rendering/overlays/velocity/velocity-overlay.js:Math.min 255': ['FORMAT', COLOR_BYTE],
  'rendering/overlays/velocity/velocity-overlay.js:maxSize: 30.0': ['UI', CONTROL_RANGE],
  'rendering/overlays/velocity/velocity-shaders.js:clamp 0.05': ['UI', 'The longest step of the velocity animation after a stall, in seconds.'],
  'rendering/projectiles.js:maxResults = 64': ['UI', 'An easter-egg animation parameter.'],
  'rendering/read-cell-layer.js:Math.min 100': ['FORMAT', 'A lightness in percent.'],
  'rendering/shaders/edge-grid-shaders.js:clamp 1.41421356': ['FORMAT', 'The square root of 2, the corner distance of a unit square.'],
  'rendering/shaders/high-perf-shaders.js:clamp 256.0': ['UI', 'A highlight point size in pixels: a visual setting, not data.'],
  'rendering/shaders/smoke-shaders.js:clamp 0.85': ['UI', SHADER_LOOK],
  'rendering/shaders/smoke-shaders.js:clamp 3.0': ['UI', SHADER_LOOK],
  'rendering/smoke-cloud/smoke-renderer.js:Math.min 0.1': ['UI', 'The longest step of the smoke animation after a stall, in seconds.'],
  'rendering/studio-backdrop.js:maxFamilySpacing: 2.5': ['UI', 'A studio backdrop grid spacing: a visual setting, not data.'],
  'rendering/viewer.js:Math.min 100': ['UI', 'The largest zoom step one wheel event takes; more wheel events zoom further.'],
  'rendering/viewer.js:Math.min 100.0': ['UI', 'The farthest orbit radius of the camera.'],
  'utils/format-units.js:Math.min 17': ['FORMAT', DIGITS],
  'utils/style-manager.js:max: 9999': ['UI', 'The topmost stacking layer (z-index).'],
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

/** The web app (keys relative to assets/js) and the agent relay Worker (keys under relay/). */
const SCANNED = [
  { base: path.join(ROOT, 'assets', 'js'), prefix: '' },
  { base: path.join(ROOT, 'relay'), prefix: 'relay/' },
];

function scanLimits() {
  const found = new Set();
  for (const { base, prefix } of SCANNED) scanLimitsUnder(base, prefix, found);
  return found;
}

function scanLimitsUnder(base, prefix, found) {
  for (const file of sourceFiles(base)) {
    const relative = prefix + path.relative(base, file).split(path.sep).join('/');
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
}

const NUMBER = String.raw`(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)`;
const NUMERIC_LITERAL = new RegExp(`^-?${NUMBER}$`);
const QUOTED_NUMBER = String.raw`(?:${NUMBER}|'\d+'|"\d+")`;
const CAP_NAME = String.raw`(?:max|maximum|maxlength|limit|cap|(?:max|maximum)[A-Z]\w*|\w+(?:Limit|Cap|Max|Maximum))`;
const CALL = /\b(Math\.min|clamp\w*)\(/g;
const CAP_PROPERTY = new RegExp(String.raw`(?<![\w$.'"])(${CAP_NAME})\s*:\s*(${QUOTED_NUMBER})(?![\w.])`, 'g');
const CAP_DEFAULT = new RegExp(String.raw`(?<![\w$.'"])(${CAP_NAME})\s*=\s*(${NUMBER})(?=\s*[,)}])`, 'g');
const CAP_ATTRIBUTE = new RegExp(
  String.raw`\b(max|maxlength)\s*=\s*["'](\d+)["']` +
  String.raw`|\.(max|maxLength)\s*=\s*(${QUOTED_NUMBER})` +
  String.raw`|setAttribute\(\s*['"](max|maxlength)['"]\s*,\s*(${QUOTED_NUMBER})`,
  'g'
);

/** The value a literal states: `'50'`, `65_536` and `0xffff_ffff` included. */
function literalValue(literal) {
  return Number(literal.replace(/['"_]/g, ''));
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArguments(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, index).trim());
        return args;
      }
    } else if (character === ',' && depth === 1) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return args;
}

/** Every inline cap of one source text, as allowlist keys. */
function inlineCaps(relative, source) {
  // Whole-line comments document code; they bound nothing.
  const text = source
    .split('\n')
    .map(line => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n');
  const found = new Set();
  const add = (key, literal) => {
    const value = literalValue(literal);
    if (value !== 0 && value !== 1) found.add(`${relative}:${key}`);
  };
  for (const match of text.matchAll(CALL)) {
    const args = callArguments(text, match.index + match[0].length - 1);
    if (match[1] === 'Math.min') {
      for (const arg of args) {
        if (NUMERIC_LITERAL.test(arg)) add(`Math.min ${arg}`, arg);
      }
    } else if (args.length >= 3 && NUMERIC_LITERAL.test(args.at(-1))) {
      add(`clamp ${args.at(-1)}`, args.at(-1));
    }
  }
  for (const match of text.matchAll(CAP_PROPERTY)) add(`${match[1]}: ${match[2]}`, match[2]);
  for (const match of text.matchAll(CAP_DEFAULT)) add(`${match[1]} = ${match[2]}`, match[2]);
  for (const match of text.matchAll(CAP_ATTRIBUTE)) {
    if (match[1]) add(`${match[1]}="${match[2]}"`, match[2]);
    else if (match[3]) add(`.${match[3]} = ${match[4]}`, match[4]);
    else add(`setAttribute ${match[5]} ${match[6]}`, match[6]);
  }
  return found;
}

function scanInlineCaps() {
  const found = new Set();
  for (const { base, prefix } of SCANNED) {
    for (const file of sourceFiles(base)) {
      const relative = prefix + path.relative(base, file).split(path.sep).join('/');
      for (const key of inlineCaps(relative, readFileSync(file, 'utf8'))) found.add(key);
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

test('every inline cap in the web app is classified with a reason', () => {
  const found = scanInlineCaps();
  const unclassified = [...found].filter(key => !Object.hasOwn(INLINE_ALLOWLIST, key)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'Classify these in INLINE_ALLOWLIST (tests/size-limit-allowlist-contract.test.mjs), or remove the cap.',
  );
  const stale = Object.keys(INLINE_ALLOWLIST).filter(key => !found.has(key)).sort();
  assert.deepEqual(stale, [], 'Remove these entries: the caps are gone.');
});

test('the inline scan finds caps written in every scanned form', () => {
  // The forms that once slipped past the named-constant scan (B8: a clamp to
  // 50 and an input max of '50' rewrote a published minAnnotators of 100).
  const source = [
    'value = clampInt(Number(minInput.value), 0, 50);',
    "const input = el('input', { type: 'number', min: '0', max: '50' });",
    'const n = Math.min(count, 64);',
    'const m = Math.max(1, Math.min(4, Number(n) || 1));',
    'const k = Math.min(Math.round(Number(x)), 1_000);',
    'function f(value, { maxLength = 120 } = {}) {}',
    `const tag = '<input type="range" max="1000">';`,
    "node.setAttribute('maxlength', '500');",
    'node.maxLength = 64;',
    'const settings = { pageLimit: 30, minimum: 5 };',
    '// Math.min(count, 99) in a comment bounds nothing.',
    ' * clampInt(x, 0, 77) in a JSDoc line bounds nothing.',
    'const fraction = Math.min(1, ratio); const sign = clamp(x, -1, 1);',
  ].join('\n');
  assert.deepEqual([...inlineCaps('example.js', source)].sort(), [
    'example.js:.maxLength = 64',
    'example.js:Math.min 1_000',
    'example.js:Math.min 4',
    'example.js:Math.min 64',
    'example.js:clamp 50',
    'example.js:max: \'50\'',
    'example.js:max="1000"',
    'example.js:maxLength = 120',
    'example.js:pageLimit: 30',
    'example.js:setAttribute maxlength \'500\'',
  ]);
});

test('every allowlist entry names a real class and its reason', () => {
  for (const [key, [kind, reason]] of [...Object.entries(ALLOWLIST), ...Object.entries(INLINE_ALLOWLIST)]) {
    assert.ok(CLASSES.has(kind), `${key}: ${kind} is not a limit class`);
    assert.ok(reason.trim().length > 0, `${key}: say why the limit exists`);
    if (kind === 'OWNED') {
      assert.match(reason, /limits-inventory/, `${key}: an OWNED limit names its inventory entry`);
    }
  }
});
