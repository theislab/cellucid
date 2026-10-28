/**
 * A subsample in a link (`assets/js/app/subsample-url.js`): parsed strictly,
 * written so it reproduces the exact cells (count, method, seed, the
 * method's settings, never the cells), and carried by a shared link.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSubsampleUrlParameters, subsampleLink, subsampleUrlEntries } from '../assets/js/app/subsample-url.js';
import { readDataSourceUrlParameters } from '../assets/js/app/url-state.js';
import { keptChunkShare } from '../assets/js/data/anndata/views/cell-subset.js';

const parse = query => parseSubsampleUrlParameters(new URLSearchParams(query));

test('no subsample parameter is no request', () => {
  assert.equal(parse('data=gh:a/b&dataset=x'), null);
});

test('shares, counts and every method parse to the exact request', () => {
  // No method or seed named: left unset, for the file's default.
  assert.deepEqual({ ...parse('cells=10%') }, { mode: 'subsample', percent: '10', strict: true });
  assert.deepEqual({ ...parse('cells=250000&sample=uniform&seed=7') }, { mode: 'subsample', method: 'uniform', k: 250000, seed: 7, strict: true });
  assert.deepEqual({ ...parse('cells=0.5%&sample=blocks&block=64') }, { mode: 'subsample', method: 'blocks', percent: '0.5', blockSize: 64, strict: true });
  assert.throws(() => parse('cells=10%&block=64'), /needs "sample"/);
  assert.deepEqual({ ...parse('cells=1000&sample=stratified&by=cell_type&alloc=balanced&min=3&seed=4294967295') },
    { mode: 'subsample', method: 'stratified', k: 1000, seed: 4294967295, field: 'cell_type', allocation: 'balanced', minPerCategory: 3, strict: true });
  assert.deepEqual({ ...parse('cells=5%&sample=spatial&embedding=X_umap&grid=16') },
    { mode: 'subsample', method: 'spatial', percent: '5', embedding: 'X_umap', gridSize: 16, strict: true });
  assert.deepEqual({ ...parse('cells=100%') }, { mode: 'all' });
  assert.deepEqual({ ...parse('cells=2') }, { mode: 'subsample', k: 2, strict: true });
});

test('malformed values and misplaced parameters are refused by name', () => {
  for (const [query, pattern] of [
    ['sample=uniform', /needs "cells"/],
    ['cells=0%', /above 0%/],
    ['cells=120%', /at most 100%/],
    ['cells=ten', /share \(10%\) or a count/],
    // One cell has no coordinate variation to draw (`FEWEST_OPEN_CELLS`):
    // the fewest a link opens is 2, refused with that reason.
    ['cells=0', /at least 2: one cell has no coordinate variation to draw; got "0"/],
    ['cells=1', /at least 2: one cell has no coordinate variation to draw; got "1"/],
    ['cells=4294967296', /from 2 to 4294967295/],
    ['cells=10%&sample=random', /"sample" must be/],
    ['cells=10%&seed=-1', /"seed" must be a whole number/],
    ['cells=10%&seed=4294967296', /"seed"/],
    ['cells=10%&sample=uniform&by=x', /"by" is not a parameter of sample=uniform/],
    ['cells=10%&sample=stratified', /needs "by"/],
    ['cells=10%&sample=stratified&by=x&alloc=even', /"alloc" must be/],
    ['cells=10%&cells=20%', /given 2 times/],
    ['cells=100%&sample=uniform', /takes no other parameter/],
    ['cells=', /must have a value/],
  ]) {
    assert.throws(() => parse(query), pattern, query);
  }
});

test('a subsample is written as the parameters that reproduce it, and a link carries them', () => {
  const spec = { method: 'stratified', nObs: 5000, k: 500, seed: 3, field: 'sample', allocation: 'balanced', minPerCategory: 0 };
  const entries = subsampleUrlEntries(spec);
  assert.deepEqual(entries, [['cells', '500'], ['sample', 'stratified'], ['seed', '3'], ['by', 'sample'], ['alloc', 'balanced']]);
  const request = parseSubsampleUrlParameters(new URLSearchParams(entries));
  assert.deepEqual({ ...request }, { mode: 'subsample', method: 'stratified', k: 500, seed: 3, field: 'sample', allocation: 'balanced', strict: true });
  const link = subsampleLink('https://www.cellucid.com/?data=gh%3Aa%2Fb&theme=dark', new URLSearchParams('data=gh:a/b'), spec);
  assert.equal(link, 'https://www.cellucid.com/?data=gh%3Aa%2Fb&cells=500&sample=stratified&seed=3&by=sample&alloc=balanced');
  const shared = readDataSourceUrlParameters(`${link}&theme=dark`);
  assert.equal(shared.get('cells'), '500');
  assert.equal(shared.get('by'), 'sample');
  assert.equal(shared.get('theme'), null);
  const blocks = subsampleUrlEntries({ method: 'blocks', nObs: 10, k: 4, seed: 0, blockSize: 2 });
  assert.deepEqual(blocks, [['cells', '4'], ['sample', 'blocks'], ['seed', '0'], ['block', '2']]);
});

test('the share of a cell-major matrix a subsample reads is the share of its chunks its rows lie in', () => {
  // 10 rows of 3 entries, chunks of 6 entries (2 rows each).
  const pointers = Float64Array.from({ length: 11 }, (_, i) => 3 * i);
  assert.equal(keptChunkShare(pointers, Uint32Array.from([0, 1]), 6), 1 / 5);
  assert.equal(keptChunkShare(pointers, Uint32Array.from([0, 2, 4, 6, 8]), 6), 1);
  assert.equal(keptChunkShare(pointers, Uint32Array.from([1, 2]), 6), 2 / 5);
});
