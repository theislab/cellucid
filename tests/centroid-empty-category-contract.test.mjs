/**
 * A category no cell holds has no centroid.
 *
 * A centroid is the mean position of a category's cells. The centroid pass
 * used to return one entry for every category of the inventory, so a
 * category without cells got a centroid at the origin with `n_points: 0`,
 * and every consumer built a point and a label for it: a field with 70,000
 * categories of which three hold cells drew 69,997 labels stacked at (0, 0,
 * 0). The list now holds exactly the categories with cells, in inventory
 * order, and its consumers find a centroid's category by identity, never by
 * its position in the list. A category that gains its first cell (an edit, a
 * rebuilt consensus column) gets its centroid, and one that loses its last
 * loses it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  computeCentroidsForDimension,
  computeCentroidsForDimensionInSlices,
} from '../assets/js/app/registries/user-defined-fields/centroids.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

const MISSING = Object.freeze({ 1: 0xff, 2: 0xffff, 4: 0xffffffff });

test('the centroid pass returns one centroid for each category with cells, and none for the others', async () => {
  const categories = ['a', 'b', 'c', 'd', 'e'];
  for (const Codes of [Uint8Array, Uint16Array, Uint32Array]) {
    const missing = MISSING[Codes.BYTES_PER_ELEMENT];
    // a, c and e hold cells; b and d hold none; one cell has no category.
    const codes = Codes.from([0, 2, 0, missing, 4, 2, 0]);
    for (const dim of [1, 2, 3]) {
      const positions = new Float32Array(codes.length * dim);
      for (let i = 0; i < positions.length; i++) positions[i] = (i % 7) * 0.25 - 0.5 + (i % dim);
      const mean = cells => Array.from({ length: dim }, (_, axis) => (
        cells.reduce((sum, cell) => sum + positions[cell * dim + axis], 0) / cells.length
      ));
      const expected = [
        { category: 'a', position: mean([0, 2, 6]), n_points: 3 },
        { category: 'c', position: mean([1, 5]), n_points: 2 },
        { category: 'e', position: mean([4]), n_points: 1 },
      ];
      const whole = computeCentroidsForDimension(codes, categories, positions, dim);
      assert.deepEqual(whole, expected, `${Codes.name} ${dim}D`);
      const sliced = await computeCentroidsForDimensionInSlices(codes, categories, positions, dim, {
        sliceMs: 0,
        yieldToMacrotask: () => new Promise(resolve => setImmediate(resolve)),
      });
      assert.deepEqual(sliced, expected, `${Codes.name} ${dim}D in slices`);
    }
  }

  // No cell holds any category: there is no centroid at all.
  const allMissing = Uint8Array.from([0xff, 0xff]);
  assert.deepEqual(computeCentroidsForDimension(allMissing, ['a', 'b'], new Float32Array(4), 2), []);
});

/** The uint32 browser fixture's placement: three of 70,000 categories hold cells. */
const INVENTORY_SIZE = 70_000;
const PLACEMENT = Object.freeze({ gamma: 0, alpha: 65_536, beta: 69_999 });
const POINTS = 12;

function largeInventory() {
  const categories = Array.from({ length: INVENTORY_SIZE }, (_, code) => `zz-${String(code).padStart(6, '0')}`);
  for (const [label, code] of Object.entries(PLACEMENT)) categories[code] = label;
  const labels = ['alpha', 'beta', 'gamma'];
  const codes = new Uint32Array(POINTS);
  for (let cell = 0; cell < POINTS; cell++) {
    const label = labels[cell % 3];
    // The first gamma cell has no category.
    codes[cell] = label === 'gamma' && cell === 2 ? MISSING[4] : PLACEMENT[label];
  }
  return { categories, codes };
}

function rawPositions(pointCount, dimension) {
  let value = 7;
  const positions = new Float32Array(pointCount * dimension);
  for (let index = 0; index < positions.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    positions[index] = (value / 2 ** 32) * 20 - 7 + (index % dimension) * 3;
  }
  return positions;
}

/** Elements and a label layer with exactly what the state uses of them. */
function fakeLabelDom() {
  const children = [];
  const layer = {
    children,
    appendChild(element) {
      if (element.parentNode) element.remove();
      element.parentNode = layer;
      children.push(element);
      return element;
    },
    querySelectorAll(selector) {
      const match = /^\[data-view-id="(.*)"\]$/.exec(selector);
      assert.ok(match, `unexpected selector ${selector}`);
      return children.filter(element => element.dataset.viewId === match[1]);
    },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'div');
      const element = {
        className: '',
        dataset: {},
        style: {},
        textContent: '',
        parentNode: null,
        remove() {
          if (!element.parentNode) return;
          const siblings = element.parentNode.children;
          siblings.splice(siblings.indexOf(element), 1);
          element.parentNode = null;
        },
      };
      return element;
    },
  };
  return { document, layer };
}

async function createScene(t, obsFields) {
  const { document, layer } = fakeLabelDom();
  const previousDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap_2d' },
      items: {
        X_umap_2d: {
          label: 'X_umap_2d',
          dimension: 2,
          path: 'obsm/0/0-1',
          source: { key: 'X_umap_2d', columns: [0, 1] },
        },
      },
    },
  });
  loadsAsReader(manager, async () => rawPositions(POINTS, 2));
  await manager.getPositions('X_umap_2d', { showProgress: false });

  const centroidPublications = [];
  const labelPublications = [];
  const viewer = {
    hasVectorFieldForLayout: () => false,
    isDisposed: () => false,
    resetVectorFieldOverlay() {},
    setCentroidLabels(labels) {
      labelPublications.push(labels);
    },
    setCentroids({ positions, colors }) {
      centroidPublications.push({ positions: Array.from(positions), colors: Array.from(colors) });
    },
    setData() {},
    setViewEmbedding() {},
    updateColors() {},
    updatePositions() {},
    updateTransparency() {},
  };
  const state = createDataState({ viewer, labelLayer: layer });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [] });
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(manager.getResidentPositions('X_umap_2d'), { fields: obsFields });
  return { centroidPublications, labelPublications, layer, manager, state };
}

/** What the state drew for the active field: its centroids, one entry each. */
function drawn(state, layer) {
  const count = state.centroidPositions.length / 3;
  assert.equal(state.centroidColors.length, count * 4);
  assert.equal(state.centroidLabels.length, count);
  assert.equal(layer.children.length, count, 'one label element per centroid');
  return Array.from({ length: count }, (_, i) => ({
    label: state.centroidLabels[i].el.textContent,
    position: Array.from(state.centroidPositions.subarray(i * 3, i * 3 + 3)),
    rgba: Array.from(state.centroidColors.subarray(i * 4, i * 4 + 4)),
    shown: state.centroidLabels[i].el.style.display !== 'none',
  }));
}

function expectedRgb(field, categoryIndex) {
  return field._categoryColors[categoryIndex].map(channel => Math.round(channel * 255));
}

test('a 70,000-category field draws one point and one label per category with cells', async t => {
  const { categories, codes } = largeInventory();
  const { centroidPublications, layer, manager, state } = await createScene(t, [
    { key: 'cell_type', kind: 'category', categories, codes },
  ]);
  const result = state.setActiveField(0);
  const field = state.obsData.fields[0];

  const positions = manager.getResidentPositions('X_umap_2d');
  const expected = computeCentroidsForDimension(codes, categories, positions, 2);
  // Inventory order: gamma (0), alpha (65,536), beta (69,999).
  assert.deepEqual(expected.map(c => [c.category, c.n_points]), [['gamma', 3], ['alpha', 4], ['beta', 4]]);
  assert.deepEqual(field.centroidsByLayout.get('X_umap_2d'), expected);
  assert.equal(state.centroidCount, 3);
  assert.equal(result.centroidInfo, ' • Centroids: 3');

  // Each point sits at its category's mean and wears its category's colour,
  // looked up by identity: the third centroid is category 69,999, not 2.
  const shown = drawn(state, layer);
  assert.deepEqual(shown.map(c => c.label), ['gamma', 'alpha', 'beta']);
  shown.forEach((centroid, i) => {
    const categoryIndex = PLACEMENT[centroid.label];
    assert.deepEqual(centroid.position, [...expected[i].position, 0].map(Math.fround));
    assert.deepEqual(centroid.rgba, [...expectedRgb(field, categoryIndex), 255], centroid.label);
    assert.equal(centroid.shown, true);
  });
  assert.equal(centroidPublications.at(-1).positions.length, 9);

  // Hiding alpha hides exactly its point and label.
  state.setVisibilityForCategory(field, PLACEMENT.alpha, false);
  const afterHide = drawn(state, layer);
  assert.deepEqual(afterHide.map(c => [c.label, c.rgba[3], c.shown]), [
    ['gamma', 255, true],
    ['alpha', 0, false],
    ['beta', 255, true],
  ]);
  assert.deepEqual(centroidPublications.at(-1).colors.filter((_, i) => i % 4 === 3), [255, 0, 255]);

  // Rebuilding the label layer (a view switch does) keeps the same three.
  state._rebuildLabelLayerFromCentroids();
  assert.deepEqual(drawn(state, layer).map(c => [c.label, c.shown]), [
    ['gamma', true],
    ['alpha', false],
    ['beta', true],
  ]);
});

test('a category gains its centroid with its first cell and loses it with its last', async t => {
  const codesOf = (...values) => Uint8Array.from(values);
  const { layer, manager, state } = await createScene(t, [
    { key: 'cell_type', kind: 'category', categories: ['t', 'b'], codes: new Uint8Array(POINTS) },
  ]);
  const positions = manager.getResidentPositions('X_umap_2d');
  const centroidsOf = field => field.centroidsByLayout.get('X_umap_2d').map(c => c.category);

  // A consensus column whose 'z' holds no cell yet.
  const created = state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['x', 'y', 'z'],
    codes: codesOf(0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1),
  });
  const consensus = state.obsData.fields[created.fieldIndex];
  state.setActiveField(created.fieldIndex);
  assert.deepEqual(centroidsOf(consensus), ['x', 'y']);
  assert.deepEqual(drawn(state, layer).map(c => c.label), ['x', 'y']);

  // Rebuilt in place while shown: 'z' gains cells and its centroid is drawn
  // at once, at the mean of its cells.
  state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['x', 'y', 'z'],
    codes: codesOf(0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1),
  });
  const withZ = computeCentroidsForDimension(consensus.codes, consensus.categories, positions, 2);
  assert.deepEqual(centroidsOf(consensus), ['x', 'y', 'z']);
  assert.deepEqual(drawn(state, layer).map(c => [c.label, c.position]), withZ.map(c => (
    [c.category, [...c.position, 0].map(Math.fround)]
  )));
  assert.equal(state.centroidCount, 3);

  // 'y' loses its last cell: its point and label go.
  state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['x', 'y', 'z'],
    codes: codesOf(0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 0),
  });
  assert.deepEqual(centroidsOf(consensus), ['x', 'z']);
  assert.deepEqual(drawn(state, layer).map(c => c.label), ['x', 'z']);

  // Deleting 'x' into a new 'unassigned' category moves its cells there:
  // the new category has cells, so it has a centroid.
  state.deleteCategoryToUnassigned(created.fieldIndex, 0, {
    editInPlace: true,
    unassignedLabel: 'unassigned',
  });
  const edited = state.obsData.fields[created.fieldIndex];
  assert.equal(edited.categories.includes('unassigned'), true);
  assert.deepEqual(
    edited.centroidsByLayout.get('X_umap_2d'),
    computeCentroidsForDimension(edited.codes, edited.categories, positions, 2)
  );
  assert.deepEqual(
    drawn(state, layer).map(c => c.label).sort(),
    edited.centroidsByLayout.get('X_umap_2d').map(c => String(c.category)).sort()
  );
  assert.ok(drawn(state, layer).some(c => c.label === 'unassigned'));
  assert.ok(!drawn(state, layer).some(c => c.label === 'y'), 'y still holds no cell');
});

test('a centroid that names no cells is refused where centroids are drawn', async t => {
  const { state } = await createScene(t, [
    { key: 'cell_type', kind: 'category', categories: ['t', 'b'], codes: Uint8Array.from(Array.from({ length: POINTS }, (_, i) => i % 2)) },
  ]);
  const field = state.obsData.fields[0];
  field.centroidsByLayout.set('X_umap_2d', [
    { category: 't', position: [0.1, 0.2], n_points: 6 },
    { category: 'b', position: [0, 0], n_points: 0 },
  ]);
  field._normalizedLayouts = new Set(['X_umap_2d']);
  assert.throws(
    () => state.buildCentroidsForField(field, { viewId: 'live', layoutKey: 'X_umap_2d' }),
    /Centroid 1 must contain an exact 2D position and a positive point count/
  );
});
