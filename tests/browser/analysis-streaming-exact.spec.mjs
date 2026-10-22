/**
 * The streaming analyses compute the same numbers in every engine.
 *
 * Differential expression and marker discovery stream one gene at a time: the
 * gene's gzip payload is inflated and dequantized in the decode worker, the two
 * groups are gathered through per-run plans, and the statistics run in the
 * analysis worker pool. Each of those steps was rewritten for speed, so this
 * pins the end result against references computed on the page itself from the
 * raw files — inflated on the main thread, decoded with the published formula
 * and tested with the shared two-sample kernels — and requires the same
 * IEEE-754 numbers, not close ones.
 */
import { expect, test } from './helpers/test.mjs';
import { appUrl, encodedAppUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET = 'synthetic-cell-types-2d';
const DATASET_BASE = appUrl(
  `/tests/browser/fixtures/demo-custom-exports/${DATASET}/`,
);

test('streamed DE and marker statistics equal on-page references exactly', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto(
    `/?exportsBaseUrl=${encodedAppUrl('/tests/browser/fixtures/demo-custom-exports/')}` +
      `&dataset=${DATASET}`,
    { waitUntil: 'domcontentloaded' },
  );
  await dismissWelcome(page);
  await page.waitForFunction(
    () => window._comparisonModule?.state?.pointCount === 72,
  );

  const proof = await page.evaluate(async datasetBase => {
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

    // Reference decode: the raw file, inflated here, decoded by the formula.
    const manifest = await (await fetch(`${datasetBase}var_manifest.json`)).json();
    const reference = new Map();
    const decodeMismatches = [];
    for (const [index, key, minValue, maxValue] of manifest.fields) {
      const path = manifest._varSchema.pathPattern.replace('{index}', String(index));
      const compressed = await (await fetch(`${datasetBase}${path}`)).arrayBuffer();
      const inflated = await new Response(
        new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer();
      const codes = new Uint8Array(inflated);
      const expected = new Float32Array(codes.length);
      const scale = (maxValue - minValue) / 254;
      for (let i = 0; i < codes.length; i++) {
        expected[i] = codes[i] === 255
          ? NaN
          : (minValue === maxValue ? minValue : minValue + codes[i] * scale);
      }
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
      genes: manifest.fields.length,
      decodeMismatches,
      deChecks,
      deMismatches,
      markerChecks,
      markerMismatches,
    };
  }, DATASET_BASE);

  expect(proof.genes).toBe(8);
  expect(proof.decodeMismatches).toEqual([]);
  expect(proof.deChecks).toBe(16);
  expect(proof.deMismatches).toEqual([]);
  expect(proof.markerChecks).toBe(24);
  expect(proof.markerMismatches).toEqual([]);
  expect(errors).toEqual([]);
});
