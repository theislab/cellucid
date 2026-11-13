/**
 * @fileoverview The one memory model of the app: what the device allows,
 * what is drawn, what every cache keeps, and what happens when memory is
 * short. Every thread that keeps memory by choice (the page, the AnnData
 * reader worker) reads its budgets here.
 *
 * - **The device** is what the browser lets a page learn of its memory
 *   (`estimatedDeviceMemory`): `navigator.deviceMemory` (Chromium, secure
 *   contexts; rounded down to a power of two, and capped at 8 GiB by earlier
 *   Chromium releases), and the
 *   JavaScript heap limit (`performance.memory.jsHeapSizeLimit`, Chromium
 *   pages only), which V8 sizes at about a quarter of physical memory, up to
 *   its pointer-compression cage. The heap limit
 *   raises the estimate past an 8 GiB report that may be a cap and stands in
 *   when deviceMemory is not reported. A
 *   browser that reports neither (Firefox, Safari) is taken to be 8 GiB, the
 *   report earlier Chromium gave any larger device. The page estimates it
 *   once and hands it to every worker it starts (`connectMemoryWorker`), so
 *   every thread counts against the same device (a worker has no heap
 *   limit to read).
 * - **The allowance** is half the device: what the app may use, drawn and
 *   kept together. The other half is the system, the browser and other
 *   tabs. Several Cellucid pages of one origin (tabs, notebook widgets)
 *   divide it (`data/memory-census.js`): each may use what the others do not
 *   hold, and at least an equal share. A refused allocation lowers it (below).
 * - **The working set** is what is drawn: the open cells of the shown
 *   dataset (`setOpenCells`, `CELL_WORKING_SET_BYTES` a cell: positions,
 *   colors, visibility, the spatial tree and draw order on the page and on
 *   the GPU, the colored field), a neighbor graph while a view shows its
 *   edges (`setWorkingSet('graph', bytes)`), what a worker builds while it
 *   builds it (a worker's `setWorkingSet` reaches the page, counted under the
 *   worker's name: the reader worker's `'graph build'`), the values the
 *   action history keeps for every step of the dataset shown
 *   (`setWorkingSet('history', bytes)`, `app/history/dataset-history.js`: the
 *   typed arrays of its value pool, each buffer once; the person's work,
 *   never evicted, held while the dataset is shown), and, where the browser can
 *   measure the page (`measureUserAgentSpecificMemory`, cross-origin isolated
 *   pages only), what it uses beyond everything counted. The auto-fit sizes
 *   the open cells against the allowance (`anndata/subsample-plan.js`).
 * - **The caches** divide what the working set leaves of the allowance
 *   (`cacheRoomBytes`) by fixed shares (`RESIDENCY_SHARES`, summing to
 *   one), so the working set and every cache together never exceed the
 *   allowance and no two caches count the same bytes. No budget has a floor
 *   or ceiling of its own. Every budget is a residency policy: it decides
 *   what is evicted, spilled to disk or read again later, never what can be
 *   opened or shown.
 * - **The ledger**: every cache registers as a holder of its share
 *   (`registerResidentHolder`): what it keeps now (`bytes()`) and how to keep
 *   less (`trim(budget)`: its least recently used entries go until it keeps
 *   no more than `budget`; entries in use stay). Whenever the allowance or
 *   the working set changes, every share over its budget is trimmed
 *   (`settleMemory`), in every thread. Workers report what their holders
 *   keep, so the page knows what the app holds in all (`memoryReport`), and
 *   tells the other pages of its origin.
 * - **A refused allocation** (`recordAllocationFailure`, reported by
 *   `allocateTypedArray` in any thread) of less than the allowance says the
 *   estimate was more than this page can have: the allowance halves, in
 *   every thread, and every cache over its new budget gives memory back at
 *   once (one notice says what). It comes back a step at a time, on
 *   evidence: an allocation at least as large granted while the app already
 *   holds the lowered allowance (`recordAllocationSuccess`), or the refused
 *   size granted again when another dataset opens
 *   (`retryRefusedAllocation`).
 * - **Giving memory back** (`releaseResidentMemory`) empties every cache of
 *   a level, cheapest to rebuild first (`RELEASE_ORDER`): `'caches'`
 *   everything but the gene-column index (a pass over the matrix to build)
 *   and the selection undo steps (the person's work); `'all'` the
 *   gene-column index too. A page hidden or frozen calls it (`app/main.js`).
 *
 * The JavaScript heap is not measured: `performance.memory` counts the V8
 * heap only, never the `ArrayBuffer`s every per-cell array lives in, is
 * quantised and refreshed rarely outside cross-origin isolated pages, and
 * exists only on Chromium pages.
 *
 * @module data/memory-budget
 */

import { createListenerSet } from '../utils/listener-set.js';

const GIB = 1024 ** 3;

/** The 8 GiB report earlier Chromium releases give any larger device. */
const DEVICE_MEMORY_TOP_BUCKET_GIB = 8;

/**
 * Physical memory per byte of JavaScript heap limit: V8 sizes the heap limit
 * at about a quarter of physical memory (`Heap::HeapSizeFromPhysicalMemory`).
 */
const HEAP_TO_PHYSICAL_RATIO = 4;

/** The device a browser that reports nothing is taken to be (Firefox, Safari). */
const UNREPORTED_DEVICE_BYTES = DEVICE_MEMORY_TOP_BUCKET_GIB * GIB;

/** The part of the device the app may use, drawn and kept together. */
const ALLOWANCE_OF_DEVICE = 1 / 2;

/**
 * Bytes one cell holds in the page's working set however a dataset is
 * shown, as measured, not modeled: the physical memory a cell takes for
 * the points themselves -- 3D positions and colors in the page and on the
 * GPU with the GPU process's own overhead, visibility, the spatial tree and
 * the draw order levels of detail need, and its permutation (renderer and
 * GPU processes together, 3D cells with levels of detail; measured:
 * 27_decisions_memory_model.md), rounded up, plus the codes of the field the
 * cells are colored by (4), one continuous field (4) and its outlier
 * quantile (4). A model that leaves out the tree, the draw order or the GPU
 * process's overhead fits more cells to a device than it holds.
 */
export const CELL_WORKING_SET_BYTES = 77;

/**
 * Shares of what the working set leaves of the allowance. They sum to
 * exactly one.
 */
export const RESIDENCY_SHARES = Object.freeze({
  /**
   * A gene-column index held in memory before it spills to disk (8 bytes per
   * stored entry), with the row pointers of the cell-major matrices it is
   * built from (8 bytes a stored row).
   */
  columnIndex: 3 / 8,
  /** Decoded embedding positions of layouts no view shows. */
  positions: 1 / 8,
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: 1 / 8,
  /**
   * An analysis run's memory: the genes it buffers (marker discovery,
   * differential expression, dot plots), the per-cell context each analysis
   * worker keeps for it (its groups), and the marker results kept for the
   * next look.
   */
  analysis: 1 / 16,
  /**
   * The values analysis windows read for their pages, kept for the next read
   * (`app/analysis/data/data-layer.js`), with the page cell lists made for
   * them (unions of groups, "rest of" pages, first-pass samples).
   */
  analysisPages: 1 / 16,
  /**
   * The AnnData adapter's cached copies: normalized coordinates, obs field
   * payloads not handed to a view, and the neighbor graph read last while
   * no view shows its edges.
   */
  adapterCache: 1 / 16,
  /** A latent space the reader worker holds for outlier quantiles. */
  latentHold: 1 / 16,
  /**
   * Decoded chunks of the open store, every cache of them together (`formats/io/decoded-budget.js`):
   * the store's own (dense strips shared by their genes, chunks read in part) and the whole chunks a
   * subsample is read through (`anndata/decoded-chunks.js`), every open store together.
   */
  decodedBlocks: 1 / 32,
  /**
   * Bytes of remote files kept for the reader workers: the page's byte-range cache (`byte-range-cache.js`), whichever
   * worker fetched them, and each worker's own held reads (`heldReaderBytes`, registered by `anndata-reader-worker.js`).
   */
  fetchedRanges: 1 / 32,
  /** Decode workers while they decompress chunks (`formats/io/decode-pool.js`). */
  decodeWorkers: 1 / 32,
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: 1 / 32,
});

/**
 * The order caches give memory back in, cheapest to rebuild first: decoded
 * chunks are decoded again from bytes, fetched bytes fetched again, idle
 * decode workers started again; cached copies are read again from the
 * reader; analysis values and unshown layouts are read and decoded again; a
 * latent hold is a pass over a latent space; a gene-column index a pass over
 * the matrix. Selection undo steps are the person's work: kept to their
 * budget, never released on their own.
 */
export const RELEASE_ORDER = Object.freeze([
  'decodedBlocks',
  'fetchedRanges',
  'decodeWorkers',
  'adapterCache',
  'inactiveFields',
  'analysisPages',
  'analysis',
  'positions',
  'latentHold',
  'columnIndex',
  'undoHistory',
]);

/** The shares each release level empties (`releaseResidentMemory`). */
const RELEASE_LEVELS = Object.freeze({
  caches: Object.freeze(RELEASE_ORDER.filter(name => name !== 'columnIndex' && name !== 'undoHistory')),
  all: Object.freeze(RELEASE_ORDER.filter(name => name !== 'undoHistory')),
});

if (RELEASE_ORDER.length !== Object.keys(RESIDENCY_SHARES).length ||
    !RELEASE_ORDER.every(name => Object.hasOwn(RESIDENCY_SHARES, name))) {
  throw new Error('Every residency share has one place in the release order.');
}

function requireShare(name) {
  if (!Object.hasOwn(RESIDENCY_SHARES, name)) throw new TypeError(`Unknown residency budget '${String(name)}'`);
  return name;
}

function requireBytes(bytes, label) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new TypeError(`${label} must be a non-negative number of bytes.`);
  return bytes;
}

// ---------------------------------------------------------------------------
// The state every thread evaluates its budgets from
// ---------------------------------------------------------------------------

/**
 * The page's state as a worker was handed it (`receiveMemoryMessage`), or
 * null in the page (and any thread no page configured), which decides it.
 * @type {Readonly<Object>|null}
 */
let handed = null;

/** How far refused allocations have lowered the allowance (halved per refusal). */
let allowanceScale = 1;

/** The size of the allocation refused last, while the allowance is lowered. */
let refusedBytes = 0;

/** The other Cellucid pages of this origin, and what they hold (`setOtherInstances`). */
let otherInstances = { count: 0, heldBytes: 0 };

/** What is drawn, by part (`setOpenCells`, `setWorkingSet`). @type {Map<string, number>} */
const workingSet = new Map();

/** The cells of the shown dataset (`setOpenCells`). */
let openCells = 0;

/**
 * The device memory this page can count on, in bytes, and where the estimate
 * comes from.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {{bytes: number, source: 'deviceMemory'|'jsHeapSizeLimit'|'unreported'}}
 */
export function estimatedDeviceMemory(environment = globalThis) {
  if (handed !== null && environment === globalThis) return { bytes: handed.deviceBytes, source: handed.deviceSource };
  const deviceMemory = environment?.navigator?.deviceMemory;
  const reported = typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory > 0
    ? Math.floor(deviceMemory * GIB)
    : null;
  const heapLimit = environment?.performance?.memory?.jsHeapSizeLimit;
  const fromHeap = typeof heapLimit === 'number' && Number.isFinite(heapLimit) && heapLimit > 0
    ? Math.floor(heapLimit * HEAP_TO_PHYSICAL_RATIO)
    : null;
  // A report below 8 GiB names the device; one of 8 GiB or more may be a cap
  // and says "at least", which the heap limit can raise.
  if (reported !== null && (reported < DEVICE_MEMORY_TOP_BUCKET_GIB * GIB || fromHeap === null || fromHeap <= reported)) {
    return { bytes: reported, source: 'deviceMemory' };
  }
  if (fromHeap !== null) return { bytes: fromHeap, source: 'jsHeapSizeLimit' };
  return { bytes: UNREPORTED_DEVICE_BYTES, source: 'unreported' };
}

function currentScale() {
  return handed === null ? allowanceScale : handed.scale;
}

function currentOthers() {
  return handed === null ? otherInstances : handed.otherInstances;
}

/**
 * What the app may use, drawn and kept together, in bytes: half the device,
 * less what other Cellucid pages of this origin hold (at least an equal
 * share), lowered by refused allocations.
 *
 * @param {Object} [environment]
 * @returns {number}
 */
export function memoryAllowanceBytes(environment = globalThis) {
  const device = estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * currentScale();
  const others = currentOthers();
  const shared = others.count === 0 ? device : Math.max(device / (others.count + 1), device - others.heldBytes);
  return Math.floor(shared);
}

/** What is drawn now, in bytes (the open cells and every other part). */
export function workingSetBytes() {
  if (handed !== null) return handed.workingSetBytes;
  let total = 0;
  for (const bytes of workingSet.values()) total += bytes;
  return total;
}

/**
 * What the working set leaves of the allowance for the caches, in bytes.
 *
 * @param {{workingSetBytes?: number, environment?: Object}} [options] -
 *   `workingSetBytes`: a working set to price instead of the current one
 *   (the auto-fit, sizing an opening)
 * @returns {number}
 */
export function cacheRoomBytes({ workingSetBytes: drawn = workingSetBytes(), environment = globalThis } = {}) {
  return Math.max(0, memoryAllowanceBytes(environment) - drawn);
}

/**
 * One residency budget in bytes: its share of what the working set leaves
 * of the allowance.
 *
 * @param {keyof typeof RESIDENCY_SHARES} name
 * @param {Object} [environment] - A stand-in for `globalThis` (tests)
 * @param {{workingSetBytes?: number}} [options] - a working set to price
 *   instead of the current one
 * @returns {number}
 */
export function residencyBudgetBytes(name, environment = globalThis, { workingSetBytes: drawn = workingSetBytes() } = {}) {
  requireShare(name);
  return Math.floor(cacheRoomBytes({ workingSetBytes: drawn, environment }) * RESIDENCY_SHARES[name]);
}

/** The cells of the shown dataset, as last set (`setOpenCells`). */
export function openCellCount() {
  return handed === null ? openCells : handed.openCells;
}

/**
 * The shown dataset's open cells changed (opened, grown, cut, closed): the
 * working set is `count` cells, and the caches divide what it leaves.
 *
 * @param {number} count
 */
export function setOpenCells(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('An open cell count is a non-negative integer.');
  if (count === openCells) return;
  openCells = count;
  setWorkingSet('cells', count * CELL_WORKING_SET_BYTES);
  sampleMeasuredMemory();
}

/** What each part of the working set draws, when it is one object (a graph). @type {Map<string, Object>} */
const drawnObjects = new Map();

/** A worker's parts of the working set (`setWorkingSet` in a worker), as it last reported them. @type {Map<string, number>} */
const workerParts = new Map();

/**
 * One part of what is drawn besides the open cells (a neighbor graph whose
 * edges a view shows or the k-NN tool uses: `'graph'`; a neighbor graph a
 * worker is building: `'graph build'`) holds `bytes` now; 0 when nothing.
 * `object`, when given, is what it draws: a cache that keeps the same object
 * does not count it again while it is drawn (`isDrawn`). A worker's part is
 * reported to the page at once and counted there under the worker's name, so
 * every thread's caches make room for it.
 *
 * @param {string} part
 * @param {number} bytes
 * @param {Object|null} [object]
 */
export function setWorkingSet(part, bytes, object = null) {
  if (typeof part !== 'string' || part.length === 0) throw new TypeError('A working-set part is named.');
  requireBytes(bytes, `The working set's ${part}`);
  if (reporter !== null) {
    if (object !== null) throw new Error('A worker\'s part of the working set draws no object of the page.');
    if ((workerParts.get(part) ?? 0) === bytes) return;
    if (bytes === 0) workerParts.delete(part);
    else workerParts.set(part, bytes);
    report({ working: Object.fromEntries(workerParts) });
    return;
  }
  if (handed !== null) throw new Error('The working set is the page\'s to set.');
  if (bytes === 0 || object === null) drawnObjects.delete(part);
  else drawnObjects.set(part, object);
  if ((workingSet.get(part) ?? 0) === bytes) return;
  if (bytes === 0) workingSet.delete(part);
  else workingSet.set(part, bytes);
  stateChanged('working set');
}

/** Whether `object` is drawn (`setWorkingSet`): counted there, not by a cache that keeps it too. */
export function isDrawn(object) {
  for (const drawn of drawnObjects.values()) if (drawn === object) return true;
  return false;
}

/**
 * The bytes of the typed arrays `value` holds as its own properties, each
 * buffer once (a neighbor graph's arrays, a payload of several arrays).
 *
 * @param {Object|null} value
 * @returns {number}
 */
export function typedArrayBytes(value) {
  if (value === null || typeof value !== 'object') return 0;
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength;
  const buffers = new Set();
  for (const item of Object.values(value)) {
    if (ArrayBuffer.isView(item)) buffers.add(item.buffer);
  }
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

/**
 * Other Cellucid pages of this origin (`data/memory-census.js`): how many
 * there are and what they hold together, drawn and kept.
 *
 * @param {{count: number, heldBytes: number}} others
 */
export function setOtherInstances({ count, heldBytes }) {
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('An instance count is a non-negative integer.');
  requireBytes(heldBytes, 'What other pages hold');
  if (count === otherInstances.count && heldBytes === otherInstances.heldBytes) return;
  otherInstances = Object.freeze({ count, heldBytes });
  stateChanged('other pages');
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * Every holder of this thread, in registration order (oldest first).
 * @type {Set<{share: string, label: string, bytes: () => number, trim: (budget: number) => (string|string[]|null|void)}>}
 */
const holders = new Set();

/** What each worker's holders keep, as its last report said, by worker. @type {Map<string, Object<string, number>>} */
const workerHeld = new Map();

/**
 * Count one cache against its share: `bytes()` what it keeps now,
 * `trim(budget)` lets its least recently used entries go until it keeps no
 * more than `budget` (0: everything not in use) and says what it let go in
 * words (or nothing). A holder that keeps nothing more unregisters.
 *
 * @param {keyof typeof RESIDENCY_SHARES} share
 * @param {{label: string, bytes: () => number, trim: (budget: number) => (string|string[]|null|void)}} holder
 * @returns {() => void} Unregister
 */
export function registerResidentHolder(share, holder) {
  requireShare(share);
  if (holder === null || typeof holder !== 'object' || typeof holder.bytes !== 'function' || typeof holder.trim !== 'function') {
    throw new TypeError('A resident holder has bytes() and trim(budget).');
  }
  if (typeof holder.label !== 'string' || holder.label.length === 0) throw new TypeError('A resident holder is labeled.');
  const entry = { share, label: holder.label, bytes: holder.bytes, trim: holder.trim };
  holders.add(entry);
  return () => {
    holders.delete(entry);
  };
}

function holderBytes(entry) {
  const bytes = entry.bytes();
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** What this thread's holders of `share` keep, in bytes. */
function localHeld(share) {
  let total = 0;
  for (const entry of holders) if (entry.share === share) total += holderBytes(entry);
  return total;
}

/** What every thread's holders keep, by share (workers as last reported). */
function heldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) shares[name] = localHeld(name);
  for (const report of workerHeld.values()) {
    for (const [name, bytes] of Object.entries(report)) if (Object.hasOwn(shares, name)) shares[name] += bytes;
  }
  return shares;
}

/** What every thread's holders keep, in bytes. */
export function heldBytes() {
  let total = 0;
  for (const bytes of Object.values(heldByShare())) total += bytes;
  return total;
}

function wordsOf(result) {
  if (typeof result === 'string') return result.length > 0 ? [result] : [];
  if (Array.isArray(result)) return result.filter(item => typeof item === 'string' && item.length > 0);
  return [];
}

/** Bring `share`'s holders within `budget`: the oldest holders first, each its own least recently used entries. */
function trimShare(share, budget, released) {
  const entries = [...holders].filter(entry => entry.share === share);
  let held = entries.reduce((sum, entry) => sum + holderBytes(entry), 0);
  if (held <= budget) return;
  for (const entry of entries) {
    if (held <= budget) break;
    const own = holderBytes(entry);
    released.push(...wordsOf(entry.trim(Math.max(0, budget - (held - own)))));
    held += holderBytes(entry) - own;
  }
}

/**
 * Bring every share of this thread within its budget (after the allowance
 * or the working set changed), cheapest to rebuild first.
 *
 * @param {string} [reason] - Why, for the release listeners
 * @returns {string[]} What was let go, in words
 */
export function settleMemory(reason = 'settle') {
  const released = [];
  for (const share of RELEASE_ORDER) trimShare(share, residencyBudgetBytes(share), released);
  announceRelease(reason, released);
  return released;
}

/**
 * Give back every cache of `level` in this thread, cheapest to rebuild first
 * (the page passes it on to its workers): `'caches'` everything but the
 * gene-column index and the selection undo steps, `'all'` the gene-column
 * index too. Entries in use stay; everything let go is read or built again
 * when asked for.
 *
 * @param {'caches'|'all'} level
 * @param {string} [reason]
 * @returns {string[]} What was let go, in words
 */
export function releaseResidentMemory(level, reason = level) {
  const shares = RELEASE_LEVELS[level];
  if (shares === undefined) throw new TypeError(`Unknown release level '${String(level)}'`);
  const released = [];
  for (const share of shares) trimShare(share, 0, released);
  for (const connection of connections) connection.post({ memoryRelease: level, reason });
  announceRelease(reason, released);
  noteMemoryChanged();
  return released;
}

// ---------------------------------------------------------------------------
// Refused and granted allocations
// ---------------------------------------------------------------------------

/**
 * A typed array of `bytes` could not be allocated, in this thread. When it
 * was smaller than the allowance, the estimate was more than this page can
 * have: the allowance halves, in every thread (a worker tells the page,
 * which decides), and every cache over its new budget gives memory back at
 * once. A refusal of more than the allowance (an array beyond what the
 * engine allocates in one piece) says nothing about it.
 *
 * @param {number} bytes
 * @param {Object} [environment]
 * @returns {boolean} Whether the allowance was lowered
 */
export function recordAllocationFailure(bytes, environment = globalThis) {
  if (!(bytes > 0) || bytes >= memoryAllowanceBytes(environment)) return false;
  if (handed !== null) {
    // The page decides; this thread gives back at once meanwhile.
    handed = Object.freeze({ ...handed, scale: handed.scale / 2, refusedBytes: bytes });
    report({ refused: bytes });
    settleMemory('refused');
    return true;
  }
  allowanceScale /= 2;
  refusedBytes = bytes;
  stateChanged('refused');
  return true;
}

/**
 * This tab stopped while it opened a dataset, last time it was loaded: the
 * browser ended it before its first view (`app/page-memory.js`), as a phone
 * ends a tab that holds more memory than the phone lets it, without a refused
 * allocation the page could hear first. A browser that reports neither its
 * device memory nor a heap limit (Safari, Firefox) is taken to be an 8 GiB
 * device (`UNREPORTED_DEVICE_BYTES`), more than most phones have; this is the
 * evidence that it was not. The allowance halves, as for a refused
 * allocation, and comes back the same way: on an allocation granted while
 * the app holds the lowered allowance (`recordAllocationSuccess`).
 *
 * @returns {boolean} Whether the allowance halved (in the page; a worker's
 *   is the page's)
 */
export function recordInterruptedOpening() {
  if (handed !== null) return false;
  allowanceScale /= 2;
  refusedBytes = Math.max(refusedBytes, 1);
  stateChanged('interrupted');
  return true;
}

/**
 * A typed array of `bytes` was allocated. While a refusal keeps the
 * allowance lowered, one at least as large as the refused one, granted while
 * the app already holds the lowered allowance, shows the device has room
 * beyond it: the allowance comes back one step (it doubles, to at most what
 * the device allows).
 *
 * @param {number} bytes
 */
export function recordAllocationSuccess(bytes) {
  const refused = handed === null ? refusedBytes : handed.refusedBytes;
  if (refused === 0 || !(bytes >= refused)) return;
  if (handed !== null) {
    report({ granted: bytes });
    return;
  }
  if (workingSetBytes() + heldBytes() + bytes < memoryAllowanceBytes()) return;
  raiseAllowance('granted');
}

/**
 * Another dataset opens: an allocation of the size refused last is tried
 * again, and the allowance comes back one step when it is granted (what was
 * held when it was refused is gone).
 */
export function retryRefusedAllocation() {
  if (handed !== null || refusedBytes === 0) return;
  try {
    // Reserved, never written: granted or refused as the refused one was.
    void new ArrayBuffer(refusedBytes);
  } catch (error) {
    if (error instanceof RangeError) return;
    throw error;
  }
  raiseAllowance('retried');
}

function raiseAllowance(reason) {
  allowanceScale = Math.min(1, allowanceScale * 2);
  if (allowanceScale === 1) refusedBytes = 0;
  stateChanged(reason);
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

const changeListeners = createListenerSet('the memory budgets');
const releaseListeners = createListenerSet('memory released');

/**
 * Be told when the budgets change (the allowance, the working set, other
 * pages): a run sized from a budget sizes itself again.
 *
 * @param {(reason: string) => void} listener
 * @returns {() => void} Stop being told
 */
export function onMemoryChange(listener) {
  return changeListeners.add(listener);
}

/**
 * Be told what caches let go and why (`'refused'`: memory ran short;
 * `'hidden'`, `'frozen'`; `'working set'`, `'other pages'`; a worker's
 * release arrives with its own reason).
 *
 * @param {(event: {reason: string, released: string[]}) => void} listener
 * @returns {() => void} Stop being told
 */
export function onMemoryReleased(listener) {
  return releaseListeners.add(listener);
}

function announceRelease(reason, released) {
  if (released.length === 0) return;
  if (handed !== null) report({ released, reason });
  releaseListeners.notify({ reason, released: [...released] });
}

function stateChanged(reason) {
  settleMemory(reason);
  const state = memoryState();
  for (const connection of connections) connection.post({ memoryState: state, reason });
  changeListeners.notify(reason);
  noteMemoryChanged();
}

// ---------------------------------------------------------------------------
// Threads: the page hands its state to its workers; they report back
// ---------------------------------------------------------------------------

/** The state a worker evaluates its budgets from. */
function memoryState() {
  const device = estimatedDeviceMemory();
  return Object.freeze({
    deviceBytes: device.bytes,
    deviceSource: device.source,
    scale: allowanceScale,
    refusedBytes,
    otherInstances,
    workingSetBytes: workingSetBytes(),
    openCells,
  });
}

/** @type {Set<{post: (message: Object) => void}>} */
const connections = new Set();
let nextWorker = 1;

/**
 * Hand the page's memory state to a worker it starts (first, before any
 * request, and again on every change), and take its reports: what its
 * holders keep, the allocations it was refused or granted, what it let go.
 *
 * @param {{postMessage: (message: Object) => void}} worker
 * @returns {{receive: (event: Object) => void, disconnect: () => void}} -
 *   `receive` a `{event: 'memory'}` message of the worker's
 */
export function connectMemoryWorker(worker) {
  if (handed !== null) throw new Error('Only the page hands its memory state to workers.');
  const key = `worker-${nextWorker++}`;
  const connection = { post: message => worker.postMessage(message) };
  connections.add(connection);
  connection.post({ memoryState: memoryState(), reason: 'started' });
  return {
    receive(event) {
      if (!connections.has(connection)) return;
      if (event.held !== undefined) workerHeld.set(key, Object.freeze({ ...event.held }));
      if (event.working !== undefined) setWorkerParts(key, event.working);
      if (event.released !== undefined) {
        releaseListeners.notify({ reason: event.reason ?? 'worker', released: [...event.released] });
      }
      if (event.refused !== undefined) recordAllocationFailure(event.refused);
      if (event.granted !== undefined) recordAllocationSuccess(event.granted);
      noteMemoryChanged();
    },
    disconnect() {
      if (!connections.delete(connection)) return;
      workerHeld.delete(key);
      setWorkerParts(key, {});
      noteMemoryChanged();
    },
  };
}

/** A worker's parts of the working set, as it reported them: each counted as `<worker>: <part>`, the ones it no longer names dropped. */
function setWorkerParts(key, parts) {
  const prefix = `${key}: `;
  for (const part of [...workingSet.keys()]) {
    if (part.startsWith(prefix) && !Object.hasOwn(parts, part.slice(prefix.length))) setWorkingSet(part, 0);
  }
  for (const [part, bytes] of Object.entries(parts)) setWorkingSet(`${prefix}${part}`, bytes);
}

/** How a worker reports to the page, or null (the page, an unconnected thread). */
let reporter = null;
let reportScheduled = false;

/**
 * A worker reports through `post` (`{event: 'memory', ...}` to the page).
 *
 * @param {(message: Object) => void} post
 */
export function setMemoryReporter(post) {
  if (typeof post !== 'function') throw new TypeError('A memory reporter is a function.');
  reporter = post;
}

function report(extra) {
  if (reporter === null) return;
  // Refusals and grants go at once: the page decides from them.
  if (extra !== undefined) {
    reporter({ event: 'memory', held: localHeldByShare(), ...extra });
    return;
  }
  reporter({ event: 'memory', held: localHeldByShare() });
}

function localHeldByShare() {
  const shares = {};
  for (const name of RELEASE_ORDER) {
    const bytes = localHeld(name);
    if (bytes > 0) shares[name] = bytes;
  }
  return shares;
}

/** Listeners of what the page holds in all (the census of other pages). */
const heldListeners = createListenerSet('the memory this page holds');

/**
 * What a holder keeps changed (a request ended, a cache emptied when idle):
 * a worker reports what its holders keep to the page, soon; the page tells
 * whoever counts what it holds.
 */
export function noteMemoryChanged() {
  if (reportScheduled) return;
  reportScheduled = true;
  setTimeout(() => {
    reportScheduled = false;
    if (reporter !== null) report();
    else if (heldListeners.size > 0) heldListeners.notify(workingSetBytes() + heldBytes());
  }, 0);
}

/**
 * Be told, soon after it changes, what this page holds in all, drawn and
 * kept, every thread together (`data/memory-census.js`).
 *
 * @param {(bytes: number) => void} listener
 * @returns {() => void} Stop being told
 */
export function onHeldChange(listener) {
  return heldListeners.add(listener);
}

/**
 * A worker's message from the page about memory: its state (adopted, and
 * every cache over its new budget trimmed) or a release (`memoryRelease`).
 *
 * @param {Object} message
 * @returns {boolean} Whether the message was about memory
 */
export function receiveMemoryMessage(message) {
  if (message?.memoryState !== undefined) {
    const state = message.memoryState;
    handed = Object.freeze({
      deviceBytes: requireBytes(state.deviceBytes, 'The device memory'),
      deviceSource: state.deviceSource,
      scale: state.scale,
      refusedBytes: state.refusedBytes,
      otherInstances: Object.freeze({ ...state.otherInstances }),
      workingSetBytes: requireBytes(state.workingSetBytes, 'The working set'),
      openCells: state.openCells,
    });
    settleMemory(message.reason ?? 'settle');
    changeListeners.notify(message.reason ?? 'settle');
    report();
    return true;
  }
  if (message?.memoryRelease !== undefined) {
    releaseResidentMemory(message.memoryRelease, message.reason ?? message.memoryRelease);
    report();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// What the browser measures, where it can
// ---------------------------------------------------------------------------

let measuring = false;

/**
 * Where the browser measures the page's own memory
 * (`performance.measureUserAgentSpecificMemory`, which exists only in
 * cross-origin isolated pages of Chromium), what it uses beyond everything
 * counted (the working set, every holder) is counted as working set too.
 * Elsewhere (Firefox, Safari, pages that are not isolated, as Cellucid's
 * hosts are not) the model is what it counts.
 */
function sampleMeasuredMemory() {
  const measure = globalThis.performance?.measureUserAgentSpecificMemory;
  if (handed !== null || measuring || globalThis.crossOriginIsolated !== true || typeof measure !== 'function') return;
  measuring = true;
  measure.call(globalThis.performance).then(result => {
    const counted = workingSetBytes() - (workingSet.get('unaccounted') ?? 0) + heldBytes();
    setWorkingSet('unaccounted', Math.max(0, Number(result?.bytes ?? 0) - counted));
  }, () => {}).finally(() => {
    measuring = false;
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * What the app holds against what it may: the device and allowance, the
 * working set, every share's budget and what its holders keep in every
 * thread (workers as last reported), other pages, a refusal in force.
 *
 * @returns {Object}
 */
export function memoryReport() {
  const device = estimatedDeviceMemory();
  const held = heldByShare();
  const shares = {};
  let heldTotal = 0;
  for (const name of RELEASE_ORDER) {
    shares[name] = { budgetBytes: residencyBudgetBytes(name), heldBytes: held[name] };
    heldTotal += held[name];
  }
  return {
    deviceBytes: device.bytes,
    deviceSource: device.source,
    allowanceBytes: memoryAllowanceBytes(),
    scale: currentScale(),
    refusedBytes: handed === null ? refusedBytes : handed.refusedBytes,
    workingSetBytes: workingSetBytes(),
    workingSet: Object.fromEntries(workingSet),
    openCells: openCellCount(),
    cacheRoomBytes: cacheRoomBytes(),
    heldBytes: heldTotal,
    shares,
    instances: currentOthers().count + 1,
    otherInstancesHeldBytes: currentOthers().heldBytes,
    workers: workerHeld.size,
    holders: holders.size,
  };
}

/** Forget refusals, other pages, the working set, workers and holders (tests). */
export function resetMemoryModel() {
  handed = null;
  allowanceScale = 1;
  refusedBytes = 0;
  otherInstances = { count: 0, heldBytes: 0 };
  workingSet.clear();
  drawnObjects.clear();
  openCells = 0;
  holders.clear();
  workerHeld.clear();
  workerParts.clear();
  connections.clear();
  reporter = null;
  changeListeners.clear();
  releaseListeners.clear();
  heldListeners.clear();
}
