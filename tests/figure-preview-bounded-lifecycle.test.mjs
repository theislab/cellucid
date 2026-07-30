import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  areFigurePreviewCertificatesEqual,
  createFigurePreviewEpochFence,
  mapFigurePreviewPointToPlot,
} from '../assets/js/app/ui/modules/figure-export/figure-export-ui.js';
import {
  reducePointsByDensity,
} from '../assets/js/app/ui/modules/figure-export/utils/density-reducer.js';

const IDENTITY_MATRIX = Float32Array.from([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function renderState({
  viewportHeight = 100,
  viewportWidth = 100,
} = {}) {
  return {
    mvpMatrix: IDENTITY_MATRIX,
    viewportHeight,
    viewportWidth,
  };
}

function observeNumericReads(owner, counter) {
  return new Proxy(owner, {
    get(target, key) {
      if (/^(?:0|[1-9][0-9]*)$/.test(String(key))) {
        counter.count++;
      }
      return Reflect.get(target, key, target);
    },
  });
}

test('large-N preview reads and retains only bounded sampled ownership', () => {
  const pointCount = 1_000_000;
  const maxScanPoints = 1_000;
  const targetCount = 100;
  const positionsOwner = new Float32Array(pointCount * 3);
  const colorsOwner = new Uint8Array(pointCount * 4);
  const highlightOwner = new Uint8Array(pointCount);
  colorsOwner.fill(255);
  highlightOwner.fill(255);
  const stride = Math.ceil(pointCount / maxScanPoints);
  for (
    let pointIndex = 0;
    pointIndex < pointCount;
    pointIndex += stride
  ) {
    positionsOwner[pointIndex * 3] =
      pointIndex / pointCount;
  }

  const positionReads = { count: 0 };
  const colorReads = { count: 0 };
  const highlightReads = { count: 0 };
  const sparseReads = { count: 0 };
  const positions = observeNumericReads(
    positionsOwner,
    positionReads
  );
  const colors = observeNumericReads(colorsOwner, colorReads);
  const highlightArray = observeNumericReads(
    highlightOwner,
    highlightReads
  );
  const hugeSparseOwner = new Proxy(
    new Array(pointCount),
    {
      get(target, key) {
        if (/^(?:0|[1-9][0-9]*)$/.test(String(key))) {
          sparseReads.count++;
        }
        return Reflect.get(target, key);
      },
    }
  );

  const reduced = reducePointsByDensity({
    positions,
    colors,
    highlightArray,
    highlightedIndices: hugeSparseOwner,
    renderState: renderState(),
    targetCount,
    maxScanPoints,
    gridSize: 32,
    seed: 20260730,
  });

  assert.equal(reduced.index.length, targetCount);
  assert.equal(reduced.scannedSourceCount, maxScanPoints);
  assert.equal(reduced.candidateSourceCount, pointCount);
  assert.equal(reduced.sourcePositions.length, targetCount * 3);
  assert.equal(reduced.highlighted.length, targetCount);
  assert.equal(
    Array.from(reduced.highlighted).every(value => value === 255),
    true
  );
  for (let outputIndex = 0; outputIndex < targetCount; outputIndex++) {
    const sourceIndex = reduced.index[outputIndex];
    assert.equal(sourceIndex % stride, 0);
    assert.equal(
      reduced.sourcePositions[outputIndex * 3],
      positionsOwner[sourceIndex * 3]
    );
  }

  assert.equal(
    sparseReads.count,
    0,
    'H > target must not traverse the huge sparse highlight inventory'
  );
  assert.ok(positionReads.count < 10_000, positionReads.count);
  assert.ok(colorReads.count < 10_000, colorReads.count);
  assert.ok(highlightReads.count < 10_000, highlightReads.count);
  assert.ok(
    positionReads.count + colorReads.count + highlightReads.count <
      25_000
  );
  for (const retained of Object.values(reduced)) {
    assert.notStrictEqual(retained, positions);
    assert.notStrictEqual(retained, colors);
    assert.notStrictEqual(retained, highlightArray);
    assert.notStrictEqual(retained, hugeSparseOwner);
  }
  const retainedBytes = [
    reduced.x,
    reduced.y,
    reduced.rgba,
    reduced.alpha,
    reduced.index,
    reduced.sourcePositions,
    reduced.highlighted,
  ].reduce((sum, owner) => sum + owner.byteLength, 0);
  assert.ok(retainedBytes < 10_000, retainedBytes);

  const sparseHighlightArray = new Uint8Array(pointCount);
  const sparseHighlightIds = [999_997, 999_998, 999_999];
  for (const sourceIndex of sparseHighlightIds) {
    sparseHighlightArray[sourceIndex] = 255;
  }
  const sparseVisible = reducePointsByDensity({
    positions: positionsOwner,
    colors: colorsOwner,
    highlightArray: sparseHighlightArray,
    highlightedIndices: sparseHighlightIds,
    renderState: renderState(),
    targetCount: 5,
    maxScanPoints,
    gridSize: 32,
    seed: 20260730,
  });
  assert.equal(sparseVisible.candidateSourceCount, pointCount);
  assert.equal(
    sparseVisible.scannedSourceCount,
    maxScanPoints + sparseHighlightIds.length
  );
  for (const sourceIndex of sparseHighlightIds) {
    assert.equal(sparseVisible.index.includes(sourceIndex), true);
  }
});

test('preview sampling consumes the exact cap just above its boundary', () => {
  const pointCount = 101;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  colors.fill(255);

  const reduced = reducePointsByDensity({
    positions,
    colors,
    renderState: renderState(),
    targetCount: 10,
    maxScanPoints: 100,
    gridSize: 32,
    seed: 19,
  });

  assert.equal(reduced.candidateSourceCount, pointCount);
  assert.equal(reduced.scannedSourceCount, 100);
  assert.equal(reduced.index.length, 10);
  assert.throws(
    () => reducePointsByDensity({
      positions,
      colors,
      renderState: renderState(),
      targetCount: 10,
      maxScanPoints: 0,
    }),
    /positive safe integer/i
  );
});

test('small sparse highlights preserve exact source positions and sampled ownership', () => {
  const pointCount = 100;
  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const highlightArray = new Uint8Array(pointCount);
  colors.fill(255);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    positions[pointIndex * 3] =
      ((pointIndex % 10) + 0.5) / 5 - 1;
    positions[pointIndex * 3 + 1] =
      (Math.floor(pointIndex / 10) + 0.5) / 5 - 1;
    positions[pointIndex * 3 + 2] = pointIndex / 100;
  }
  const highlightedIndices = [97, 98, 99];
  for (const pointIndex of highlightedIndices) {
    highlightArray[pointIndex] = 255;
  }

  const reduced = reducePointsByDensity({
    positions,
    colors,
    highlightArray,
    highlightedIndices,
    renderState: renderState(),
    targetCount: 10,
    maxScanPoints: 10,
    gridSize: 32,
    seed: 41,
  });
  const slotBySource = new Map(
    Array.from(reduced.index, (sourceIndex, slot) => [
      sourceIndex,
      slot,
    ])
  );
  assert.equal(
    reduced.scannedSourceCount,
    13,
    'the exact scan count includes the capped base stride and three sparse supplements'
  );
  assert.equal(reduced.candidateSourceCount, pointCount);
  for (const sourceIndex of highlightedIndices) {
    const slot = slotBySource.get(sourceIndex);
    assert.notEqual(slot, undefined);
    assert.equal(reduced.highlighted[slot], 255);
    assert.deepEqual(
      Array.from(
        reduced.sourcePositions.subarray(slot * 3, slot * 3 + 3)
      ),
      Array.from(
        positions.subarray(sourceIndex * 3, sourceIndex * 3 + 3)
      )
    );
  }
});

test('crop mapping subtracts its source origin exactly once', () => {
  assert.deepEqual(
    mapFigurePreviewPointToPlot({
      viewportX: 40,
      viewportY: 35,
      sourceOriginX: 30,
      sourceOriginY: 20,
      plotOffsetX: 5,
      plotOffsetY: 7,
      plotScale: 2,
    }),
    {
      x: 25,
      y: 37,
    }
  );

  const reduced = reducePointsByDensity({
    positions: Float32Array.from([0, 0, 0]),
    colors: Uint8Array.from([10, 20, 30, 255]),
    renderState: renderState(),
    targetCount: 1,
    crop: {
      enabled: true,
      x: 0.25,
      y: 0.2,
      width: 0.5,
      height: 0.6,
    },
    gridSize: 32,
  });
  assert.deepEqual(Array.from(reduced.x), [25]);
  assert.deepEqual(Array.from(reduced.y), [30]);
  assert.deepEqual(
    mapFigurePreviewPointToPlot({
      viewportX: reduced.x[0],
      viewportY: reduced.y[0],
      sourceOriginX: 0,
      sourceOriginY: 0,
      plotOffsetX: 0,
      plotOffsetY: 0,
      plotScale: 1,
    }),
    {
      x: 25,
      y: 30,
    }
  );
});

test('preview epoch and certificate fences reject stale or closed work', () => {
  const lodToken = Object.freeze({});
  const certificate = {
    aspect: { height: 900, width: 1200 },
    dimensionLevel: 2,
    geometryGeneration: 7,
    lodGeneration: lodToken,
    mode: 'full',
    presentedCacheKey: 'live|7|camera-a|layout-a',
    viewId: 'live',
  };
  const equivalent = {
    ...certificate,
    aspect: { height: 900, width: 1200 },
  };
  assert.equal(
    areFigurePreviewCertificatesEqual(
      certificate,
      equivalent
    ),
    true
  );
  assert.equal(
    areFigurePreviewCertificatesEqual(
      certificate,
      {
        ...equivalent,
        presentedCacheKey: 'live|7|camera-b|layout-a',
      }
    ),
    false
  );
  assert.equal(
    areFigurePreviewCertificatesEqual(
      certificate,
      {
        ...equivalent,
        lodGeneration: Object.freeze({}),
      }
    ),
    false,
    'opaque generation owners compare by identity'
  );

  const fence = createFigurePreviewEpochFence();
  const first = fence.capture(certificate);
  assert.equal(fence.accepts(first, equivalent), true);
  fence.invalidate();
  assert.equal(fence.accepts(first, equivalent), false);
  const second = fence.capture(equivalent);
  assert.equal(fence.accepts(second, equivalent), true);
  fence.close();
  assert.equal(fence.accepts(second, equivalent), false);
  assert.equal(fence.closed, true);
});

test('empty and fully cropped reductions publish deterministic empty owners', () => {
  const empty = reducePointsByDensity({
    positions: new Float32Array(0),
    colors: new Uint8Array(0),
    renderState: renderState({
      viewportHeight: 80,
      viewportWidth: 120,
    }),
    targetCount: 0,
  });
  assert.deepEqual(
    {
      alpha: empty.alpha.length,
      highlighted: empty.highlighted.length,
      index: empty.index.length,
      rgba: empty.rgba.length,
      sourcePositions: empty.sourcePositions.length,
      x: empty.x.length,
      y: empty.y.length,
    },
    {
      alpha: 0,
      highlighted: 0,
      index: 0,
      rgba: 0,
      sourcePositions: 0,
      x: 0,
      y: 0,
    }
  );
  assert.equal(empty.viewportWidth, 120);
  assert.equal(empty.viewportHeight, 80);
  assert.equal(empty.scannedSourceCount, 0);
  assert.equal(empty.candidateSourceCount, 0);

  const cropped = reducePointsByDensity({
    positions: Float32Array.from([-0.9, -0.9, 0]),
    colors: Uint8Array.from([255, 255, 255, 255]),
    renderState: renderState(),
    targetCount: 1,
    crop: {
      enabled: true,
      x: 0.5,
      y: 0.5,
      width: 0.4,
      height: 0.4,
    },
  });
  assert.equal(cropped.index.length, 0);
  assert.equal(cropped.sourcePositions.length, 0);
  assert.equal(cropped.highlighted.length, 0);
  assert.equal(cropped.scannedSourceCount, 1);
  assert.equal(cropped.candidateSourceCount, 1);
  assert.equal(cropped.viewportWidth, 40);
  assert.equal(cropped.viewportHeight, 40);
});

test('preview UI borrows N-sized data and fences every retained lifecycle owner', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/ui/modules/figure-export/figure-export-ui.js',
      import.meta.url
    ),
    'utf8'
  );
  assert.match(source, /viewer\.withBorrowedViewData\(/);
  assert.match(source, /viewer\.getPresentedViewState\(/);
  assert.match(
    source,
    /typeof viewer\.onPresentedViewStateChanged !== 'function'/
  );
  assert.doesNotMatch(
    source,
    /viewer\.getView(?:Positions|Colors|Transparency)\(/
  );
  assert.doesNotMatch(source, /sample\.positions/);
  assert.match(source, /reduced\.sourcePositions/);
  assert.match(
    source,
    /const maxScanPoints = PREVIEW_MAX_SCAN_POINTS;/
  );
  assert.doesNotMatch(
    source,
    /const fastSample = !force|maxScanPoints\s*=\s*null/
  );
  for (const eventName of [
    'field:changed',
    'visibility:changed',
    'highlight:changed',
    'dimension:changed',
    'view:changed',
    'page:changed',
  ]) {
    assert.match(source, new RegExp(`['"]${eventName}['"]`));
  }
  assert.match(source, /viewer\.onLodChanged/);
  assert.match(source, /viewer\.onPresentedViewStateChanged/);
  assert.match(
    source,
    /rebuildDelayMs:\s*PREVIEW_PRESENTATION_SETTLE_MS/
  );
  assert.match(
    source,
    /event\?\.reason === 'camera-changing'[\s\S]*invalidatePreviewSamples\(\{ rebuild: false \}\)/
  );
  assert.match(
    source,
    /event\?\.reason === 'camera-settled'[\s\S]*invalidatePreviewSamples\(\)/
  );
  assert.match(
    source,
    /clearTimeout\(previewRebuildTimer\)/
  );
  assert.match(source, /runPreviewUiAction\('Preview toggle'/);
  assert.match(source, /runPreviewUiAction\('Preview refresh'/);
  assert.match(source, /runPreviewUiAction\('Preview framing'/);
  assert.match(
    source,
    /candidate\.reduced\.scannedSourceCount\s*<\s*candidate\.reduced\.candidateSourceCount/
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*if \(!abortController\.signal\.aborted\)[\s\S]*reportFigureExportFailure\(error\);/i
  );
  assert.match(source, /isPreviewSampleCurrent\(sample\)/);
  assert.match(source, /previewEpochFence\.accepts\(/);
  assert.match(source, /previewEpochFence\.close\(\)/);
  assert.match(source, /cancelPendingPreviewFrame\(\)/);
  assert.match(source, /clearTimeout\(previewDrawTimer\)/);
  assert.match(source, /clearTimeout\(previewRebuildTimer\)/);
  assert.match(source, /clearTimeout\(previewTitleTimer\)/);
  assert.match(source, /endCropDrag\(\)/);
  assert.match(source, /releasePreviewSamples\(\)/);
  assert.match(
    source,
    /cropDrag !== null[\s\S]*evt\.isPrimary === false[\s\S]*evt\.pointerType === 'mouse'/
  );
  assert.match(
    source,
    /cropDrag !== null[\s\S]*evt\.pointerId !== cropDrag\.pointerId/
  );
  assert.match(source, /listen\(previewCanvas, 'lostpointercapture'/);
  assert.equal(
    source.match(/\.addEventListener\(/g)?.length,
    1,
    'Every figure-export DOM listener must use the shared lifecycle owner'
  );
  assert.match(
    source,
    /if \(cleanupComplete \|\| exportInFlight\) return;[\s\S]*setBusy\(true\);[\s\S]*await exportFigureFromUi\(abortController\.signal\)/
  );
  assert.match(
    source,
    /confirmExportFidelityWarnings\(\{[\s\S]*warnings,[\s\S]*signal,/
  );
  assert.match(
    source,
    /engine\.exportFigure\(\{[\s\S]*signal,[\s\S]*format: jobs\[0\]\.format/
  );
  assert.match(
    source,
    /engine\.exportFigures\(\{[\s\S]*signal,[\s\S]*jobs/
  );
  assert.doesNotMatch(
    source,
    /Figure preview axes require at least one visible point/
  );
});

test('figure-export UI exposes its stable idempotent cleanup owner', async () => {
  const source = await readFile(
    new URL(
      '../assets/js/app/ui/modules/figure-export/figure-export-ui.js',
      import.meta.url
    ),
    'utf8'
  );

  assert.match(
    source,
    /const destroy = \(\) => \{\s*if \(cleanupComplete\) return;/
  );
  assert.match(source, /container\.__cellucidCleanup = destroy;/);
  assert.match(source, /return \{ destroy \};\s*\n\}/);
});
