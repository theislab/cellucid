/**
 * CEL-0216 — the Marker Genes group picker names categories, not handles.
 *
 * `GenesPanelController._buildMarkerGroups` keys each group by a synthetic
 * handle, `category-code:<code>`
 * (`assets/js/app/analysis/genes-panel/genes-panel-controller.js:1022`), and
 * carries the category it came from alongside it as `groupName`. The handle is
 * what every downstream lookup addresses — `markers.groups[groupId]`, the
 * heatmap's `matrix.groupIds`, the hover lookup, the saved
 * `modalSelectedGroupId` — so it has to stay the option's `value`.
 *
 * It was also the option's *label*: `opt.textContent = id`. A user who grouped
 * by `cell_type` and opened the expanded Marker Genes view was offered
 * `category-code:0`, `category-code:1`, … with no way to tell which cell type
 * each one was, while the heatmap beside it drew the real names on its own axis.
 * The committed screenshot
 * `cellucid-python/docs/_static/screenshots/analysis/marker-genes-expanded.png`
 * shows `category-code:0` in the picker and `Ductal` on the heatmap row.
 *
 * `MarkerDiscoveryEngine` requires `groupName` — a group without an exact
 * primitive name is rejected before any statistics are computed
 * (`marker-discovery-engine.js:988-1007`) — and carries it into the published
 * record (`:1301`), which `_rebuildMarkerGroupsFromStats` preserves by spread
 * when thresholds move. So the label was never missing; it was never read.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

// =============================================================================
// The smallest DOM `_renderModalAnnotations` touches
// =============================================================================

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.selected = false;
    this.hidden = false;
    this.listeners = new Map();
  }

  set innerHTML(html) {
    this._innerHTML = html;
    if (html === '') this.children = [];
  }

  get innerHTML() {
    return this._innerHTML ?? '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  /** Every element of `tagName` in this subtree, in document order. */
  collect(tagName) {
    const wanted = tagName.toUpperCase();
    const found = [];
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.tagName === wanted) found.push(child);
      found.push(...child.collect(tagName));
    }
    return found;
  }
}

function withFakeDocument(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: tagName => new FakeElement(tagName),
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

// =============================================================================
// A marker result shaped exactly as MarkerDiscoveryEngine publishes one
// =============================================================================

// exports/pancreas/obs_manifest.json, field `cell_type`.
const PANCREAS_CELL_TYPES = [
  'Ductal', 'Ngn3 low EP', 'Ngn3 high EP', 'Pre-endocrine',
  'Beta', 'Alpha', 'Delta', 'Epsilon',
];

function markerResult() {
  const groups = {};
  for (const [code, groupName] of PANCREAS_CELL_TYPES.entries()) {
    groups[`category-code:${code}`] = {
      groupId: `category-code:${code}`,
      groupName,
      cellCount: 100 + code,
      color: '#336699',
      genesTested: 3753,
      genesUntestable: 12,
      markers: [{
        gene: `Gene${code}`,
        groupId: `category-code:${code}`,
        log2FoldChange: -4.708,
        pValue: 1e-30,
        adjustedPValue: 1e-28,
        rank: 1,
      }],
    };
  }
  return { markers: { groups, minCellsPerSide: 3 } };
}

function renderPicker({ result, selectedGroupId = null }) {
  return withFakeDocument(() => {
    const ui = Object.create(GenesPanelUI.prototype);
    ui._lastResult = result;
    ui._modalGeneListMode = 'top5';
    ui._modalSelectedGroupId = selectedGroupId;
    ui._modalAnnotationsRenderRevision = 0;

    const container = new FakeElement('div');
    ui._renderModalAnnotations(container);

    const selects = container.collect('select');
    assert.equal(selects.length, 2, 'the header owns a list-size and a group select');
    return { groupSelect: selects[1], ui, container };
  });
}

test('the group picker shows category names, never internal handles', () => {
  const { groupSelect } = renderPicker({ result: markerResult() });
  const options = groupSelect.collect('option');

  assert.equal(options.length, PANCREAS_CELL_TYPES.length);
  assert.deepEqual(
    options.map(option => option.textContent),
    PANCREAS_CELL_TYPES,
    'a user picks the cell type they grouped by, not the code it was stored '
      + 'under',
  );
  for (const option of options) {
    assert.ok(
      !option.textContent.includes('category-code:'),
      `option label ${JSON.stringify(option.textContent)} leaks a handle`,
    );
  }
});

test('the option value stays the handle every lookup addresses', () => {
  const result = markerResult();
  const { groupSelect } = renderPicker({ result });
  const options = groupSelect.collect('option');

  assert.deepEqual(
    options.map(option => option.value),
    Object.keys(result.markers.groups),
    'the value keys markers.groups, the heatmap columns and the saved '
      + 'modalSelectedGroupId, so it must remain the group id',
  );
});

test('the selected option is the selected group', () => {
  const { groupSelect } = renderPicker({
    result: markerResult(),
    selectedGroupId: 'category-code:5',
  });
  const selected = groupSelect.collect('option').filter(option => option.selected);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].value, 'category-code:5');
  assert.equal(selected[0].textContent, 'Alpha');
});

test('a non-string group name is still drawn as a label', () => {
  // MarkerDiscoveryEngine accepts a number or a boolean category name as well
  // as a string (`marker-discovery-engine.js:988-1007`), which is what an obs
  // column of integer cluster labels produces.
  const result = { markers: { groups: {}, minCellsPerSide: 3 } };
  result.markers.groups['category-code:0'] = {
    groupId: 'category-code:0',
    groupName: 0,
    cellCount: 10,
    color: '#336699',
    genesTested: 5,
    genesUntestable: 0,
    markers: [],
  };
  result.markers.groups['category-code:1'] = {
    groupId: 'category-code:1',
    groupName: 12,
    cellCount: 10,
    color: '#336699',
    genesTested: 5,
    genesUntestable: 0,
    markers: [],
  };

  const { groupSelect } = renderPicker({ result });
  assert.deepEqual(
    groupSelect.collect('option').map(option => option.textContent),
    ['0', '12'],
    'a numeric cluster label is a label, not a missing one',
  );
});
