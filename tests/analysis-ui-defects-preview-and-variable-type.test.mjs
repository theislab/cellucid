/**
 * CEL-0057 and CEL-0058.
 *
 * CEL-0058 — Correlation's expanded view was a bare click listener on the
 * preview `<div>` (`tabindex="-1"`, no role, no accessible name), while DE,
 * Gene Signature and Marker Genes each hand-rolled the same `.analysis-actions`
 * row with a real `.analysis-expand-btn` after calling the shared preview
 * renderer. Correlation was the one that never added it. The affordance now
 * belongs to the preview renderer, so every mode gets exactly one real button.
 *
 * CEL-0057 — Detailed's Variable type select discarded the first interaction.
 * Changing the type reports `('', '')`; the panel read that as "selection
 * cleared", wiped `dataSource` and rebuilt the variable selector from the now
 * empty config, so the type the user had just chosen came back as "None".
 * Choosing the same option again worked, because by then there was no variable
 * left to clear and no rebuild happened. The selector is now built once and
 * re-attached, so the control that raises a change is never destroyed by it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CorrelationAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/correlation-analysis-ui.js';
import { DEAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/de-analysis-ui.js';
import { DetailedAnalysisUI } from '../assets/js/app/analysis/ui/analysis-types/detailed-analysis-ui.js';
import { GeneSignatureUI } from '../assets/js/app/analysis/ui/analysis-types/gene-signature-ui.js';
import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';
import { PlotRegistry } from '../assets/js/app/analysis/shared/plot-registry-utils.js';
import { createRequestIdTracker } from '../assets/js/app/analysis/shared/cancellable-operation.js';

// =============================================================================
// Minimal DOM
// =============================================================================

class FakeStyle {
  setProperty(name, value) {
    this[name] = String(value);
  }

  getPropertyValue(name) {
    return this[name] ?? '';
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  _set() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    const values = this._set();
    for (const name of names) values.add(name);
    this.element.className = [...values].join(' ');
  }

  remove(...names) {
    const values = this._set();
    for (const name of names) values.delete(name);
    this.element.className = [...values].join(' ');
  }

  contains(name) {
    return this._set().has(name);
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    this.title = '';
    this.textContent = '';
    this.type = '';
    this.disabled = false;
    this.tabIndex = -1;
  }

  set innerHTML(value) {
    if (value !== '') throw new Error('Only clearing is supported');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  get innerHTML() {
    return '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const listener of this.listeners.get('click') ?? []) {
      listener.call(this, { preventDefault() {}, stopPropagation() {}, target: this });
    }
  }

  remove() {
    if (this.parentNode === null) return;
    this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
  }

  /** Supports only the single class selectors these tests need. */
  querySelectorAll(selector) {
    const wanted = selector.replace(/^\./, '');
    const found = [];
    for (const child of this.children) {
      if (child.classList.contains(wanted)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

async function withFakeDOM(run) {
  const original = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    createElement: tagName => new FakeElement(tagName)
  };
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

// =============================================================================
// CEL-0058
// =============================================================================

const PREVIEW_MODES = [
  {
    label: 'Correlation',
    prototype: CorrelationAnalysisUI.prototype,
    plotType: '__defects-correlation-preview__',
    configure(ui) {
      ui._plotContainerIdBase = 'correlation-preview';
    }
  },
  {
    label: 'Differential Expression',
    prototype: DEAnalysisUI.prototype,
    plotType: '__defects-de-preview__',
    configure(ui) {
      ui._plotContainerIdBase = 'de-preview';
    }
  },
  {
    label: 'Gene Signature',
    prototype: GeneSignatureUI.prototype,
    plotType: '__defects-signature-preview__',
    configure(ui) {
      ui._instanceId = 'signature-preview';
    }
  },
  {
    label: 'Marker Genes',
    prototype: GenesPanelUI.prototype,
    plotType: '__defects-genes-panel-preview__',
    configure(ui) {
      ui._plotContainerId = 'genes-panel-preview';
      ui._currentMode = 'clustered';
      ui._setupHoverContext = () => {};
    }
  }
];

function previewHarness(modeCase) {
  const ui = Object.create(modeCase.prototype);
  ui._resultContainer = new FakeElement('div');
  ui._analysisRequestTracker = createRequestIdTracker();
  ui._activeAnalysisRequestId = null;
  ui._analysisInvalidationOwner = null;
  ui._isDestroyed = false;
  ui._isLoading = false;
  ui._createOwnedPlotSlot = (host, candidateClassName) => ({
    async render() {
      const candidate = new FakeElement('div');
      candidate.className = candidateClassName;
      host.appendChild(candidate);
      return candidate;
    }
  });
  let modalOpens = 0;
  ui._openExpandedView = async () => {
    modalOpens += 1;
  };
  ui._trackInteractiveTask = task => task;
  modeCase.configure(ui);
  return { ui, modalOpens: () => modalOpens };
}

test('CEL-0058: every analysis preview renders one real Expand button', async () => {
  await withFakeDOM(async () => {
    const originalGet = PlotRegistry.get;
    const originalMergeOptions = PlotRegistry.mergeOptions;
    PlotRegistry.get = () => ({ async render() {} });
    PlotRegistry.mergeOptions = (_plotType, options = {}) => structuredClone(options);

    try {
      for (const modeCase of PREVIEW_MODES) {
        const { ui, modalOpens } = previewHarness(modeCase);
        const requestId = ui._startAnalysisRequest();
        await ui._showResult({ plotType: modeCase.plotType }, requestId);
        ui._finishAnalysisRequest(requestId);

        const buttons = ui._resultContainer.querySelectorAll('.analysis-expand-btn');
        assert.equal(
          buttons.length,
          1,
          `${modeCase.label} must render exactly one Expand button`,
        );
        const [button] = buttons;
        assert.equal(button.tagName, 'BUTTON', modeCase.label);
        assert.equal(button.type, 'button', modeCase.label);
        assert.equal(button.textContent, '⤢ Expand', modeCase.label);
        assert.ok(button.title.length > 0, `${modeCase.label} button has a tooltip`);

        // The preview itself is no longer a mouse-only pseudo control.
        const preview = ui._resultContainer.querySelector('.analysis-preview-container');
        assert.ok(preview, `${modeCase.label} renders a preview container`);
        assert.equal(preview.listeners.get('click'), undefined, modeCase.label);
        assert.equal(preview.style.cursor, undefined, modeCase.label);
        assert.equal(preview.title, '', modeCase.label);

        // The row is laid out by its class, not by an inline style.
        const actions = ui._resultContainer.querySelector('.analysis-actions');
        assert.equal(actions.style.display, undefined, modeCase.label);

        button.click();
        assert.equal(modalOpens(), 1, `${modeCase.label} opens the full view once`);
      }
    } finally {
      PlotRegistry.get = originalGet;
      PlotRegistry.mergeOptions = originalMergeOptions;
    }
  });
});

test('CEL-0058: re-rendering a preview never accumulates Expand buttons', async () => {
  await withFakeDOM(async () => {
    const originalGet = PlotRegistry.get;
    const originalMergeOptions = PlotRegistry.mergeOptions;
    PlotRegistry.get = () => ({ async render() {} });
    PlotRegistry.mergeOptions = (_plotType, options = {}) => structuredClone(options);

    try {
      const { ui } = previewHarness(PREVIEW_MODES[0]);
      for (let run = 0; run < 3; run++) {
        const requestId = ui._startAnalysisRequest();
        await ui._showResult({ plotType: PREVIEW_MODES[0].plotType }, requestId);
        ui._finishAnalysisRequest(requestId);
      }
      assert.equal(
        ui._resultContainer.querySelectorAll('.analysis-expand-btn').length,
        1,
      );
    } finally {
      PlotRegistry.get = originalGet;
      PlotRegistry.mergeOptions = originalMergeOptions;
    }
  });
});

// =============================================================================
// CEL-0057
// =============================================================================

function detailedHarness(dataSource) {
  const ui = Object.create(DetailedAnalysisUI.prototype);
  ui._controlsContainer = new FakeElement('div');
  ui._currentConfig = { dataSource: { ...dataSource } };
  ui._idPrefix = 'detailed';
  ui._variableBlock = new FakeElement('div');
  const calls = [];
  ui._variableSelector = {
    _shown: { ...dataSource },
    getSelectedVariable() {
      return { ...this._shown };
    },
    setSelectedVariable(type, variable) {
      calls.push({ type, variable });
      this._shown = { type, variable };
    },
    destroy() {
      calls.push({ destroyed: true });
    }
  };
  return { ui, calls };
}

test('CEL-0057: a rebuild re-attaches the live selector instead of replacing it', async () => {
  await withFakeDOM(() => {
    const { ui, calls } = detailedHarness({ type: '', variable: '' });
    const block = ui._variableBlock;
    const selector = ui._variableSelector;

    // The selector reports the state `dataSource` cannot express: a type the
    // user has chosen whose variable is not picked yet.
    selector._shown = { type: '', variable: '' };

    ui._renderVariableSelectors();
    assert.equal(ui._variableSelector, selector, 'the selector survives the rebuild');
    assert.equal(ui._variableBlock, block, 'its DOM block survives too');
    assert.deepEqual(ui._controlsContainer.children, [block]);
    assert.deepEqual(calls, [], 'a matching config must not re-render the selector');

    // A second rebuild is equally inert, and does not duplicate the block.
    ui._controlsContainer.innerHTML = '';
    ui._renderVariableSelectors();
    assert.deepEqual(ui._controlsContainer.children, [block]);
    assert.deepEqual(calls, []);
  });
});

test('CEL-0057: clearing a completed selection does not reseed the selector', async () => {
  await withFakeDOM(() => {
    const { ui, calls } = detailedHarness({
      type: 'categorical_obs',
      variable: 'cell_type'
    });
    ui._scheduleUpdate = () => {};
    ui._renderControls = () => ui._renderVariableSelectors();

    // What the selector reports after the user switches the type.
    ui._variableSelector._shown = { type: '', variable: '' };
    ui._handleVariableChange('', '');

    assert.deepEqual(
      ui._currentConfig.dataSource,
      { type: '', variable: '' },
      'the mirror follows the completed selection',
    );
    assert.deepEqual(
      calls,
      [],
      'the selector keeps the type the user just chose',
    );
  });
});

test('CEL-0057: a config the panel owns is still pushed into the selector', async () => {
  await withFakeDOM(() => {
    const { ui, calls } = detailedHarness({ type: '', variable: '' });
    // A restored session or a copied window sets the config directly.
    ui._currentConfig.dataSource = {
      type: 'continuous_obs',
      variable: 'score'
    };
    ui._renderVariableSelectors();
    assert.deepEqual(calls, [{ type: 'continuous_obs', variable: 'score' }]);

    // Re-rendering with the same config is then a no-op.
    ui._controlsContainer.innerHTML = '';
    ui._renderVariableSelectors();
    assert.equal(calls.length, 1);
  });
});
