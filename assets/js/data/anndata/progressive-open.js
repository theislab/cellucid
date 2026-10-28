/**
 * Progressive opening: a dataset whose first view would take long to read
 * opens a smaller first view, a sample of the cells asked for, and grows in
 * place to them (`app/open-cells-resize.js`, `grow`).
 *
 * Only openings whose cells come in nested samples can grow without reading
 * anything twice: a `uniform` or `blocks` subsample (its first `m` open
 * cells are the subsample of `m` cells with the same seed,
 * `subsample.js`, `priorityOrder`) and a priority-ordered file opened whole
 * (its first `m` rows are its `uniform` subsample of `m` under its seed,
 * `priority-layout.js`). Any other opening (a stratified or spatial
 * subsample, every cell of a file in its own order, a session's recorded
 * cells) opens at once.
 *
 * The first view's size comes from what reading it is measured to cost, not
 * from a fixed count, by one rule for every source -- a local file as a web
 * host: the link this store is read over (its measured latency and bytes
 * per millisecond, `formats/io/link.js`; a picked file's are its reads'),
 * the stored bytes of what the first view reads (the chunks of the
 * embedding it draws that its cells lie in, `firstViewCost`) and their
 * decoding (the decoded bytes they hold, at the rate chunks are measured to
 * decode here, `decodePoolStats`), plus what showing a cell was measured
 * to cost this page (`request.progressive`, `msPerCell`: its earlier
 * openings, from their cells in the page to their first frame,
 * `data/opening-cost.js`). Before any chunk has been decoded here, the chunk of the
 * first open cell is read to measure it, when a read costs no round trip
 * worth pricing (the link reads ahead): a read the first view makes anyway;
 * over a slower link, decoding is priced once a chunk has been decoded. It is planned after the store's
 * structure is read (`openDatasetStore` walks it before the reader opens);
 * opening reads no gene name (the var index is read when the names are
 * first asked for, after the first view), so the plan prices what the first
 * view still reads: its embedding's chunks. The first view is the most cells
 * predicted to arrive within the response-time target the page asks for
 * (`targetMs`; about a second keeps a person's flow of thought, Card,
 * Robertson and Mackinlay 1991; Nielsen 1993), never fewer than the square
 * root of the cells asked for; when every cell is predicted within it, or
 * the first view would not arrive at least twice as soon (its cells lie in
 * most of the chunks every cell does), the opening is not progressive. Each step after it doubles the cells open
 * (the segments a cell-major matrix is indexed in double too,
 * `prefix-column-index.js`), the last being the cells asked for.
 *
 * **Growing from few chunks.** A file Cellucid did not write may store the
 * first view's embedding in chunks much coarser than a subsample's blocks
 * (the lung atlas: blocks of about 19 cells, chunks of 8,916 rows): the
 * first cells of priority order lie in every chunk, so even a small first
 * view reads the whole embedding. Its subsample stays exactly as asked
 * for; only the order it arrives in changes: the chunks its cells lie in,
 * in a seeded random order (`chunkMajorOrder`, so even the first view is
 * spread over the file), each chunk's cells in priority order. Each step
 * opens the kept cells of the chunks read so far (a `chunks` request,
 * `subsample-plan.js`), every chunk read once; after the last, the same
 * cells are put in priority order in place (`reordered`,
 * `app/open-cells-resize.js`), so what is open is what opening the
 * subsample directly opens. It is taken only over a measured link and when
 * its first view arrives at least twice as soon as the priority order's
 * (or, when that is not progressive, as every cell). A step's cells are
 * not a sample of the subsample (they lie in some of the file's chunks):
 * the opening says it is growing until the last.
 *
 * @module data/anndata/progressive-open
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { child } from './elements.js';
import { fmix32 } from '../cell-identity.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { decodePoolStats } from '../../formats/io/decode-pool.js';

/** The `obsm` array a first view draws when the file names none: an embedding of 2 or 3 columns, UMAP first. */
function firstViewEmbedding(root, nObs) {
  const obsm = child(root, 'obsm');
  if (!isGroup(obsm)) return null;
  const keys = obsm.keys();
  for (const key of [...['X_umap', 'X_tsne', 'X_pca'].filter(name => keys.includes(name)), ...keys]) {
    const node = obsm.get(key);
    if (isArrayNode(node) && node.shape[0] === nObs && node.shape.length === 2 && node.shape[1] >= 2) return node;
  }
  return null;
}

/**
 * What reading the first `k` open cells of the first view costs in stored
 * bytes: the bytes of the embedding's row chunks those cells lie in
 * (`fileRows`: the file row of each open cell in open order, null for open
 * cell `i` at file row `i`), a chunk counted once. A file's chunk is the
 * least it can deliver, so cells spread over many chunks (a `blocks`
 * subsample of a file chunked coarser than its blocks) cost the chunks, not
 * their own bytes. Each chunk is priced at the embedding's stored bytes
 * over its chunks (its values' size when the store cannot say).
 *
 * @param {Object} root - The store's root (every cell)
 * @param {number} nObs
 * @param {Uint32Array|null} fileRows
 * @param {number} target - Open cells asked for
 * @param {Object} readOptions
 * @param {{measureDecode?: boolean}} [options] - `measureDecode`: read the
 *   first open cell's chunk when no chunk has been decoded here yet, so
 *   decoding is priced at a measured rate (module doc)
 * @returns {Promise<{bytesFor: (k: number) => number, chunkRows: number, bytesPerChunk: number, expansion: number}|null>}
 *   `bytesFor(k)`: the first k open cells' cost; `chunkRows`, `bytesPerChunk`:
 *   the embedding's chunk geometry; `expansion`: decoded bytes per stored
 *   byte. Null when the file has no embedding to draw
 */
export async function firstViewCost(root, nObs, fileRows, target, readOptions = {}, { measureDecode = false } = {}) {
  const embedding = firstViewEmbedding(root, nObs);
  if (embedding === null || nObs === 0) return null;
  const columns = Math.min(3, embedding.shape[1]);
  const chunkRows = Array.isArray(embedding.chunks) && embedding.chunks[0] > 0 ? Math.min(nObs, embedding.chunks[0]) : nObs;
  const chunkCount = Math.ceil(nObs / chunkRows);
  const valueBytes = (embedding.dtype?.bytes ?? 8) * columns * nObs;
  let storedBytes = valueBytes;
  if (typeof embedding.storedBytes === 'function') {
    try {
      const stored = await embedding.storedBytes([[0, nObs], [0, columns]], readOptions);
      if (Number.isFinite(stored) && stored > 0) storedBytes = stored;
    } catch {
      // The store cannot say: its values' size.
    }
  }
  if (measureDecode && decodePoolStats().decodedBytesPerMs === null) {
    // How fast chunks decode here, measured on the chunk the first open
    // cell lies in (the first view reads it whatever its size): read now.
    const first = Math.floor((fileRows === null ? 0 : fileRows[0]) / chunkRows) * chunkRows;
    await embedding.read([[first, Math.min(nObs, first + chunkRows)], [0, columns]], readOptions);
  }
  const bytesPerChunk = storedBytes / chunkCount;
  // Decoded bytes per stored byte: what decoding the chunks read costs.
  const geometry = { chunkRows, bytesPerChunk, expansion: valueBytes / storedBytes };
  if (fileRows === null) return { ...geometry, bytesFor: k => Math.ceil(Math.min(k, nObs) / chunkRows) * bytesPerChunk };
  // The first open cell of each chunk (a value a chunk, not a cell): the
  // first k open cells lie in the chunks whose first open cell is below k.
  const NONE = 0xffffffff;
  const firstOpen = allocateTypedArray(Uint32Array, chunkCount, 'Chunk first open cells').fill(NONE);
  for (let i = 0; i < target; i++) {
    const chunk = Math.floor(fileRows[i] / chunkRows);
    if (firstOpen[chunk] === NONE) firstOpen[chunk] = i;
  }
  firstOpen.sort();
  let touched = chunkCount;
  while (touched > 0 && firstOpen[touched - 1] === NONE) touched--;
  return {
    ...geometry,
    bytesFor: k => {
      let low = 0;
      let high = touched;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (firstOpen[mid] < k) low = mid + 1;
        else high = mid;
      }
      return low * bytesPerChunk;
    },
  };
}

/**
 * A subsample's cells in chunk order (module doc, "Growing from few
 * chunks"): the chunks of `chunkRows` file rows its cells lie in, ranked by
 * a hash of `seed` and the chunk (ties by chunk), each chunk's cells in
 * `openOrder` (priority order). For a file in its own order (a file
 * Cellucid did not write: file row = original position).
 *
 * @param {Uint32Array} openOrder - The subsample's cells (original positions) in priority order
 * @param {number} chunkRows
 * @param {number} seed
 * @returns {{order: Uint32Array, ends: Uint32Array}} `order`: the cells in
 *   chunk order; `ends[c]`: how many of them lie in the first c + 1 chunks
 */
export function chunkMajorOrder(openOrder, chunkRows, seed) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1) throw new RangeError(`Chunks hold a positive count of rows, not ${chunkRows}.`);
  const counts = new Map();
  for (let i = 0; i < openOrder.length; i++) {
    const chunk = Math.floor(openOrder[i] / chunkRows);
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
  }
  const mix = fmix32((seed >>> 0) ^ 0x9e3779b9);
  const chunks = [...counts.keys()].map(chunk => ({ chunk, rank: fmix32((mix ^ chunk) >>> 0) }))
    .sort((a, b) => a.rank - b.rank || a.chunk - b.chunk);
  const start = new Map();
  const ends = allocateTypedArray(Uint32Array, chunks.length, 'Chunk ends');
  let at = 0;
  chunks.forEach(({ chunk }, index) => {
    start.set(chunk, at);
    at += counts.get(chunk);
    ends[index] = at;
  });
  const order = allocateTypedArray(Uint32Array, openOrder.length, 'Chunk-major cell order');
  for (let i = 0; i < openOrder.length; i++) {
    const chunk = Math.floor(openOrder[i] / chunkRows);
    const slot = start.get(chunk);
    order[slot] = openOrder[i];
    start.set(chunk, slot + 1);
  }
  return { order, ends };
}

/** The smallest chunk end at or above `k` (`ends` ascending), else the last. */
function chunkEndAtLeast(ends, k) {
  let low = 0;
  let high = ends.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ends[mid] >= k) high = mid;
    else low = mid + 1;
  }
  return ends[low];
}

/**
 * The first view's size and the steps after it, or null when the opening is
 * not progressive (module doc): the most cells predicted to arrive within
 * `targetMs` (time = the link's latency + their stored bytes over its
 * measured rate, `bytesFor(k)`, + the page's cost of showing them), never
 * fewer than the square root of the cells asked for; null when every cell
 * is predicted within it, when nothing is measured, or when the first view
 * would not arrive at least twice as soon as every cell (its chunks are
 * most of theirs).
 *
 * @param {{target: number, bytesFor: ((k: number) => number)|null, link: {latencyMs: number|null, bytesPerMs: number|null}|null,
 *   decoding?: {bytesPerMs: number, expansion: number}|null, msPerCell: number|null, targetMs: number}} cost
 *   `decoding`: decoded bytes a millisecond here (every decoder together),
 *   and decoded bytes per stored byte of what is read (null: unpriced)
 * @returns {{first: number, steps: number[], firstMs: number, wholeMs: number}|null}
 */
export function progressivePlan({ target, bytesFor, link, decoding = null, msPerCell, targetMs }) {
  if (!Number.isSafeInteger(target) || target < 2 || !(targetMs > 0)) return null;
  // What cells cost: their chunks over the measured link (whatever the
  // source: a picked file's link is its reads') and their decoding, and
  // showing them.
  const read = priced(link) && bytesFor !== null;
  const showMs = msPerCell > 0 ? msPerCell : 0;
  if (!read && !(showMs > 0)) return null;
  const timeOf = readTime(read ? link : null, decoding, bytesFor, showMs);
  const whole = timeOf(target);
  if (whole <= targetMs) return null;
  // The most cells read within `ms` (the time grows with k).
  const cellsWithin = ms => {
    let low = 0;
    let high = target;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (timeOf(mid) <= ms) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const first = Math.min(target - 1, Math.max(Math.ceil(Math.sqrt(target)), cellsWithin(targetMs)));
  if (timeOf(first) * 2 > whole) return null;
  // Each step at least doubles the cells and the time spent: cells that
  // cost little more than those open (their chunks are read already) come
  // in the same step.
  const steps = [];
  for (let k = first; k < target;) {
    k = Math.min(target, Math.max(2 * k, cellsWithin(2 * timeOf(k))));
    steps.push(k);
  }
  return { first, steps, firstMs: timeOf(first), wholeMs: whole };
}

/** Whether `link` is measured (a round trip and a rate): its reads are priced, whatever the source. */
function priced(link) {
  return link !== null && link.bytesPerMs > 0 && Number.isFinite(link.latencyMs) && link.latencyMs >= 0;
}

/**
 * The time to the first frame of `k` cells: one round trip of `link` (none
 * when null), their stored bytes over its rate and their decoded bytes over
 * `decoding`'s, and showing them.
 */
function readTime(link, decoding, bytesFor, showMs) {
  const fixedMs = link === null ? 0 : link.latencyMs;
  const msPerByte = link === null ? 0
    : 1 / link.bytesPerMs + (decoding !== null && decoding.bytesPerMs > 0 ? decoding.expansion / decoding.bytesPerMs : 0);
  return k => fixedMs + (link === null ? 0 : bytesFor(k) * msPerByte) + k * showMs;
}

/**
 * Decoded bytes a millisecond here, every decoder together: the rate one
 * chunk is measured to decode at (`decodePoolStats`), times the chunks
 * decoded at once; null before any chunk is decoded.
 */
export function decodingRate() {
  const { decodedBytesPerMs, size } = decodePoolStats();
  return decodedBytesPerMs > 0 ? decodedBytesPerMs * Math.max(1, size) : null;
}

/**
 * Plan a progressive opening of a resolved cell subset
 * (`resolveCellSubset`), or null: the request that opens the first view,
 * and `growth` -- the cells asked for (`target`), the counts of the steps
 * (`steps`, ascending, the last `target`), the request of each step but the
 * last (`step`, with its `k` to set) and the last one's (`final`, the cells
 * asked for exactly, as resolved: a fitted subsample stays fitted).
 *
 * `costOf(target)` (`firstViewCost`) is asked only for an opening that can
 * grow (module doc) over a measured link: any other is decided without
 * reading anything.
 *
 * @param {Object} resolution - `resolveCellSubset`'s, of the cells asked for
 * @param {{nObs: number, costOf: (target: number) => Promise<{bytesFor: (k: number) => number, chunkRows: number, bytesPerChunk: number, expansion?: number}|null>, link: Object|null,
 *   decodeBytesPerMs?: number|null, msPerCell: number|null, targetMs: number}} cost
 *   `decodeBytesPerMs`: how fast chunks decode here (every decoder
 *   together); null: as measured in this realm (`decodingRate`)
 * @returns {Promise<{first: Object, growth: {target: number, steps: number[], step: Object, final: Object, chunked: boolean}}|null>}
 *   `chunked`: grown from few chunks (`step` a `chunks` request, the
 *   cells of each step its `cells`), then put in priority order (`final`)
 */
export async function planProgressiveOpening(resolution, { nObs, costOf, link, decodeBytesPerMs = null, msPerCell, targetMs }) {
  const { kept, spec } = resolution;
  let step;
  let final;
  if (kept === null) {
    // A priority-ordered file opened whole grows through its prefixes.
    if (resolution.prioritySeed === null || resolution.prioritySeed === undefined) return null;
    step = { mode: 'subsample', method: 'uniform', seed: resolution.prioritySeed, strict: true };
    final = { mode: 'all' };
  } else {
    if (spec?.method !== 'uniform' && spec?.method !== 'blocks') return null;
    step = { mode: 'subsample', method: spec.method, seed: spec.seed, strict: true, ...(spec.method === 'blocks' ? { blockSize: spec.blockSize } : {}) };
    final = { mode: 'kept', spec, kept, autoFit: resolution.autoFit ?? null, reproduced: null };
  }
  const target = kept === null ? nObs : kept.length;
  if (!priced(link) && !(msPerCell > 0)) return null;
  const cost = priced(link) ? await costOf(target) : null;
  // Measured after `costOf`, which may have decoded the first chunk to measure it.
  const rate = decodeBytesPerMs ?? decodingRate();
  const decoding = cost === null || rate === null ? null : { bytesPerMs: rate, expansion: cost.expansion ?? 1 };
  const plan = progressivePlan({ target, bytesFor: cost?.bytesFor ?? null, link, decoding, msPerCell, targetMs });
  const chunked = kept === null || cost === null || resolution.prioritySeed != null || resolution.openOrder == null
    ? null
    : chunkedPlan(resolution, cost, { link, decoding, msPerCell, targetMs, against: plan === null ? null : plan.firstMs });
  if (chunked !== null) return chunked;
  if (plan === null) return null;
  return {
    first: { ...step, k: plan.first },
    growth: Object.freeze({ target, steps: Object.freeze(plan.steps), step: Object.freeze(step), final: Object.freeze(final), chunked: false }),
  };
}

/**
 * The plan of a subsample grown from few chunks (module doc), or null when
 * it does not bring the first view forward at least twice as soon as
 * `against` (the priority order's first view; null: it is not
 * progressive, and every cell is what it is weighed against). Steps end
 * at chunk boundaries, so each chunk is read by one step.
 */
function chunkedPlan(resolution, cost, { link, decoding, msPerCell, targetMs, against }) {
  const { spec, kept } = resolution;
  const chunks = { rows: cost.chunkRows, seed: spec.seed };
  const { ends } = chunkMajorOrder(resolution.openOrder, chunks.rows, chunks.seed);
  if (ends.length < 2) return null;
  const target = kept.length;
  const bytesFor = k => {
    if (k <= 0) return 0;
    let low = 0;
    let high = ends.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ends[mid] >= k) high = mid;
      else low = mid + 1;
    }
    return (low + 1) * cost.bytesPerChunk;
  };
  const plan = progressivePlan({ target, bytesFor, link, decoding, msPerCell, targetMs });
  if (plan === null) return null;
  const timeOf = readTime(link, decoding, bytesFor, msPerCell > 0 ? msPerCell : 0);
  const first = chunkEndAtLeast(ends, plan.first);
  if (first >= target) return null;
  if (timeOf(first) * 2 > (against ?? plan.wholeMs)) return null;
  const steps = [...new Set(plan.steps.map(k => chunkEndAtLeast(ends, k)))].filter(k => k > first).sort((a, b) => a - b);
  if (steps.at(-1) !== target) steps.push(target);
  const step = { mode: 'chunks', spec, autoFit: resolution.autoFit ?? null, chunks: Object.freeze(chunks) };
  const final = { mode: 'kept', spec, kept, autoFit: resolution.autoFit ?? null, reproduced: null };
  return {
    first: { ...step, chunks: { ...chunks, cells: first } },
    growth: Object.freeze({ target, steps: Object.freeze(steps), step: Object.freeze(step), final: Object.freeze(final), chunked: true }),
  };
}
