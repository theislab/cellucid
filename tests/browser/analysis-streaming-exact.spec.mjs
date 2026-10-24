/**
 * The streaming analyses compute the same numbers in every engine.
 *
 * Differential expression and marker discovery stream one gene at a time: the
 * gene's column is read from the AnnData file in the reader worker, the two
 * groups are gathered through per-run plans, and the statistics run in the
 * analysis worker pool. Each of those steps was rewritten for speed, so this
 * pins the end result against references computed on the page itself from the
 * expression the file was written with -- tested with the shared two-sample
 * kernels -- and requires the same IEEE-754 numbers, not close ones.
 */
import { expect, test } from './helpers/test.mjs';
import { serveSyntheticCatalog } from './helpers/anndata-zarr-zip.mjs';
import { appUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'streaming-exact';
const ROOT = appUrl('/tests/browser/fixtures/generated-streaming-exact/');
const CELLS = 72;
const GENES = Object.freeze(Array.from({ length: 8 }, (_, gene) => `GENE${gene + 1}`));
const CATEGORIES = Object.freeze(['alpha', 'beta', 'gamma']);

/** Dense expression, cells x genes: ties, zeros and a gene with one value. */
const X = Float32Array.from({ length: CELLS * GENES.length }, (_, index) => {
  const cell = Math.floor(index / GENES.length);
  const gene = index % GENES.length;
  if (gene === GENES.length - 1) return 1.5;
  const value = ((cell * 31 + gene * 17) % 23) / 7 + (cell % 3 === gene % 3 ? gene : 0);
  return value < 0.5 ? 0 : value;
});

test('streamed DE and marker statistics equal on-page references exactly', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await serveSyntheticCatalog(page, ROOT, {
    id: DATASET,
    name: 'Streaming exact fixture',
    cells: CELLS,
    genes: [...GENES],
    X,
    obs: {
      cell_type: {
        categories: [...CATEGORIES],
        codes: Int8Array.from({ length: CELLS }, (_, cell) => cell % 3),
      },
    },
    obsm: {
      X_umap_2d: {
        data: Float32Array.from({ length: CELLS * 2 }, (_, index) => Math.sin(index * 0.7) * 3),
        columns: 2,
      },
    },
  });
  await page.goto(
    `/?sampleCatalog=${encodeURIComponent(ROOT)}&dataset=${DATASET}`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await page.waitForFunction(
    () => window._comparisonModule?.state?.pointCount === 72,
  );

  const proof = await page.evaluate(async ({ genes: geneNames, expression }) => {
    const { computeDifferential } = await import(
      '/assets/js/app/analysis/compute/operation-handlers.js'
    );
    const { mannWhitneyU } = await import(
      '/assets/js/app/analysis/compute/math-utils.js'
    );
    const { GenesPanelController, GROUP_ID_PREFIX } = await import(
      '/assets/js/app/analysis/genes-panel/genes-panel-controller.js'
    );
    const { MARKER_OPTIONS } = await import('/assets/js/app/analysis/options/marker-options.js');
    const cm = window._comparisonModule;
    const state = cm.state;
    const dataLayer = cm.dataLayer;
    const sameBits = (a, b) => {
      const left = new Uint32Array(Float32Array.from(a).buffer);
      const right = new Uint32Array(Float32Array.from(b).buffer);
      return left.length === right.length && left.every((v, i) => v === right[i]);
    };

    // Reference: each gene's column of the expression the file was written with.
    const referenceColumns = new Map();
    const decodeMismatches = [];
    for (const [gene, key] of geneNames.entries()) {
      const expected = Float32Array.from(
        { length: expression.length / geneNames.length },
        (_, cell) => expression[cell * geneNames.length + gene],
      );
      referenceColumns.set(key, expected);
      const loaded = await dataLayer.ensureGeneExpressionLoaded(key);
      if (!sameBits(loaded.values, expected)) decodeMismatches.push(key);
    }

    await dataLayer.ensureObsFieldLoaded('cell_type');
    const fieldIndex = state.obsData.fields.findIndex(f => f.key === 'cell_type');
    const makePage = (name, category) => {
      const created = state.createHighlightPage(name);
      state.switchToPage(created.id);
      state.addHighlightFromCategory(fieldIndex, category, 'obs');
      return created.id;
    };
    const pageA = makePage('A', 0);
    const pageB = makePage('B', 1);
    const cellsA = dataLayer.getCellIndicesForPage(pageA);
    const cellsB = dataLayer.getCellIndicesForPage(pageB);

    const deMismatches = [];
    let deChecks = 0;
    for (const method of ['wilcox', 'ttest']) {
      const run = await cm.multiVariableAnalysis.differentialExpression({
        groupA: cm.multiVariableAnalysis.pageGroup(pageA),
        groupB: cm.multiVariableAnalysis.pageGroup(pageB),
        method,
        minCells: 10,
      });
      for (const row of run.results) {
        const values = referenceColumns.get(row.gene);
        deChecks++;
        const expected = computeDifferential({
          groupAValues: Float32Array.from(cellsA, i => values[i]),
          groupBValues: Float32Array.from(cellsB, i => values[i]),
          method,
        });
        for (const key of ['meanA', 'meanB', 'log2FoldChange', 'pValue', 'statistic']) {
          if (!Object.is(row[key], expected[key])) {
            deMismatches.push(`${method} ${row.gene} ${key}: ${row[key]} != ${expected[key]}`);
          }
        }
      }
    }

    // Markers against the rest, and against one reference group: every
    // tested group's p-value equals the rank-sum test of its cells against
    // the reference's cells.
    const controller = new GenesPanelController({ dataLayer });
    const markerMismatches = [];
    let markerChecks = 0;
    const codes = (await dataLayer.ensureObsFieldLoaded('cell_type')).codes;
    try {
      for (const choice of [{ compareAgainst: 'rest' }, { compareAgainst: 'group', referenceGroup: 'beta' }]) {
        const options = MARKER_OPTIONS.withDefaults(
          { groupBy: 'cell_type', minCells: 2, ...choice },
          {
            categoricalFields: [{ key: 'cell_type' }],
            groupsFor: () => ['alpha', 'beta', 'gamma'].map(name => ({ id: name, name, count: 24 })),
          },
        );
        controller.clearCache();
        const { stats } = await controller.runAnalysis({ options });
        const codeOf = group => Number(group.groupId.slice(GROUP_ID_PREFIX.length));
        const reference = stats.groups.find(group => group.reference) ?? null;
        stats.groups.forEach((group, g) => {
          if (!group.tested) return;
          for (let geneIndex = 0; geneIndex < stats.genes.length; geneIndex++) {
            const values = referenceColumns.get(stats.genes[geneIndex]);
            const inGroup = [];
            const rest = [];
            for (let cell = 0; cell < codes.length; cell++) {
              if (!Number.isFinite(values[cell])) continue;
              if (codes[cell] === codeOf(group)) inGroup.push(values[cell]);
              else if (reference === null || codes[cell] === codeOf(reference)) rest.push(values[cell]);
            }
            const expected = mannWhitneyU(inGroup, rest).pValue;
            markerChecks++;
            if (!Object.is(stats.pValuesByGroup[g][geneIndex], expected)) {
              markerMismatches.push(
                `${choice.compareAgainst} ${group.groupName} ${stats.genes[geneIndex]}: ${stats.pValuesByGroup[g][geneIndex]} != ${expected}`,
              );
            }
          }
        });
      }
    } finally {
      controller.close();
    }

    return {
      genes: geneNames.length,
      decodeMismatches,
      deChecks,
      deMismatches,
      markerChecks,
      markerMismatches,
    };
  }, { genes: GENES, expression: Array.from(X) });

  expect(proof.genes).toBe(8);
  expect(proof.decodeMismatches).toEqual([]);
  expect(proof.deChecks).toBe(16);
  expect(proof.deMismatches).toEqual([]);
  // 3 groups x 8 genes against the rest, 2 groups x 8 genes against beta.
  expect(proof.markerChecks).toBe(40);
  expect(proof.markerMismatches).toEqual([]);
  expect(errors).toEqual([]);
});
