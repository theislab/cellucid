import assert from 'node:assert/strict';
import test from 'node:test';

import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createMatrix() {
  return {
    genes: ['RAW_ONLY', 'ADJUSTED_DEFAULT', 'LOW_FOLD_CHANGE'],
    groupIds: ['group-a'],
    groupNames: ['Group A'],
    groupColors: ['#123456'],
    nRows: 3,
    nCols: 1,
    values: new Float32Array([11, 22, 33]),
    rawValues: new Float32Array([111, 222, 333]),
    transform: 'zscore',
  };
}

function createMatrixForGenes(genes, { transform = 'zscore' } = {}) {
  return {
    genes: [...genes],
    groupIds: ['group-a'],
    groupNames: ['Group A'],
    groupColors: ['#123456'],
    nRows: genes.length,
    nCols: 1,
    values: Float32Array.from(genes.map((_, index) => index + 1)),
    rawValues: Float32Array.from(genes.map((_, index) => index + 11)),
    transform,
  };
}

function createMarkers() {
  return {
    groups: {
      'group-a': {
        groupId: 'group-a',
        markers: [],
      },
    },
    stats: {
      genes: ['RAW_ONLY', 'ADJUSTED_DEFAULT', 'LOW_FOLD_CHANGE'],
      groupIds: ['group-a'],
      pValuesByGroup: [
        new Float64Array([0.0001, 0.02, 0.0001]),
      ],
      adjustedPValuesByGroup: [
        new Float64Array([0.2, 0.03, 0.0001]),
      ],
      log2FoldChangeByGroup: [
        new Float64Array([3, 3, 1.5]),
      ],
    },
  };
}

function staleOptions() {
  return {
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: true,
    transform: 'zscore',
  };
}

function requestedOptions() {
  return {
    pValueThreshold: 0.001,
    foldChangeThreshold: 2,
    useAdjustedPValue: false,
    transform: 'zscore',
  };
}

function createResult() {
  return {
    plotType: 'gene-heatmap',
    data: {
      matrix: createMatrix(),
      clustering: null,
    },
    options: staleOptions(),
    markers: createMarkers(),
    metadata: {
      obsCategory: 'cell_type',
      transform: 'zscore',
      batchConfig: {},
    },
  };
}

function createUI() {
  const ui = new GenesPanelUI({
    comparisonModule: {},
    dataLayer: {},
    multiVariableAnalysis: {},
  });
  ui._isDestroyed = false;
  ui._modalGeneListMode = 'top5';
  return ui;
}

test(
  'Genes threshold refresh rebuilds marker groups and matrix from newly requested thresholds',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._fullMatrix = createMatrix();
    ui._requestedPlotOptions = requestedOptions();
    ui._optionRenderRevision = 4;
    ui._rerenderAfterOptionChange = async () => {};

    await ui._refreshMarkersAndHeatmapFromThresholds(4);

    assert.deepEqual(
      ui._lastResult.markers.groups['group-a'].markers.map(marker => marker.gene),
      ['RAW_ONLY'],
      'marker groups must use the requested raw-p, p-value, and fold-change thresholds',
    );
    assert.deepEqual(
      ui._lastResult.data.matrix.genes,
      ['RAW_ONLY'],
      'the displayed heatmap matrix must be sliced from the same requested thresholds',
    );
  },
);

test(
  'Genes threshold intent starts only its specialized recomputation before rendering',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._requestedPlotOptions = staleOptions();
    ui._optionRenderRevision = 7;

    const specializedGate = deferred();
    let specializedCalls = 0;
    let genericRenderCalls = 0;
    ui._reconcileGeneHeatmapIntent = () => {
      specializedCalls += 1;
      return specializedGate.promise;
    };
    ui._rerenderAfterOptionChange = async revision => {
      // Match the real renderer's first asynchronous cancellation boundary:
      // a specialized intent may invalidate the generic task before Plotly work.
      await Promise.resolve();
      if (revision !== ui._optionRenderRevision) return;
      genericRenderCalls += 1;
    };

    ui._handlePlotOptionChange('pValueThreshold', 0.001);
    await waitFor(
      () => specializedCalls === 1,
      'specialized threshold recomputation',
    );
    const rendersBeforeSpecializedSettlement = genericRenderCalls;
    specializedGate.resolve();
    await specializedGate.promise;

    assert.equal(
      rendersBeforeSpecializedSettlement,
      0,
      'threshold intent must not launch a generic render in parallel with scientific recomputation',
    );
  },
);

test(
  'Genes threshold option handler returns and awaits its specialized owner task',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._requestedPlotOptions = staleOptions();
    ui._optionRenderRevision = 2;

    const specializedGate = deferred();
    let specializedStarted = false;
    ui._reconcileGeneHeatmapIntent = () => {
      specializedStarted = true;
      return specializedGate.promise;
    };
    ui._rerenderAfterOptionChange = async () => {};

    const operation = ui._handlePlotOptionChange(
      'foldChangeThreshold',
      2,
    );
    await waitFor(() => specializedStarted, 'threshold owner task');

    const isAwaitable = typeof operation?.then === 'function';
    let settled = false;
    Promise.resolve(operation).then(() => {
      settled = true;
    });
    await Promise.resolve();
    const settledBeforeOwner = settled;

    specializedGate.resolve();
    await specializedGate.promise;
    await Promise.resolve(operation);

    assert.equal(isAwaitable, true);
    assert.equal(
      settledBeforeOwner,
      false,
      'the public option task cannot settle before specialized recomputation',
    );
  },
);

test(
  'Genes transform option handler returns and awaits its specialized owner task',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._requestedPlotOptions = staleOptions();
    ui._optionRenderRevision = 5;

    const specializedGate = deferred();
    let specializedStarted = false;
    ui._reconcileGeneHeatmapIntent = () => {
      specializedStarted = true;
      return specializedGate.promise;
    };
    ui._rerenderAfterOptionChange = async () => {};

    const operation = ui._handlePlotOptionChange('transform', 'log1p');
    await waitFor(() => specializedStarted, 'transform owner task');

    const isAwaitable = typeof operation?.then === 'function';
    let settled = false;
    Promise.resolve(operation).then(() => {
      settled = true;
    });
    await Promise.resolve();
    const settledBeforeOwner = settled;

    specializedGate.resolve();
    await specializedGate.promise;
    await Promise.resolve(operation);

    assert.equal(isAwaitable, true);
    assert.equal(
      settledBeforeOwner,
      false,
      'the public option task cannot settle before transform recomputation',
    );
  },
);

test(
  'Genes threshold refresh awaits the downstream plot render it starts',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._fullMatrix = createMatrix();
    ui._requestedPlotOptions = requestedOptions();
    ui._optionRenderRevision = 9;

    const renderGate = deferred();
    let renderStarted = false;
    ui._renderStagedGeneResult = () => {
      renderStarted = true;
      return renderGate.promise.then(() => true);
    };

    const operation = ui._refreshMarkersAndHeatmapFromThresholds(9);
    await waitFor(() => renderStarted, 'threshold downstream render');
    let settled = false;
    operation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    const settledBeforeRender = settled;

    renderGate.resolve();
    await operation;

    assert.equal(
      settledBeforeRender,
      false,
      'threshold recomputation cannot settle before its plot render',
    );
  },
);

test(
  'Genes transform refresh awaits the downstream plot render it starts',
  async () => {
    const ui = createUI();
    ui._lastResult = createResult();
    ui._fullMatrix = createMatrix();
    ui._optionRenderRevision = 12;
    ui._controller = {
      retransform({ matrix }, transform) {
        return {
          matrix: {
            ...matrix,
            transform,
          },
        };
      },
    };

    const renderGate = deferred();
    let renderStarted = false;
    ui._renderStagedGeneResult = () => {
      renderStarted = true;
      return renderGate.promise.then(() => true);
    };

    const operation = ui._refreshHeatmapTransform(12, 'log1p');
    await waitFor(() => renderStarted, 'transform downstream render');
    let settled = false;
    operation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    const settledBeforeRender = settled;

    renderGate.resolve();
    await operation;

    assert.equal(
      settledBeforeRender,
      false,
      'transform recomputation cannot settle before its plot render',
    );
  },
);

test(
  'Genes initial matrix filtering uses the exact submitted form thresholds',
  async () => {
    const ui = createUI();
    ui._isCurrentAnalysisRequest = () => true;
    ui._controller = {
      async runAnalysis() {
        return {
          matrix: createMatrix(),
          markers: createMarkers(),
          clustering: null,
          metadata: {
            obsCategory: 'cell_type',
            transform: 'zscore',
            batchConfig: {},
          },
        };
      },
    };

    const output = await ui._runAnalysisImpl(
      {
        obsCategory: 'cell_type',
        mode: 'clustered',
        colorscale: 'RdBu',
        ...requestedOptions(),
        transform: 'log1p',
      },
      1,
      {},
    );

    assert.deepEqual(
      output.result.data.matrix.genes,
      ['RAW_ONLY'],
      'initial heatmap filtering must not fall back to defaults or a prior result',
    );
    assert.deepEqual(
      {
        pValueThreshold: output.result.options.pValueThreshold,
        foldChangeThreshold: output.result.options.foldChangeThreshold,
        useAdjustedPValue: output.result.options.useAdjustedPValue,
        transform: output.result.options.transform,
      },
      {
        pValueThreshold: 0.001,
        foldChangeThreshold: 2,
        useAdjustedPValue: false,
        transform: 'log1p',
      },
    );
  },
);

test('Genes All mode still filters the matrix with current scientific thresholds', () => {
  const ui = createUI();
  ui._modalGeneListMode = 'all';

  const matrix = ui._buildHeatmapMatrixForMode({
    matrix: createMatrix(),
    markers: createMarkers(),
    mode: 'all',
    thresholdOptions: requestedOptions(),
  });

  assert.deepEqual(
    matrix.genes,
    ['RAW_ONLY'],
    'All means every qualifying marker, not every row retained by an older threshold',
  );
});

test('Genes threshold rebuild preserves every prototype-named marker group', () => {
  const ui = createUI();
  const groupIds = Object.getOwnPropertyNames(Object.prototype);
  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    Object.prototype,
  );
  const groups = Object.fromEntries(
    groupIds.map(groupId => [
      groupId,
      {
        groupId,
        groupName: `Group ${groupId}`,
        markers: [],
      },
    ]),
  );

  const rebuilt = ui._rebuildMarkerGroupsFromStats({
    markers: {
      groups,
      stats: {
        genes: ['GENE'],
        groupIds,
        pValuesByGroup: groupIds.map(() => Float64Array.of(0.001)),
        adjustedPValuesByGroup: groupIds.map(
          () => Float64Array.of(0.001),
        ),
        log2FoldChangeByGroup: groupIds.map(() => Float64Array.of(2)),
      },
    },
    topN: 1,
    thresholdOptions: {
      pValueThreshold: 0.05,
      foldChangeThreshold: 1,
      useAdjustedPValue: true,
    },
  });

  assert.equal(Object.getPrototypeOf(rebuilt), Object.prototype);
  assert.deepEqual(Object.keys(rebuilt), groupIds);
  for (const groupId of groupIds) {
    assert.equal(Object.hasOwn(rebuilt, groupId), true, groupId);
    assert.equal(rebuilt[groupId].groupId, groupId);
    assert.equal(rebuilt[groupId].groupName, `Group ${groupId}`);
    assert.equal(rebuilt[groupId].markers[0].groupId, groupId);
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(Object.prototype),
    prototypeDescriptors,
  );
});

test('Genes modal replaces an inherited-only stale group selection', t => {
  const priorDocument = globalThis.document;
  const stopAfterSelection = new Error('stop after exact group selection');
  globalThis.document = {
    createElement() {
      throw stopAfterSelection;
    },
  };
  t.after(() => {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  });

  const ui = createUI();
  ui._modalAnnotationsRenderRevision = 0;
  ui._modalSelectedGroupId = 'constructor';
  ui._lastResult = {
    markers: {
      groups: {
        'group-a': {
          groupId: 'group-a',
          markers: [],
        },
      },
    },
  };

  assert.throws(
    () => ui._renderModalAnnotations({ innerHTML: '' }),
    error => error === stopAfterSelection,
  );
  assert.equal(ui._modalSelectedGroupId, 'group-a');
});

test('Genes explicit threshold values are exact and never silently defaulted', () => {
  const ui = createUI();

  assert.throws(
    () => ui._getMarkerThresholdOptions({
      pValueThreshold: Number.NaN,
      foldChangeThreshold: 1,
      useAdjustedPValue: true,
    }),
    /p-value.*finite|threshold.*finite/i,
  );
  assert.throws(
    () => ui._getMarkerThresholdOptions({
      pValueThreshold: 0.05,
      foldChangeThreshold: -1,
      useAdjustedPValue: true,
    }),
    /fold.*non-negative|fold.*range/i,
  );
  assert.throws(
    () => ui._getMarkerThresholdOptions({
      pValueThreshold: 0.05,
      foldChangeThreshold: 1,
      useAdjustedPValue: 'false',
    }),
    /adjusted.*boolean/i,
  );
  assert.deepEqual(
    ui._getMarkerThresholdOptions({}),
    {
      pValueThreshold: 0.05,
      foldChangeThreshold: 1,
      useAdjustedPValue: true,
    },
    'only absent values may adopt declared defaults',
  );
});

test('Genes raw-p mode ranks by raw p when adjusted p-values tie', () => {
  const ui = createUI();
  const picked = ui._computeTopMarkersForGroupIndex({
    groupId: 'group-a',
    geneKeys: ['LOWER_RAW_P', 'LARGER_EFFECT'],
    pValuesEffective: new Float64Array([0.001, 0.002]),
    pValuesRaw: new Float64Array([0.001, 0.002]),
    adjPValues: new Float64Array([0.01, 0.01]),
    log2FC: new Float32Array([1, 5]),
    topN: 1,
    pValueThreshold: 0.05,
    foldChangeThreshold: 0,
  });

  assert.deepEqual(
    picked.map(marker => marker.gene),
    ['LOWER_RAW_P'],
  );
});

test('Genes zero-marker thresholds atomically replace stale heatmap rows', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._fullMatrix = createMatrix();
  ui._requestedPlotOptions = {
    ...staleOptions(),
    pValueThreshold: 0,
  };
  ui._optionRenderRevision = 20;
  ui._renderStagedGeneResult = async () => true;
  ui._rerenderAfterOptionChange = async () => {};

  await ui._refreshMarkersAndHeatmapFromThresholds(
    20,
    ui._requestedPlotOptions,
  );

  assert.equal(ui._lastResult.data.matrix.nRows, 0);
  assert.deepEqual(ui._lastResult.data.matrix.genes, []);
  assert.equal(ui._lastResult.data.matrix.values.length, 0);
  assert.deepEqual(
    ui._lastResult.markers.groups['group-a'].markers,
    [],
  );
  assert.equal(
    ui._serializeHeatmapCSV(ui._lastResult.data.matrix),
    'gene,Group A',
    'an empty scientific result exports only its exact header',
  );
});

test('Genes zero-row render owns an explicit no-markers candidate without hover', async () => {
  const ui = createUI();
  const result = createResult();
  result.data.matrix = createMatrixForGenes([]);
  let hoverSetupCalls = 0;
  ui._setupHoverContext = () => {
    hoverSetupCalls += 1;
  };

  const ownerDocument = {
    createElement() {
      return {
        attributes: new Map(),
        className: '',
        textContent: '',
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
      };
    },
  };
  const candidate = {
    ownerDocument,
    children: [],
    replaceChildren(...children) {
      this.children = children;
    },
  };
  const slot = {
    async render(payload, { isCurrent }) {
      assert.equal(isCurrent(), true);
      await payload.render(candidate);
      assert.equal(Object.hasOwn(payload, 'onRendered'), false);
      return candidate;
    },
  };

  const committed = await ui._renderGeneResultInSlot({
    slot,
    result,
    isCurrent: () => true,
  });

  assert.equal(committed, candidate);
  assert.equal(candidate.children.length, 1);
  assert.equal(
    candidate.children[0].textContent,
    'No marker genes match the current thresholds.',
  );
  assert.equal(candidate.children[0].attributes.get('role'), 'status');
  assert.equal(hoverSetupCalls, 0);
});

test('Genes Top-N changes preserve the currently requested thresholds', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._fullMatrix = createMatrix();
  ui._requestedPlotOptions = requestedOptions();
  ui._modalGeneListMode = 'top5';
  ui._renderStagedGeneResult = async () => true;
  ui._rerenderAfterOptionChange = async () => {};

  await ui._rerenderHeatmapForModalSelection();

  assert.deepEqual(
    ui._lastResult.markers.groups['group-a'].markers.map(marker => marker.gene),
    ['RAW_ONLY'],
  );
  assert.deepEqual(ui._lastResult.data.matrix.genes, ['RAW_ONLY']);
});

test('Genes missing selected rows trigger a complete matrix build', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._lastResult.data.matrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._fullMatrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._requestedPlotOptions = requestedOptions();
  ui._optionRenderRevision = 30;
  ui._renderStagedGeneResult = async () => true;
  ui._rerenderAfterOptionChange = async () => {};

  const buildCalls = [];
  ui._controller = {
    async getGroupsAndCodes() {
      return {
        groups: [{
          groupId: 'group-a',
          groupName: 'Group A',
          color: '#123456',
          cellIndices: new Uint32Array([0]),
        }],
      };
    },
    async buildMatrixForGenes(options) {
      buildCalls.push([...options.genes]);
      return createMatrixForGenes(options.genes, {
        transform: options.transform,
      });
    },
    retransform({ matrix }, transform) {
      return { matrix: { ...matrix, transform } };
    },
  };

  await ui._refreshMarkersAndHeatmapFromThresholds(
    30,
    ui._requestedPlotOptions,
  );

  assert.deepEqual(buildCalls, [['RAW_ONLY']]);
  assert.deepEqual(ui._lastResult.data.matrix.genes, ['RAW_ONLY']);
});

test('Genes render failure leaves every committed scientific field unchanged', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._fullMatrix = createMatrix();
  ui._requestedPlotOptions = requestedOptions();
  ui._optionRenderRevision = 40;
  const renderFailure = new Error('candidate render failed');
  ui._renderStagedGeneResult = async () => {
    throw renderFailure;
  };
  ui._rerenderAfterOptionChange = async () => {
    throw renderFailure;
  };

  const before = {
    genes: [...ui._lastResult.data.matrix.genes],
    markerGenes: ui._lastResult.markers.groups['group-a'].markers.map(
      marker => marker.gene,
    ),
    metadata: { ...ui._lastResult.metadata },
    options: { ...ui._lastResult.options },
  };

  await assert.rejects(
    ui._refreshMarkersAndHeatmapFromThresholds(
      40,
      ui._requestedPlotOptions,
    ),
    error => error === renderFailure,
  );

  assert.deepEqual(ui._lastResult.data.matrix.genes, before.genes);
  assert.deepEqual(
    ui._lastResult.markers.groups['group-a'].markers.map(marker => marker.gene),
    before.markerGenes,
  );
  assert.deepEqual(ui._lastResult.metadata, before.metadata);
  assert.deepEqual(ui._lastResult.options, before.options);
});

test('Genes later visual intent converges pending scientific selection instead of canceling it', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._lastResult.data.matrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._fullMatrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._requestedPlotOptions = {
    ...requestedOptions(),
    useAdjustedPValue: true,
  };
  ui._optionRenderRevision = 50;
  ui._renderStagedGeneResult = async () => true;
  ui._rerenderAfterOptionChange = async (revision, options) => {
    if (revision === ui._optionRenderRevision) {
      ui._lastResult.options = { ...options };
    }
  };

  const groupGate = deferred();
  let groupCalls = 0;
  ui._controller = {
    async getGroupsAndCodes() {
      groupCalls += 1;
      await groupGate.promise;
      return {
        groups: [{
          groupId: 'group-a',
          groupName: 'Group A',
          color: '#123456',
          cellIndices: new Uint32Array([0]),
        }],
      };
    },
    async buildMatrixForGenes(options) {
      return createMatrixForGenes(options.genes, {
        transform: options.transform,
      });
    },
    retransform({ matrix }, transform) {
      return { matrix: { ...matrix, transform } };
    },
  };

  const scientificTask = ui._handlePlotOptionChange(
    'useAdjustedPValue',
    false,
  );
  await waitFor(() => groupCalls === 1, 'pending scientific matrix rebuild');
  const visualTask = ui._handlePlotOptionChange('colorscale', 'Viridis');
  groupGate.resolve();

  await Promise.all([scientificTask, visualTask]);

  assert.deepEqual(ui._lastResult.data.matrix.genes, ['RAW_ONLY']);
  assert.equal(ui._lastResult.options.useAdjustedPValue, false);
  assert.equal(ui._lastResult.options.colorscale, 'Viridis');
});

test('Genes visual-only intent reuses the committed marker selection', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._lastResult.data.matrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._lastResult.markers.groups['group-a'].markers = [{
    gene: 'ADJUSTED_DEFAULT',
    geneIndex: 1,
    groupId: 'group-a',
    pValue: 0.02,
    adjustedPValue: 0.03,
    log2FoldChange: 3,
    rank: 1,
  }];
  ui._fullMatrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._requestedPlotOptions = staleOptions();
  ui._committedGeneListMode = 'top5';
  ui._optionRenderRevision = 65;
  ui._renderStagedGeneResult = async () => true;
  ui._rebuildMarkerGroupsFromStats = () => {
    throw new Error('visual intent rescanned all marker statistics');
  };

  await ui._reconcileGeneHeatmapIntent(
    65,
    {
      ...staleOptions(),
      colorscale: 'Viridis',
    },
    'top5',
  );

  assert.deepEqual(
    ui._lastResult.data.matrix.genes,
    ['ADJUSTED_DEFAULT'],
  );
  assert.equal(ui._lastResult.options.colorscale, 'Viridis');
});

test('Genes stale matrix work cannot publish marker groups or rows', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._lastResult.data.matrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._fullMatrix = createMatrixForGenes(['ADJUSTED_DEFAULT']);
  ui._requestedPlotOptions = requestedOptions();
  ui._optionRenderRevision = 70;
  ui._renderStagedGeneResult = async () => true;

  const groupGate = deferred();
  let groupStarted = false;
  ui._controller = {
    async getGroupsAndCodes() {
      groupStarted = true;
      await groupGate.promise;
      return { groups: [] };
    },
    async buildMatrixForGenes(options) {
      return createMatrixForGenes(options.genes, {
        transform: options.transform,
      });
    },
  };

  const beforeGroups = ui._lastResult.markers.groups;
  const operation = ui._refreshMarkersAndHeatmapFromThresholds(
    70,
    ui._requestedPlotOptions,
  );
  await waitFor(() => groupStarted, 'stale matrix group load');
  ui._optionRenderRevision = 71;
  groupGate.resolve();
  await operation;

  assert.equal(ui._lastResult.markers.groups, beforeGroups);
  assert.deepEqual(
    ui._lastResult.data.matrix.genes,
    ['ADJUSTED_DEFAULT'],
  );
});

test('Genes invalidate clustering when genes or transform change', async () => {
  const ui = createUI();
  ui._lastResult = createResult();
  ui._lastResult.data.clustering = { rowOrder: ['RAW_ONLY'] };
  ui._lastResult.clustering = ui._lastResult.data.clustering;
  ui._lastResult.options.hasClustering = true;
  ui._fullMatrix = createMatrix();
  ui._requestedPlotOptions = requestedOptions();
  ui._optionRenderRevision = 60;
  ui._renderStagedGeneResult = async () => true;
  ui._rerenderAfterOptionChange = async () => {};

  await ui._refreshMarkersAndHeatmapFromThresholds(
    60,
    ui._requestedPlotOptions,
  );

  assert.equal(ui._lastResult.data.clustering, null);
  assert.equal(ui._lastResult.clustering, null);
  assert.equal(ui._lastResult.options.hasClustering, false);
});
