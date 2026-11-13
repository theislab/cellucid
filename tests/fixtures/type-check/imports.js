// Imports of what a module does not export, and of a module that is not there.
import { gone } from './exports.js'; // expect TS2305
import absent from './absent.js'; // expect TS2307

/** @type {import('./exports.js').Nope} */ // expect TS2694
export const typed = null;

export const used = [gone, absent];
