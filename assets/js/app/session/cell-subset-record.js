/**
 * Which of a dataset's cells a session was saved on, recorded in the session
 * manifest as `cells` when they were a subsample (`data/subsample.js`); a
 * manifest without `cells` was saved on every cell.
 *
 *     cells: {
 *       spec:   the subsample specification (method, nObs, k, seed, and the
 *               method's own: blockSize; field, allocation, minPerCategory;
 *               embedding, columns, gridSize),
 *       kept:   the kept original positions, encoded as the cell-set bytes
 *               (`encodeCellSet`: LEB128 gaps) in base64,
 *       digest: the cell-set digest of those positions (`cellSetDigest`)
 *     }
 *
 * Loading a session opens its dataset with exactly these cells (a dataset
 * open with other cells is read again first, `session-controls.js`). Every
 * per-cell chunk of the session — highlights, labels — names these cells by
 * original position, ascending (cell `i` is `kept[i]`,
 * `session-cell-order.js`), whatever order they were open in, and its
 * fingerprint (cell count, cell-order digest) matches. The recorded set is the truth; the
 * specification says how it was made and whether it still reproduces.
 *
 * @module session/cell-subset-record
 */

import { cellSetDigest, createCellIdentity, decodeCellSet, encodeCellSet } from '../../data/cell-identity.js';
import { requireSubsampleSpec } from '../../data/subsample.js';
import { requireExactKeys, requirePlainRecord } from '../../utils/exact-record.js';
import { formatCountOf } from '../../utils/format-units.js';

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The record of the open dataset's cells, or null when every cell is open
 * (or nothing names them).
 *
 * @param {object|null} dataSourceManager
 * @returns {{spec: object, kept: string, digest: string}|null}
 */
export function captureCellSubsetRecord(dataSourceManager) {
  if (dataSourceManager === null) return null;
  const sourceType = dataSourceManager.getCurrentSourceType?.() ?? null;
  const datasetId = dataSourceManager.getCurrentDatasetId?.() ?? null;
  if (sourceType === null || datasetId === null) return null;
  const source = dataSourceManager.getSource?.(sourceType) ?? null;
  const annData = typeof source?.getAnnDataSource === 'function' ? source.getAnnDataSource(datasetId) : null;
  const subset = annData?.getCellSubset?.() ?? null;
  if (subset === null || subset.kept === null) return null;
  const identity = createCellIdentity({ nObs: subset.nObs, kept: subset.kept });
  return {
    spec: { ...subset.spec, ...(subset.spec.columns ? { columns: [...subset.spec.columns] } : {}) },
    kept: toBase64(encodeCellSet(identity)),
    digest: identity.digest,
  };
}

/**
 * Check a recorded `cells` (untrusted input) and decode it.
 *
 * @param {unknown} value
 * @param {string} context
 * @returns {{spec: Readonly<object>, kept: Uint32Array, digest: string}}
 */
export function decodeCellSubsetRecord(value, context) {
  requirePlainRecord(value, context);
  requireExactKeys(value, ['spec', 'kept', 'digest'], context);
  const spec = requireSubsampleSpec(value.spec);
  if (typeof value.kept !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.kept)) {
    throw new TypeError(`${context} kept must be base64 text.`);
  }
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{16}$/.test(value.digest)) {
    throw new TypeError(`${context} digest must be 16 lowercase hex digits.`);
  }
  const identity = decodeCellSet(fromBase64(value.kept), spec.nObs);
  if (identity.n !== spec.k) {
    throw new TypeError(`${context} lists ${formatCountOf(identity.n, 'cell')}; its specification keeps ${spec.k}.`);
  }
  if (cellSetDigest(spec.nObs, identity.kept) !== value.digest) {
    throw new TypeError(`${context} digest does not match its cells.`);
  }
  return { spec, kept: identity.kept, digest: value.digest };
}
