/**
 * The page's residency count (`state/managers/field/residency.js`) is asked
 * on every memory report — each worker report, each working-set change — so
 * its work is the views times the cached keys, never the inventories' length
 * (a 30,000-gene inventory walked whole on every report would cost about a
 * second of the page's main thread per markers run at 10M cells; measured:
 * 27_decisions_memory_model.md). The answer stays the full
 * walk's, bit for bit, through every change that moves a field in or out of
 * use.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inactiveFieldBytes,
  indexedFieldCount,
  releaseInactiveFieldsOverBudget,
} from '../assets/js/app/state/managers/field/residency.js';
import { hasCategoryFilter, hasOutlierFilter, hasRangeFilter } from '../assets/js/app/state/managers/filter-manager.js';

const GENES = 30_000;

/** The full walk the count must equal: every field of every view. */
function referenceInactiveBytes(state) {
  const key = (field, index) => field._originalKey || field.key || String(index);
  const filtered = field => {
    const kept = { ...field, _isDeleted: false };
    return kept.kind === 'category' ? hasCategoryFilter(kept) || hasOutlierFilter(kept) : hasRangeFilter(kept);
  };
  // A user's own arrays exist nowhere else; only a copy of a file's continuous column is read again.
  const ownArrays = field => field._isUserDefined === true && !(field.kind === 'continuous' && typeof field._sourceField?.sourceKey === 'string');
  const views = [state];
  for (const ctx of state.viewContexts?.values?.() ?? []) {
    if (ctx.obsData === state.obsData && ctx.varData === state.varData) continue;
    views.push(ctx);
  }
  const inUse = { obs: new Set(), var: new Set() };
  for (const view of views) {
    for (const source of ['obs', 'var']) {
      const fields = (source === 'obs' ? view.obsData : view.varData)?.fields ?? [];
      const active = view.activeFieldSource === source
        ? (source === 'obs' ? view.activeFieldIndex : view.activeVarFieldIndex) : -1;
      fields.forEach((field, index) => {
        if (index === active || field._loadingPromise || filtered(field) || ownArrays(field)) inUse[source].add(key(field, index));
        if (field.loaded === true && typeof field._sourceField?.sourceKey === 'string') inUse[source].add(field._sourceField.sourceKey);
      });
    }
  }
  const buffersOf = entry => [entry.values, entry.codes, entry.outlierQuantiles]
    .filter(array => ArrayBuffer.isView(array)).map(array => array.buffer);
  const caches = [['obs', state._fieldDataCache], ['var', state._varFieldDataCache]];
  const pinned = new Set();
  for (const [source, cache] of caches) {
    for (const [k, entry] of cache) if (inUse[source].has(k)) buffersOf(entry).forEach(buffer => pinned.add(buffer));
  }
  const counted = new Set();
  for (const [source, cache] of caches) {
    for (const [k, entry] of cache) {
      if (inUse[source].has(k)) continue;
      for (const buffer of buffersOf(entry)) if (!pinned.has(buffer)) counted.add(buffer);
    }
  }
  let bytes = 0;
  for (const buffer of counted) bytes += buffer.byteLength;
  return bytes;
}

/** A state of `GENES` genes and a few obs fields; genes 0..cached-1 loaded and cached. */
function geneState({ cached = 6, reads = null } = {}) {
  const genes = [];
  for (let index = 0; index < GENES; index++) {
    const field = { key: `G${index}`, kind: 'continuous', loaded: false };
    if (reads !== null) {
      let loading = null;
      Object.defineProperty(field, '_loadingPromise', {
        enumerable: true,
        configurable: true,
        get() { reads.count += 1; return loading; },
        set(value) { loading = value; },
      });
    }
    genes.push(field);
  }
  const varCache = new Map();
  for (let index = 0; index < cached; index++) {
    const values = new Float32Array(16 * (index + 1));
    genes[index].values = values;
    genes[index].loaded = true;
    varCache.set(`G${index}`, { values });
  }
  const obs = [
    { key: 'cluster', kind: 'category', loaded: true, codes: new Uint8Array(64), categories: ['a', 'b'] },
    { key: 'score', kind: 'continuous', loaded: true, values: new Float32Array(32) },
  ];
  const obsCache = new Map(obs.map(field => [field.key, field.kind === 'category' ? { codes: field.codes } : { values: field.values }]));
  return {
    obsData: { fields: obs },
    varData: { fields: genes },
    activeFieldSource: 'var',
    activeFieldIndex: -1,
    activeVarFieldIndex: 0,
    _fieldDataCache: obsCache,
    _varFieldDataCache: varCache,
    viewContexts: new Map(),
  };
}

test('a memory report reads the cached genes, not every gene: the inventory is indexed once', () => {
  const reads = { count: 0 };
  const state = geneState({ cached: 6, reads });
  const before = indexedFieldCount();
  inactiveFieldBytes(state);
  assert.equal(indexedFieldCount() - before, GENES + 2, 'the first report indexes each inventory once');
  reads.count = 0;
  for (let report = 0; report < 500; report++) inactiveFieldBytes(state);
  assert.equal(indexedFieldCount() - before, GENES + 2, 'later reports index nothing again');
  // Each report asks the inactive cached genes only (5 of 6: the active one is in use already).
  assert.ok(reads.count <= 500 * 5, `${reads.count} reads of a gene's loading state for 500 reports`);
  assert.equal(inactiveFieldBytes(state), referenceInactiveBytes(state));
});

test('the count equals the full walk through every change that moves a field in or out of use', () => {
  const state = geneState({ cached: 6 });
  const genes = state.varData.fields;
  const check = step => assert.equal(inactiveFieldBytes(state), referenceInactiveBytes(state), step);
  check('opened');

  state.activeVarFieldIndex = 3;
  check('another gene shown');
  genes[1]._continuousStats = { min: 0, max: 4 };
  genes[1]._continuousFilter = { min: 1, max: 4 };
  check('a range filter on a cached gene');
  genes[2]._loadingPromise = Promise.resolve();
  check('a cached gene mid-load');
  genes[2]._loadingPromise = null;
  check('its load ended');
  genes[1]._continuousFilter = { min: 0, max: 4 };
  check('the filter widened to the whole range');

  // A rename keeps the cache key (`_originalKey`).
  genes[4]._originalKey = genes[4].key;
  genes[4].key = 'renamed';
  state.activeVarFieldIndex = 4;
  check('a renamed gene shown');

  // A user-defined alias, appended, shares its source's arrays.
  genes.push({ key: 'alias', kind: 'continuous', loaded: true, values: genes[5].values, _sourceField: { sourceKey: 'G5' } });
  check('an alias of a cached gene added');
  genes[genes.length - 1].loaded = false;
  check('the alias released');
  genes[genes.length - 1]._sourceField = { sourceKey: 'G2' };
  genes[genes.length - 1].loaded = true;
  check('the alias pointed at another gene');

  // A view of its own with copies of the fields sharing the arrays.
  const copies = genes.map(field => ({ ...field }));
  state.viewContexts.set('kept', {
    obsData: { fields: state.obsData.fields.map(field => ({ ...field })) },
    varData: { fields: copies },
    activeFieldSource: 'var',
    activeVarFieldIndex: 0,
    activeFieldIndex: -1,
  });
  check('a kept view shows gene 0');
  copies[5]._continuousStats = { min: 0, max: 1 };
  copies[5]._continuousFilter = { min: 0.5, max: 1 };
  check('a filter in the kept view only');

  // Category state on an obs field shown nowhere.
  state.activeFieldSource = 'var';
  state.obsData.fields[0]._categoryVisible = { a: false, b: true };
  check('a hidden category');

  // The inventory replaced whole (a new gene axis).
  state.varData = { fields: genes.slice() };
  check('the gene inventory replaced');

  // A release lets go of what the full walk says is inactive, every view's copy too.
  const released = releaseInactiveFieldsOverBudget(state, 0);
  assert.ok(released > 0);
  check('after a release');
  assert.equal(state.varData.fields[0].loaded, true, 'the kept view still shows gene 0');
});

test('a release lets go only of what can be read again: a user\'s own arrays and every narrowing filter stay', () => {
  const array = () => new Uint8Array(8);
  const values = () => new Float32Array(8);
  const fields = [
    { key: 'shown once', kind: 'category', loaded: true, codes: array(), categories: ['a', 'b'], _categoryVisible: Uint8Array.of(1, 1), _categoryColors: Uint8Array.of(1, 2, 3, 4, 5, 6) },
    { key: 'hidden', kind: 'category', loaded: true, codes: array(), categories: ['a', 'b'], _categoryVisible: Uint8Array.of(0, 1) },
    { key: 'missing hidden', kind: 'category', loaded: true, codes: array(), categories: ['a', 'b'], _missingVisible: false },
    { key: 'cell count', kind: 'category', loaded: true, codes: array(), categories: ['a', 'b'], _categoryCellLimits: Object.freeze([{ category: 0, count: 2, seed: 1 }]) },
    { key: 'deleted with a filter', kind: 'continuous', loaded: true, values: values(), _isDeleted: true, _continuousStats: { min: 0, max: 1 }, _continuousFilter: { min: 0.5, max: 1 } },
    { key: 'my labels', kind: 'category', loaded: true, codes: array(), categories: ['a', 'b'], _isUserDefined: true, _sourceField: null },
    { key: 'pushed', kind: 'continuous', loaded: true, values: values(), _isUserDefined: true, _sourceField: null },
    { key: 'copy of a column', kind: 'continuous', loaded: true, values: values(), _isUserDefined: true, _sourceField: { sourceKey: 'read again' } },
    { key: 'read again', kind: 'continuous', loaded: true, values: values() },
    { key: 'full range', kind: 'continuous', loaded: true, values: values(), _continuousStats: { min: 0, max: 1 }, _continuousFilter: { min: 0, max: 1 } },
  ];
  const state = {
    obsData: { fields },
    varData: { fields: [] },
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    _fieldDataCache: new Map(fields.map(field => [field.key, field.kind === 'category' ? { codes: field.codes } : { values: field.values }])),
    _varFieldDataCache: new Map(),
  };
  releaseInactiveFieldsOverBudget(state, 0);
  const loaded = Object.fromEntries(fields.map(field => [field.key, field.loaded]));
  assert.deepEqual(loaded, {
    'shown once': false,
    hidden: true,
    'missing hidden': true,
    'cell count': true,
    'deleted with a filter': true,
    'my labels': true,
    pushed: true,
    // A copy of a file's column shares its source's array and reads it again.
    'copy of a column': false,
    'read again': true,
    'full range': false,
  });
  // What was set on it stays; only its arrays went.
  assert.deepEqual(fields[0]._categoryColors, Uint8Array.of(1, 2, 3, 4, 5, 6));
  assert.equal('codes' in fields[0], false);
  assert.deepEqual(fields[9]._continuousFilter, { min: 0, max: 1 });
});
