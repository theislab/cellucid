// A JSDoc that does not match its function.

/**
 * @param {number} renamed // expect TS8024
 */
export function one(value) {
  return value;
}

/**
 * @param {number} [first]
 * @param {number} second
 */
export function ordered(first, second) { // expect TS1016
  return first + second;
}

/**
 * @returns {number} // expect TS1064
 */
export async function later() {
  return 1;
}
