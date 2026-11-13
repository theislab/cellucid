/**
 * @fileoverview The consensus column of an annotated categorical column,
 * derived category for category (pure; the `field.consensus` action's).
 *
 * Each category of the annotated column has one outcome: an agreed label
 * (`consensus`), `disputed` or `pending` (a category with no outcome is
 * pending). A cell takes the outcome of its category; a cell with no
 * category is pending. The column's categories are the agreed labels, in
 * the order of the categories they agree for, then the statuses that occur.
 *
 * Agreed labels are one category when they are one label by the rule
 * suggestions are bundled by (`exactLabelForCompare`: Unicode NFC, nothing
 * folded); the category is named as the first category agreeing on it spells
 * it.
 *
 * A status is its own category, never an agreed label: a label agreed as
 * literally "Pending" or "Disputed" keeps its own category, and the status
 * then takes a name no label has ("Pending (status)", "Pending (status 2)",
 * …), so the two never merge.
 *
 * @module app/community-annotations/consensus-codes
 */

import { categoricalStorageForCount, isCategoricalCodes, missingCategoryCode } from '../../data/categorical-storage-contract.js';
import { exactLabelForCompare } from './wire-contract.js';

/** The categories a status is shown as, unless an agreed label already has that name. */
const CONSENSUS_STATUS_NAMES = Object.freeze({ disputed: 'Disputed', pending: 'Pending' });

/**
 * The category name of a status, beside the agreed labels `labels`.
 * @param {'disputed'|'pending'} status
 * @param {Set<string>} labels - the agreed labels, each as `exactLabelForCompare` gives it
 */
export function statusCategoryName(status, labels) {
  const base = CONSENSUS_STATUS_NAMES[status];
  let name = base;
  for (let n = 1; labels.has(exactLabelForCompare(name)); n++) name = n === 1 ? `${base} (status)` : `${base} (status ${n})`;
  return name;
}

/**
 * The consensus column's categories and codes.
 *
 * @param {{outcomes: Array<{status: 'consensus'|'disputed'|'pending', label: string|null}|null>, codes: ArrayLike<number>}} input -
 *   `outcomes`: one per category of the annotated column, in its order (null: pending);
 *   `codes`: its codes on the open cells
 * @returns {{categories: string[], codes: Uint8Array|Uint16Array|Uint32Array}}
 */
export function consensusColumnOf({ outcomes, codes }) {
  if (!Array.isArray(outcomes) || codes === null || typeof codes?.length !== 'number') {
    throw new TypeError('A consensus column needs the outcome of each category and the codes of the cells');
  }
  const k = outcomes.length;
  const missingSourceCode = isCategoricalCodes(codes) ? missingCategoryCode(codes) : null;
  const labels = [];
  const labelIndex = new Map();
  for (const outcome of outcomes) {
    if (outcome?.status !== 'consensus') continue;
    const key = exactLabelForCompare(outcome.label);
    if (!labelIndex.has(key)) {
      labelIndex.set(key, labels.length);
      labels.push(outcome.label);
    }
  }
  const labelSet = new Set(labelIndex.keys());
  const categories = [...labels];
  const statusIndex = { disputed: -1, pending: -1 };
  const statusOf = status => {
    if (statusIndex[status] === -1) {
      statusIndex[status] = categories.length;
      categories.push(statusCategoryName(status, labelSet));
    }
    return statusIndex[status];
  };
  // Statuses in a fixed order (Disputed, then Pending), whatever order the categories come in.
  if (outcomes.some(outcome => outcome?.status === 'disputed')) statusOf('disputed');
  if (outcomes.some(outcome => outcome === null || outcome.status === 'pending')) statusOf('pending');
  const map = new Int32Array(k);
  outcomes.forEach((outcome, index) => {
    map[index] = outcome?.status === 'consensus' ? labelIndex.get(exactLabelForCompare(outcome.label)) : statusOf(outcome?.status ?? 'pending');
  });
  // A cell with no category is pending: "Pending" is added only when some cell needs it.
  let pendingForMissing = -1;
  if (missingSourceCode !== null) {
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === missingSourceCode) {
        pendingForMissing = statusOf('pending');
        break;
      }
    }
  }
  // The width follows the final inventory (`categorical-storage-contract.js` owns where it changes).
  const storage = categoricalStorageForCount(categories.length, 'Community consensus column');
  const out = new storage.TypedArrayClass(codes.length);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (missingSourceCode !== null && code === missingSourceCode) {
      out[i] = pendingForMissing;
      continue;
    }
    if (!Number.isInteger(code) || code < 0 || code >= k) {
      throw new RangeError(`The code of cell ${i} is outside the annotated column's categories`);
    }
    out[i] = map[code];
  }
  return { categories, codes: out };
}
