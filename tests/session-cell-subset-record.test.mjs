/**
 * A session saved on a subsample records which cells were open
 * (`app/session/cell-subset-record.js`): the specification, the cells
 * themselves (the cell-set encoding, base64) and their digest. A session
 * saved on every cell records nothing. The record is checked as untrusted
 * input: every key, the encoding, the count against the specification, the
 * digest against the cells.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { captureCellSubsetRecord, decodeCellSubsetRecord } from '../assets/js/app/session/cell-subset-record.js';
import { cellSetDigest } from '../assets/js/data/cell-identity.js';
import { subsampleBlocks } from '../assets/js/data/subsample.js';

function managerWith(subset) {
  const annData = { getCellSubset: () => subset };
  const source = { getAnnDataSource: id => (id === 'atlas' ? annData : null) };
  return {
    getCurrentSourceType: () => 'local-user',
    getCurrentDatasetId: () => 'atlas',
    getSource: type => (type === 'local-user' ? source : null),
  };
}

const SPEC = Object.freeze({ method: 'blocks', nObs: 100000, k: 12345, seed: 9, blockSize: 64 });
const KEPT = subsampleBlocks(SPEC.nObs, SPEC.k, SPEC.seed, SPEC.blockSize);

test('a subsample is recorded and read back exactly', () => {
  const record = captureCellSubsetRecord(managerWith({ nObs: SPEC.nObs, kept: KEPT, spec: SPEC }));
  assert.deepEqual(Object.keys(record).sort(), ['digest', 'kept', 'spec']);
  assert.equal(record.digest, cellSetDigest(SPEC.nObs, KEPT));
  // Neighbouring cells encode as one byte each: blocks of 64 at 12 % cost about 1.2 bytes a cell.
  assert.ok(Buffer.from(record.kept, 'base64').length < SPEC.k * 1.3);
  const decoded = decodeCellSubsetRecord(JSON.parse(JSON.stringify(record)), 'cells');
  assert.deepEqual(decoded.kept, KEPT);
  assert.deepEqual({ ...decoded.spec }, SPEC);
});

test('every cell open, or nothing open, records nothing', () => {
  assert.equal(captureCellSubsetRecord(managerWith({ nObs: 10, kept: null, spec: null })), null);
  assert.equal(captureCellSubsetRecord(managerWith(null)), null);
  assert.equal(captureCellSubsetRecord(null), null);
});

test('a malformed record is refused', () => {
  const record = captureCellSubsetRecord(managerWith({ nObs: SPEC.nObs, kept: KEPT, spec: SPEC }));
  assert.throws(() => decodeCellSubsetRecord({ ...record, extra: 1 }, 'cells'), /extra|exactly/);
  assert.throws(() => decodeCellSubsetRecord({ ...record, digest: '0'.repeat(16) }, 'cells'), /digest/);
  assert.throws(() => decodeCellSubsetRecord({ ...record, spec: { ...SPEC, k: SPEC.k + 1 } }, 'cells'), /specification keeps/);
  assert.throws(() => decodeCellSubsetRecord({ ...record, kept: '!!' }, 'cells'), /base64/);
  assert.throws(() => decodeCellSubsetRecord({ ...record, spec: { ...SPEC, nObs: 10 } }, 'cells'), /beyond|no subsample/);
});
