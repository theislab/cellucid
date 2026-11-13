// A call with more arguments than the function takes, and with fewer than its JSDoc requires.
import { two } from './exports.js';

/**
 * @param {number} a
 * @param {number} b
 */
function both(a, b) {
  return a + b;
}

export const surplus = two(1, 2, 3); // expect TS2554
export const short = both(1); // expect TS2554
