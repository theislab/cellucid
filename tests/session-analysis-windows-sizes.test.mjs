/**
 * The `analysis/windows` session chunk carries the sizes a user gave each
 * analysis's windows and expanded views (`sizes`), beside the windows
 * themselves with their box, open state and layer. The record is exact: a
 * payload without `sizes` (a session from before it existed) is refused, not
 * migrated, and so is a size of an unknown analysis or with a missing field.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { analysisViewSizes } from '../assets/js/app/analysis/shared/analysis-view-sizes.js';
import {
  capture as captureAnalysisWindows,
  restore as restoreAnalysisWindows
} from '../assets/js/app/session/contributors/analysis-windows.js';
import { decodeTypedJson, encodeTypedJson } from '../assets/js/app/session/codecs/typed-json.js';

const KNOWN = new Set(['genesPanel', 'differential', 'dotplot', 'composition']);
const isKnown = modeId => KNOWN.has(modeId);

const SIZES = {
  window: { genesPanel: { width: 520, height: 640 } },
  expandedView: {
    dotplot: { width: 900, height: 700, optionsWidth: 260, footerHeight: 180, statsWidth: 400 }
  }
};

function managerOver(store, windows = []) {
  const events = [];
  return {
    events,
    exportSessionWindows: () => windows,
    exportViewSizes: () => store.exportSizes(),
    importViewSizes(sizes) {
      events.push('sizes');
      store.importSizes(sizes, isKnown);
    },
    async closeAll() {
      events.push('close');
    },
    async createFromSessionDescriptor(descriptor) {
      events.push(`open:${descriptor.modeId}:${descriptor.z}`);
    }
  };
}

test('remembered sizes round-trip exactly and replace the ones held', () => {
  analysisViewSizes.clear();
  analysisViewSizes.rememberWindowSize('composition', { width: 400, height: 300 });
  analysisViewSizes.importSizes(structuredClone(SIZES), isKnown);
  assert.deepEqual(analysisViewSizes.exportSizes(), SIZES);
  assert.equal(analysisViewSizes.windowSize('composition'), null, 'an import replaces, not merges');
  assert.deepEqual(analysisViewSizes.windowSize('genesPanel'), { width: 520, height: 640 });
  analysisViewSizes.clear();
  assert.deepEqual(analysisViewSizes.exportSizes(), { window: {}, expandedView: {} });
});

test('a sizes record is refused whole: unknown analysis, missing field, bad number', () => {
  analysisViewSizes.clear();
  analysisViewSizes.rememberWindowSize('genesPanel', { width: 300, height: 200 });
  const before = analysisViewSizes.exportSizes();
  assert.throws(
    () => analysisViewSizes.importSizes({ window: { nope: { width: 1, height: 1 } }, expandedView: {} }, isKnown),
    /unknown analysis "nope"/
  );
  assert.throws(
    () => analysisViewSizes.importSizes({ window: {}, expandedView: { dotplot: { width: 1, height: 1 } } }, isKnown),
    /must contain exactly/
  );
  assert.throws(
    () => analysisViewSizes.importSizes({ window: { dotplot: { width: 0, height: 10 } }, expandedView: {} }, isKnown),
    /positive finite/
  );
  assert.throws(() => analysisViewSizes.importSizes({ window: {} }, isKnown), /exactly: expandedView, window/);
  assert.deepEqual(analysisViewSizes.exportSizes(), before, 'nothing changed');
  assert.throws(() => analysisViewSizes.rememberWindowSize('', { width: 1, height: 1 }), /non-empty/);
});

test('the chunk carries windows and sizes; restore sets the sizes before reopening windows', async () => {
  analysisViewSizes.clear();
  analysisViewSizes.importSizes(structuredClone(SIZES), isKnown);
  const windows = [
    { modeId: 'genesPanel', open: true, rect: { left: 1, top: 2, width: 300, height: 400 }, z: 91, settings: {}, result: null, headerTitle: 'Marker genes' },
    { modeId: 'dotplot', open: false, rect: { left: 9, top: 9, width: 500, height: 600 }, z: 92, settings: {}, result: null, headerTitle: 'Dot plot' }
  ];
  const [chunk] = captureAnalysisWindows({ analysisWindowManager: managerOver(analysisViewSizes, windows) });
  assert.equal(chunk.id, 'analysis/windows');
  const payload = decodeTypedJson(chunk.payload);
  assert.deepEqual(Object.keys(payload).sort(), ['sizes', 'windows']);
  assert.deepEqual(payload.sizes, SIZES);
  assert.deepEqual(payload.windows, windows);

  analysisViewSizes.clear();
  const manager = managerOver(analysisViewSizes);
  await restoreAnalysisWindows({ analysisWindowManager: manager }, { id: 'analysis/windows' }, chunk.payload);
  assert.deepEqual(manager.events, ['close', 'sizes', 'open:genesPanel:91', 'open:dotplot:92']);
  assert.deepEqual(analysisViewSizes.exportSizes(), SIZES);
});

test('a payload without sizes is refused, not migrated', async () => {
  const manager = managerOver(analysisViewSizes);
  await assert.rejects(
    restoreAnalysisWindows(
      { analysisWindowManager: manager },
      { id: 'analysis/windows' },
      encodeTypedJson({ windows: [] })
    ),
    /exactly: sizes, windows/
  );
  assert.deepEqual(manager.events, []);
});
