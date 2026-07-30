import assert from 'node:assert/strict';
import test from 'node:test';

import { initLegendRenderer } from '../assets/js/app/ui/modules/legend-renderer.js';

function createControl({ checked = false, value = '' } = {}) {
  const listeners = new Map();
  return {
    checked,
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    style: {},
    textContent: '',
    value,
    addEventListener(type, listener, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.removeEventListener(type, listener);
        }, { once: true });
      }
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(candidate => candidate !== listener)
      );
    },
    listeners(type) {
      return [...(listeners.get(type) ?? [])];
    }
  };
}

test('legend destroy retires permanent slider and centroid event owners', () => {
  class FakeHTMLElement {}
  class FakeHTMLButtonElement extends FakeHTMLElement {}
  const viewListeners = new Map();
  const view = {
    HTMLElement: FakeHTMLElement,
    HTMLButtonElement: FakeHTMLButtonElement,
    addEventListener(type, listener, options = {}) {
      viewListeners.set(type, listener);
      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => viewListeners.delete(type),
          { once: true }
        );
      }
    }
  };
  const legendEl = new FakeHTMLElement();
  legendEl.ownerDocument = { defaultView: view };
  legendEl.querySelectorAll = () => [];
  legendEl.replaceChildren = () => {};

  const mutations = [];
  const state = new Proxy({
    getActiveField() {
      return null;
    },
    getActiveViewId() {
      return 'live';
    },
    getDatasetGeneration() {
      return 0;
    },
    getFields() {
      return [];
    },
    on() {
      return () => mutations.push(['unsubscribe']);
    },
    setOutlierThresholdForActive(value) {
      mutations.push(['outlier', value]);
    }
  }, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      return () => {};
    }
  });
  const viewer = {
    getCentroidFlags() {
      return { points: false, labels: false };
    },
    setShowCentroidLabels(value, viewId) {
      mutations.push(['labels', value, viewId]);
    },
    setShowCentroidPoints(value, viewId) {
      mutations.push(['points', value, viewId]);
    }
  };
  const outlierInput = createControl({ value: '25' });
  const centroidPoints = createControl();
  const centroidLabels = createControl();
  const legend = initLegendRenderer({
    state,
    viewer,
    dom: {
      optionsContainer: createControl(),
      legendEl,
      outlierFilterContainer: createControl(),
      outlierFilterInput: outlierInput,
      outlierFilterDisplay: createControl(),
      centroidControls: createControl(),
      centroidPointsCheckbox: centroidPoints,
      centroidLabelsCheckbox: centroidLabels
    },
    dataSourceManager: {
      getCurrentDatasetId() {
        return null;
      }
    }
  });
  const retainedOutlier = outlierInput.listeners('input')[0];
  const retainedPoints = centroidPoints.listeners('change')[0];
  const retainedLabels = centroidLabels.listeners('change')[0];

  legend.destroy();
  legend.destroy();
  mutations.length = 0;

  assert.equal(outlierInput.listeners('input').length, 0);
  assert.equal(centroidPoints.listeners('change').length, 0);
  assert.equal(centroidLabels.listeners('change').length, 0);
  retainedOutlier();
  retainedPoints();
  retainedLabels();
  legend.handleOutlierUI({ outlierQuantiles: [1] });
  legend.refreshCategoryCounts();
  assert.deepEqual(mutations, []);
  assert.equal(viewListeners.size, 0);
});
