/**
 * A dataset's published starting view (`assets/js/app/session/published-default.js`):
 * a format-4 session of one tracker of one root and no content a person
 * made. Publishing turns a Save into one (the head becomes the root; steps
 * and conversations go; the person's layout is not carried), refuses a
 * capture whose steps made content, and binds the fingerprint to the
 * identity the catalog serves, refusing to restate what the capture was
 * taken against. The profile the app's restore checks is the same function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STARTING_VIEW_CONTENT_DOMAINS, STARTING_VIEW_OMITTED_DOMAINS, assertPublishedDefaultProfile, assertPublishedDefaultRoot,
  rebindPublishedDefaultFingerprint, trimToPublishedDefault,
} from '../assets/js/app/session/published-default.js';
import { openHistoryFile, readHistoryFileManifest, writeHistoryFile } from '../assets/js/app/session/history-file.js';
import { SAVE_DEFAULTS, writeSharedHistory } from '../assets/js/app/session/share-scope.js';
import { HEADER, setup } from './helpers/history-fixtures.mjs';

/** A Save of the page's history (the page's own path, `writeSharedHistory`). */
async function save(page, { chats = false, header = HEADER } = {}) {
  const { blob } = await writeSharedHistory({
    snapshot: page.history.snapshot(), shown: page.history.shownHashes(), valueOf: hash => page.history.pool.get(hash),
    choice: { ...SAVE_DEFAULTS, chats }, header, catalog: page.dispatcher.catalog, version: '0.9.6',
    newTrackerId: () => 't-00000000-0000-4000-8000-0000000000ff', now: Date.parse(header.createdAt),
  });
  return blob;
}

async function framedView() {
  const page = setup();
  await page.history.startTracker({ name: 'Framing' });
  await page.dispatcher.dispatch('color.by', { field: 'cell_type' });
  await page.dispatcher.dispatch('camera.set', { at: 2 });
  return page;
}

const PUBLISHED = Object.freeze({ ...HEADER.datasetFingerprint, datasetId: 'demo-published', name: 'Demo (published)' });

test('publishing makes one tracker of one root: the head, without steps, conversations, source, cells or layout', async () => {
  const page = await framedView();
  page.history.setChat(page.history.active.id, 'c1', { messages: ['framed'] });
  const view = await trimToPublishedDefault(await save(page, { chats: true }), PUBLISHED);
  const manifest = await readHistoryFileManifest(view);
  assert.deepEqual(assertPublishedDefaultProfile(manifest), manifest);
  assert.equal(manifest.source, null);
  assert.equal(Object.hasOwn(manifest, 'cells') || Object.hasOwn(manifest, 'genes'), false);
  assert.equal(manifest.datasetFingerprint.datasetId, 'demo-published');
  assert.equal(manifest.trackers.length, 1);
  assert.equal(manifest.trackers[0].name, 'Starting view');
  assert.deepEqual(manifest.trackers[0].chats, []);
  assert.ok(manifest.chunks.every(chunk => chunk.priority === 'eager'));
  const file = await openHistoryFile(view, { signal: null, onProgress: null });
  const eager = await file.readEager();
  await file.readRest();
  const [root] = eager.history.trackers[0].steps;
  assert.equal(eager.history.trackers[0].steps.length, 1);
  assert.deepEqual(assertPublishedDefaultRoot(root), root);
  for (const id of STARTING_VIEW_OMITTED_DOMAINS) assert.equal(id in root.after, false, id);
  const shown = id => eager.values.get(root.after[id]);
  assert.equal(shown('colors').by, 'cell_type');
  assert.equal(shown('camera').at, 2);
  // Published again, it is the same file (nothing of the capture's time or ids leaks into it twice).
  const again = await trimToPublishedDefault(view, PUBLISHED);
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), new Uint8Array(await view.arrayBuffer()));
});

test('publishing refuses a capture whose steps made content, naming it', async () => {
  assert.deepEqual([...STARTING_VIEW_CONTENT_DOMAINS], ['field-overlays', 'gene-sets', 'visibility', 'highlights', 'camera-path']);
  const page = await framedView();
  await page.dispatcher.dispatch('highlight.cells', { label: 'T cells', cells: Uint32Array.of(1, 2) });
  await assert.rejects(
    trimToPublishedDefault(await save(page), PUBLISHED),
    /Publishing would carry content made in the capture \(highlight pages and their groups of cells\)\. A starting view holds no content a person made\./,
  );
  // Undone, the capture publishes: the head holds the root's highlights again.
  await page.history.undo();
  const manifest = await readHistoryFileManifest(await trimToPublishedDefault(await save(page), PUBLISHED));
  assert.deepEqual(assertPublishedDefaultProfile(manifest), manifest);
});

test('the profile refuses anything but one state', async () => {
  const page = await framedView();
  const saved = await readHistoryFileManifest(await save(page));
  const view = await readHistoryFileManifest(await trimToPublishedDefault(await save(page), PUBLISHED));
  assert.throws(() => assertPublishedDefaultProfile(saved), /it names a source/);
  const cases = [
    [m => { m.trackers.push({ ...m.trackers[0], id: 'other' }); }, /holds 2 trackers, not one/],
    [m => { m.trackers[0].headId = 's9'; }, /it holds steps/],
    [m => { m.trackers[0].chats = ['chat/0/0']; }, /holds a conversation/],
    [m => { m.chunks[m.chunks.length - 1].priority = 'lazy'; }, /values beyond its one state/],
    [m => { m.cells = {}; }, /names the cells it was saved on/],
  ];
  for (const [mutate, pattern] of cases) {
    const changed = structuredClone(view);
    mutate(changed);
    assert.throws(() => assertPublishedDefaultProfile(changed), pattern);
  }
  assert.throws(() => assertPublishedDefaultRoot({ after: { layout: 'a'.repeat(64) } }), /sets docked and floating panels, analysis windows' places and sizes, open sections, sidebar, theme, which stay the person's own/);
});

test('publishing needs the identity it ships under', async () => {
  const page = await framedView();
  await assert.rejects(trimToPublishedDefault(await save(page)), /Published dataset fingerprint/);
});

test('publishing rebinds a capture to the identity it ships under, never restating what it was taken against', () => {
  const captured = structuredClone(HEADER.datasetFingerprint);
  const rebound = rebindPublishedDefaultFingerprint(captured, PUBLISHED);
  assert.deepEqual(rebound, { ...captured, datasetId: 'demo-published', name: 'Demo (published)' });
  assert.notStrictEqual(rebound.cellOrder.embedding, captured.cellOrder.embedding);
  assert.notStrictEqual(rebound.dataMapping, captured.dataMapping);
  const cellOrder = changes => ({ cellOrder: { ...captured.cellOrder, ...changes } });
  for (const [label, override] of [
    ['cell count', { cellCount: captured.cellCount - 1 }],
    ['gene count', { varCount: captured.varCount + 1 }],
    ['cell-order embedding', cellOrder({ embedding: { key: 'X_umap', columns: [1, 0] } })],
    ['cell-order digest', cellOrder({ digest: '0000000000000000' })],
    ['data mapping', { dataMapping: { ...captured.dataMapping, geneNames: 'column:gene_symbols' } }],
  ]) {
    assert.throws(
      () => rebindPublishedDefaultFingerprint(captured, { ...PUBLISHED, ...override }),
      new RegExp(`cannot be published as "demo-published".*${label}`, 's'),
      label,
    );
  }
  assert.throws(() => rebindPublishedDefaultFingerprint(captured, { ...PUBLISHED, datasetId: null }), /must name the dataset it ships beside/);
  assert.throws(() => rebindPublishedDefaultFingerprint({ ...captured, cellOrder: { dimension: 2, digest: 'x' } }, PUBLISHED), /must contain exactly/);
});
