/**
 * Analysis reads categorical codes at the width the field stores them.
 *
 * A field with more categories than uint16 addresses (65,535) is stored as
 * uint32. Analysis used to copy every field into a Uint16Array, which turned a
 * uint32 code into code mod 65,536: a cell of category 65,536 was counted as
 * category 0, with no error. Every consumer below gets a field of 70,000
 * categories whose cells sit at codes on both sides of 65,535 (and one past
 * the Int16 group-index range of the marker worker), and has to count each
 * cell under its own label, exactly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DataLayer } from '../assets/js/app/analysis/data/data-layer.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';
import { QuickInsights } from '../assets/js/app/analysis/ui/analysis-types/quick-insights-ui.js';

const CATEGORY_COUNT = 70_000;
const UINT32_MISSING = 4_294_967_295;
const categories = Array.from({ length: CATEGORY_COUNT }, (_, code) => `c${code}`);

// Codes chosen so that a 16-bit copy changes each of them: 65,536 becomes 0,
// 69,999 becomes 4,463, 40,000 stays (it is a uint16 code but past Int16).
const CELL_CODES = [
  ...Array(7).fill(65_536),
  ...Array(5).fill(69_999),
  ...Array(4).fill(40_000),
  ...Array(3).fill(0),
  ...Array(2).fill(UINT32_MISSING),
];
const EXPECTED = new Map([['c65536', 7], ['c69999', 5], ['c40000', 4], ['c0', 3]]);
const codes = Uint32Array.from(CELL_CODES);
const allCells = Uint32Array.from(CELL_CODES.keys());

function layerOver(field) {
  const layer = Object.create(DataLayer.prototype);
  layer.state = { obsData: { fields: [field] }, varData: null, pointCount: field.codes.length };
  layer._datasetGeneration = 0;
  layer._notifications = null;
  layer.getVariableInfo = () => ({ key: field.key, kind: field.kind, _fieldIndex: 0 });
  layer.getPageInfo = pageId => ({ id: pageId, name: pageId });
  layer.getPages = () => [{ id: 'P1', name: 'P1' }];
  layer.getCellIndicesForPage = () => allCells;
  layer._getVersionedCellIndices = () => allCells;
  layer._getObsFieldIndexMap = () => new Map([[field.key, 0]]);
  layer.getAvailableVariables = type => (type === 'categorical_obs' ? [{ key: field.key }] : []);
  layer._ensureFieldLoaded = async () => {};
  layer._requireCurrentDatasetGeneration = () => {};
  return layer;
}

const wideField = () => ({ key: 'wide', kind: 'category', categories, codes, loaded: true });

function countLabels(values) {
  const counts = new Map();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

test('page values label every uint32 code as its own category', async () => {
  const layer = layerOver(wideField());
  const [page] = await layer._fetchDataForPages({
    type: 'categorical_obs', variableKey: 'wide', pageIds: ['P1'], silent: true,
  });
  assert.deepEqual(countLabels(page.values), EXPECTED);
  assert.equal(page.values.filter(value => value === null).length, 2);
});

test('bulk observation fields keep the width of the field in every page', async () => {
  const layer = layerOver(wideField());
  const whole = await layer.fetchBulkObsFields({
    pageIds: ['P1'], obsFields: ['wide'], subsetPages: false, includeCategoricalValues: false,
  });
  assert.strictEqual(whole.fields.wide.codes, codes);

  const paged = await layer.fetchBulkObsFields({
    pageIds: ['P1'], obsFields: ['wide'], subsetPages: true, includeCategoricalValues: true,
  });
  const page = paged.fields.wide.P1;
  assert.ok(page.codes instanceof Uint32Array);
  assert.deepEqual([...page.codes], CELL_CODES);
  assert.deepEqual(countLabels(page.values), EXPECTED);
});

test('marker groups from a uint32 field carry the exact codes and cell counts', async () => {
  const controller = Object.create(GenesPanelController.prototype);
  controller.dataLayer = {
    state: { obsData: { fields: [{ key: 'wide', loaded: true }] } },
    ensureObsFieldLoaded: async () => ({ kind: 'category', codes, categories, colors: {} }),
  };
  const { groups, obsCodes } = await controller._getGroupsFromCategory('wide', {});
  assert.strictEqual(obsCodes, codes);
  assert.deepEqual(
    new Map(groups.map(group => [group.groupName, group.cellCount])),
    EXPECTED,
  );
  const beyond = groups.find(group => group.groupName === 'c69999');
  assert.equal(beyond.groupCode, 69_999);
  assert.deepEqual([...beyond.cellIndices], [7, 8, 9, 10, 11]);
});

test('the marker worker counts each cell in its group past 32,767 groups', async () => {
  const messages = [];
  globalThis.self = { postMessage: message => messages.push(message) };
  try {
    await import('../assets/js/app/analysis/compute/data-worker.js?wide-category-codes');
    const run = (type, payload) => {
      globalThis.self.onmessage({ data: { type, payload, requestId: type } });
      const message = messages.at(-1);
      assert.equal(message.success, true, message.error);
      return message.result;
    };
    // Every one of the 70,000 categories is a group, so group indices run
    // past what an Int16Array holds.
    run('MARKERS_SET_CONTEXT', {
      codes: codes.slice(),
      codeToGroupIndex: Int32Array.from({ length: CATEGORY_COUNT }, (_, code) => code),
      groupCount: CATEGORY_COUNT,
    });
    const values = Float32Array.from(CELL_CODES, (_, cell) => cell + 1);
    const result = run('MARKERS_COMPUTE_GENE', { values, method: 'ttest', minCells: 1 });
    assert.equal(result.nAll, CELL_CODES.length - 2);
    for (const [label, count] of EXPECTED) {
      assert.equal(result.nIn[Number(label.slice(1))], count, label);
    }
    assert.equal(result.nIn[4_463], 0, 'no cell of 69,999 lands on 69,999 mod 65,536');
  } finally {
    delete globalThis.self;
  }
});

test('Quick Insights counts a uint32 field by its own codes', async () => {
  const insights = Object.create(QuickInsights.prototype);
  const summary = await insights._summarizeCategoricalAcrossPages(
    'wide',
    { categories, codes },
    ['P1'],
    { P1: { cellIndices: allCells } },
  );
  assert.equal(summary.total, CELL_CODES.length - 2);
  assert.deepEqual(
    new Map(summary.topCategories.map(entry => [entry.name, entry.count])),
    EXPECTED,
  );
});
