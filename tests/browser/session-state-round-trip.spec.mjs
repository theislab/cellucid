/**
 * A session must come back whole, not almost whole (CEL-0232).
 *
 * Every existing session test names what it checks: four renderer controls,
 * eleven filter properties, one active field, a theme and a point size. That is
 * the same shape as the defect this subsystem keeps producing — state
 * republished from a hand-maintained list, and the list drifts. A control added
 * to the app is covered by none of those tests until somebody remembers to add
 * an assertion for it.
 *
 * This spec names nothing. It builds a rich state in the real application,
 * saves it, drifts every part of it, loads the file back, saves again, and
 * compares the two captures **whole**. The captures are what the running app
 * says its state is — re-derived from the live DOM, `DataState`, and the viewer
 * at each save — so a difference means a real restore failure, not a byte
 * difference in a container. A control that stops restoring fails this spec the
 * day it stops, whether or not anyone updated a list.
 *
 * The state it builds deliberately includes a **highlight group with cell
 * membership**. No published preset ships one, so before this spec the lazy
 * binary `highlights/cells/<groupId>` path had never been exercised by a real
 * end-to-end save and load — only by node fixtures. It also includes a kept
 * view, a second highlight page, a non-default selection tool, and controls
 * from four different accordions.
 *
 * One thing is normalized before comparing, and only one: the viewer's
 * snapshot-view counter is monotonic for the lifetime of the page and is never
 * reset, so views rebuilt by a restore are numbered `snap_2`, `snap_3`, …
 * rather than reusing the saved `snap_1`. The spec asserts the renumbering is a
 * consistent position-preserving relabeling and then applies it, which keeps
 * every other multiview field — layout, active view, per-view camera, per-view
 * dimension, per-view filters, per-view active field — inside the comparison.
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { readBundle } from '../../assets/js/app/session/bundle/reader.js';
import { gzipDecompress } from '../../assets/js/app/session/codecs/gzip.js';
import { ENCODED_EXPORTS_BASE_URL } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';

const DATASET_URL =
  `/?exportsBaseUrl=${ENCODED_EXPORTS_BASE_URL}`
  + '&dataset=current-ui-prepared&acceptance=session-round-trip-ci';

/**
 * Every chunk of one saved session, decoded.
 *
 * JSON chunks become their parsed payload; binary chunks keep their exact
 * bytes as a hex string so a membership array that came back permuted or
 * truncated is a visible difference rather than an equal length.
 */
async function readSessionChunks(sessionPath) {
  const bytes = await readFile(sessionPath);
  const { manifest, chunkStream } = await readBundle(
    new Blob([bytes]),
    { signal: null, onProgress: null },
  );
  const order = [];
  const payloads = new Map();
  for await (const chunk of chunkStream) {
    const raw = chunk.meta.codec === 'gzip'
      ? await gzipDecompress(chunk.bytes, {
        maxOutputBytes: chunk.meta.uncompressedBytes,
        signal: null,
      })
      : chunk.bytes;
    order.push(chunk.meta.id);
    payloads.set(
      chunk.meta.id,
      chunk.meta.kind === 'json'
        ? JSON.parse(new TextDecoder().decode(raw))
        : `binary:${Buffer.from(raw).toString('hex')}`,
    );
  }
  return { manifest, order, payloads };
}

/**
 * Rewrite the restored snapshot ids back onto the saved ones.
 *
 * Asserts the relabeling before applying it, so a restore that lost, added, or
 * reordered a view is a failure rather than a rename.
 */
function relabelSnapshotIds(savedCore, restoredCore) {
  const saved = savedCore.multiview.snapshots.map(snapshot => snapshot.id);
  const restored = restoredCore.multiview.snapshots.map(snapshot => snapshot.id);
  expect(
    restored.length,
    'the restore must rebuild exactly the kept views the session recorded',
  ).toBe(saved.length);

  const rename = new Map(restored.map((id, index) => [id, saved[index]]));
  expect(
    new Set(rename.values()).size,
    'the snapshot relabeling must be one-to-one',
  ).toBe(saved.length);

  const rewritten = structuredClone(restoredCore);
  for (const snapshot of rewritten.multiview.snapshots) {
    snapshot.id = rename.get(snapshot.id);
  }
  if (rewritten.multiview.layout.activeId !== 'live') {
    const mapped = rename.get(rewritten.multiview.layout.activeId);
    expect(
      mapped,
      'the restored active view must be one of the rebuilt snapshots',
    ).not.toBe(undefined);
    rewritten.multiview.layout.activeId = mapped;
  }
  return rewritten;
}

/**
 * Set one control the way its owner hears about it.
 *
 * Several serialized controls sit in collapsed accordions or in containers the
 * renderer panel hides — `#hp-lod-force` is revealed only when adaptive LOD is
 * off — so a pointer-driven `fill()` cannot reach them from a fresh page. This
 * writes the value and dispatches the same event `ui-controls.js` dispatches,
 * which is the real publication path: the owner's listener runs, and a control
 * that rejects the value still rejects it here.
 */
async function setControl(page, id, value) {
  await page.evaluate(([controlId, controlValue]) => {
    const element = document.getElementById(controlId);
    if (element === null) throw new Error(`no control #${controlId}`);
    if (element.type === 'checkbox') {
      element.checked = controlValue;
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    element.value = String(controlValue);
    element.dispatchEvent(new Event(
      element.tagName === 'SELECT' ? 'change' : 'input',
      { bubbles: true },
    ));
  }, [id, value]);
}

async function saveSession(page, testInfo, name) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#save-state-btn').click();
  const download = await downloadPromise;
  const sessionPath = testInfo.outputPath(name);
  await download.saveAs(sessionPath);
  return sessionPath;
}

async function loadSession(page, sessionPath) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#load-state-btn').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sessionPath);
}

test('a saved session restores to the exact state it recorded', async (
  { page },
  testInfo,
) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => {
    browserErrors.push(`page: ${error.stack || error.message}`);
  });

  await page.goto(DATASET_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(page.locator('#dataset-name')).toHaveText(
    'Current UI prepared fixture',
  );

  // ---------------------------------------------------------------------
  // Build a state worth saving.
  // ---------------------------------------------------------------------
  const categorical = page.locator('#categorical-field');
  await categorical.selectOption({ label: 'cell_type' });
  await expect(categorical.locator('option:checked')).toHaveText('cell_type');

  // Two highlight pages, with real cell membership on each. `addHighlightFrom*`
  // are the same DataState entry points the legend and the range controls call;
  // driving them directly keeps the spec about persistence rather than about
  // the geometry of a lasso gesture.
  // Selecting the field starts an asynchronous load; a category highlight needs
  // the codes, so wait for them rather than for a frame count.
  await expect.poll(() => page.evaluate(() => {
    const state = window._cellucidState;
    if (state.activeFieldSource !== 'obs' || state.activeFieldIndex < 0) {
      return null;
    }
    const field = state.obsData.fields[state.activeFieldIndex];
    return field?.key === 'cell_type' && field.codes != null
      ? field.codes.length
      : null;
  })).toBe(120);

  const built = await page.evaluate(() => {
    const state = window._cellucidState;
    const fieldIndex = state.activeFieldIndex;
    const first = state.addHighlightFromCategory(fieldIndex, 0, 'obs');
    const second = state.addHighlightFromCategory(fieldIndex, 1, 'obs');
    const page2 = state.createHighlightPage();
    state.switchToPage(page2.id);
    const third = state.addHighlightDirect({
      type: 'lasso',
      label: 'Hand drawn region',
      cellIndices: [3, 11, 12, 40, 41, 42, 97],
    });
    state.setHighlightPageColor(page2.id, '#ff8800');
    state.renameHighlightPage(page2.id, 'Region of interest');
    // `toggleHighlightEnabled` is a setter despite its name: the second
    // argument is required and is written to `group.enabled` unvalidated.
    state.toggleHighlightEnabled(third.id, false);
    state.switchToPage(state.highlightPages[0].id);
    return {
      groups: [first, second, third].map(group => group.id),
      counts: [first, second, third].map(group => group.cellCount),
    };
  });
  expect(
    built.groups.length,
    'the spec must actually create highlight groups, or the membership path '
      + 'it exists to exercise is never reached',
  ).toBe(3);
  expect(Math.min(...built.counts)).toBeGreaterThan(0);

  // A non-default selection tool.
  await page.locator('#highlight-mode-lasso').click();
  await expect(page.locator('#highlight-mode-lasso'))
    .toHaveAttribute('aria-pressed', 'true');

  // Controls from several accordions, including two the renderer owns and one
  // that is only reachable once adaptive LOD is off.
  await page.locator('#point-size').fill('31');
  await page.locator('#point-size').dispatchEvent('input');
  await page.locator('#background-select').selectOption('black');
  await setControl(page, 'hp-lod-enabled', false);
  await setControl(page, 'hp-lod-force', '5');
  await setControl(page, 'hp-frustum-culling', false);
  await setControl(page, 'toggle-centroid-labels', true);
  await setControl(page, 'smoke-density', '71');
  await expect(page.locator('#hp-lod-force')).toHaveValue('5');

  // A kept view, so multiview is inside the comparison.
  await page.locator('#split-keep-view-btn').click();
  await expect(page.locator('#split-view-badges-list > *')).not.toHaveCount(0);

  const savedPath = await saveSession(page, testInfo, 'saved.cellucid-session');
  const saved = await readSessionChunks(savedPath);

  // The saved file has to contain the things this spec claims to cover;
  // otherwise the comparison below could be satisfied by two empty states.
  const savedCore = saved.payloads.get('core/state');
  expect(
    saved.order.filter(id => id.startsWith('highlights/cells/')),
    'the session must carry one membership chunk per highlight group — this is '
      + 'the path no published preset exercises',
  ).toHaveLength(3);
  expect(savedCore.uiControls['highlight-mode']).toEqual({
    type: 'pressed-group',
    pressedId: 'highlight-mode-lasso',
  });
  expect(savedCore.multiview.snapshots.length).toBeGreaterThan(0);
  expect(saved.payloads.get('highlights/meta').pages).toHaveLength(2);

  // ---------------------------------------------------------------------
  // Drift past the saved state, in every part of it.
  // ---------------------------------------------------------------------
  await page.locator('#highlight-mode-annotation').click();
  await page.locator('#point-size').fill('7');
  await page.locator('#point-size').dispatchEvent('input');
  await setControl(page, 'hp-lod-force', '-1');
  await setControl(page, 'hp-lod-enabled', true);
  await setControl(page, 'hp-frustum-culling', true);
  await page.locator('#background-select').selectOption('white');
  await setControl(page, 'toggle-centroid-labels', false);
  await setControl(page, 'smoke-density', '20');
  await page.evaluate(() => {
    const state = window._cellucidState;
    state.clearAllHighlights();
    for (const highlightPage of [...state.highlightPages].slice(1)) {
      state.deleteHighlightPage(highlightPage.id);
    }
    state.clearActiveField();
    const viewer = window._cellucidViewer;
    const camera = viewer.getCameraState();
    viewer.setCameraState({
      ...camera,
      orbit: { ...camera.orbit, radius: camera.orbit.radius * 1.7 },
    });
  });

  await expect(page.locator('#point-size')).toHaveValue('7');
  await expect(page.locator('#highlight-mode-annotation'))
    .toHaveAttribute('aria-pressed', 'true');

  // ---------------------------------------------------------------------
  // Restore, then ask the application what its state is now.
  // ---------------------------------------------------------------------
  await loadSession(page, savedPath);

  await expect(page.locator('#point-size')).toHaveValue('31');
  await expect(page.locator('#highlight-mode-lasso'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#categorical-field option:checked'))
    .toHaveText('cell_type');

  const restoredPath = await saveSession(
    page,
    testInfo,
    'restored.cellucid-session',
  );
  const restored = await readSessionChunks(restoredPath);

  // ---------------------------------------------------------------------
  // Compare the two captures whole.
  // ---------------------------------------------------------------------
  expect(
    restored.order,
    'the restored state must produce the same chunk inventory, in the same '
      + 'order; a missing chunk is state that did not come back',
  ).toEqual(saved.order);
  expect(restored.manifest.datasetFingerprint)
    .toEqual(saved.manifest.datasetFingerprint);

  const restoredCore = relabelSnapshotIds(
    savedCore,
    restored.payloads.get('core/state'),
  );
  expect(
    restoredCore,
    'the whole core state must come back: camera, dimension, every UI control, '
      + 'filters, active fields, and the complete multiview graph',
  ).toEqual(savedCore);

  for (const chunkId of saved.order) {
    if (chunkId === 'core/state') continue;
    expect(
      restored.payloads.get(chunkId),
      `the "${chunkId}" chunk must come back unchanged`,
    ).toEqual(saved.payloads.get(chunkId));
  }

  // ---------------------------------------------------------------------
  // A restore raises nothing (CEL-0239).
  //
  // This assertion used to carry a named exemption for exactly one uncaught
  // `RangeError` per restore. `state-serializer/multiview.js` empties the
  // viewer's snapshot inventory through `clearPublishedSnapshotViews()` at the
  // start of the rebuild, and `ui/modules/view-controls.js` kept private
  // `activeViewId` and `liveViewHidden` copies of state its owners had already
  // moved. The badge render that the same rebuild scheduled then threw on a
  // kept view that no longer existed. The module now reads both from their
  // owners on every use, so there is nothing left to exempt.
  //
  // The exemption mattered because `state-serializer/ui-controls.js` installs a
  // capture-phase window `error` listener for the duration of each control
  // event it dispatches: a badge render reached synchronously from a restored
  // control's own listener turned this into a restore failure naming an
  // unrelated control.
  expect(
    browserErrors,
    'no session restore may raise a page error',
  ).toEqual([]);
});
