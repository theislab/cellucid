/**
 * The neighbour graph of a data mapping, read from a real `.h5ad` and Zarr
 * ZIP in the browser readers (Phase E).
 *
 * - Every square `obsp` matrix is listed; any of them is read by key, through
 *   its `obsp/{p}` route.
 * - A graph's canonical edges are byte-identical to the numpy reference for
 *   the same file (`data-mapping-full.expected.json`, computed by
 *   `scripts/generate-data-mapping-fixtures.py` independently of this code).
 * - A graph that is not symmetric is refused with the server's words and is
 *   never repaired; the file's own graph keeps working.
 * - Switching graphs keeps at most the default graph and one other in memory.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import {
  MappingLoadError,
  mappingGraphPath,
  parseMappingGraphPath,
} from '../assets/js/data/data-mapping-candidates.js';
import { edgeListOf } from './helpers/connectivity-edges.mjs';

const FIXTURE = new URL('./browser/fixtures/data-mapping-full.h5ad', import.meta.url);
const ZARR_FIXTURE = new URL('./browser/fixtures/data-mapping-full.zarr.zip', import.meta.url);
const EXPECTED = JSON.parse(
  await readFile(new URL('./browser/fixtures/data-mapping-full.expected.json', import.meta.url), 'utf8')
);

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info'];
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

async function openH5ad(t) {
  silenceNotifications(t);
  const file = new File([await readFile(FIXTURE)], 'data-mapping-full.h5ad', {
    type: 'application/x-hdf5',
  });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(file);
  return source.getAdapter();
}

async function openZarr(t) {
  silenceNotifications(t);
  const file = new File([await readFile(ZARR_FIXTURE)], 'data-mapping-full.zarr.zip', {
    type: 'application/zip',
  });
  const source = new AnnDataFileSource();
  t.after(() => source.clear());
  await source.loadFile(file);
  return source.getAdapter();
}

function sha256(view) {
  return createHash('sha256')
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest('hex');
}

for (const [format, open] of [['H5AD', openH5ad], ['Zarr ZIP', openZarr]]) {
  test(`${format}: every graph is listed, read by key, and equal to the server's edges`, async t => {
    const adapter = await open(t);
    const candidates = adapter.getMappingCandidates();
    assert.deepEqual(
      candidates.obsp.map(item => [item.key, item.usable]),
      [['connectivities', true], ['distances', true], ['scvi_connectivities', true]]
    );
    // The file opens with its connectivities.
    assert.equal(candidates.defaults.knn, 'connectivities');

    for (const [index, item] of candidates.obsp.entries()) {
      const expected = EXPECTED.knn[item.key];
      if (expected.refused) continue;
      const summary = await adapter.getMappedConnectivitySummary(index);
      assert.equal(summary.n_cells, EXPECTED.n_obs);
      assert.equal(summary.n_edges, expected.n_edges, item.key);
      assert.equal(summary.max_neighbors, expected.max_neighbors, item.key);
      const edges = await adapter.getConnectivityEdges({ key: item.key });
      assert.equal(sha256(edgeListOf(edges).sources), expected.sources, `${item.key} sources`);
      assert.equal(sha256(edgeListOf(edges).destinations), expected.destinations, `${item.key} destinations`);
      assert.equal(sha256(edgeListOf(edges).strength), expected.strength, `${item.key} strength`);
      assert.equal(edges.maxWeight, expected.max_weight, `${item.key} largest weight`);
    }
  });

  test(`${format}: a graph that is not symmetric is refused in the server's words`, async t => {
    const adapter = await open(t);
    const index = adapter.getMappingCandidates().obsp.findIndex(item => item.key === 'distances');
    assert.equal(EXPECTED.knn.distances.refused, true);
    await assert.rejects(
      adapter.getMappedConnectivitySummary(index),
      error => (
        error instanceof MappingLoadError &&
        error.key === 'distances' &&
        error.reason === 'not symmetric — choose a connectivities matrix' &&
        error.message === "obsp['distances'] is not symmetric — choose a connectivities matrix."
      )
    );
    // Refusing one graph changes nothing about the file's own.
    const own = await adapter.getConnectivityEdges();
    assert.equal(own.nEdges, EXPECTED.knn.connectivities.n_edges);
    await assert.rejects(adapter.getMappedConnectivitySummary(99), RangeError);
  });
}

test('switching graphs keeps only the graph asked for last', async t => {
  // The viewer holds the graph it shows (the same payload), so the adapter
  // keeps no other.
  const adapter = await openH5ad(t);
  const own = await adapter.getConnectivityEdges();
  assert.deepEqual([...adapter._connectivityCache.keys()], ['connectivities']);
  assert.equal(await adapter.getConnectivityEdges(), own, 'asking again reads nothing');
  const scvi = await adapter.getConnectivityEdges({ key: 'scvi_connectivities' });
  assert.deepEqual([...adapter._connectivityCache.keys()], ['scvi_connectivities']);
  assert.equal(await adapter.getConnectivityEdges({ key: 'scvi_connectivities' }), scvi);
  // A refused graph is never retained.
  await assert.rejects(adapter.getConnectivityEdges({ key: 'distances' }), MappingLoadError);
  assert.deepEqual([...adapter._connectivityCache.keys()], ['scvi_connectivities']);
  assert.equal(await adapter.getConnectivityEdges({ key: 'absent' }), null);
  assert.deepEqual([...adapter._connectivityCache.keys()], ['absent']);
  await assert.rejects(adapter.getConnectivityEdges({ key: '' }), TypeError);
});

test('mapped graph routes name a catalog position, never a key', () => {
  assert.equal(mappingGraphPath(2), 'obsp/2');
  assert.equal(parseMappingGraphPath('obsp/2'), 2);
  for (const path of [
    'obsp',
    'obsp/02',
    'obsp/connectivities',
    'obsp/2/edges',
  ]) {
    assert.equal(parseMappingGraphPath(path), null, path);
  }
  assert.throws(() => mappingGraphPath(-1), TypeError);
});
