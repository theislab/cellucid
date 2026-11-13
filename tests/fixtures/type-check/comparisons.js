// Comparisons and conditions with one possible outcome.
import { K } from './exports.js';

/** @type {'a'|'b'} */
const letter = 'a';

export const never = letter === 'c'; // expect TS2367
export const notANumber = K === NaN; // expect TS2845
export const freshArray = K === []; // expect TS2839 TS2367
