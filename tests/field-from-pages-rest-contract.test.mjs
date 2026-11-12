/**
 * A field made from highlight pages over another field's labels (bug hunt
 * L25-3, round 9 close RCA): `field.create-from-pages` `rest` — the cells on
 * no page keep their category of a categorical field, so splitting one label
 * is a page per new label and one call (an agent had made 45 temporary pages,
 * a field of 48 pages, then deleted 56 pages: 101 calls, $3). A page label
 * that is one of the kept field's categories is that category; a cell with no
 * category there takes the uncovered label; every overlap rule keeps it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { UserDefinedFieldsRegistry } from '../assets/js/app/registries/user-defined-fields.js';
import { StateValidator } from '../assets/js/app/utils/state-validator.js';
import { OverlapStrategy } from '../assets/js/app/utils/field-constants.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';

/** Eight cells; page A holds cells 0 and 1, page B cells 1 and 2. */
function pagesState() {
  const page = (id, cells) => ({ id, name: id, highlightedGroups: [{ enabled: true, label: 'g', cellIndices: cells }] });
  return {
    pointCount: 8,
    highlightPages: [page('A', [0, 1]), page('B', [1, 2])],
    getHighlightPageColor: () => '#2563eb',
    dimensionManager: { getResidentPositions: () => null, getRegisteredLayouts: () => [{ layoutKey: '2d', dimension: 2 }] },
  };
}

/** The annotation kept: cells 0-2 "Fibroblast", 3-4 "Endothelial", 5 "Fibroblast", 6 none (255), 7 "Unassigned". */
const REST = Object.freeze({
  categories: ['Fibroblast', 'Endothelial', 'Unassigned'],
  codes: Uint8Array.of(0, 0, 0, 1, 1, 0, 255, 2),
  missing: 255,
});

function options(overlapStrategy, extra = {}) {
  return {
    key: 'refined',
    pages: [{ pageId: 'A', label: 'Fibroblast GSC+' }, { pageId: 'B', label: 'Fibroblast PI16+' }],
    uncoveredLabel: 'Unassigned',
    overlapStrategy,
    overlapLabel: overlapStrategy === OverlapStrategy.OVERLAP_LABEL ? 'Both' : '',
    intersectionLabels: overlapStrategy === OverlapStrategy.INTERSECTIONS ? { '0+1': 'Both' } : {},
    rest: REST,
    ...extra,
  };
}

const labelsOf = field => [...field.codes].map(code => field.categories[code] ?? null);

test('the cells on no page keep their category of the kept field; a cell with none there takes the uncovered label', () => {
  const { field, conflicts, uncoveredCount } = new UserDefinedFieldsRegistry().createFromPages(options(OverlapStrategy.FIRST), pagesState());
  assert.deepEqual(labelsOf(field), [
    'Fibroblast GSC+', 'Fibroblast GSC+', 'Fibroblast PI16+', 'Endothelial', 'Endothelial', 'Fibroblast', 'Unassigned', 'Unassigned',
  ]);
  // Pages first, then the kept categories the cells on no page hold; the uncovered label is the kept "Unassigned".
  assert.deepEqual(field.categories, ['Fibroblast GSC+', 'Fibroblast PI16+', 'Fibroblast', 'Endothelial', 'Unassigned']);
  assert.equal(conflicts, 1);
  assert.equal(uncoveredCount, 5);
});

test('every overlap rule keeps the kept categories; a page label that is a kept category is that category', () => {
  const last = new UserDefinedFieldsRegistry().createFromPages(options(OverlapStrategy.LAST), pagesState()).field;
  assert.equal(labelsOf(last)[1], 'Fibroblast PI16+');
  assert.deepEqual(labelsOf(last).slice(3), ['Endothelial', 'Endothelial', 'Fibroblast', 'Unassigned', 'Unassigned']);
  const both = new UserDefinedFieldsRegistry().createFromPages(options(OverlapStrategy.OVERLAP_LABEL), pagesState()).field;
  assert.deepEqual(labelsOf(both).slice(0, 4), ['Fibroblast GSC+', 'Both', 'Fibroblast PI16+', 'Endothelial']);
  const split = new UserDefinedFieldsRegistry().createFromPages(options(OverlapStrategy.INTERSECTIONS), pagesState()).field;
  assert.deepEqual(labelsOf(split), [
    'Fibroblast GSC+', 'Both', 'Fibroblast PI16+', 'Endothelial', 'Endothelial', 'Fibroblast', 'Unassigned', 'Unassigned',
  ]);
  // Page B named "Endothelial": its cell joins the kept category, one category.
  const merged = new UserDefinedFieldsRegistry().createFromPages(
    options(OverlapStrategy.FIRST, { pages: [{ pageId: 'A', label: 'Fibroblast GSC+' }, { pageId: 'B', label: 'Endothelial' }] }),
    pagesState(),
  ).field;
  assert.deepEqual(merged.categories.filter(label => label === 'Endothelial'), ['Endothelial']);
  assert.deepEqual(labelsOf(merged).slice(0, 5), ['Fibroblast GSC+', 'Fibroblast GSC+', 'Endothelial', 'Endothelial', 'Endothelial']);
  // No uncovered label: a cell with no kept category has none.
  const bare = new UserDefinedFieldsRegistry().createFromPages(options(OverlapStrategy.FIRST, { uncoveredLabel: '' }), pagesState()).field;
  assert.equal(labelsOf(bare)[6], null);
});

test('without rest, as before: the cells on no page take the uncovered label; a malformed rest is refused', () => {
  const { rest: _rest, ...plain } = options(OverlapStrategy.FIRST);
  const { field } = new UserDefinedFieldsRegistry().createFromPages(plain, pagesState());
  assert.deepEqual(field.categories, ['Fibroblast GSC+', 'Fibroblast PI16+', 'Unassigned']);
  assert.deepEqual(labelsOf(field).slice(3), Array(5).fill('Unassigned'));
  assert.throws(() => StateValidator.validateUserDefinedOptions({ ...plain, rest: { categories: ['x'], codes: [0], missing: 255 } }), /rest must be null or the kept field's categories/);
  assert.throws(() => new UserDefinedFieldsRegistry().createFromPages({ ...plain, rest: { ...REST, codes: Uint8Array.of(0) } }, pagesState()), /one code per open cell/);
});

test('the action names the kept field (version 2: a version-1 step reads the same) and says it in its step', () => {
  const definition = getActionCatalog().get('field.create-from-pages');
  assert.equal(definition.version, 2);
  assert.deepEqual(definition.params.properties.rest.properties.source, { type: 'string', const: 'obs' });
  const params = { key: 'refined', pages: [{ page: 'A', label: 'x' }], rest: { source: 'obs', key: 'cell_type' } };
  assert.equal(definition.describe(params, null), 'Made refined from 1 highlight page, the rest as cell_type');
  assert.match(definition.code(params), /rest=/);
});
