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
    const { GenesPanelController } = await import(
      '/assets/js/app/analysis/genes-panel/genes-panel-controller.js'
    );
    const cm = window._comparisonModule;
    const state = cm.state;
    const dataLayer = cm.dataLayer;
    const sameBits = (a, b) => {
      const left = new Uint32Array(Float32Array.from(a).buffer);
      const right = new Uint32Array(Float32Array.from(b).buffer);
      return left.length === right.length && left.every((v, i) => v === right[i]);
    };

    // Reference: each gene's column of the expression the file was written with.
    const reference = new Map();
    const decodeMismatches = [];
    for (const [gene, key] of geneNames.entries()) {
      const expected = Float32Array.from(
        { length: expression.length / geneNames.length },
        (_, cell) => expression[cell * geneNames.length + gene],
      );
      reference.set(key, expected);
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
        pageA,
        pageB,
        method,
        minCells: 10,
      });
      for (const row of run.results) {
        const values = reference.get(row.gene);
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

    const controller = new GenesPanelController({ dataLayer });
    const markerMismatches = [];
    let markerChecks = 0;
    try {
      const { groups, obsCodes } = await controller.getGroupsAndCodes('cell_type');
      const run = await controller.runAnalysis({
        obsCategory: 'cell_type',
        method: 'wilcox',
        useCache: false,
        topNPerGroup: 'all',
        pValueThreshold: 1,
        foldChangeThreshold: 0,
      });
      const { genes, groupIds, pValuesByGroup } = run.markers.stats;
      for (let g = 0; g < groupIds.length; g++) {
        const group = groups.find(candidate => candidate.groupId === groupIds[g]);
        for (let geneIndex = 0; geneIndex < genes.length; geneIndex++) {
          const values = reference.get(genes[geneIndex]);
          const inGroup = [];
          const rest = [];
          for (let cell = 0; cell < obsCodes.length; cell++) {
            if (obsCodes[cell] === 65535 || !Number.isFinite(values[cell])) continue;
            (obsCodes[cell] === group.groupCode ? inGroup : rest).push(values[cell]);
          }
          const expected = mannWhitneyU(inGroup, rest).pValue;
          markerChecks++;
          if (!Object.is(pValuesByGroup[g][geneIndex], expected)) {
            markerMismatches.push(
              `${groupIds[g]} ${genes[geneIndex]}: ${pValuesByGroup[g][geneIndex]} != ${expected}`,
            );
          }
        }
      }
    } finally {
      await controller.close();
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
  expect(proof.markerChecks).toBe(24);
  expect(proof.markerMismatches).toEqual([]);
  expect(errors).toEqual([]);
});
