/**
 * What the reader reports about the link a dataset is read over, for the
 * work that tunes itself to it: `{latencyMs, bytesPerMs,
 * backgroundConcurrency, protocol}` posted by the reader worker whenever it
 * changes and kept by the client (`linkMeasurement()`), null before the first
 * measurement; a local file has no round trip (latency 0) and reports how
 * fast its chunks decode, which the decode pool measures
 * (`decodePoolStats().decodedBytesPerMs`).
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { linkMeasurementOf } from '../assets/js/data/anndata-reader-worker.js';
import { decodeChunkBytes, decodePoolStats } from '../assets/js/formats/io/decode-pool.js';
import { LinkMeter } from '../assets/js/formats/io/link.js';
import { REMOTE_POLICY } from '../assets/js/formats/io/byte-source.js';

test('the decode pool measures decoded bytes per millisecond', async () => {
  await decodeChunkBytes({
    kind: 'zarr',
    description: {},
    input: new Uint8Array(4),
    size: 1 << 20,
    revive: data => new Error(data.message),
    inThread: () => new Promise(resolve => setTimeout(() => resolve(new Uint8Array(1 << 20)), 5)),
  });
  const rate = decodePoolStats().decodedBytesPerMs;
  assert.ok(Number.isFinite(rate) && rate > 0, `a measured rate, got ${rate}`);
});

test('a remote link is reported as measured, and not before', () => {
  let now = 0;
  const link = new LinkMeter(REMOTE_POLICY, { clock: () => now });
  const source = { url: 'https://host.test/a.h5ad' };
  assert.equal(linkMeasurementOf(source, link), null);
  const started = link.begin();
  now = 120;
  link.end(started, 60_000);
  assert.deepEqual(linkMeasurementOf(source, link), {
    latencyMs: 120,
    bytesPerMs: 500,
    backgroundConcurrency: 5,
    protocol: null,
  });
});

test('the client keeps the latest measurement of a local file: no round trip, its decode rate', async t => {
  const name = 'data-mapping-full.zarr.zip';
  const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
  const client = new AnnDataReaderClient({ kind: 'zarr' });
  t.after(() => client.close());
  assert.equal(client.linkMeasurement(), null);
  await client.open({ archive: file });
  await client.readEmbedding('X_pca', [0, 1], true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const measurement = client.linkMeasurement();
  assert.ok(measurement !== null, 'measured once chunks decoded');
  assert.equal(measurement.latencyMs, 0);
  assert.ok(measurement.bytesPerMs > 0);
  assert.equal(measurement.protocol, null);
});

test('the var field loader reaches the open dataset\'s measurement through its adapter, else null', async t => {
  const { createVarFieldLoader } = await import('../assets/js/data/data-loaders.js');
  const { ZarrDataSource } = await import('../assets/js/data/zarr.js');
  // No dataset is open at that address.
  assert.equal(createVarFieldLoader('zarr://nothing-open/var').linkMeasurement(), null);
  const name = 'data-mapping-full.zarr.zip';
  const file = new File([await readFile(new URL(`./browser/fixtures/${name}`, import.meta.url))], name);
  const source = new ZarrDataSource();
  t.after(() => source.clear());
  const { getNotificationCenter } = await import('../assets/js/app/notification-center.js');
  const notifications = getNotificationCenter();
  const info = notifications.info;
  notifications.info = () => 'info';
  t.after(() => {
    notifications.info = info;
  });
  await source.loadFromArchiveFile(file, {});
  await new Promise(resolve => setTimeout(resolve, 0));
  const measurement = source.getAdapter().linkMeasurement();
  assert.ok(measurement !== null && measurement.latencyMs === 0 && measurement.bytesPerMs > 0);
});
