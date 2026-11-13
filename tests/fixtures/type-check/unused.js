// An import and a local nothing reads.
import { two } from './exports.js'; // expect TS6133

export function compute() {
  const forgotten = 1; // expect TS6133
  return 2;
}
