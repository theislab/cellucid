/**
 * Detailed's plot and plot options set by `analysis.detailed.set` (`setPlot`)
 * are the action's change, never reported as the person's: a person's change
 * is a step of its own even while an action runs (dispatcher
 * `recordObserved`, R9W-5), so a `setPlot` that went through the person's
 * handlers made its change the person's step and left the action with none
 * (round 9 gate, `actions-settings-layout-analysis.spec.mjs`). The plot
 * selector and the expanded view's options, a person's, still report theirs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';

function detailed() {
  const ui = Object.create(DetailedAnalysisUI.prototype);
  ui._currentConfig = {
    dataSource: { type: 'categorical_obs', variable: 'cell_type' },
    pages: [],
    plotType: 'barplot',
    plotOptions: {},
  };
  ui._savedPlotOptions = new Map();
  ui._modal = null;
  ui._variableSelector = null;
  ui.dataLayer = { getAvailableVariables: () => [{ key: 'cell_type' }] };
  ui.person = [];
  ui._recordPersonChange = (kind, detail) => ui.person.push([kind, detail]);
  ui._scheduleUpdate = () => {};
  ui._renderControls = () => {};
  return ui;
}

async function withPlots(run) {
  const saved = { get: PlotRegistry.get, getForDataType: PlotRegistry.getForDataType, mergeOptions: PlotRegistry.mergeOptions };
  PlotRegistry.get = () => ({ optionSchema: { maxCategories: {}, donut: {} } });
  PlotRegistry.getForDataType = () => [{ id: 'barplot' }, { id: 'pieplot' }];
  PlotRegistry.mergeOptions = (_plot, options = {}) => ({ donut: true, ...structuredClone(options) });
  try {
    await run();
  } finally {
    Object.assign(PlotRegistry, saved);
  }
}

test('setPlot changes the plot and its options as the action\'s change, reporting none as the person\'s', async () => {
  await withPlots(() => {
    const ui = detailed();
    const changed = ui.setPlot({ plot: 'pieplot', plotOptions: [{ option: 'maxCategories', value: 5 }] });
    assert.equal(changed, true);
    assert.equal(ui._currentConfig.plotType, 'pieplot');
    assert.deepEqual(ui._currentConfig.plotOptions, { donut: true, maxCategories: 5 });
    assert.deepEqual(ui._savedPlotOptions.get('pieplot'), { donut: true, maxCategories: 5 });
    assert.deepEqual(ui.person, []);
  });
});

test('the person\'s plot choice and plot option are each reported as the person\'s change', async () => {
  await withPlots(() => {
    const ui = detailed();
    ui._handlePlotTypeChange('pieplot');
    ui._handlePlotOptionChange('maxCategories', 5);
    // The same value again is no change of theirs.
    ui._handlePlotOptionChange('maxCategories', 5);
    assert.deepEqual(ui.person, [
      ['detailed', { plot: 'pieplot' }],
      ['detailed', { plotOptions: [{ option: 'maxCategories', value: 5 }] }],
    ]);
    assert.equal(ui._currentConfig.plotType, 'pieplot');
    assert.equal(ui._currentConfig.plotOptions.maxCategories, 5);
  });
});
