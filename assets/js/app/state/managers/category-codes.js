/**
 * @fileoverview Validation of categorical codes against their inventory.
 *
 * Coloring, visibility and filtering each prove that every code of a field
 * names a category or is the dtype's missing value. A field's codes are never
 * written in place once published — a changed field gets a new array — so one
 * proof per array and category count holds for as long as the array does,
 * instead of rescanning every cell on every field switch.
 *
 * @module state/managers/category-codes
 */

import { missingCategoryCode } from '../../../data/categorical-storage-contract.js';

const PROVEN_CATEGORY_COUNTS = new WeakMap();

/**
 * @param {Uint8Array|Uint16Array} codes
 * @param {number} categoryCount
 * @param {(index: number) => string} describeInvalid Message for the first
 *   code outside the inventory.
 */
export function requireCategoryCodesInInventory(codes, categoryCount, describeInvalid) {
  if (PROVEN_CATEGORY_COUNTS.get(codes) === categoryCount) return;
  const missingCode = missingCategoryCode(codes);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code >= categoryCount && code !== missingCode) {
      throw new RangeError(describeInvalid(index));
    }
  }
  PROVEN_CATEGORY_COUNTS.set(codes, categoryCount);
}
