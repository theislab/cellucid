/**
 * Vector fields of a data mapping, read from a real `.h5ad` and Zarr ZIP in
 * the browser readers, against the numpy reference for the same binding
 * (`data-mapping-full.expected.json`, computed by
 * `scripts/generate-data-mapping-fixtures.py` independently of this code):
 * - an array as wide as the embedding's dimension is read whole, one as wide
 *   as the embedding's array at the embedding's own columns, and both are
 *   scaled by that embedding's normalization: byte-identical payloads;
 * - an array that fits neither is refused, and a route that does not match
 *   its binding's rule is refused.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';
import { resolveVectorBinding } from '../assets/js/data/data-mapping-candidates.js';

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
  test(`${format}: every bound vector payload equals the server's bytes`, async t => {
    const adapter = await open(t, format);
    const candidates = adapter.getMappingCandidates();
    for (const [name, expected] of Object.entries(EXPECTED.vectors)) {
      const [, key, embeddingKey, columns] = /^(.+)@(.+)\[([0-9,]+)\]$/.exec(name);
      const resolved = resolveVectorBinding(candidates, {
        key,
        embedding: { key: embeddingKey, columns: columns.split(',').map(Number) },
      });
      assert.equal(resolved.ok, true, name);
      const { vectors } = await adapter.getVectorPayload(resolved.path, resolved.dimension);
      assert.equal(sha256(vectors), expected, name);
    }
  });

  test(`${format}: a vector array that fits no rule is refused`, async t => {
    const adapter = await open(t, format);
    const candidates = adapter.getMappingCandidates();
    const pcaVectors = resolveVectorBinding(candidates, {
      key: 'velocity_pca',
      embedding: { key: 'X_umap', columns: [0, 1] },
    });
    assert.deepEqual(pcaVectors, {
      ok: false,
      reason: "obsm['velocity_pca'] has 6 columns; it needs 2, or 2 like obsm['X_umap']",
    });
    const fitting = resolveVectorBinding(candidates, {
      key: 'velocity_pca',
      embedding: { key: 'X_pca', columns: [2, 3] },
    });
    // The same arrays at other vector columns are not that binding.
    await assert.rejects(
      adapter.getVectorPayload(fitting.path.replace('/2-3/', '/0-1/'), 2),
      /cannot be bound/
    );
    await assert.rejects(adapter.getVectorPayload(fitting.path, 3), /not 3D/);
  });
}
