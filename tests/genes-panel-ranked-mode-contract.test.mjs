/**
 * Marker Genes keeps its display mode, and its CSV export obeys it.
 *
 * All three Marker Genes modes draw the same sidebar preview — a gene heatmap.
 * Ranked Genes differs from Clustered only in that it skips clustering, and its
 * ranked table is rendered in the expanded view by `_renderModalAnnotations`.
 * That is what the user guide promises, so the preview must never lose its plot
 * type for a mode.
 *
 * What the modes *do* differ in is the export. The guide states it directly:
 * Clustered and Custom Genes export the wide `marker_genes_heatmap.csv`, while
 * Ranked Genes exports the per-group `marker_genes_ranked.csv` carrying
 * `group,gene,rank,log2FoldChange,pValue,adjustedPValue,…`. The export decides
 * that from the result's own `metadata.mode`; a result that reached the modal
 * without one cannot be exported correctly and says so instead of guessing.
 *
 * CEL-0229 — what the `group` column contains.
 *
 * `GenesPanelController._buildMarkerGroups` keys each group by a synthetic
 * handle, `category-code:<code>` (`genes-panel-controller.js:1022`), and carries
 * the category it came from alongside it as `groupName`. The handle addresses
 * `markers.groups`, the matrix columns, the hover lookup and the saved
 * `modalSelectedGroupId`, and it means nothing outside the session that minted
 * it. The ranked serializer wrote it into the downloaded file anyway, so a
 * downloaded ranked table read `category-code:0` where the heatmap downloaded
 * from the same analysis read `Ductal` — two exports of one run that cannot be
 * joined on the group. Both encode through `encodeGroupName` now.
 *
 * The fixture below is shaped the way `MarkerDiscoveryEngine` actually emits a
 * result, and that is load bearing. It previously built `markers.groups`
 * entries with no `groupName` at all and asserted the export wrote the handle —
 * pinning, as correct, a shape the engine refuses to produce. A group without a
 * name is unreachable: `_validateGroups` rejects one before a single statistic
 * is computed (`marker-discovery-engine.js:988-1007`), `_buildMarkersFromHeaps`
 * copies the name onto every published group (`:1301`), `cloneMarkerCacheData`
 * carries it through the hot and warm caches by spread
 * (`marker-cache.js:66`), and `_rebuildMarkerGroupsFromStats` preserves it the
 * same way when a threshold moves (`genes-panel-ui.js:1338`) — over a `groupId`
 * set that is `stats.groupIds` element for element, both being
 * `groups.map(g => g.groupId)` of one array. So the export refuses a nameless
 * group rather than falling back to the handle, and the last test here pins
 * that refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GenesPanelUI } from '../assets/js/app/analysis/ui/analysis-types/genes-panel-ui.js';

const GENES = ['STRONG', 'MIDDLE', 'WEAK'];

// The handle is the group id `_buildMarkerGroups` mints; the name is the
// category the user grouped by. Keeping them visibly different is the whole
// point of the fixture — with `group-a`/`group-a` a leak is invisible.
const GROUP_IDS = ['category-code:0', 'category-code:1'];
const GROUP_NAMES = ['T cell', 'B cell'];

function createMatrix(genes = GENES) {
  return {
    genes: [...genes],
    groupIds: [...GROUP_IDS],
    groupNames: [...GROUP_NAMES],
    groupColors: ['#123456', '#654321'],
    nRows: genes.length,
    nCols: 2,
    values: Float32Array.from(genes.flatMap((_, index) => [index, index + 1])),
    rawValues: Float32Array.from(
      genes.flatMap((_, index) => [index + 10, index + 11])
    ),
    transform: 'zscore',
  };
}

function createMarkers() {
  return {
    minCellsPerSide: 10,
    groups: {
      [GROUP_IDS[0]]: {
        groupId: GROUP_IDS[0],
        groupName: GROUP_NAMES[0],
        cellCount: 120,
        color: '#123456',
        genesTested: 3,
        genesUntestable: 0,
        markers: [],
      },
      [GROUP_IDS[1]]: {
        groupId: GROUP_IDS[1],
        groupName: GROUP_NAMES[1],
        cellCount: 140,
        color: '#654321',
        genesTested: 3,
        genesUntestable: 1,
        markers: [],
      },
    },
    stats: {
      genes: [...GENES],
      groupIds: [...GROUP_IDS],
      pValuesByGroup: [
        new Float64Array([0.0001, 0.001, 0.4]),
        new Float64Array([0.002, 0.0003, 0.5]),
      ],
      adjustedPValuesByGroup: [
        new Float64Array([0.0002, 0.002, 0.6]),
        new Float64Array([0.004, 0.0006, 0.7]),
      ],
      log2FoldChangeByGroup: [
        new Float64Array([4, 2, 0.1]),
        new Float64Array([-3, 5, 0.2]),
      ],
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
  ui._isCurrentAnalysisRequest = () => true;
  ui._updateProgress = () => {};
  return ui;
}

function formValues(mode) {
  return {
    obsCategory: 'cell_type',
    mode,
    transform: 'zscore',
    colorscale: 'RdBu',
    pValueThreshold: 0.05,
    foldChangeThreshold: 1,
    useAdjustedPValue: true,
  };
}

function controllerFor(mode) {
  return {
    runAnalysis: async () => ({
      markers: mode === 'custom' ? null : createMarkers(),
      matrix: createMatrix(),
      clustering: null,
      metadata: {
        obsCategory: 'cell_type',
        mode,
        method: 'wilcox',
        transform: 'zscore',
        batchConfig: {},
      },
    }),
    getGroupsAndCodes: async () => ({ groups: [] }),
    buildMatrixForGenes: async () => createMatrix(),
  };
}

test(
  'every Marker Genes mode publishes a heatmap preview that still names its mode',
  async () => {
    for (const mode of ['ranked', 'clustered', 'custom']) {
      const ui = createUI();
      ui._controller = controllerFor(mode);

      const output = await ui._runAnalysisImpl(formValues(mode), 1, null, null);

      assert.equal(
        output.result.plotType,
        'gene-heatmap',
        `${mode} mode must draw the gene heatmap preview in the sidebar`,
      );
      assert.equal(
        output.result.metadata.mode,
        mode,
        `${mode} mode identity must survive onto the published result; the `
          + 'export and the expanded view both dispatch on it',
      );
    }
  },
);

test(
  'Ranked Genes exports the ranked marker table, not the heatmap matrix',
  async () => {
    const ui = createUI();
    ui._controller = controllerFor('ranked');
    const { result } = await ui._runAnalysisImpl(formValues('ranked'), 1, null, null);

    const csvExport = ui._buildModalCSVExport(result);

    assert.equal(csvExport.filename, 'marker_genes_ranked');
    const lines = csvExport.csv.split('\n');
    assert.equal(
      lines[0],
      'group,gene,rank,log2FoldChange,pValue,adjustedPValue,meanInGroup,'
        + 'meanOutGroup,percentInGroup,percentOutGroup',
    );
    assert.ok(
      lines.length > 1,
      'the ranked export must carry the discovered markers, not only a header',
    );
    for (const line of lines.slice(1)) {
      const [group, gene, rank] = line.split(',');
      assert.ok(
        GROUP_NAMES.includes(group),
        `ranked rows must name their group; received ${JSON.stringify(group)}`,
      );
      assert.ok(GENES.includes(gene), `unexpected exported gene ${gene}`);
      assert.ok(Number.isSafeInteger(Number(rank)) && Number(rank) >= 1);
    }
  },
);

test(
  'the ranked export names the category, never the internal group handle',
  async () => {
    const ui = createUI();
    ui._controller = controllerFor('ranked');
    const { result } = await ui._runAnalysisImpl(formValues('ranked'), 1, null, null);

    const { csv } = ui._buildModalCSVExport(result);

    assert.ok(
      !csv.includes('category-code:'),
      'a downloaded ranked table carried `category-code:0` as its group, a '
        + 'handle that means nothing outside the session that minted it:\n'
        + csv,
    );
    // Every group that produced a marker is present under its own name, so the
    // file identifies which cell types were compared.
    assert.deepEqual(
      [...new Set(csv.split('\n').slice(1).map(line => line.split(',')[0]))],
      GROUP_NAMES,
    );
  },
);

test(
  'the two Marker Genes exports of one run agree on what a group is called',
  async () => {
    // The ranked table and the heatmap matrix are the same analysis in two
    // shapes. A user who exports both and joins them on the group needs the
    // strings to match exactly, so both render through `encodeGroupName`.
    const ui = createUI();
    ui._controller = controllerFor('ranked');
    const { result } = await ui._runAnalysisImpl(formValues('ranked'), 1, null, null);

    const rankedGroups = new Set(
      ui._serializeRankedMarkersCSV(result.markers.groups)
        .split('\n')
        .slice(1)
        .map(line => line.split(',')[0]),
    );
    const heatmapColumns = ui._serializeHeatmapCSV(result.data.matrix)
      .split('\n')[0]
      .split(',')
      .slice(1);

    assert.deepEqual([...rankedGroups], heatmapColumns);
  },
);

test(
  'a non-string category name is exported as its label, not dropped',
  async () => {
    // An obs column of integer cluster labels produces numeric group names, and
    // `MarkerDiscoveryEngine` accepts them (`marker-discovery-engine.js:988`).
    // Zero is the case a truthiness test would silently lose.
    const ui = createUI();
    const markers = createMarkers();
    markers.groups[GROUP_IDS[0]].groupName = 0;
    markers.groups[GROUP_IDS[1]].groupName = 12;

    const csv = ui._serializeRankedMarkersCSV({
      [GROUP_IDS[0]]: {
        ...markers.groups[GROUP_IDS[0]],
        markers: [{ gene: 'STRONG', rank: 1, log2FoldChange: 4, pValue: 0.001 }],
      },
      [GROUP_IDS[1]]: {
        ...markers.groups[GROUP_IDS[1]],
        markers: [{ gene: 'MIDDLE', rank: 1, log2FoldChange: 5, pValue: 0.002 }],
      },
    });

    assert.deepEqual(
      csv.split('\n').slice(1).map(line => line.split(',')[0]),
      ['0', '12'],
    );
  },
);

test(
  'a marker group with no category name is refused, not exported as a handle',
  () => {
    // Unreachable through the engine, which is exactly why the export must not
    // carry a fallback for it: a silent handle in the `group` column is how
    // CEL-0229 survived a full contract suite.
    const ui = createUI();
    const groups = createMarkers().groups;
    delete groups[GROUP_IDS[0]].groupName;

    assert.throws(
      () => ui._serializeRankedMarkersCSV(groups),
      {
        name: 'TypeError',
        message: /category-code:0/,
      },
    );
  },
);

test(
  'Clustered and Custom Genes export the wide heatmap matrix',
  async () => {
    for (const mode of ['clustered', 'custom']) {
      const ui = createUI();
      ui._controller = controllerFor(mode);
      const { result } = await ui._runAnalysisImpl(formValues(mode), 1, null, null);

      const csvExport = ui._buildModalCSVExport(result);

      assert.equal(csvExport.filename, 'marker_genes_heatmap');
      assert.equal(
        csvExport.csv.split('\n')[0],
        `gene,${GROUP_NAMES.join(',')}`,
        `${mode} mode must export the wide per-group matrix`,
      );
    }
  },
);

test(
  'a Marker Genes result without a display mode refuses to export',
  () => {
    const ui = createUI();
    assert.throws(
      () => ui._buildModalCSVExport({
        plotType: 'gene-heatmap',
        data: { matrix: createMatrix(), clustering: null },
        markers: createMarkers(),
        metadata: { obsCategory: 'cell_type' },
      }),
      /Unknown marker genes display mode/,
      'an unknown mode must be reported, never silently exported as a heatmap',
    );
  },
);

test(
  'the sidebar has no second, poorer ranked table',
  () => {
    assert.equal(
      typeof GenesPanelUI.prototype._renderRankedMarkers,
      'undefined',
      'the ranked table is `_renderModalAnnotations`, which alone carries the '
        + 'Top-N selector and the FDR-denominator caption; a second unreachable '
        + 'copy in the sidebar is what CEL-0164 was filed against',
    );
  },
);
