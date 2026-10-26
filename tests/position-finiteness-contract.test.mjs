// Coordinates must be finite before anything normalizes them.
//
// `normalizePositions()` derives one centre and one scale from a whole
// embedding buffer, so a non-finite coordinate is never contained to the cell
// that carries it:
//
//   * one NaN x  -> that cell's x stays NaN through the affine transform. The
//                   cell disappears from the view while it still counts in
//                   every legend total, category count, and analysis.
//   * one +Inf x -> maxX becomes Infinity, so scale is 2/Infinity = 0 and
//                   centerX is Infinity. Every finite x becomes (x - Inf) * 0
//                   = NaN and every y/z becomes 0: the entire embedding
//                   collapses onto a degenerate line, silently.
//
// The AnnData adapter refuses a non-finite coordinate where an embedding is
// read (anndata-reader-contract), and the in-memory DimensionManager and the
// viewer at theirs. Coordinates are measured data: a bad payload is refused,
// never dropped, clamped, or imputed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePositions } from '../assets/js/rendering/gl-utils.js';

test('the collapse this guard prevents is real, not hypothetical', () => {
  // Executed against the real normalizePositions so the invariant is anchored
  // to observed behaviour rather than to a claim about it.
  const oneNaN = new Float32Array([0, 0, 0, Number.NaN, 1, 1, 2, 2, 2]);
  normalizePositions(oneNaN);
  assert.equal(Number.isNaN(oneNaN[3]), true, 'the NaN cell vanishes');
  assert.equal(
    [oneNaN[0], oneNaN[6]].every(Number.isFinite),
    true,
    'while its neighbours keep plausible finite coordinates'
  );

  const oneInfinity = new Float32Array([0, 0, 0, Infinity, 1, 1, 2, 2, 2]);
  const transform = normalizePositions(oneInfinity);
  assert.equal(transform.scale, 0, 'one Infinity zeroes the shared scale');
  assert.equal(
    [oneInfinity[0], oneInfinity[3], oneInfinity[6]].every(Number.isNaN),
    true,
    'every cell loses its x, not just the one that carried the Infinity'
  );
  assert.equal(
    [oneInfinity[1], oneInfinity[2], oneInfinity[7], oneInfinity[8]]
      .every(value => value === 0),
    true,
    'and the embedding collapses onto a degenerate line'
  );
});

test('a published positions array is proven finite once: a switch back to it scans nothing', async () => {
  const { assertFiniteFloat32Array } = await import('../assets/js/rendering/viewer/viewer-contracts.js');
  const positions = new Float32Array([0, 1, 2, 3, 4, 5]);
  assert.strictEqual(assertFiniteFloat32Array(positions, 6, 'Positions'), positions);
  // Published arrays are never written; writing one here shows the proof is
  // remembered rather than re-derived by a fresh O(N) scan.
  positions[3] = Number.NaN;
  assert.strictEqual(assertFiniteFloat32Array(positions, 6, 'Positions'), positions);
  // A new array is scanned.
  assert.throws(
    () => assertFiniteFloat32Array(new Float32Array([0, Number.POSITIVE_INFINITY]), 2, 'Positions'),
    /value 1 must be finite/,
  );
  // The length contract is still checked every time.
  assert.throws(() => assertFiniteFloat32Array(positions, 9, 'Positions'), /exactly 9 values/);
});
