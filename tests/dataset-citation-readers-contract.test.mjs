/**
 * The dataset's citation reaches every place that quotes it. The open
 * dataset's metadata carries it as `citation: {text, url}` (from
 * `uns['cellucid']`, or the provider that served the file); its `source` is
 * where the data comes from and never holds one (the identity check refuses a
 * `source.citation`). The methods paragraph, the history report, a figure's
 * provenance and the agents' `dataset_summary` once read `source.citation`,
 * so every one of them said nothing of how to cite any dataset, and an agent
 * writing a methods paragraph told the person "the dataset has no citation
 * recorded" for a sample that has one (live pass 3, L12-2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { citationText } from '../assets/js/data/anndata-cellucid-metadata.js';
import { datasetFactsOf } from '../assets/js/app/ui/modules/state/dataset-facts.js';
import { buildProvenanceJson } from '../assets/js/app/ui/modules/figure-export/utils/figure-provenance.js';

const JS_ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));
const TEXT = 'Bastidas-Ponce A, et al. Development. 2019;146(12):dev173849.';
const URL_ = 'https://doi.org/10.1242/dev.173849';

test('citationText: the text, then its address unless the text carries it; null without one', () => {
  assert.equal(citationText({ text: TEXT, url: URL_ }), `${TEXT} ${URL_}`);
  assert.equal(citationText({ text: `${TEXT} ${URL_}`, url: URL_ }), `${TEXT} ${URL_}`);
  assert.equal(citationText({ text: TEXT, url: null }), TEXT);
  assert.equal(citationText({ text: '  ', url: URL_ }), null);
  assert.equal(citationText(null), null);
  assert.equal(citationText(undefined), null);
});

test('the methods and report facts quote the metadata citation', () => {
  const facts = datasetFactsOf({
    state: { cellIdentity: { n: 10, nOriginal: 10, isSubset: false } },
    dataSourceManager: {
      getCurrentMetadata: () => ({
        name: 'Pancreas', stats: { n_cells: 10, n_genes: 5 },
        source: { name: 'scVelo', url: 'https://scvelo.org' },
        citation: { text: TEXT, url: URL_ },
      }),
      getCurrentDatasetId: () => 'pancreas',
      getCurrentSourceType: () => 'remote',
      getSource: () => null,
    },
  })();
  assert.equal(facts.citation, `${TEXT} ${URL_}`);
});

test('a figure\'s provenance names the citation beside the source, not inside it', () => {
  const json = JSON.parse(buildProvenanceJson({
    datasetName: 'Pancreas', datasetSourceName: 'scVelo', datasetSourceUrl: 'https://scvelo.org',
    datasetCitation: `${TEXT} ${URL_}`,
    views: [{ id: 'live', label: 'Live', name: null, fieldKey: null, fieldKind: null, filters: [], vectorField: null }],
  }, { options: {} }, 'png'));
  assert.deepEqual(json.dataset.source, { name: 'scVelo', url: 'https://scvelo.org' });
  assert.equal(json.dataset.citation, `${TEXT} ${URL_}`);
});

async function* jsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

test('no reader looks for the citation in the dataset\'s source', async () => {
  const offenders = [];
  for await (const file of jsFiles(JS_ROOT)) {
    const text = await readFile(file, 'utf8');
    if (/\bsource\??\.citation\b/.test(text)) offenders.push(path.relative(JS_ROOT, file));
  }
  assert.deepEqual(offenders, [], 'the metadata keeps the citation at `citation` ({text, url}); read it with citationText()');
});
