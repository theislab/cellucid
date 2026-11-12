import assert from 'node:assert/strict';
import test from 'node:test';

import { figureAutoTitle, gridPanelsDifferInField } from '../assets/js/app/ui/modules/figure-export/utils/figure-title.js';

const model = (categories, { hidden = [], empty = [] } = {}) => ({
  kind: 'category',
  categories,
  visible: Uint8Array.from(categories, (_, i) => (hidden.includes(i) ? 0 : 1)),
  counts: {
    available: categories.map((_, i) => (empty.includes(i) ? 0 : 10)),
    visible: categories.map((_, i) => (empty.includes(i) || hidden.includes(i) ? 0 : 10)),
  },
});
const types = Array.from({ length: 69 }, (_, i) => `Type ${i}`);

test('every category shown: the title names the field, not its categories', () => {
  // Found 2026-11-10 on Suo: "… • cell_type: AXL+ and SIGLEC6+ DCs, B1 cells +67" over all 69.
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: model(types) }), 'Suo • cell_type');
  // A category with no cell passing the other filters is not hidden by the person.
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: model(types, { empty: [3] }) }), 'Suo • cell_type');
});

test('some categories hidden: the smaller side named, as the filter list says it', () => {
  const four = model(['B', 'T', 'NK', 'Mono'], { hidden: [3] });
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: four }), 'Suo • cell_type: hiding Mono');
  const one = model(types, { hidden: [0] });
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: one }), 'Suo • cell_type: hiding Type 0');
  const two = model(types, { hidden: types.map((_, i) => i).filter(i => i > 1) });
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: two }), 'Suo • cell_type: showing only Type 0, Type 1');
  assert.equal(figureAutoTitle({ datasetName: '', fieldLabel: 'cell_type', legendModel: four }), 'cell_type: hiding Mono');
});

test('a continuous field or none: the dataset and the field', () => {
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'n_genes', legendModel: { kind: 'continuous' } }), 'Suo • n_genes');
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: '', legendModel: null }), 'Suo');
  assert.equal(figureAutoTitle({ datasetName: '', fieldLabel: '', legendModel: null }), '');
});

test('a grid whose panels show different fields is titled by the dataset alone', () => {
  // Found 2026-11-10: a grid of a cell_type panel and an organ panel was titled "… • organ".
  const fields = { live: 'cell_type', snap_1: 'organ', snap_2: 'cell_type' };
  const fieldKeyOf = viewId => fields[viewId] ?? null;
  assert.equal(gridPanelsDifferInField({ viewLayout: { mode: 'grid' }, snapshotViewIds: ['snap_1'], fieldKeyOf }), true);
  assert.equal(gridPanelsDifferInField({ viewLayout: { mode: 'grid' }, snapshotViewIds: ['snap_2'], fieldKeyOf }), false);
  // The live view hidden is not a panel; a single view is never a grid.
  assert.equal(gridPanelsDifferInField({ viewLayout: { mode: 'grid', liveViewHidden: true }, snapshotViewIds: ['snap_1'], fieldKeyOf }), false);
  assert.equal(gridPanelsDifferInField({ viewLayout: { mode: 'single' }, snapshotViewIds: ['snap_1'], fieldKeyOf }), false);
  assert.equal(figureAutoTitle({ datasetName: 'Suo', fieldLabel: '', legendModel: null }), 'Suo');
});


test('one view: the filters on other fields follow the field, as its view label says them (F113)', () => {
  // He, colored by LVL2 with only the epithelial cells kept: the legend lists the 11 epithelial
  // types with cells, so the title says why the other 30 are absent.
  const lvl2 = model(['Aerocyte', 'Lung_AT_cells', 'Lung_club_cells'], { empty: [0] });
  assert.equal(
    figureAutoTitle({ datasetName: 'Developing human lung (He)', fieldLabel: 'LVL2', legendModel: lvl2, otherFilters: ['LVL0: showing only Epithelial'] }),
    'Developing human lung (He) • LVL2 • LVL0: showing only Epithelial',
  );
  const hiding = model(['B', 'T', 'NK', 'Mono'], { hidden: [3] });
  assert.equal(
    figureAutoTitle({ datasetName: 'Suo', fieldLabel: 'cell_type', legendModel: hiding, otherFilters: ['organ: hiding Liver', 'n_genes: 200 – 6000'] }),
    'Suo • cell_type: hiding Mono • organ: hiding Liver • n_genes: 200 – 6000',
  );
});

test('a named view: the dataset and the name it was given (F130)', () => {
  const hiding = model(['B', 'T', 'NK', 'Mono'], { hidden: [3] });
  assert.equal(
    figureAutoTitle({ datasetName: 'He', fieldLabel: 'LVL2', legendModel: hiding, otherFilters: ['LVL0: showing only Epithelial'], viewName: 'Early epithelium' }),
    'He • Early epithelium',
  );
  assert.equal(figureAutoTitle({ datasetName: '', fieldLabel: 'LVL2', legendModel: null, viewName: 'Early' }), 'Early');
  // No name: as before.
  assert.equal(figureAutoTitle({ datasetName: 'He', fieldLabel: 'LVL2', legendModel: null, viewName: null }), 'He • LVL2');
});
