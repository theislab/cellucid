/**
 * The gene list of a data mapping, read from a real `.h5ad` and Zarr ZIP in
 * the browser readers (Phase F), against the numpy reference for the same
 * file (`data-mapping-full.expected.json`, computed by
 * `scripts/generate-data-mapping-fixtures.py` independently of this code):
 * - every expression matrix (`X`, each layer, `raw.X` with its own var axis)
 *   and every name source (the var index, each usable var column) gives the
 *   same unique names, the same make-unique record and byte-identical values;
 * - a duplicated or empty name is made unique with the one shared rule, never
 *   refused;
 * - a column that cannot name genes is refused with the catalog's reason.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { MappingLoadError, mappingGeneListPath } from '../assets/js/data/data-mapping-candidates.js';
import { geneNameText } from '../assets/js/data/gene-names.js';

const EXPECTED = JSON.parse(
  await readFile(new URL('./browser/fixtures/data-mapping-full.expected.json', import.meta.url), 'utf8')
);

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `${name}-${++next}`;
  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

async function open(t, format) {
  silenceNotifications(t);
  if (format === 'H5AD') {
    const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.h5ad', import.meta.url))], 'data-mapping-full.h5ad');
    const source = new AnnDataFileSource();
    t.after(() => source.clear());
    await source.loadFile(file);
    return source.getAdapter();
  }
  const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url))], 'data-mapping-full.zarr.zip');
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(file);
  return source.getAdapter();
}

function sha256(view) {
  return createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}

for (const format of ['H5AD', 'Zarr ZIP']) {
  test(`${format}: every gene list equals the server's, names and values`, async t => {
    const adapter = await open(t, format);
    for (const [route, expected] of Object.entries(EXPECTED.genes)) {
      const [axis, names] = route.split('/');
      const listRoute = mappingGeneListPath(axis, names);
      const list = await adapter.getGeneList(listRoute);
      assert.deepEqual(list.fields.map(field => field.key), expected.names, route);
      assert.deepEqual(
        list.fields.map(field => field.path),
        expected.names.map((_, gene) => `${listRoute}/${gene}`),
        route
      );
      const { source, filledFromIndex, renamed } = list.geneNames;
      assert.deepEqual(
        { source, filled_from_index: filledFromIndex, renamed },
        expected.gene_names,
        route
      );
      for (let index = 0; index < expected.names.length; index += 1) {
        const values = await adapter.getGeneValues(`${listRoute}/${index}`);
        assert.equal(sha256(values), expected.values[index], `${route} gene ${index}`);
      }
    }
  });

  test(`${format}: the file opens with X named by its index, and refuses a float column`, async t => {
    const adapter = await open(t, format);
    const own = await adapter.getGeneList();
    assert.deepEqual(own.fields.map(field => field.key), EXPECTED.genes['X/index'].names);
    assert.equal(
      sha256(await adapter.getGeneValues('var/2')),
      EXPECTED.genes['X/index'].values[2]
    );
    const columns = adapter.getMappingCandidates().var.columns;
    const dispersions = columns.findIndex(column => column.key === 'dispersions');
    await assert.rejects(
      adapter.getGeneList(mappingGeneListPath('X', `column-${dispersions}`)),
      error => error instanceof MappingLoadError
        && error.key === 'dispersions'
        && error.reason === 'floating-point values cannot name genes'
    );
    await assert.rejects(adapter.getGeneValues('var/6'), RangeError);
    await assert.rejects(
      adapter.getGeneList(mappingGeneListPath('layer-9', 'index')),
      RangeError
    );
  });
}

test('gene-name text is Python str() for every value a column can hold', () => {
  assert.equal(geneNameText('CD3E'), 'CD3E');
  assert.equal(geneNameText(''), '');
  assert.equal(geneNameText(null), null);
  assert.equal(geneNameText(Number.NaN), null);
  assert.equal(geneNameText(7), '7');
  assert.equal(geneNameText(7n), '7');
  assert.equal(geneNameText(true), 'True');
  assert.equal(geneNameText(5, { isFloat: true }), '5.0');
  assert.equal(geneNameText(0.5, { isFloat: true }), '0.5');
  assert.throws(() => geneNameText({}), TypeError);
});
