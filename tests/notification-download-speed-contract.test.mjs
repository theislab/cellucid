/**
 * What gets a transfer line (round 9 close, RCA-7). A load's line says a
 * speed only once bytes were measured arriving: never "0 B/s" before the
 * first bytes, nor while the load does work that reads none (a phase), and a
 * starting view, which is a part of its dataset's opening and is already in
 * the page, has no line of its own (`session-serializer.js` `restoreLine`,
 * `session-serializer-contract.test.mjs`; "↓ Loading Starting view 0 B/s
 * Cancel" showed at every sample's start).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { downloadTrackingMethods } from '../assets/js/app/notification-center/download-tracking.js';

function fakeCenter() {
  const shown = [];
  const updates = [];
  let ids = 0;
  const center = {
    downloadTrackers: new Map(),
    _generateId: () => `n${++ids}`,
    show: options => { shown.push(options); return options.id; },
    _updateNotification: (id, options) => updates.push({ id, ...options }),
    complete: () => {},
    dismiss: () => {},
    ...downloadTrackingMethods,
  };
  return { center, shown, updates };
}

test('a load\'s line names no speed until bytes were measured arriving, and none during a phase that reads none', async () => {
  const { center, shown, updates } = fakeCenter();
  const id = center.startDownload('Session file', 1000, {});
  assert.equal(Object.hasOwn(shown[0], 'speed'), false, 'no "0 B/s" before any byte');
  // Bytes at once (within the first measuring window): their count, still no rate.
  center.updateDownload(id, 10);
  assert.equal(Object.hasOwn(updates.at(-1), 'speed'), false);
  assert.match(updates.at(-1).message, /^Session file \(10 B \/ /);
  // A window later: measured.
  const start = performance.now();
  while (performance.now() - start < 120) { /* the measuring window passes */ }
  center.updateDownload(id, 500);
  assert.equal(typeof updates.at(-1).speed, 'number');
  assert.ok(updates.at(-1).speed > 0);
  // A phase reads no bytes: the speed is taken away.
  center.phaseDownload(id, 'Summing each cell\'s counts…');
  assert.equal(updates.at(-1).speed, null);
  assert.equal(updates.at(-1).message, 'Session file: Summing each cell\'s counts…');
});

