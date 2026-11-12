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
    version: 3,
    sizePreset: 'custom',
    width: 160,
    frame: { lockAspect: true, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } },
    background: 'custom',
    backgroundColor: '#123abc',
    fontFamily: '"Times New Roman", Times, serif',
    autoTextSize: false,
    fontSizes: { base: 7, legend: 6.5, ticks: 6, axisLabel: 7, title: 9, centroidLabel: 5.5 },
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
  assert.equal(FIGURE_EXPORT_SESSION_SETTINGS_VERSION, 3);
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
  assert.throws(() => assertFigureExportSessionSettings(settings({ version: 1 })), /version must be 3/);
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
    [{ sizePreset: '1600x1200' }, /sizePreset/],
    [{ width: 9.9 }, /width must be a width in millimetres, at least 10/],
    [{ width: Number.NaN }, /width/],
    [{ width: '160' }, /width/],
    // A preset is its own width; any other is custom (F271).
    [{ sizePreset: 'single-column', width: 90 }, /width must be 89 mm, the single-column width/],
    [{ height: 120 }, /unexpected: height/],
    [{ fontSizes: { base: 7.25, legend: 7, ticks: 6, axisLabel: 7, title: 8, centroidLabel: 6 } }, /fontSizes\.base must be a size in points from 1 to 375, in steps of 0\.5/],
    [{ fontSizes: { base: 400, legend: 7, ticks: 6, axisLabel: 7, title: 8, centroidLabel: 6 } }, /fontSizes\.base/],
    [{ background: 'black' }, /background must be one of/],
    [{ backgroundColor: '#ABCDEF' }, /lowercase #rrggbb/],
    [{ fontFamily: 'Comic Sans' }, /fontFamily/],
    [{ fontSizes: { base: 0, legend: 6.5, ticks: 6, axisLabel: 7, title: 9, centroidLabel: 5.5 } }, /fontSizes\.base/],
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
  // Full vector until another is chosen: never "none chosen" (F160).
  assert.throws(() => assertFigureExportSessionSettings(settings({ svgStrategy: null })), /svgStrategy/);
  // Every journal column is its own width; a custom width has no widest.
  for (const [sizePreset, width] of [['single-column', 89], ['one-and-half-column', 120], ['double-column', 183], ['custom', 10], ['custom', 2400]]) {
    assert.doesNotThrow(() => assertFigureExportSessionSettings(settings({ sizePreset, width })), sizePreset);
  }
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
    range: FIGURE_EXPORT_SETTING_RANGES.widthMm,
    integer: false,
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
  // A decimal comma, as a German or Turkish keyboard types it, is the same number.
  opacity.value = '0,3';
  opacity.dispatchEvent(new Event('input'));
  assert.equal(tracked.read(), 0.3);
  opacity.value = '0,';
  opacity.dispatchEvent(new Event('input'));
  assert.equal(tracked.read(), 0.3, 'still being typed');

  const never = trackCommittedNumber(numberBox('abc'), {
    label: 'width (mm)',
    range: FIGURE_EXPORT_SETTING_RANGES.widthMm,
    integer: false,
  });
  assert.throws(() => never.read(), /width \(mm\) has never held a number of at least 10/);
});

test('every number setting the panel exports is its last committed value', async () => {
  const source = await readFile(
    new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('  function exportSessionSettings() {');
  const end = source.indexOf('  function importSessionSettings(', start);
  const body = source.slice(start, end);
  for (const key of ['width', 'base', 'legend', 'ticks', 'axisLabel', 'title', 'centroidLabel', 'selectionMutedOpacity', 'optimizedTargetCount']) {
    assert.match(body, new RegExp(`committedNumbers\\.${key}\\.read\\(\\)`), key);
  }
  assert.doesNotMatch(body, /Input\.value\)|parseInt|Number\((?!dpiSelect)/);
});

// ---------------------------------------------------------------------------
// The settings as the parameters of `figure-export.set` (a step like any other)
// ---------------------------------------------------------------------------

test('every setting of the record is a parameter of figure-export.set, in its snake_case name', async () => {
  const {
    FIGURE_EXPORT_PARAMS, figureExportParamsOf, figureExportSettingsOf,
  } = await import('../assets/js/app/ui/modules/figure-export/utils/session-settings.js');
  const { schemaProblem } = await import('../assets/js/app/actions/schema.js');
  const { getActionCatalog } = await import('../assets/js/app/actions/index.js');
  const record = settings();
  const { version, ...rest } = record;
  assert.equal(version, 3);
  const params = figureExportParamsOf(rest);
  // The schema names exactly the record's settings: one added to the record is a parameter at once.
  assert.deepEqual(Object.keys(FIGURE_EXPORT_PARAMS.properties).sort(), Object.keys(params).sort());
  assert.deepEqual(Object.keys(params.font_sizes).sort(), ['axis_label', 'base', 'centroid_label', 'legend', 'ticks', 'title']);
  assert.deepEqual(Object.keys(params.frame), ['lock_aspect', 'rect']);
  assert.deepEqual(Object.keys(params.preview), ['enabled', 'colorblind_mode']);
  // Every valid record is a valid step, and comes back exactly.
  assert.equal(schemaProblem(FIGURE_EXPORT_PARAMS, params), null);
  assert.deepEqual(figureExportSettingsOf(params), rest);
  const derived = settings({ autoTextSize: true, fontSizes: null, titleFollowsDataset: true, title: null, frame: null });
  const { version: _v, ...derivedRest } = derived;
  assert.equal(schemaProblem(FIGURE_EXPORT_PARAMS, figureExportParamsOf(derivedRest)), null);
  // The action is in the catalog, changes the settings domain only, and its example is valid.
  const definition = getActionCatalog().get('figure-export.set');
  assert.deepEqual(definition.touches, ['settings']);
  assert.equal(definition.params, FIGURE_EXPORT_PARAMS);
  assert.match(definition.describe({ width: 180, include_axes: false, frame: null }, null), /^Figure export: width 180, include axes off, frame none$/);
  // Fit the cells (F161): a step's frame "cells", read back as the rect it made.
  assert.equal(schemaProblem(FIGURE_EXPORT_PARAMS, { frame: 'cells' }), null);
  assert.notEqual(schemaProblem(FIGURE_EXPORT_PARAMS, { frame: 'view' }), null);
  assert.equal(definition.describe({ frame: 'cells' }, null), 'Figure export: frame fitted to the cells');
  const { FIGURE_EXPORT_SETTINGS } = await import('../assets/js/app/ui/modules/figure-export/utils/session-settings.js');
  assert.equal(getActionCatalog().get('figure-export.get').result, FIGURE_EXPORT_SETTINGS);
  assert.equal(schemaProblem(FIGURE_EXPORT_SETTINGS, params), null);
  assert.notEqual(schemaProblem(FIGURE_EXPORT_SETTINGS, { ...params, frame: 'cells' }), null, 'a setting read back is never "cells"');
  // A step of version 1 that left the strategy unchosen comes up as full vector; a step of
  // version 1 or 2 sized in CSS pixels (1/96 inch) comes up in millimetres and points (F271):
  // its box's width is the figure's width (691.65 px is 183 mm, double column), its height
  // goes, its text sizes are points to the half point (12 px is 9 pt, 11 px 8.5).
  const { upgradeParams } = await import('../assets/js/app/actions/catalog.js');
  assert.deepEqual(upgradeParams(definition, 1, { svg_strategy: null, width: 900 }), { width: 238.1, size_preset: 'custom', svg_strategy: 'full-vector' });
  assert.deepEqual(upgradeParams(definition, 1, { svg_strategy: 'hybrid' }), { svg_strategy: 'hybrid' });
  assert.deepEqual(upgradeParams(definition, 2, { width: 691.65, height: 500, size_preset: '1600x1200' }), { width: 183, size_preset: 'double-column' });
  assert.deepEqual(
    upgradeParams(definition, 2, { auto_text_size: false, font_sizes: { base: 12, legend: 11, ticks: 10, axis_label: 12, title: 15, centroid_label: 9 } }),
    { auto_text_size: false, font_sizes: { base: 9, legend: 8.5, ticks: 7.5, axis_label: 9, title: 11.5, centroid_label: 7 } },
  );
  assert.deepEqual(upgradeParams(definition, 2, { height: 900, include_axes: true }), { include_axes: true });
  // A size that followed the window was no one's choice: it upgrades to the default, never to a
  // custom width measured off the window that saved it (a 1440 px window's half was 190.5 mm).
  assert.deepEqual(upgradeParams(definition, 2, { width: 720, height: 450, size_preset: 'screen-half', include_axes: true }), { include_axes: true });
  assert.deepEqual(upgradeParams(definition, 2, { width: 1440, height: 900, size_preset: 'screen' }), {});
  const upgraded = upgradeParams(definition, 2, { width: 1600, height: 1200, size_preset: '1600x1200', include_legend: true });
  assert.equal(schemaProblem(FIGURE_EXPORT_PARAMS, upgraded), null);
  assert.equal(definition.coalesce({ title: 'a', title_follows_dataset: false }), 'title,title_follows_dataset');
});

test('what changed between two records, settings that change together carried together', async () => {
  const { changedFigureExportSettings } = await import('../assets/js/app/ui/modules/figure-export/utils/session-settings.js');
  const before = settings();
  assert.deepEqual(changedFigureExportSettings(before, settings()), {});
  assert.deepEqual(changedFigureExportSettings(before, settings({ width: 89, sizePreset: 'single-column' })), { sizePreset: 'single-column', width: 89 });
  // Typing a title: the title and whether it follows the dataset, every keystroke, so a burst coalesces.
  assert.deepEqual(changedFigureExportSettings(before, settings({ title: 'B' })), { titleFollowsDataset: false, title: 'B' });
  assert.deepEqual(
    changedFigureExportSettings(before, settings({ autoTextSize: true, fontSizes: null })),
    { autoTextSize: true, fontSizes: null },
  );
  assert.deepEqual(
    changedFigureExportSettings(before, settings({ fontSizes: { base: 8, legend: 6.5, ticks: 6, axisLabel: 7, title: 9, centroidLabel: 5.5 } })),
    { autoTextSize: false, fontSizes: { base: 8, legend: 6.5, ticks: 6, axisLabel: 7, title: 9, centroidLabel: 5.5 } },
  );
  const moved = changedFigureExportSettings(before, settings({ frame: { lockAspect: true, rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.4 } } }));
  assert.deepEqual(Object.keys(moved), ['frame']);
});

test('the panel records a person\'s change of any setting as one figure-export.set step and provides the action', async () => {
  const source = await readFile(new URL('../assets/js/app/ui/modules/figure-export/figure-export-ui.js', import.meta.url), 'utf8');
  // One observer of the whole panel, not a recorder per control: a control added later is recorded too.
  assert.match(source, /for \(const type of \['input', 'change', 'click', 'pointerup', 'keyup'\]\) listen\(container, type, observeSettings\);/);
  assert.match(source, /recordObserved\('figure-export\.set', figureExportParamsOf\(changed\)\)/);
  assert.match(source, /getActions\(\)\.provide\('figure-export\.set'/);
  // A restore or the action itself puts the baseline the next change is compared with.
  assert.match(source, /observedSettings = settingsNow\(\);\n  }\n/);
});

test('a saved record is read one setting at a time: an earlier version upgraded, a refused value kept as shown, never failing the others', async () => {
  const { readSavedFigureExportSettings } = await import('../assets/js/app/ui/modules/figure-export/utils/session-settings.js');
  const current = settings({ width: 80, svgStrategy: 'hybrid' });
  // Version 1 (before 2026-11-11), as an hour-old session and a dataset's starting view hold it:
  // the SVG strategy unchosen, the size a box in CSS pixels, text in pixels. Every setting is
  // read; the strategy is full vector, said nowhere as a loss (it is how the panel opens now);
  // the box's width is the figure's width in millimetres, its height goes, text is in points.
  const { version: _version, width: _width, sizePreset: _preset, fontSizes: _sizes, ...shared } = settings();
  const older = {
    ...shared, version: 1, svgStrategy: null, sizePreset: '1600x1200', width: 1600, height: 1200,
    fontSizes: { base: 14, legend: 13, ticks: 12, axisLabel: 16, title: 22, centroidLabel: 11 },
    title: 'Figure 2', titleFollowsDataset: false,
  };
  const read = readSavedFigureExportSettings(older, current);
  assert.deepEqual(read.unread, []);
  assert.equal(read.settings.version, 3);
  assert.equal(read.settings.svgStrategy, 'full-vector');
  assert.equal(read.settings.width, 423.3);
  assert.equal(read.settings.sizePreset, 'custom');
  assert.deepEqual(read.settings.fontSizes, { base: 10.5, legend: 10, ticks: 9, axisLabel: 12, title: 16.5, centroidLabel: 8.5 });
  assert.equal(Object.hasOwn(read.settings, 'height'), false);
  assert.equal(read.settings.title, 'Figure 2');
  assert.doesNotThrow(() => assertFigureExportSessionSettings(read.settings));
  // A value no version can use keeps the panel's, is named, and the rest is read.
  const odd = readSavedFigureExportSettings({ ...settings({ width: 160 }), dpi: 299, retired: true }, current);
  assert.equal(odd.settings.width, 160);
  assert.equal(odd.settings.dpi, current.dpi);
  assert.deepEqual(odd.unread.map(({ setting }) => setting), ['dpi', 'retired']);
  assert.match(odd.unread[0].reason, /dpi/);
  // A preset and its width are read together (F271): an undo from a 1.5 column back to a double
  // one is neither half alone (each refuses the other's value).
  const narrower = settings({ sizePreset: 'one-and-half-column', width: 120 });
  const wider = readSavedFigureExportSettings(settings({ sizePreset: 'double-column', width: 183 }), narrower);
  assert.deepEqual(wider.unread, []);
  assert.deepEqual([wider.settings.sizePreset, wider.settings.width], ['double-column', 183]);
  // Settings that go together are read together; a frame waits for the preview it needs.
  const framed = settings({ frame: { lockAspect: false, rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 } }, preview: { enabled: true, colorblindMode: 'none' } });
  const offNow = settings({ frame: null, preview: { enabled: false, colorblindMode: 'none' } });
  const both = readSavedFigureExportSettings(framed, offNow);
  assert.deepEqual(both.unread, []);
  assert.deepEqual(both.settings.frame, framed.frame);
  // Not a record at all: nothing read, said once.
  assert.deepEqual(readSavedFigureExportSettings(null, current), { settings: current, unread: [{ setting: 'figure export settings', reason: 'not a record of settings' }] });
});

