import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeFragment {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.children = [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this.textContent = '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) {
      if (child instanceof FakeFragment) {
        for (const fragmentChild of child.children) {
          this.appendChild(fragmentChild);
        }
      } else {
        this.appendChild(child);
      }
    }
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) throw new Error('child is not mounted');
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      right: 160,
      bottom: 100,
      width: 160,
      height: 100,
    };
  }
}

class FakePlotElement extends FakeElement {
  constructor(ownerDocument) {
    super(ownerDocument, 'div');
    this.listeners = new Map();
  }

  on(eventName, listener) {
    if (this.listeners.has(eventName)) {
      throw new Error(`duplicate ${eventName} listener`);
    }
    this.listeners.set(eventName, listener);
    return this;
  }

  removeListener(eventName, listener) {
    if (this.listeners.get(eventName) !== listener) {
      throw new Error(`unknown ${eventName} listener`);
    }
    this.listeners.delete(eventName);
    return this;
  }

  emit(eventName, data) {
    const listener = this.listeners.get(eventName);
    if (typeof listener !== 'function') {
      throw new Error(`missing ${eventName} listener`);
    }
    return listener(data);
  }
}

function createFakeDocument() {
  const createdTags = [];
  const view = {
    innerWidth: 800,
    innerHeight: 600,
    setTimeout,
    clearTimeout,
  };
  const document = {
    defaultView: view,
    body: null,
    createElement(tagName) {
      createdTags.push(tagName);
      return new FakeElement(document, tagName);
    },
    createDocumentFragment() {
      return new FakeFragment(document);
    },
  };
  document.body = new FakeElement(document, 'body');
  return { document, createdTags };
}

function createResult(markers) {
  return {
    data: {
      matrix: {
        genes: ['GENE_A'],
        groupIds: ['category-code:0'],
        groupNames: ['Displayed group'],
        nRows: 1,
        nCols: 1,
      },
    },
    markers,
  };
}

function createMarkerResults() {
  return {
    groups: {
      'category-code:0': {
        groupId: 'category-code:0',
        markers: [{
          gene: 'GENE_A',
          groupId: 'category-code:0',
          rank: 1,
          pValue: 0.002,
          adjustedPValue: 0.004,
          log2FoldChange: 2.5,
          percentInGroup: 75,
        }],
      },
    },
  };
}

function collectText(element) {
  return [
    element.textContent,
    ...element.children.flatMap(child => collectText(child)),
  ].filter(Boolean);
}

function createUiHarness() {
  const ui = Object.create(GenesPanelUI.prototype);
  ui._hoverContext = null;
  ui._hoverPlotBinding = null;
  return ui;
}

test('GenesPanel hover uses exact heatmap identity, coordinates, and listener ownership', () => {
  const { document, createdTags } = createFakeDocument();
  const firstPlot = new FakePlotElement(document);
  const ui = createUiHarness();
  const result = createResult(createMarkerResults());

  ui._setupHoverContext(firstPlot, result);
  assert.deepEqual(
    new Set(firstPlot.listeners.keys()),
    new Set(['plotly_hover', 'plotly_unhover']),
  );
  assert.equal(document.body.children.length, 1);
  assert.equal(createdTags.includes('style'), false);

  firstPlot.emit('plotly_hover', {
    points: [{
      pointNumber: [0, 0],
      x: 'GENE_A',
      y: 'Displayed group',
      z: 1.25,
    }],
    event: { clientX: 120, clientY: 140 },
  });

  const tooltip = document.body.children[0];
  assert.equal(tooltip.classList.contains('visible'), true);
  assert.equal(tooltip.style.left, '130px');
  assert.equal(tooltip.style.top, '150px');
  assert.deepEqual(
    collectText(tooltip),
    [
      'GENE_A',
      'Displayed group',
      'Value:',
      '1.25',
      'p-value:',
      '0.002',
      'Adj. p-value:',
      '0.004',
      'Log2 FC:',
      '2.50',
      '% in group:',
      '75.0%',
      'Rank:',
      '#1',
    ],
    'marker lookup must use the exact groupId, not its display label',
  );

  const secondPlot = new FakePlotElement(document);
  ui._setupHoverContext(secondPlot, result);
  assert.equal(firstPlot.listeners.size, 0);
  assert.equal(secondPlot.listeners.size, 2);
  assert.equal(document.body.children.length, 1);

  ui._teardownHoverContext();
  assert.equal(secondPlot.listeners.size, 0);
  assert.equal(document.body.children.length, 0);
});

test('GenesPanel hover rejects missing event coordinates and malformed heatmap points', () => {
  const { document } = createFakeDocument();
  const plot = new FakePlotElement(document);
  const ui = createUiHarness();
  ui._setupHoverContext(plot, createResult(null));

  assert.throws(
    () => plot.emit('plotly_hover', {
      points: [{
        pointNumber: [0, 0],
        x: 'GENE_A',
        y: 'Displayed group',
        z: 1,
        xpx: 200,
        ypx: 100,
      }],
      event: {},
    }),
    /finite client coordinates/i,
  );
  assert.throws(
    () => plot.emit('plotly_hover', {
      points: [{
        x: 'GENE_A',
        y: 'Displayed group',
        z: 1,
      }],
      event: { clientX: 10, clientY: 20 },
    }),
    /heatmap index pair/i,
  );

  ui._teardownHoverContext();
});

test('GenesPanel hover source has no coordinate or runtime-style alternate path', async () => {
  const [uiSource, hoverSource] = await Promise.all([
    readFile(
      new URL(
        '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        '../assets/js/app/analysis/ui/components/hover-context.js',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);

  assert.doesNotMatch(
    uiSource.slice(
      uiSource.indexOf('_setupHoverContext('),
      uiSource.indexOf('_updateProgress(', uiSource.indexOf('_setupHoverContext(')),
    ),
    /\.on\?\.|xpx|ypx|touches|center of plot|\{ x: 0, y: 0 \}/,
  );
  assert.doesNotMatch(
    hoverSource,
    /style\.cssText|createElement\(['"]style['"]\)|#[0-9a-f]{3,8}|var\([^)]*,/,
  );
});
