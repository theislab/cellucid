/**
 * The subsampling specification, held to the shared conformance fixture:
 * `tests/fixtures/subsample-conformance.json`, computed in plain Python by
 * `scripts/generate-subsample-conformance.py` (which `--check`s it),
 * independently of `assets/js/data/subsample.js`. cellucid-python and
 * cellucid-r hold byte-identical copies under the same SHA-256.
 *
 * Also: the cell identity (`assets/js/data/cell-identity.js`) — positions
 * both ways, the digest, the session encoding — and the properties every
 * implementation must keep beyond the fixture's cases: nesting, exact sizes,
 * refusals.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  allocate,
  countFromFraction,
  countFromShare,
  priorityOrder,
  rankOf,
  requireSubsampleSpec,
  subsampleBlocks,
  subsampleSpatial,
  subsampleStratified,
  subsampleUniform,
} from '../assets/js/data/subsample.js';
import {
  cellSetDigest,
  createCellIdentity,
  decodeCellSet,
  encodeCellSet,
} from '../assets/js/data/cell-identity.js';

const FIXTURE_BYTES = await readFile(new URL('./fixtures/subsample-conformance.json', import.meta.url));
const FIXTURE_SHA256 = 'a805a302a88e77e0c7e07e998811ce79825b5a34890db79a9462e801ab84a60d';
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8'));

function run(item) {
  switch (item.method) {
    case 'uniform': return subsampleUniform(item.nObs, item.k, item.seed);
    case 'blocks': return subsampleBlocks(item.nObs, item.k, item.seed, item.blockSize);
    case 'stratified':
      // A null code is NaN: no category.
      return subsampleStratified(Float64Array.from(item.codes, code => (code === null ? Number.NaN : code)), item.nCategories, item.k, item.seed, {
        allocation: item.allocation,
        minPerCategory: item.minPerCategory,
      });
    case 'spatial':
      return subsampleSpatial(Float32Array.from(item.coordinates, value => (value === null ? Number.NaN : Number(value))),
        item.dimensions, item.k, item.seed, { gridSize: item.gridSize });
    default: throw new Error(`unknown method ${item.method}`);
  }
}

test('the fixture is the pinned one', () => {
  assert.equal(createHash('sha256').update(FIXTURE_BYTES).digest('hex'), FIXTURE_SHA256);
  assert.equal(FIXTURE.version, 1);
});

test('ranks and sizes are the specification\'s', () => {
  for (const { seed, positions, ranks } of FIXTURE.rank) {
    assert.deepEqual(positions.map(position => rankOf(seed, position)), ranks, `seed ${seed}`);
  }
  for (const { percent, nObs, k } of FIXTURE.percent) {
    assert.equal(countFromShare(percent, nObs, { percent: true }), k, `${percent} % of ${nObs}`);
  }
  for (const item of FIXTURE.refusals) {
    assert.throws(() => run(item), /cannot hold/, item.name);
  }
  for (const { fraction, nObs, k } of FIXTURE.fraction) {
    assert.equal(countFromFraction(fraction, nObs), k, `${fraction} of ${nObs}`);
  }
});

test('every case keeps the cells the fixture lists, with its digest', () => {
  for (const item of FIXTURE.cases) {
    const kept = run(item);
    if (item.kept === null) {
      assert.equal(kept, null, item.name);
    } else if (item.kept !== undefined) {
      assert.deepEqual(Array.from(kept), item.kept, item.name);
    } else {
      assert.equal(kept.length, item.keptCount, item.name);
      assert.deepEqual(Array.from(kept.subarray(0, 8)), item.keptHead, item.name);
      assert.deepEqual(Array.from(kept.subarray(kept.length - 8)), item.keptTail, item.name);
    }
    assert.equal(cellSetDigest(item.nObs, kept), item.digest, `${item.name}: digest`);
    if (kept === null) continue;
    // The order its cells are opened in (and a session's per-cell state is in).
    const order = priorityOrder(requireSubsampleSpec(specOf(item)), kept);
    if (item.order !== undefined) {
      assert.deepEqual(Array.from(order), item.order, `${item.name}: priority order`);
    } else {
      assert.deepEqual(Array.from(order.subarray(0, 8)), item.orderHead, `${item.name}: priority order`);
      assert.deepEqual(Array.from(order.subarray(order.length - 8)), item.orderTail, `${item.name}: priority order`);
    }
  }
});

/** A fixture case's request as a specification (its method's own settings, inputs left out). */
function specOf(item) {
  const spec = { method: item.method, nObs: item.nObs, k: item.k, seed: item.seed };
  if (item.method === 'blocks') spec.blockSize = item.blockSize;
  if (item.method === 'stratified') Object.assign(spec, { field: 'cluster', allocation: item.allocation, minPerCategory: item.minPerCategory });
  if (item.method === 'spatial') Object.assign(spec, { embedding: 'X_umap', columns: Array.from({ length: item.dimensions }, (_, c) => c), gridSize: item.gridSize });
  return spec;
}

test('the first m cells of a priority order are the subsample of size m (uniform, blocks), and orders are permutations', () => {
  for (const [method, extra] of [['uniform', {}], ['blocks', { blockSize: 37 }]]) {
    for (const seed of [0, 11, 0xffffffff]) {
      const k = 3000;
      const spec = requireSubsampleSpec({ method, nObs: 5000, k, seed, ...extra });
      const kept = method === 'uniform' ? subsampleUniform(5000, k, seed) : subsampleBlocks(5000, k, seed, 37);
      const order = priorityOrder(spec, kept);
      assert.deepEqual(Array.from(order).sort((a, b) => a - b), Array.from(kept));
      for (const m of [1, 36, 37, 38, 999, 2999]) {
        const smaller = method === 'uniform' ? subsampleUniform(5000, m, seed) : subsampleBlocks(5000, m, seed, 37);
        assert.deepEqual(Array.from(order.subarray(0, m)).sort((a, b) => a - b), Array.from(smaller), `${method} seed ${seed} m ${m}`);
      }
    }
  }
});

test('the session encoding of a cell set is the fixture\'s', () => {
  for (const { nObs, kept, bytesHex, digest } of FIXTURE.encoding) {
    const identity = createCellIdentity({ nObs, kept: kept === null ? null : Uint32Array.from(kept) });
    assert.equal(Buffer.from(encodeCellSet(identity)).toString('hex'), bytesHex);
    assert.equal(identity.digest, digest);
    const decoded = decodeCellSet(Uint8Array.from(Buffer.from(bytesHex, 'hex')), nObs);
    assert.deepEqual(decoded.kept === null ? null : Array.from(decoded.kept), kept);
  }
});

test('uniform and blocks are nested: a smaller subsample is inside a larger one of the same seed', () => {
  for (const seed of [0, 7, 0xffffffff]) {
    let previous = null;
    for (const k of [1, 10, 100, 999, 4000]) {
      const kept = new Set(subsampleUniform(5000, k, seed));
      if (previous !== null) for (const p of previous) assert.ok(kept.has(p));
      previous = kept;
    }
    previous = null;
    for (const k of [3, 50, 600, 4999]) {
      const kept = new Set(subsampleBlocks(5000, k, seed, 37));
      if (previous !== null) for (const p of previous) assert.ok(kept.has(p));
      previous = kept;
    }
  }
});

test('every method keeps exactly k ascending cells, and every cell from k = n on', () => {
  const codes = Int32Array.from({ length: 700 }, (_, i) => (i % 11 === 0 ? -1 : i % 5));
  const coordinates = Float32Array.from({ length: 1400 }, (_, i) => Math.sin(i) * 10);
  for (const k of [1, 2, 350, 699]) {
    for (const kept of [
      subsampleUniform(700, k, 3),
      subsampleBlocks(700, k, 3, 13),
      subsampleStratified(codes, 5, k, 3, { allocation: 'balanced' }),
      subsampleStratified(codes, 5, k, 3, { allocation: 'proportional' }),
      subsampleSpatial(coordinates, 2, k, 3, { gridSize: 6 }),
    ]) {
      assert.equal(kept.length, k);
      for (let i = 1; i < kept.length; i++) assert.ok(kept[i] > kept[i - 1]);
    }
  }
  assert.equal(subsampleUniform(700, 700, 1), null);
  assert.equal(subsampleBlocks(700, 900, 1, 4), null);
});

test('allocations are exact and within every stratum', () => {
  const capacity = Float64Array.from([5, 100, 3, 50, 0x7fffffff]);
  for (const total of [0, 1, 7, 158, 1000, 2 ** 31]) {
    for (const allocation of ['proportional', 'balanced']) {
      const out = allocate(capacity, total, allocation);
      assert.equal(out.reduce((a, b) => a + b, 0), total, `${allocation} ${total}`);
      out.forEach((value, s) => assert.ok(value >= 0 && value <= capacity[s]));
    }
  }
});

test('requests outside the specification are refused', () => {
  assert.throws(() => subsampleUniform(10, 0, 1), /at least|\[1,/);
  assert.throws(() => subsampleUniform(10, 3, -1), /seed/);
  assert.throws(() => subsampleUniform(10, 3, 2 ** 32), /seed/);
  assert.throws(() => countFromFraction(0, 10), /fraction/);
  assert.throws(() => countFromFraction(1.5, 10), /fraction/);
  assert.throws(() => subsampleStratified(Int32Array.from([0, 1, 5]), 3, 1, 0), /outside/);
  assert.throws(() => subsampleStratified(Int32Array.from([0, 1, 2, 0]), 3, 2, 0, { minPerCategory: 1 }), /cannot hold/);
  assert.throws(() => requireSubsampleSpec({ method: 'uniform', nObs: 10, k: 10, seed: 0 }), /no subsample/);
  assert.throws(() => requireSubsampleSpec({ method: 'blocks', nObs: 10, k: 3, seed: 0 }), /blockSize/);
  assert.throws(() => requireSubsampleSpec({ method: 'uniform', nObs: 10, k: 3, seed: 0, extra: 1 }), /no 'extra'/);
});

test('a cell identity names cells both ways and counts the ones not open', () => {
  const identity = createCellIdentity({ nObs: 10, kept: Uint32Array.from([1, 4, 5, 9]) });
  assert.equal(identity.n, 4);
  assert.equal(identity.nOriginal, 10);
  assert.equal(identity.isSubset, true);
  assert.deepEqual(Array.from(identity.toOriginal([0, 3, 2])), [1, 9, 5]);
  // The open ones, as a cell list (ascending).
  const back = identity.fromOriginal([9, 0, 4, 3, 1]);
  assert.deepEqual(Array.from(back.positions), [0, 1, 3]);
  assert.equal(back.dropped, 2);
  assert.throws(() => identity.toOriginal([4]), /outside/);
  assert.throws(() => identity.fromOriginal([10]), /outside/);
  const all = createCellIdentity({ nObs: 5, kept: Uint32Array.from([0, 1, 2, 3, 4]) });
  assert.equal(all.isSubset, false);
  assert.equal(all.kept, null);
  assert.equal(all.digest, cellSetDigest(5, null));
  assert.throws(() => createCellIdentity({ nObs: 5, kept: Uint32Array.from([2, 1]) }), /ascending/);
  assert.throws(() => createCellIdentity({ nObs: 5, kept: new Uint32Array(0) }), /at least one/);
});
