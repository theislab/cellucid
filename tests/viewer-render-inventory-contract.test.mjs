import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  retireRenderViewRecord,
} from '../assets/js/rendering/viewer.js';

test('viewer render inventory uses stable live and weak snapshot records', async () => {
  const viewerSource = await readFile(
    new URL(
      '../assets/js/rendering/viewer.js',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    viewerSource,
    /const _liveRenderViewRecord = \{/,
  );
  assert.match(
    viewerSource,
    /const _snapshotRenderViewRecordPool = new WeakMap\(\)/,
  );
  assert.doesNotMatch(
    viewerSource,
    /_renderAllViews\.push\(\s*\{/,
    'the hot render inventory must not allocate one descriptor literal per view per frame',
  );
});

test('stable live render record releases every dataset-sized reference at terminal retirement', () => {
  const colors = new Uint8Array(4_000_000);
  const transparency = new Float32Array(1_000_000);
  const centroidPositions = new Float32Array(300);
  const centroidColors = new Uint8Array(400);
  const centroidTransparencies = new Float32Array(100);
  const cameraState = {
    orbit: {
      radius: 1,
      target: [0, 0, 0],
    },
  };
  const stableRecord = {
    id: 'live',
    label: 'Large live dataset',
    colors,
    transparency,
    centroidPositions,
    centroidColors,
    centroidTransparencies,
    centroidCount: 100,
    cameraState,
  };
  const acceptedIdentity = stableRecord;

  // Publishing new per-frame references mutates the stable descriptor rather
  // than replacing it; retirement must preserve that allocation contract.
  stableRecord.colors = colors;
  stableRecord.transparency = transparency;
  stableRecord.cameraState = cameraState;
  assert.strictEqual(stableRecord, acceptedIdentity);

  const retired =
    retireRenderViewRecord(stableRecord);

  assert.strictEqual(retired, acceptedIdentity);
  assert.equal(retired.id, 'live');
  assert.equal(retired.label, '');
  assert.equal(retired.colors, null);
  assert.equal(retired.transparency, null);
  assert.equal(retired.centroidPositions, null);
  assert.equal(retired.centroidColors, null);
  assert.equal(retired.centroidTransparencies, null);
  assert.equal(retired.centroidCount, 0);
  assert.equal(retired.cameraState, null);
});
