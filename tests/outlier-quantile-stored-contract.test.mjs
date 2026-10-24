/**
 * Outlier quantiles a Cellucid-ready AnnData stores (`prepare(latent_key=...)`,
 * `uns['cellucid']['outlierQuantiles']`) are read, not computed, and are the
 * bytes the browser computes and the numpy reference gives:
 * - opening describes them and reads none of their values;
 * - in the stored latent space a field's quantiles are one small read of its
 *   own array (`stored`), equal to the worker's computation and to
 *   `outliers-stored.expected.json`;
 * - in any other latent space, or for quantiles that no longer fit the
 *   file's categories (`outliers-stale.h5ad`), they are computed, with the
 *   same bytes as the reference;
 * - a field the file stores none for because no category is large enough
 *   reads nothing at all;
 * - fields asked for together are computed in one pass, and cancelling every
 *   caller stops the computation.
 *
 * Fixtures: `scripts/generate-outlier-quantile-fixtures.py` (the real writer).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import { mappingLatentOutlierPath } from '../assets/js/data/data-mapping-candidates.js';
import { OutlierQuantileSource } from '../assets/js/data/outlier-quantile-source.js';
import { categoricalStorageForDtype } from '../assets/js/data/categorical-storage-contract.js';
import { getReadActivityLog } from '../assets/js/data/read-activity-log.js';

const FIXTURES = new URL('./browser/fixtures/', import.meta.url);
const EXPECTED = JSON.parse(await readFile(new URL('outliers-stored.expected.json', FIXTURES), 'utf8'));

function silence(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => `${name}-id`;
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    for (const [name, method] of originals) notifications[name] = method;
    console.warn = warn;
  });
  return warnings;
}

async function open(t, name) {
  const warnings = silence(t);
  const bytes = await readFile(new URL(name, FIXTURES));
  const file = new File([bytes], name);
  const source = name.endsWith('.h5ad') ? new AnnDataFileSource() : new AnnDataFileSource();
  t.after(() => source.clear());
  if (name.endsWith('.h5ad')) await source.loadFile(file);
  else await source.loadFile(file);
  return { adapter: source.getAdapter(), warnings };
}

const sha256 = view => createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');

function routes(adapter) {
  const obsm = adapter.getMappingCandidates().obsm.map(item => item.key);
  const fields = new Map(adapter.getObsFields().fields.filter(field => field.kind === 'category').map(field => [field.key, field.fieldIndex]));
  return (latent, field) => mappingLatentOutlierPath(obsm.indexOf(latent), fields.get(field));
}

function outlierActivities() {
  return getReadActivityLog().entries().filter(activity => activity.kind === 'outliers');
}

for (const name of ['outliers-stored.h5ad', 'outliers-stored.zarr.zip']) {
  test(`${name}: stored quantiles are read, one field at a time, with the reference bytes`, async t => {
    const { adapter } = await open(t, name);
    const route = routes(adapter);
    assert.equal(adapter.getStoredOutlierLatentKey(), 'X_scVI');
    assert.equal(adapter.getObsFields().stored_outlier_latent_key, 'X_scVI');
    getReadActivityLog().clear();

    for (const field of EXPECTED.stored) {
      const plan = await adapter.describeLatentOutlierQuantiles(route('X_scVI', field));
      assert.equal(plan.source, 'stored', field);
      const quantiles = await adapter.getLatentOutlierQuantiles(route('X_scVI', field));
      assert.equal(sha256(quantiles), EXPECTED.quantiles.X_scVI[field], field);
    }
    const reads = outlierActivities();
    assert.deepEqual(
      reads.map(activity => activity.label).sort(),
      EXPECTED.stored.map(field => `stored outlier quantiles of obs['${field}']`).sort(),
      'each field is its own read; the latent space is never read'
    );

    // The same rule computed in the worker gives the same bytes.
    const computed = new OutlierQuantileSource({ loader: adapter._loader, stored: null, minPoints: EXPECTED.minPoints });
    t.after(() => computed.close());
    for (const field of EXPECTED.stored) {
      const data = await adapter.getObsFieldData(field);
      const { TypedArrayClass } = categoricalStorageForDtype(data.dtype, field);
      const quantiles = await computed.quantiles({
        latentKey: 'X_scVI',
        width: 12,
        fieldKey: field,
        codes: new TypedArrayClass(data.data),
        nCategories: data.categories.length,
      });
      assert.equal(sha256(quantiles), EXPECTED.quantiles.X_scVI[field], `${field}, computed`);
    }
  });
}

test('another latent space is computed, every field in one pass, with the reference bytes', async t => {
  const { adapter } = await open(t, 'outliers-stored.h5ad');
  const route = routes(adapter);
  const plan = await adapter.describeLatentOutlierQuantiles(route('X_pca', 'cell_type'));
  assert.equal(plan.source, 'read');
  assert.equal(plan.storedLatentKey, 'X_scVI');
  assert.equal(plan.kept, true);
  assert.ok(plan.valueBytes > 0);
  getReadActivityLog().clear();
  const fields = ['cell_type', 'batch', 'rare', 'doublet'];
  const results = await Promise.all(fields.map(field => adapter.getLatentOutlierQuantiles(route('X_pca', field))));
  fields.forEach((field, index) => assert.equal(sha256(results[index]), EXPECTED.quantiles.X_pca[field], field));
  const reads = outlierActivities();
  assert.equal(reads.length, 1, 'one read of the latent space served every field');
  assert.match(reads[0].label, /latent space obsm\['X_pca'\] for outlier quantiles/);
  // Kept: the next plan reads nothing.
  assert.equal((await adapter.describeLatentOutlierQuantiles(route('X_pca', 'cell_type'))).source, 'held');
});

test('stored quantiles that no longer fit the categories are computed instead', async t => {
  const { adapter, warnings } = await open(t, 'outliers-stale.h5ad');
  const route = routes(adapter);
  assert.equal((await adapter.describeLatentOutlierQuantiles(route('X_scVI', 'cell_type'))).source, 'stored');
  const quantiles = await adapter.getLatentOutlierQuantiles(route('X_scVI', 'cell_type'));
  assert.notEqual(sha256(quantiles), EXPECTED.quantiles.X_scVI.cell_type);
  assert.ok(warnings.some(line => /do not fit its categories/.test(line)));
  assert.equal((await adapter.describeLatentOutlierQuantiles(route('X_scVI', 'cell_type'))).source, 'held');
  // 'batch' still fits: read as stored.
  const batch = await adapter.getLatentOutlierQuantiles(route('X_scVI', 'batch'));
  assert.equal(sha256(batch), EXPECTED.quantiles.X_scVI.batch);
});

test('cancelling every caller stops the computation; it can start again', async t => {
  const { adapter } = await open(t, 'outliers-stored.h5ad');
  const route = routes(adapter);
  const controller = new AbortController();
  const pending = adapter.getLatentOutlierQuantiles(route('X_pca', 'batch'), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  const again = await adapter.getLatentOutlierQuantiles(route('X_pca', 'batch'));
  assert.equal(sha256(again), EXPECTED.quantiles.X_pca.batch);
});
