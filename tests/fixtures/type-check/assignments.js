// An assignment to a constant and to an import.
import { K } from './exports.js';

const fixed = 1;
fixed = 2; // expect TS2588
K = 3; // expect TS2632

export const kept = [fixed, K];
