/**
 * Progressive opening: a dataset whose first view would take long to read
 * opens a smaller first view, a sample of the cells asked for, and grows in
 * place to them (`app/open-cells-resize.js`, `grow`).
 *
 * An opening grows without reading anything twice when each step's cells
 * are the first cells of the next: a `uniform` or `blocks` subsample in its
 * priority order (its first `m` open cells are the subsample of `m` cells
 * with the same seed, `subsample.js`, `priorityOrder`), a priority-ordered
 * file opened whole (its first `m` rows are its `uniform` subsample of `m`
 * under its seed, `priority-layout.js`), every cell of a file in its own
 * order opened in its default subsample's priority order
 * (`subsample-plan.js`, `cellOrder`: its first `m` cells are that `blocks`
 * subsample of `m`), and a share whose order is not nested by size -- one
 * spread through a file in its own order, opened in that same cell order,
 * or a share of a priority-ordered file, opened in file order -- through
 * the first cells of its order (a `prefix` request, `prefixStep`: the
 * share's cells in the blocks, or rows, read so far; whatever its method).
 * Any other opening (a stratified or spatial subsample in its own order,
 * every cell of a file in its own order otherwise, a session's recorded
 * cells) opens at once. Every step reads genes for the same first cells as
 * the cells asked for (`genes`).
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
import { loadedRoundTripMs } from '../../formats/io/link.js';
import { measureOf } from '../../utils/machine.js';
import { geneSampleRequestOf } from '../cell-subset-policy.js';

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
 * their own bytes. Each chunk is priced at its stored bytes still to fetch
 * (its values' size when the store cannot say): what this browser keeps of
 * the file from an earlier reading (`formats/store.js` `storedBytes`
 * `toFetch`) costs no transfer. What is kept is the chunks an earlier visit
 * read -- its first view's and its growth's, the first open cells' -- never
 * spread evenly, so each chunk is priced at its own bytes to fetch when
 * anything is kept, not at the mean: the mean prices every chunk of a
 * partly kept file near its full bytes, and the revisit opens fewer cells
 * than the first visit kept (measured: 23_decisions_partial_reading.md).
 *
 * @param {Object} root - The store's root (every cell)
 * @param {number} nObs
 * @param {Uint32Array|null} fileRows
 * @param {number} target - Open cells asked for
 * @param {Object} readOptions
 * @param {{measureDecode?: boolean}} [options] - `measureDecode`: read the
 *   first open cell's chunk when no chunk has been decoded here yet, so
 *   decoding is priced at a measured rate (module doc)
 * @returns {Promise<{bytesFor: (k: number) => number, storedFor: (k: number) => number, chunkRows: number, bytesPerChunk: number, expansion: number,
 *   fetchOfChunk: (chunk: number) => number, storedPerChunk: number}|null>}
 *   `bytesFor(k)`: the first k open cells' bytes to fetch; `storedFor(k)`:
 *   their chunks' stored bytes (what decoding them costs, a kept chunk too); `chunkRows`, `bytesPerChunk`:
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
  // What the embedding's chunks cost to fetch now: none of what this browser
  // keeps from an earlier reading (`io/kept-parts.js`), so a later visit
  // of a file read before opens at once, not in steps.
  let fetchBytes = storedBytes;
  if (typeof embedding.storedBytes === 'function') {
    try {
      const toFetch = await embedding.storedBytes([[0, nObs], [0, columns]], { ...readOptions, toFetch: true });
      if (Number.isFinite(toFetch) && toFetch >= 0) fetchBytes = Math.min(storedBytes, toFetch);
    } catch {
      // The store cannot say: every stored byte.
    }
  }
  if (measureDecode && decodingRate() === null) {
    // How fast chunks decode here, measured on the chunk the first open
    // cell lies in (the first view reads it whatever its size): read now.
    const first = Math.floor((fileRows === null ? 0 : fileRows[0]) / chunkRows) * chunkRows;
    await embedding.read([[first, Math.min(nObs, first + chunkRows)], [0, columns]], readOptions);
  }
  const bytesPerChunk = fetchBytes / chunkCount;
  const storedPerChunk = storedBytes / chunkCount;
  // Each chunk's bytes to fetch, when anything is kept (module doc of
  // `firstViewCost`): null when nothing is (every chunk the mean, exactly).
  let chunkFetch = null;
  if (fetchBytes < storedBytes && typeof embedding.storedBytes === 'function') {
    chunkFetch = allocateTypedArray(Float64Array, chunkCount, 'Chunk bytes to fetch');
    for (let c = 0; c < chunkCount; c++) {
      try {
        const bytes = await embedding.storedBytes([[c * chunkRows, Math.min(nObs, (c + 1) * chunkRows)], [0, columns]], { ...readOptions, toFetch: true });
        chunkFetch[c] = Number.isFinite(bytes) && bytes >= 0 ? Math.min(bytes, storedPerChunk * 2) : storedPerChunk;
      } catch {
        chunkFetch[c] = storedPerChunk;
      }
    }
  }
  // Decoded bytes per stored byte: what decoding the chunks read costs.
  const geometry = { chunkRows, bytesPerChunk, expansion: valueBytes / storedBytes };
  // The chunks in the order the open cells first reach them: chunk `order[j]`
  // holds open cell `firstOpen[j]` first; `fetchUpTo[j]`: the bytes to fetch
  // of the first j of them.
  let order;
  let firstOpen;
  let touched;
  if (fileRows === null) {
    touched = chunkCount;
    order = null;
    firstOpen = null;
  } else {
    const NONE = 0xffffffff;
    const first = allocateTypedArray(Uint32Array, chunkCount, 'Chunk first open cells').fill(NONE);
    for (let i = 0; i < target; i++) {
      const chunk = Math.floor(fileRows[i] / chunkRows);
      if (first[chunk] === NONE) first[chunk] = i;
    }
    touched = 0;
    for (let c = 0; c < chunkCount; c++) if (first[c] !== NONE) touched++;
    order = allocateTypedArray(Uint32Array, touched, 'Chunks in open order');
    for (let c = 0, at = 0; c < chunkCount; c++) if (first[c] !== NONE) order[at++] = c;
    order.sort((a, b) => first[a] - first[b]);
    firstOpen = allocateTypedArray(Uint32Array, touched, 'Chunk first open cells');
    for (let j = 0; j < touched; j++) firstOpen[j] = first[order[j]];
  }
  let fetchUpTo = null;
  if (chunkFetch !== null) {
    fetchUpTo = allocateTypedArray(Float64Array, touched + 1, 'Chunk bytes to fetch');
    for (let j = 0; j < touched; j++) fetchUpTo[j + 1] = fetchUpTo[j] + chunkFetch[order === null ? j : order[j]];
  }
  // How many chunks the first k open cells lie in.
  const chunksFor = k => {
    if (order === null) return Math.min(chunkCount, Math.ceil(Math.min(k, nObs) / chunkRows));
    let low = 0;
    let high = touched;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (firstOpen[mid] < k) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return {
    ...geometry,
    bytesFor: k => (fetchUpTo === null ? chunksFor(k) * bytesPerChunk : fetchUpTo[chunksFor(k)]),
    storedFor: k => chunksFor(k) * storedPerChunk,
    // One chunk's bytes to fetch and stored bytes (a chunk order of its own: `chunkedPlan`).
    fetchOfChunk: chunk => (chunkFetch === null ? bytesPerChunk : chunkFetch[chunk]),
    storedPerChunk,
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
 * @returns {{order: Uint32Array, ends: Uint32Array, chunks: Uint32Array}} `order`: the cells in
 *   chunk order; `ends[c]`: how many of them lie in the first c + 1 chunks;
 *   `chunks[c]`: the chunk ranked c
 */
export function chunkMajorOrder(openOrder, chunkRows, seed) {
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1) throw new RangeError(`Chunks hold a positive count of rows, not ${chunkRows}.`);
  // Every step of a growth from few chunks asks again for the same
  // subsample's order, the same array (`subsample.js`
  // `SubsampleCache.priorityOrder`): computed once.
  let known = CHUNK_ORDERS.get(openOrder);
  if (known === undefined) CHUNK_ORDERS.set(openOrder, (known = new Map()));
  const name = `${chunkRows}:${seed}`;
  if (!known.has(name)) known.set(name, Object.freeze(chunkOrderOf(openOrder, chunkRows, seed)));
  return known.get(name);
}

/** Each open order's chunk orders (`chunkMajorOrder`), by chunk rows and seed, for as long as the order is held. */
const CHUNK_ORDERS = new WeakMap();

function chunkOrderOf(openOrder, chunkRows, seed) {
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
  const ids = allocateTypedArray(Uint32Array, chunks.length, 'Chunks in chunk order');
  chunks.forEach(({ chunk }, index) => { ids[index] = chunk; });
  return { order, ends, chunks: ids };
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
export function progressivePlan({ target, bytesFor, storedFor = bytesFor, link, decoding = null, msPerCell, targetMs }) {
  if (!Number.isSafeInteger(target) || target < 2 || !(targetMs > 0)) return null;
  // What cells cost: their chunks over the measured link (whatever the
  // source: a picked file's link is its reads') and their decoding, and
  // showing them.
  const read = priced(link) && bytesFor !== null;
  const showMs = msPerCell > 0 ? msPerCell : 0;
  if (!read && !(showMs > 0)) return null;
  const timeOf = readTime(read ? link : null, decoding, bytesFor, showMs, storedFor);
  // The first open cells whose chunks this browser keeps whole (nothing to
  // fetch): a later visit never opens fewer than an earlier one kept.
  let kept = 0;
  if (bytesFor !== null && bytesFor(1) === 0) {
    let high = target;
    while (kept < high) {
      const mid = Math.ceil((kept + high) / 2);
      if (bytesFor(mid) === 0) kept = mid;
      else high = mid - 1;
    }
  }
  if (kept >= target) return null;
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
  const first = Math.min(target - 1, Math.max(Math.ceil(Math.sqrt(target)), kept, cellsWithin(targetMs)));
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
 * The time to the first frame of `k` cells: one round trip of `link` under
 * load (`loadedRoundTripMs`; none when null, or when nothing is to be
 * fetched), their bytes to fetch over its rate, their chunks' stored bytes
 * (`storedFor`, a kept chunk's too) decoded at `decoding`'s, and showing them.
 */
function readTime(link, decoding, bytesFor, showMs, storedFor = bytesFor) {
  const fixedMs = link === null ? 0 : loadedRoundTripMs(link);
  const decodeMsPerByte = decoding !== null && decoding.bytesPerMs > 0 ? decoding.expansion / decoding.bytesPerMs : 0;
  return k => {
    if (link === null) return k * showMs;
    const fetch = bytesFor(k);
    return (fetch > 0 ? fixedMs + fetch / link.bytesPerMs : 0) + storedFor(k) * decodeMsPerByte + k * showMs;
  };
}

/**
 * Decoded bytes a millisecond here, every decoder together: the rate one
 * chunk is measured to decode at (`decodePoolStats`), times the chunks
 * decoded at once; null before any chunk is decoded. The machine's
 * `decodeBytesPerMs` (`utils/machine.js`): held, it is the held rate, and
 * nothing is read to measure it (`firstViewCost` `measureDecode`) -- the
 * measured rate follows how busy the machine is, and carries over from
 * every chunk the realm decoded before.
 */
export function decodingRate() {
  return measureOf('decodeBytesPerMs', () => {
    const { decodedBytesPerMs, size } = decodePoolStats();
    return decodedBytesPerMs > 0 ? decodedBytesPerMs * Math.max(1, size) : null;
  });
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
  // Every step reads genes for the same first cells as the cells asked for
  // (`subsample-plan.js`, `genes`): each is a prefix of their priority order.
  // A fitted sample stays fitted (`geneSampleRequestOf`): grown to every
  // cell, its gene time's rest is still filled after the first gene.
  const genes = geneSampleRequestOf(resolution.genes ?? null);
  let step;
  let final;
  if (kept === null) {
    // A priority-ordered file opened whole grows through its prefixes. Every
    // cell of a file in its own order does not grow: opened in a cell order
    // (`cellOrder`), it is for a gene sample priced over a link, whose
    // round trips make any growth end later than one reading (`grownLater`).
    if (resolution.cellOrder != null || resolution.prioritySeed === null || resolution.prioritySeed === undefined) return null;
    step = { mode: 'subsample', method: 'uniform', seed: resolution.prioritySeed, strict: true, genes };
    final = { mode: 'all', genes };
  } else if (resolution.cellOrder != null || (resolution.prioritySeed != null && resolution.prefix == null)) {
    // A share in an order its smaller sizes are not prefixes of -- spread
    // through a file in its own order and opened in the file's cell order
    // (`cellOrder`), or a share of a priority-ordered file in file order --
    // grows through the first cells of that order (`prefix`): each step's
    // first cells, and their gene sample, are the share's.
    const order = resolution.cellOrder == null ? {} : { order: resolution.cellOrder };
    step = { mode: 'prefix', spec, autoFit: resolution.autoFit ?? null, ...order, genes };
    final = { mode: 'kept', spec, kept, autoFit: resolution.autoFit ?? null, reproduced: null, ...order, genes };
  } else {
    if (spec?.method !== 'uniform' && spec?.method !== 'blocks') return null;
    step = { mode: 'subsample', method: spec.method, seed: spec.seed, strict: true, genes, ...(spec.method === 'blocks' ? { blockSize: spec.blockSize } : {}) };
    final = { mode: 'kept', spec, kept, autoFit: resolution.autoFit ?? null, reproduced: null, genes };
  }
  const target = kept === null ? nObs : kept.length;
  if (!priced(link) && !(msPerCell > 0)) return null;
  // A share over a link whose round trips cost anything opens whole
  // (`grownLater`, and `chunkedPlan`'s own completion check): decided
  // before its first view is priced (`costOf` walks its cells: measured,
  // 23_decisions_partial_reading.md).
  if (kept !== null && priced(link) && loadedRoundTripMs(link) > 0) return null;
  const cost = priced(link) ? await costOf(target) : null;
  // Measured after `costOf`, which may have decoded the first chunk to measure it.
  const rate = decodeBytesPerMs ?? decodingRate();
  const decoding = cost === null || rate === null ? null : { bytesPerMs: rate, expansion: cost.expansion ?? 1 };
  const plan = progressivePlan({ target, bytesFor: cost?.bytesFor ?? null, storedFor: cost?.storedFor ?? cost?.bytesFor ?? null, link, decoding, msPerCell, targetMs });
  if (plan !== null && grownLater(resolution, plan, link)) return null;
  const chunked = kept === null || cost === null || resolution.prioritySeed != null || resolution.openOrder == null
    ? null
    : chunkedPlan(resolution, cost, { link, decoding, msPerCell, targetMs, against: plan === null ? null : plan.firstMs, wholeMs: plan === null ? null : plan.wholeMs });
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
/**
 * Whether a growth of a share would put all its cells on the map later
 * than one reading of them (`plan.wholeMs`): a share never costs more than
 * everything, judged by when the cells asked for are all shown, not by the
 * first picture. A growth
 * reads the same bytes in more readings, each a loaded round trip of its
 * own (`loadedRoundTripMs`), so as priced it ends later wherever a round
 * trip costs anything (the bandwidth measured at opening is a lower bound:
 * it prices both alike; measured: 23_decisions_partial_reading.md). Every
 * cell of a priority-ordered file grows: its prefixes are the file's own
 * order.
 */
function grownLater(resolution, plan, link) {
  if (resolution.kept === null) return false;
  const roundTrip = priced(link) ? loadedRoundTripMs(link) : 0;
  return plan.wholeMs + plan.steps.length * roundTrip > plan.wholeMs;
}

function chunkedPlan(resolution, cost, { link, decoding, msPerCell, targetMs, against, wholeMs }) {
  const { spec, kept } = resolution;
  const chunks = { rows: cost.chunkRows, seed: spec.seed };
  const { ends, chunks: ids } = chunkMajorOrder(resolution.openOrder, chunks.rows, chunks.seed);
  if (ends.length < 2) return null;
  const target = kept.length;
  // Each chunk at its own bytes to fetch (`firstViewCost`: what this browser
  // keeps costs none), the first j chunks of chunk order summed once.
  const fetchUpTo = allocateTypedArray(Float64Array, ids.length + 1, 'Chunk bytes to fetch');
  for (let j = 0; j < ids.length; j++) fetchUpTo[j + 1] = fetchUpTo[j] + (cost.fetchOfChunk?.(ids[j]) ?? cost.bytesPerChunk);
  const chunksFor = k => {
    if (k <= 0) return 0;
    let low = 0;
    let high = ends.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ends[mid] >= k) high = mid;
      else low = mid + 1;
    }
    return low + 1;
  };
  const bytesFor = k => fetchUpTo[chunksFor(k)];
  const storedFor = k => chunksFor(k) * (cost.storedPerChunk ?? cost.bytesPerChunk);
  const plan = progressivePlan({ target, bytesFor, storedFor, link, decoding, msPerCell, targetMs });
  if (plan === null) return null;
  const timeOf = readTime(link, decoding, bytesFor, msPerCell > 0 ? msPerCell : 0, storedFor);
  const first = chunkEndAtLeast(ends, plan.first);
  if (first >= target) return null;
  if (timeOf(first) * 2 > (against ?? plan.wholeMs)) return null;
  // All its cells on the map no later than one reading of them: each step
  // a loaded round trip of its own past the chunks' reading, and every cell
  // shown again in its order at the end (`grownLater`).
  const roundTrip = priced(link) ? loadedRoundTripMs(link) : 0;
  const shownAgainMs = msPerCell > 0 ? msPerCell * target : 0;
  if (timeOf(target) + plan.steps.length * roundTrip + shownAgainMs > (wholeMs ?? plan.wholeMs)) return null;
  const steps = [...new Set(plan.steps.map(k => chunkEndAtLeast(ends, k)))].filter(k => k > first).sort((a, b) => a - b);
  if (steps.at(-1) !== target) steps.push(target);
  const step = { mode: 'chunks', spec, autoFit: resolution.autoFit ?? null, chunks: Object.freeze(chunks) };
  // Put in the order the cells asked for open in (a share's cell order, `order`).
  const final = { mode: 'kept', spec, kept, autoFit: resolution.autoFit ?? null, reproduced: null, ...(resolution.cellOrder == null ? {} : { order: resolution.cellOrder }), genes: geneSampleRequestOf(resolution.genes ?? null) };
  return {
    first: { ...step, chunks: { ...chunks, cells: first } },
    growth: Object.freeze({ target, steps: Object.freeze(steps), step: Object.freeze(step), final: Object.freeze(final), chunked: true }),
  };
}
