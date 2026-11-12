/**
 * L18-1 (live pass 5): asked "where are the cells heading … evidence from the
 * data", an agent answered "the tools don't give me the velocity numbers".
 * `vector-field.summary` reads, per category, the speed, alignment, direction
 * and where its arrows lead, from the vectors as drawn in a view's embedding.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVectorFieldReads, headingWords, summarizeFlow } from '../assets/js/app/reads/vector-field.js';
import { MappingLoadError } from '../assets/js/data/data-mapping-candidates.js';
import { SHAPED_INPUTS, SUMMARY_READS } from '../assets/js/app/agent/bridge/data-guard.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { representationName } from '../assets/js/data/representation-names.js';

/** A seeded generator, so every run reads the same cells. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Three groups along x: A in [0, 1), B in [1, 2), C in [2, 3); A and B flow
 * right (B twice as fast), C every way; the last cell has no vector.
 */
function line(n = 300) {
  const next = random(7);
  const positions = new Float32Array(n * 2);
  const vectors = new Float32Array(n * 2);
  const codes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const group = i % 3;
    codes[i] = group;
    positions[i * 2] = group + next();
    positions[i * 2 + 1] = next() * 0.3;
    if (group === 2) {
      const angle = next() * 2 * Math.PI;
      vectors[i * 2] = Math.cos(angle) * 0.05;
      vectors[i * 2 + 1] = Math.sin(angle) * 0.05;
    } else {
      vectors[i * 2] = group === 0 ? 0.05 : 0.1;
      vectors[i * 2 + 1] = 0;
    }
  }
  vectors[(n - 1) * 2] = Number.NaN;
  vectors[(n - 1) * 2 + 1] = Number.NaN;
  return { positions, vectors, codes };
}

test('each group: speed against the average cell, alignment, direction, and where its arrows lead', () => {
  const { positions, vectors, codes } = line();
  const out = summarizeFlow({ positions, vectors, dimension: 2, codes, categoryCount: 3, include: () => true, neighbors: 15 });
  assert.equal(out.cells, 299);
  assert.equal(out.withoutVector, 1);
  assert.equal(out.empty, 0);
  const [a, b, c] = out.groups;
  assert.deepEqual([a.code, b.code, c.code], [0, 1, 2]);
  assert.equal(a.coherence, 1);
  assert.deepEqual(a.direction, [1, 0]);
  assert.equal(a.heading, 'right');
  assert.ok(b.speed > a.speed * 1.9 && b.speed < a.speed * 2.1, `B is twice as fast as A: ${a.speed}, ${b.speed}`);
  assert.ok(c.coherence < 0.2, `C points every way: ${c.coherence}`);
  assert.equal(c.heading, null);
  // A's arrows stay in A or lead into B, never back; B's lead into C or stay.
  const share = (group, code) => group.towards.find(entry => entry.code === code)?.share ?? 0;
  assert.ok(share(a, 1) > 0, 'A leads into B');
  assert.equal(share(a, 2), 0);
  assert.ok(share(b, 2) > 0, 'B leads into C');
  assert.equal(share(b, 0), 0);
  for (const group of out.groups) {
    const total = group.towards.reduce((sum, entry) => sum + entry.share, 0);
    assert.ok(total > 0.9 && total <= 1.01, `shares add up to about 1: ${total}`);
    assert.deepEqual(group.towards.map(entry => entry.share), [...group.towards.map(entry => entry.share)].sort((x, y) => y - x));
  }
});

test('the nearest cells are exact: a brute-force share agrees', () => {
  const { positions, vectors, codes } = line(120);
  const k = 10;
  const out = summarizeFlow({ positions, vectors, dimension: 2, codes, categoryCount: 3, include: () => true, neighbors: k });
  // Brute force for group A into B.
  const cells = [...codes.keys()].filter(i => Number.isFinite(vectors[i * 2]));
  let intoB = 0;
  let flowing = 0;
  for (const i of cells.filter(i => codes[i] === 0)) {
    const near = cells.filter(j => j !== i)
      .map(j => [Math.hypot(positions[j * 2] - positions[i * 2], positions[j * 2 + 1] - positions[i * 2 + 1]), j])
      .sort((x, y) => x[0] - y[0]).slice(0, k);
    let total = 0;
    let b = 0;
    for (const [d, j] of near) {
      const cos = ((positions[j * 2] - positions[i * 2]) * vectors[i * 2] + (positions[j * 2 + 1] - positions[i * 2 + 1]) * vectors[i * 2 + 1]) / (d * Math.hypot(vectors[i * 2], vectors[i * 2 + 1]));
      if (cos > 0) { total += cos; if (codes[j] === 1) b += cos; }
    }
    if (total > 0) { intoB += b / total; flowing++; }
  }
  const a = out.groups.find(group => group.code === 0);
  assert.equal(a.towards.find(entry => entry.code === 1)?.share ?? 0, Math.round((intoB / flowing) * 100) / 100);
});

test('categories asked for, cells left out, a 3-D field, headings in words', () => {
  const { positions, vectors, codes } = line();
  const some = summarizeFlow({ positions, vectors, dimension: 2, codes, categoryCount: 3, include: i => positions[i * 2] < 2, neighbors: 15, wanted: new Set([0, 2]) });
  assert.deepEqual(some.groups.map(group => group.code), [0]);
  assert.equal(some.empty, 1);
  const n = 50;
  const p3 = new Float32Array(n * 3).map((_, i) => (i % 3 === 2 ? (i / 3) / n : 0));
  const v3 = new Float32Array(n * 3).map((_, i) => (i % 3 === 2 ? 1 : 0));
  const three = summarizeFlow({ positions: p3, vectors: v3, dimension: 3, codes: new Uint8Array(n), categoryCount: 1, include: () => true, neighbors: 5 });
  assert.deepEqual(three.groups[0].direction, [0, 0, 1]);
  assert.equal(three.groups[0].heading, null);
  assert.equal(headingWords(1, 1), 'up and right');
  assert.equal(headingWords(-1, 0), 'left');
  assert.equal(headingWords(0, -1), 'down');
});

function fakeState({ layoutKey = 'X_umap', fields = [{ id: 'velocity', label: 'velocity', layoutKeys: ['X_umap'] }] } = {}) {
  const { positions, vectors, codes } = line();
  const categoryField = { key: 'stage', kind: 'category', categories: ['early', 'mid', 'late'], codes };
  return {
    pointCount: codes.length,
    getAvailableVectorFields: () => fields,
    getActiveViewId: () => 'live',
    getViewLayoutKey: () => layoutKey,
    getDefaultVectorFieldId: () => 'velocity',
    // The DataState naming every menu uses (`representationNameOf`), over no dataset keys.
    representationNameOf: layout => representationName(layout),
    getDimensionManager: () => ({
      getLayout: key => ({ layoutKey: key, label: key === 'X_umap' ? 'UMAP' : 'PCA', dimension: 2 }),
      getPositions: async () => positions,
    }),
    getVectorFieldManager: () => ({ loadField: async () => ({ vectors, components: 2, cellCount: codes.length }) }),
    obsData: { fields: [categoryField] },
    getFields: () => [categoryField],
    ensureFieldLoaded: async () => {},
  };
}

const viewer = { getLiveViewLabel: () => 'stage', getSnapshotViews: () => [], getLiveViewHidden: () => false };

test('the read names categories, the view and the embedding; refuses a view whose embedding has no field', async () => {
  const reads = createVectorFieldReads({ state: fakeState(), viewer });
  const out = await reads.summary({ by: { source: 'obs', key: 'stage' } }, {});
  assert.equal(out.vector_field, 'velocity');
  assert.deepEqual(out.embedding, { name: 'UMAP', dimension: 2 });
  assert.equal(out.view, 'View 1');
  assert.equal(out.neighbors, 30);
  assert.deepEqual(out.groups.map(group => group.label), ['early', 'mid', 'late']);
  assert.equal(out.groups[0].towards.find(entry => entry.category === 'mid') !== undefined, true);
  const pca = createVectorFieldReads({ state: fakeState({ layoutKey: 'X_pca' }), viewer });
  await assert.rejects(pca.summary({ by: { source: 'obs', key: 'stage' } }, {}), /shows PCA \(2-D\).*bound to "UMAP \(2-D\)": show that embedding in the view first \(view_embedding_set\)/);
  const none = createVectorFieldReads({ state: fakeState({ fields: [] }), viewer });
  await assert.rejects(none.summary({ by: { source: 'obs', key: 'stage' } }, {}), /no vector field/);
  await assert.rejects(reads.summary({ by: { source: 'obs', key: 'stage' }, vector_field: 'drift' }, {}), /no vector field "drift".*velocity/);
});

test('with no field named, the read takes the one the overlay shows, else the default, else the only one; among several it refuses (R9V-5)', async () => {
  const two = [
    { id: 'drift', label: 'drift', layoutKeys: ['X_umap'] },
    { id: 'velocity', label: 'velocity', layoutKeys: ['X_umap'] },
  ];
  const previousDocument = globalThis.document;
  const controls = { 'velocity-overlay-enabled': { checked: false }, 'velocity-field': { value: '' } };
  globalThis.document = { getElementById: id => controls[id] ?? null };
  try {
    const noDefault = { ...fakeState({ fields: two }), getDefaultVectorFieldId: () => null };
    const reads = createVectorFieldReads({ state: noDefault, viewer });
    // Two fields on UMAP, none shown, none the default: alphabet does not choose.
    await assert.rejects(
      reads.summary({ by: { source: 'obs', key: 'stage' } }, {}),
      error => error.code === 'ambiguous-field' && /Several vector fields are bound to UMAP \(2-D\).*"drift" and "velocity"; name one \(vector_field\)/.test(error.message),
    );
    // The overlay shows velocity: that is the field read.
    controls['velocity-overlay-enabled'].checked = true;
    controls['velocity-field'].value = 'velocity';
    assert.equal((await reads.summary({ by: { source: 'obs', key: 'stage' } }, {})).vector_field, 'velocity');
    // Shown beats the default.
    controls['velocity-field'].value = 'drift';
    const withDefault = createVectorFieldReads({ state: fakeState({ fields: two }), viewer });
    assert.equal((await withDefault.summary({ by: { source: 'obs', key: 'stage' } }, {})).vector_field, 'drift');
    // Overlay off: the default.
    controls['velocity-overlay-enabled'].checked = false;
    assert.equal((await withDefault.summary({ by: { source: 'obs', key: 'stage' } }, {})).vector_field, 'velocity');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('a field the overlay cannot draw is refused as unavailable, in its own words (R9V-7)', async () => {
  const failure = new MappingLoadError('velocity_umap', "every cell's vector is missing (NaN or infinite)", "Vector field 'velocity_umap' cannot be drawn: every cell's vector is missing (NaN or infinite).");
  const state = { ...fakeState(), getVectorFieldManager: () => ({ loadField: async () => { throw failure; } }) };
  await assert.rejects(
    createVectorFieldReads({ state, viewer }).summary({ by: { source: 'obs', key: 'stage' } }, {}),
    error => error.code === 'unavailable' && error.message === failure.message,
  );
});

test('in the catalog, guarded as a summary of groups', () => {
  const action = getActionCatalog().get('vector-field.summary');
  assert.equal(action.effect, 'read');
  assert.ok(SUMMARY_READS.has('vector-field.summary'));
  assert.deepEqual(SHAPED_INPUTS['vector-field.summary'].fields({ by: { key: 'stage' } }), ['stage']);
});
