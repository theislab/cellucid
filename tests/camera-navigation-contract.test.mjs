import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const {
  assertNavigationMode,
  createNavigationModeOwnership,
  getDefaultNavigationMode
} = await import('../assets/js/rendering/viewer.js');

const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8'
);
const cameraControlsSource = await readFile(
  new URL('../assets/js/app/ui/modules/camera-controls.js', import.meta.url),
  'utf8'
);
const dimensionControlsSource = await readFile(
  new URL('../assets/js/app/ui/modules/dimension-controls.js', import.meta.url),
  'utf8'
);
const cinematicCameraSource = await readFile(
  new URL('../assets/js/app/ui/modules/cinematic-camera/index.js', import.meta.url),
  'utf8'
);
const viewControlsSource = await readFile(
  new URL('../assets/js/app/ui/modules/view-controls.js', import.meta.url),
  'utf8'
);
const uiCoordinatorSource = await readFile(
  new URL('../assets/js/app/ui/core/ui-coordinator.js', import.meta.url),
  'utf8'
);
const coreStateSource = await readFile(
  new URL('../assets/js/app/session/contributors/core-state.js', import.meta.url),
  'utf8'
);
const domCacheSource = await readFile(
  new URL('../assets/js/app/ui/core/dom-cache.js', import.meta.url),
  'utf8'
);
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('every Camera Path navigation control is cached, required, and read', () => {
  /* The Camera Path navigation block mirrors the Compare Views block; both
     drive the same viewer. It has been mistaken for dead markup, so pin the
     whole chain: markup id -> dom-cache entry -> REQUIRED_DOM_KEYS -> a read
     in the module body. */
  const blockStart = indexHtml.indexOf('id="cinematic-navigation-controls"');
  assert.ok(blockStart > 0, 'the Camera Path navigation block must exist');
  const blockEnd = indexHtml.indexOf('id="cinematic-save-btn"', blockStart);
  assert.ok(blockEnd > blockStart);
  /* The block container and its info popover are owned by the shared
     info-popovers component, not by the Camera Path DOM cache. */
  const NOT_DOM_CACHED = new Set([
    'cinematic-navigation-controls',
    'cinematic-navigation-info-btn',
    'cinematic-navigation-info-tooltip',
  ]);
  const markupIds = [
    ...new Set(
      Array.from(
        indexHtml.slice(blockStart, blockEnd).matchAll(/\bid="(cinematic-[a-z-]+)"/g),
        match => match[1],
      ),
    ),
  ].filter(id => !NOT_DOM_CACHED.has(id));
  assert.ok(
    markupIds.length >= 18,
    `expected the full navigation block, found ${markupIds.length} ids`,
  );

  const cacheStart = domCacheSource.indexOf('    cinematicCamera: {');
  const cacheEnd = domCacheSource.indexOf('\n    },', cacheStart);
  assert.ok(cacheStart >= 0 && cacheEnd > cacheStart);
  const cacheBlock = domCacheSource.slice(cacheStart, cacheEnd);

  const requiredStart = cinematicCameraSource.indexOf('const REQUIRED_DOM_KEYS = [');
  const requiredEnd = cinematicCameraSource.indexOf('];', requiredStart);
  assert.ok(requiredStart >= 0 && requiredEnd > requiredStart);
  const requiredKeys = cinematicCameraSource.slice(requiredStart, requiredEnd);

  const orphans = [];
  for (const id of markupIds) {
    const cached = cacheBlock.match(
      new RegExp(`(\\w+):\\s*byId\\('${id}'\\)`),
    );
    if (cached === null) {
      orphans.push(`${id} is not collected by dom-cache`);
      continue;
    }
    const key = cached[1];
    if (!new RegExp(`'${key}'`).test(requiredKeys)) {
      orphans.push(`${key} is not in REQUIRED_DOM_KEYS`);
    }
    if (!new RegExp(`\\bdom\\.${key}\\b`).test(cinematicCameraSource)) {
      orphans.push(`dom.${key} is never read by the Camera Path module`);
    }
  }
  assert.deepEqual(orphans, [], orphans.join('\n'));
});

test('fresh 1D/2D views use planar navigation and fresh 3D views use orbit', () => {
  assert.equal(getDefaultNavigationMode(1), 'planar');
  assert.equal(getDefaultNavigationMode(2), 'planar');
  assert.equal(getDefaultNavigationMode(3), 'orbit');
});

test('unsupported dimensions and navigation modes reject without normalization', () => {
  for (const invalidDimension of [undefined, null, 0, 4, '2', Number.NaN, 2.5]) {
    assert.throws(
      () => getDefaultNavigationMode(invalidDimension),
      /dimension/i
    );
  }

  for (const validMode of ['orbit', 'planar', 'free']) {
    assert.equal(assertNavigationMode(validMode), validMode);
  }
  for (const invalidMode of [undefined, null, '', 'Orbit', 'teleport', 3]) {
    assert.throws(
      () => assertNavigationMode(invalidMode),
      /navigation mode/i
    );
  }
});

test('camera range inputs reject coercive or partial numeric strings', async () => {
  const { parseRangeInput } = await import(
    '../assets/js/app/ui/core/numeric-input-contract.js'
  );

  assert.equal(
    parseRangeInput('5', { minimum: 1, maximum: 30, label: 'Look sensitivity' }),
    5
  );
  assert.equal(
    parseRangeInput('0.25', { minimum: 0.1, maximum: 1, label: 'Speed' }),
    0.25
  );

  for (const invalid of [
    '',
    ' ',
    '5px',
    '5 trailing',
    ' 5',
    '5 ',
    '0x10',
    'Infinity',
    Number.NaN,
    5,
    null,
    undefined
  ]) {
    assert.throws(
      () => parseRangeInput(
        invalid,
        { minimum: 1, maximum: 30, label: 'Look sensitivity' }
      ),
      /look sensitivity/i,
      `must reject ${String(invalid)}`
    );
  }

  assert.throws(
    () => parseRangeInput(
      '0',
      { minimum: 1, maximum: 30, label: 'Look sensitivity' }
    ),
    /from 1 through 30/i
  );
  assert.throws(
    () => parseRangeInput(
      '31',
      { minimum: 1, maximum: 30, label: 'Look sensitivity' }
    ),
    /from 1 through 30/i
  );
  assert.throws(
    () => parseRangeInput(
      '5',
      {
        minimum: 1,
        maximum: 30,
        label: 'Look sensitivity',
        legacyDefault: 5
      }
    ),
    /exactly/i
  );
});

test('dimension defaults stop applying after an explicit shared or per-view choice', () => {
  const perView = createNavigationModeOwnership();
  assert.equal(perView.hasExplicitUserChoice('live'), false);
  perView.recordViewUserChoice('live', 'free');
  assert.equal(perView.hasExplicitUserChoice('live'), true);
  assert.equal(perView.hasExplicitUserChoice('snap_1'), false);
  assert.equal(perView.promoteViewUserChoice('snap_1', 'orbit'), false);
  assert.equal(perView.promoteViewUserChoice('live', 'free'), true);
  assert.equal(perView.hasExplicitUserChoice('snap_1'), true);

  const shared = createNavigationModeOwnership();
  shared.recordSharedUserChoice('planar');
  assert.equal(shared.hasExplicitUserChoice('live'), true);
  assert.equal(shared.hasExplicitUserChoice('snap_1'), true);

  assert.throws(
    () => perView.recordViewUserChoice('live', 'teleport'),
    /navigation mode/i
  );
  assert.throws(
    () => perView.recordViewUserChoice('', 'orbit'),
    /view id/i
  );
});

test('viewer applies dimension-derived defaults only at data/dimension publication boundaries', () => {
  const setDataStart = viewerSource.indexOf('setData(payload)');
  const setDataEnd = viewerSource.indexOf('\n    updateColors(', setDataStart);
  const setViewDimensionStart = viewerSource.indexOf('setViewDimension(viewId, level)');
  const setViewDimensionEnd = viewerSource.indexOf('\n    /**', setViewDimensionStart + 1);
  const setNavigationStart = viewerSource.indexOf('setNavigationMode(mode)');
  const setNavigationEnd = viewerSource.indexOf('\n    getNavigationMode()', setNavigationStart);

  assert.ok(setDataStart >= 0 && setDataEnd > setDataStart);
  assert.ok(setViewDimensionStart >= 0 && setViewDimensionEnd > setViewDimensionStart);
  assert.ok(setNavigationStart >= 0 && setNavigationEnd > setNavigationStart);

  assert.match(
    viewerSource.slice(setDataStart, setDataEnd),
    /applyDimensionNavigationDefault\(LIVE_VIEW_ID,\s*dimensionLevel\)/
  );
  assert.match(
    viewerSource.slice(setViewDimensionStart, setViewDimensionEnd),
    /applyDimensionNavigationDefault\(vid,\s*level\)/
  );
  assert.doesNotMatch(
    viewerSource.slice(setNavigationStart, setNavigationEnd),
    /mode === 'free'\s*\?\s*'free'[\s\S]*?'orbit'/,
    'invalid public navigation values must not collapse to orbit'
  );
  assert.doesNotMatch(
    viewerSource,
    /dimensionLevel\s*=\s*3/,
    'setData must require an exact published dimension'
  );
});

test('both sidebar navigation selectors forward exact values to the viewer', () => {
  assert.doesNotMatch(
    cameraControlsSource,
    /selectValue === 'free'\s*\?\s*'free'[\s\S]*?'orbit'/
  );
  assert.match(
    cameraControlsSource,
    /viewer\.setNavigationMode\(navigationModeSelect\.value\)/
  );

  assert.doesNotMatch(
    cinematicCameraSource,
    /navModeSelect\.value === 'free'\s*\?\s*'free'[\s\S]*?'orbit'/
  );
  assert.match(
    cinematicCameraSource,
    /viewer\.setNavigationMode\(dom\.navModeSelect\.value\)/
  );

  for (const [label, source] of [
    ['Compare Views camera controls', cameraControlsSource],
    ['Camera Path controls', cinematicCameraSource]
  ]) {
    assert.doesNotMatch(source, /parseFloat\s*\(/, `${label} must parse exact range strings`);
    assert.doesNotMatch(
      source,
      /parseInt\s*\(/,
      `${label} must not accept partial integer strings`
    );
  }
});

test('dimension, view-badge, and session boundaries preserve exact camera ownership', () => {
  assert.doesNotMatch(dimensionControlsSource, /parseInt\(e\.target\.value/);
  assert.match(
    dimensionControlsSource,
    /\['1',\s*'2',\s*'3'\]\.includes\(rawDimension\)/
  );
  assert.match(
    viewControlsSource,
    /isFocusedView[\s\S]*?viewer\.setNavigationMode\(nextMode\)[\s\S]*?viewer\.setViewNavigationMode\(targetViewId,\s*nextMode\)/
  );
  assert.match(
    coreStateSource,
    /viewer\.setNavigationMode\(sessionCamera\.navigationMode\)/
  );
});

test('dataset-derived navigation changes synchronize both sidebar selectors once', () => {
  assert.match(
    viewerSource,
    /setNavigationModeChangeHandler\(fn\)/
  );
  assert.match(
    viewerSource,
    /applyDimensionNavigationDefault\(LIVE_VIEW_ID,\s*dimensionLevel\)/
  );
  assert.match(
    uiCoordinatorSource,
    /setNavigationModeChangeHandler\([\s\S]*?syncNavigationUiForView/
  );
  assert.match(
    uiCoordinatorSource,
    /cinematicCamera\.syncNavigationMode\(mode\)/
  );
});

test('navigation UI synchronization preserves exact view identity and required controls', () => {
  const start = uiCoordinatorSource.indexOf('  function syncNavigationUiForView(viewId)');
  const end = uiCoordinatorSource.indexOf(
    '\n  viewer.setNavigationModeChangeHandler',
    start
  );
  assert.ok(start >= 0 && end > start);
  const syncBody = uiCoordinatorSource.slice(start, end);

  assert.doesNotMatch(syncBody, /String\s*\(/);
  assert.doesNotMatch(syncBody, /\|\|\s*LIVE_VIEW_ID/);
  assert.doesNotMatch(syncBody, /cameraControls\.toggleNavigationPanels\?\./);
  assert.match(syncBody, /viewer\.getViewNavigationMode\(viewId\)/);
  assert.match(syncBody, /cameraControls\.toggleNavigationPanels\(mode\)/);
  assert.doesNotMatch(
    uiCoordinatorSource,
    /syncNavigationUiForView\(state\.getActiveViewId\(\)\s*\|\|/
  );
});
