/**
 * @fileoverview The one source of the memory budgets that decide what stays
 * resident: inactive field data, decoded positions, the AnnData adapter's
 * coordinate cache, decoded Zarr/HDF5 blocks and the gene-column index.
 *
 * Every budget here is a residency policy: it decides what is evicted and
 * reloaded later, never what can be opened or shown. Each is a share of the
 * memory the browser reports for the device -- `navigator.deviceMemory`
 * (Chromium; it reports at most 8 GiB), else the JavaScript heap limit
 * (`performance.memory`, Chromium) -- so a larger machine keeps more warm and
 * a smaller one evicts sooner, and the shares sum well below the whole
 * device. A browser that reports neither (Firefox, Safari) keeps the budgets
 * the app has always used, which are also the values at a reported 8 GiB.
 *
 * @module data/memory-budget
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Shares of reported device memory, each with a floor (so a tiny report
 * never makes a cache useless) and a ceiling (so one cache never crowds out
 * the others).
 */
export const RESIDENCY_SHARES = Object.freeze({
  /** Loaded but unused field arrays kept for fast re-selection. */
  inactiveFields: Object.freeze({ share: 1 / 16, min: 128 * MIB, max: 4 * GIB, unreported: 512 * MIB }),
  /** Decoded embedding positions of layouts no view shows. */
  positions: Object.freeze({ share: 1 / 4, min: 512 * MIB, max: 8 * GIB, unreported: 512 * MIB }),
  /** The AnnData adapter's normalized coordinates and obs field payloads. */
  adapterCache: Object.freeze({ share: 1 / 16, min: 128 * MIB, max: 4 * GIB, unreported: 512 * MIB }),
  /** Decoded dense chunk blocks shared by the genes of one chunk strip. */
  decodedBlocks: Object.freeze({ share: 1 / 32, min: 64 * MIB, max: 2 * GIB, unreported: 256 * MIB }),
  /** A gene-column index held in memory before it spills to disk. */
  columnIndex: Object.freeze({ share: 1 / 4, min: 256 * MIB, max: 16 * GIB, unreported: GIB }),
  /** Earlier selection steps a highlight tool can undo to (every tool together). */
  undoHistory: Object.freeze({ share: 1 / 32, min: 64 * MIB, max: 2 * GIB, unreported: 256 * MIB }),
});

/**
 * The device memory the browser reports, in bytes.
 *
 * @param {Object} [environment] - `globalThis`, or a stand-in in tests
 * @returns {{bytes: number|null, source: 'deviceMemory'|'jsHeapSizeLimit'|'unreported'}}
 */
export function reportedDeviceMemory(environment = globalThis) {
  const deviceMemory = environment?.navigator?.deviceMemory;
  if (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory > 0) {
    return { bytes: Math.floor(deviceMemory * GIB), source: 'deviceMemory' };
  }
  // The heap limit is a quarter to a half of the device on Chromium; twice
  // it is a conservative estimate of the device.
  const heapLimit = environment?.performance?.memory?.jsHeapSizeLimit;
  if (typeof heapLimit === 'number' && Number.isFinite(heapLimit) && heapLimit > 0) {
    return { bytes: Math.floor(heapLimit * 2), source: 'jsHeapSizeLimit' };
  }
  return { bytes: null, source: 'unreported' };
}

/**
 * One residency budget in bytes.
 *
 * @param {keyof typeof RESIDENCY_SHARES} name
 * @param {Object} [environment]
 * @returns {number}
 */
export function residencyBudgetBytes(name, environment = globalThis) {
  const policy = RESIDENCY_SHARES[name];
  if (policy === undefined) {
    throw new TypeError(`Unknown residency budget '${String(name)}'`);
  }
  const { bytes } = reportedDeviceMemory(environment);
  // A browser that reports nothing keeps the budget the app has always used.
  if (bytes === null) return policy.unreported;
  return Math.floor(Math.min(policy.max, Math.max(policy.min, bytes * policy.share)));
}
