/**
 * The gene list of a data mapping, read from a real `.h5ad` and Zarr ZIP in
 * the browser readers (Phase F), against what `cellucid-python` serves for
 * the same file (`data-mapping-full.expected.json`, written by
 * `scripts/generate-data-mapping-fixtures.py` from cellucid itself):
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
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { MappingLoadError, mappingGenesBase } from '../assets/js/data/data-mapping-candidates.js';
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
    const source = new H5adDataSource();
    t.after(() => source.clear());
    await source.loadFromFile(file);
    return source.getAdapter();
  }
  const file = new File([await readFile(new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url))], 'data-mapping-full.zarr.zip');
  const source = new ZarrDataSource();
  t.after(() => source.clear());
  await source.loadFromArchiveFile(file);
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
      const base = mappingGenesBase(axis, names);
      const manifest = await adapter.getVarManifest(`${base}var_manifest.json`);
      assert.deepEqual(manifest.fields.map(([, name]) => name), expected.names, route);
      assert.deepEqual(manifest.gene_name_sets, [expected.name_set], route);
      for (let index = 0; index < expected.names.length; index += 1) {
        const values = await adapter.getGeneValues(`${base}var/${index}.values.f32`);
        assert.equal(sha256(values), expected.values[index], `${route} gene ${index}`);
      }
    }
  });

  test(`${format}: the file opens with X named by its index, and refuses a float column`, async t => {
    const adapter = await open(t, format);
    const own = await adapter.getVarManifest();
    assert.deepEqual(own.fields.map(([, name]) => name), EXPECTED.genes['X/index'].names);
    assert.equal(
      sha256(await adapter.getGeneValues('var/2.values.f32')),
      EXPECTED.genes['X/index'].values[2]
    );
    const columns = adapter.getMappingCandidates().var.columns;
    const dispersions = columns.findIndex(column => column.key === 'dispersions');
    await assert.rejects(
      adapter.getVarManifest(`${mappingGenesBase('X', `column-${dispersions}`)}var_manifest.json`),
      error => error instanceof MappingLoadError
        && error.key === 'dispersions'
        && error.reason === 'floating-point values cannot name genes'
    );
    await assert.rejects(adapter.getGeneValues('var/6.values.f32'), RangeError);
    await assert.rejects(
      adapter.getVarManifest(`${mappingGenesBase('layer-9', 'index')}var_manifest.json`),
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
