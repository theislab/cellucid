/**
 * The figure-export settings a session records (`utils/session-settings.js`):
 * one exact, versioned plain object, read strictly, with no derived values.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertFigureExportSessionSettings,
  FIGURE_EXPORT_SESSION_SETTINGS_VERSION,
  FIGURE_EXPORT_SETTING_RANGES,
  trackCommittedNumber,
} from '../assets/js/app/ui/modules/figure-export/utils/session-settings.js';

function settings(overrides = {}) {
  return {
    version: 1,
    sizePreset: '1600x1200',
    width: 1600,
    height: 1200,
    frame: { lockAspect: true, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } },
    background: 'custom',
    backgroundColor: '#123abc',
    fontFamily: '"Times New Roman", Times, serif',
    autoTextSize: false,
    fontSizes: { base: 14, legend: 13, ticks: 12, axisLabel: 16, title: 22, centroidLabel: 11 },
    titleFollowsDataset: false,
    title: 'Figure 2 — hücre',
    xLabel: 'UMAP_1',
    yLabel: 'UMAP_2',
    includeAxes: true,
    includeLegend: false,
    referenceGrid: false,
    showOrientation: true,
    depthSort: false,
    legendPosition: 'bottom',
    emphasizeSelection: true,
    selectionMutedOpacity: 0.25,
    preview: { enabled: true, colorblindMode: 'protanopia' },
    download: 'all',
    dpi: 600,
    svgStrategy: 'optimized-vector',
    optimizedTargetCount: 250000,
    exportAllViews: true,
    ...overrides,
  };
}

test('a complete settings object is accepted as it is and survives JSON', () => {
  const value = settings();
  assert.equal(assertFigureExportSessionSettings(value), value);
  assert.deepEqual(assertFigureExportSessionSettings(JSON.parse(JSON.stringify(value))), value);
  assert.equal(FIGURE_EXPORT_SESSION_SETTINGS_VERSION, 1);
});

test('derived values are absent, never recorded', () => {
  assert.doesNotThrow(() => assertFigureExportSessionSettings(settings({ autoTextSize: true, fontSizes: null })));
  assert.throws(
    () => assertFigureExportSessionSettings(settings({ autoTextSize: true })),
    /fontSizes must be null while autoTextSize derives them/
  );
  assert.doesNotThrow(() => assertFigureExportSessionSettings(settings({ titleFollowsDataset: true, title: null })));
  assert.throws(
    () => assertFigureExportSessionSettings(settings({ titleFollowsDataset: true })),
    /title must be null while the title follows the dataset/
  );
  assert.doesNotThrow(() => assertFigureExportSessionSettings(settings({ frame: null, preview: { enabled: false, colorblindMode: 'none' } })));
});

test('unknown, missing or wrong-version keys are refused, never repaired', () => {
  assert.throws(() => assertFigureExportSessionSettings(settings({ extra: 1 })), /\(unexpected: extra\)/);
  const missing = settings();
  delete missing.dpi;
  assert.throws(() => assertFigureExportSessionSettings(missing), /Figure-export session settings must contain exactly: .*\(missing: dpi\)/);
  assert.throws(() => assertFigureExportSessionSettings(settings({ version: 2 })), /version must be 1/);
  assert.throws(
    () => assertFigureExportSessionSettings(settings({ fontSizes: { base: 14 } })),
    /fontSizes must contain exactly: .*\(missing: /
  );
  assert.throws(
    () => assertFigureExportSessionSettings(settings({ frame: { lockAspect: true, rect: { x: 0, y: 0, w: 1, h: 1 } } })),
    /frame\.rect must contain exactly: height, width, x, y \(missing: height, width; unexpected: h, w\)/
  );
  assert.throws(() => assertFigureExportSessionSettings(null), /must be a plain object/);
  assert.throws(() => assertFigureExportSessionSettings([]), /must be a plain object/);
});

test('every enumerated and ranged value is checked', () => {
  const invalid = [
    [{ sizePreset: '800x600' }, /sizePreset/],
    [{ width: 99 }, /width must be a whole number from 100 to 20000/],
    [{ height: 20001 }, /height/],
    [{ width: 1600.5 }, /width/],
    [{ background: 'black' }, /background must be one of/],
    [{ backgroundColor: '#ABCDEF' }, /lowercase #rrggbb/],
    [{ fontFamily: 'Comic Sans' }, /fontFamily/],
    [{ fontSizes: { base: 0, legend: 13, ticks: 12, axisLabel: 16, title: 22, centroidLabel: 11 } }, /fontSizes\.base/],
    [{ title: 3 }, /title must be a string/],
    [{ includeAxes: 'true' }, /includeAxes must be a boolean/],
    [{ legendPosition: 'left' }, /legendPosition/],
    [{ selectionMutedOpacity: 1.5 }, /selectionMutedOpacity/],
    [{ preview: { enabled: true, colorblindMode: 'mono' } }, /preview\.colorblindMode/],
    [{ preview: { enabled: false, colorblindMode: 'none' } }, /frame requires preview\.enabled/],
    [{ download: 'pdf' }, /download/],
    [{ dpi: '300' }, /dpi/],
    [{ svgStrategy: 'raster' }, /svgStrategy/],
    [{ optimizedTargetCount: 999 }, /optimizedTargetCount/],
    [{ frame: { lockAspect: false, rect: { x: 0.8, y: 0, width: 0.5, height: 1 } } }, /crop/i],
  ];
  for (const [override, message] of invalid) {
    assert.throws(() => assertFigureExportSessionSettings(settings(override)), message, JSON.stringify(override));
  }
  assert.doesNotThrow(() => assertFigureExportSessionSettings(settings({ svgStrategy: null })));
});

test('the panel publishes export and import through the one validator', async () => {
  const source = await readFile(
    new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /function exportSessionSettings\(\)[\s\S]+return assertFigureExportSessionSettings\(settings\);/);
  assert.match(source, /function importSessionSettings\(settings\)[\s\S]+const exact = assertFigureExportSessionSettings\(settings\);/);
});

/** A number box as the panel's listeners meet it. */
function numberBox(value) {
  const box = new EventTarget();
  box.value = value;
  return box;
}

test('a session saved mid-edit records the last valid width; the box keeps what is typed', () => {
  const width = numberBox('1200');
  const tracked = trackCommittedNumber(width, {
    label: 'width',
    range: FIGURE_EXPORT_SETTING_RANGES.plotSize,
    integer: true,
  });
  assert.equal(tracked.read(), 1200);

  // The panel sets a value itself (a preset), with no event; the person then
  // focuses the box and starts typing an out-of-range width.
  width.value = '1600';
  width.dispatchEvent(new Event('focus'));
  width.value = '5';
  width.dispatchEvent(new Event('input'));
  assert.equal(tracked.read(), 1600, 'the session records the last valid width');
  assert.equal(width.value, '5', 'the box is left as typed');

  width.value = '';
  width.dispatchEvent(new Event('input'));
  assert.equal(tracked.read(), 1600);

  width.value = '1800';
  width.dispatchEvent(new Event('change'));
  assert.equal(tracked.read(), 1800);
});

test('decimal controls track the same way, and a value never valid is an error', () => {
  const opacity = numberBox('0.15');
  const tracked = trackCommittedNumber(opacity, {
    label: 'non-selected opacity',
    range: FIGURE_EXPORT_SETTING_RANGES.selectionMutedOpacity,
    integer: false,
  });
  opacity.value = '1.';
  opacity.dispatchEvent(new Event('input'));
  assert.equal(tracked.read(), 0.15);

  const never = trackCommittedNumber(numberBox('abc'), {
    label: 'width',
    range: FIGURE_EXPORT_SETTING_RANGES.plotSize,
    integer: true,
  });
  assert.throws(() => never.read(), /width has never held a whole number from 100 to 20000/);
});

test('every number setting the panel exports is its last committed value', async () => {
  const source = await readFile(
    new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('  function exportSessionSettings() {');
  const end = source.indexOf('  function importSessionSettings(', start);
  const body = source.slice(start, end);
  for (const key of ['width', 'height', 'base', 'legend', 'ticks', 'axisLabel', 'title', 'centroidLabel', 'selectionMutedOpacity', 'optimizedTargetCount']) {
    assert.match(body, new RegExp(`committedNumbers\\.${key}\\.read\\(\\)`), key);
  }
  assert.doesNotMatch(body, /Input\.value\)|parseInt|Number\((?!dpiSelect)/);
});
