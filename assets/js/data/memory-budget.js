/**
 * @fileoverview The one source of the memory budgets that decide what stays
 * resident: the gene-column index, decoded embedding positions of layouts no
 * view shows, inactive field data, an analysis run's buffered genes, the
 * AnnData adapter's cache, a latent space held for outlier quantiles, decoded
 * chunk blocks, decode workers and selection undo history.
 *
 * Every budget is a residency policy: it decides what is evicted, spilled to
 * disk or read again later, never what can be opened or shown.
 *
 * - **The device** is what the browser lets a page learn of its memory
 *   (`estimatedDeviceMemory`): `navigator.deviceMemory` (Chromium, secure
 *   contexts; rounded down to a power of two, and capped at 8 GiB by earlier
 *   Chromium releases: Chromium 151 reports 16 on a 16 GiB Mac), and the
 *   JavaScript heap limit (`performance.memory.jsHeapSizeLimit`, Chromium),
 *   which V8 sizes at about a quarter of physical memory (3.76 GB on that
 *   Mac), up to its pointer-compression cage. The heap limit raises the
 *   estimate past an 8 GiB report that may be a cap (that Mac is then
 *   14 GiB, not 8) and stands in when deviceMemory is not reported. A browser
 *   that reports neither (Firefox, Safari) is taken to be 8 GiB, the report
 *   earlier Chromium gave any larger device. `performance.measureUserAgentSpecificMemory()`
 *   is not used: it reports what the page uses, not what it may use, only in
 *   cross-origin isolated pages (which Cellucid's hosts are not), and it
 *   forces a garbage collection.
 * - **The allowance** is half the device: everything the app keeps by choice
 *   together. The other half is the system, the browser, other tabs and the
 *   app's working set (the embedding a view shows, its colours, the fields
 *   in use).
 * - **The shares** (`RESIDENCY_SHARES`) divide the allowance and sum to
 *   exactly one, so no two budgets count the same bytes and together they
 *   never exceed it. No budget has a floor or ceiling of its own.
 * - **A refused allocation** (`recordAllocationFailure`, reported by
 *   `allocateTypedArray`) of fewer bytes than the allowance means the
 *   estimate was too high for this page: the allowance of the thread that
 *   saw it halves, for every budget read afterwards.
 *
 * Each thread (the page, the AnnData reader worker) evaluates its own
 * budgets; the shares make them disjoint whichever thread holds the memory.
 *
 * @module data/memory-budget
 */

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

/** The part of the device everything the app keeps by choice may use together. */
const ALLOWANCE_OF_DEVICE = 1 / 2;

/**
 * Shares of the allowance. They sum to exactly one.
 */
export const RESIDENCY_SHARES = Object.freeze({
  /** A gene-column index held in memory before it spills to disk (8 bytes per stored entry). */
  columnIndex: 3 / 8,
  /** Decoded embedding positions of layouts no view shows. */
  positions: 1 / 8,
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: 1 / 8,
  /** Genes an analysis run buffers by default (marker discovery, differential expression). */
  analysis: 1 / 8,
  /** The AnnData adapter's normalized coordinates and obs field payloads. */
  adapterCache: 1 / 16,
  /** A latent space the reader worker holds for outlier quantiles. */
  latentHold: 1 / 16,
  /**
   * Decoded chunks of the open store, every cache of them together (`formats/io/decoded-budget.js`):
   * the store's own (dense strips shared by their genes, chunks read in part) and the whole chunks a
   * subsample is read through (`anndata/decoded-chunks.js`).
   */
  decodedBlocks: 1 / 32,
  /** Bytes of remote files the page keeps for its reader workers, whichever worker fetched them (`byte-range-cache.js`). */
  fetchedRanges: 1 / 32,
  /** Decode workers while they decompress chunks (`formats/io/decode-pool.js`). */
  decodeWorkers: 1 / 32,
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: 1 / 32,
});

/** How far refused allocations have lowered this thread's allowance (halved per refusal). */
let allowanceScale = 1;

/**
 * The device memory this page can count on, in bytes, and where the estimate
 * comes from.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {{bytes: number, source: 'deviceMemory'|'jsHeapSizeLimit'|'unreported'}}
 */
export function estimatedDeviceMemory(environment = globalThis) {
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

/**
 * The memory everything the app keeps by choice may use together, in bytes.
 *
 * @param {Object} [environment]
 * @returns {number}
 */
export function memoryAllowanceBytes(environment = globalThis) {
  return Math.floor(estimatedDeviceMemory(environment).bytes * ALLOWANCE_OF_DEVICE * allowanceScale);
}

/**
 * One residency budget in bytes: its share of the allowance.
 *
 * @param {keyof typeof RESIDENCY_SHARES} name
 * @param {Object} [environment]
 * @returns {number}
 */
export function residencyBudgetBytes(name, environment = globalThis) {
  const share = RESIDENCY_SHARES[name];
  if (share === undefined) {
    throw new TypeError(`Unknown residency budget '${String(name)}'`);
  }
  return Math.floor(memoryAllowanceBytes(environment) * share);
}

/**
 * A typed array of `bytes` could not be allocated. When it was smaller than
 * the allowance, the estimate was more than this page can have: this
 * thread's allowance halves for every budget read from now on. A refusal of
 * more than the allowance (an array beyond what the engine allocates in one
 * piece) says nothing about it.
 *
 * @param {number} bytes
 * @param {Object} [environment]
 * @returns {boolean} Whether the allowance was lowered
 */
export function recordAllocationFailure(bytes, environment = globalThis) {
  if (!(bytes > 0) || bytes >= memoryAllowanceBytes(environment)) return false;
  allowanceScale /= 2;
  return true;
}

/** Forget refused allocations (tests). */
export function resetAllocationFailures() {
  allowanceScale = 1;
}
