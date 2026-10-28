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
const representationControlsSource = await readFile(
  new URL('../assets/js/app/ui/modules/representation-controls.js', import.meta.url),
  'utf8'
);
const cinematicCameraSource = await readFile(
  new URL('../assets/js/app/ui/modules/cinematic-camera/index.js', import.meta.url),
  'utf8'
);
const navigationSettingsSource = await readFile(
  new URL('../assets/js/app/ui/modules/navigation-settings.js', import.meta.url),
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

test('navigation has one home: the Navigation panel', () => {
  /* Compare Views and Camera Path each used to carry a copy of the mode select
     and its settings. Navigation is now its own panel, and Camera Path keeps
     the panel in step through camera-controls.js instead of a mirror. */
  const section = indexHtml.slice(
    indexHtml.indexOf('id="navigation-section"'),
    indexHtml.indexOf('</details>', indexHtml.indexOf('id="navigation-section"'))
  );
  for (const id of ['navigation-mode', 'orbit-controls', 'planar-controls', 'freefly-controls', 'reset-camera-btn']) {
    assert.ok(section.includes(`id="${id}"`), `#${id} belongs to the Navigation panel`);
  }
  assert.doesNotMatch(indexHtml, /id="cinematic-(?:nav-mode|navigation-controls|orbit-controls|planar-controls|freefly-controls|pointer-lock)"/);
  const compareViews = indexHtml.slice(
    indexHtml.indexOf('id="compare-views-section"'),
    indexHtml.indexOf('</details>', indexHtml.indexOf('id="compare-views-section"'))
  );
  assert.doesNotMatch(compareViews, /id="navigation-mode"/);

  const cacheStart = domCacheSource.indexOf('    cinematicCamera: {');
  const cacheBlock = domCacheSource.slice(cacheStart, domCacheSource.indexOf('\n    },', cacheStart));
  assert.doesNotMatch(cacheBlock, /byId\('cinematic-(?:nav|orbit|planar|look|move|invert|pointer|show)/);

  assert.doesNotMatch(cinematicCameraSource, /wireNavigationSettings/);
  assert.match(cinematicCameraSource, /navigation\.syncNavigationMode\(mode\)/);
  assert.match(cinematicCameraSource, /\.\.\.navigation\.exportSettings\(\)/);
  assert.match(cinematicCameraSource, /navigation\.restoreSettings\(data\)/);
  assert.match(uiCoordinatorSource, /initCinematicCamera\(\{[\s\S]*?navigation: cameraControls,/);
  assert.match(cameraControlsSource, /wireNavigationSettings\(\{/);
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

test('a navigation choice is recorded per view and per dimension', () => {
  // Every view navigates by its own dimension; a choice that differs from the
  // default belongs to one view at the dimension it was made for, so a view
  // set to free-fly in 3D flies again whenever it shows a 3D representation
  // and pans whenever it shows a 2D one.
  const owner = createNavigationModeOwnership();
  assert.equal(owner.choiceFor('live', 3), null);
  owner.record('live', 3, 'free');
  assert.equal(owner.choiceFor('live', 3), 'free');
  assert.equal(owner.choiceFor('live', 2), null, 'a 3D choice says nothing about 2D');
  assert.equal(owner.choiceFor('snap_1', 3), null, 'a choice belongs to one view');
  owner.record('live', 2, 'orbit');
  assert.equal(owner.choiceFor('live', 2), 'orbit');
  assert.equal(owner.choiceFor('live', 3), 'free', 'dimensions are independent');

  assert.throws(() => owner.record('live', 3, 'teleport'), /navigation mode/i);
  assert.throws(() => owner.record('', 3, 'orbit'), /view id/i);
  for (const dimension of [0, 4, 2.5, '3', null]) {
    assert.throws(() => owner.record('live', dimension, 'orbit'), /dimension/i);
    assert.throws(() => owner.choiceFor('live', dimension), /dimension/i);
    assert.throws(() => owner.release('live', dimension), /dimension/i);
  }
});

test('releasing a choice hands that view and dimension back to the dimension rule', () => {
  const owner = createNavigationModeOwnership();
  owner.record('live', 3, 'free');
  owner.record('live', 2, 'orbit');
  owner.record('snap_1', 3, 'planar');
  owner.release('live', 3);
  assert.equal(owner.choiceFor('live', 3), null);
  assert.equal(owner.choiceFor('live', 2), 'orbit', 'releasing one dimension keeps the other');
  assert.equal(owner.choiceFor('snap_1', 3), 'planar', 'releasing one view keeps its neighbours');
  // Releasing what was never chosen is a no-op, not an error.
  owner.release('snap_2', 1);
  assert.equal(owner.choiceFor('snap_2', 1), null);
  assert.throws(() => owner.release('', 3), /view id/i);
});

test('a kept view inherits the choices of its source view, and a removed view loses its own', () => {
  const owner = createNavigationModeOwnership();
  owner.record('live', 3, 'free');
  owner.record('live', 2, 'orbit');
  owner.copyView('live', 'snap_1');
  assert.equal(owner.choiceFor('snap_1', 3), 'free');
  assert.equal(owner.choiceFor('snap_1', 2), 'orbit');
  // The copy is the kept view's own: changing it leaves the source alone.
  owner.record('snap_1', 3, 'planar');
  assert.equal(owner.choiceFor('live', 3), 'free');
  // A source without choices leaves its copy without any, even over a stale
  // record for the same id.
  owner.copyView('snap_9', 'snap_1');
  assert.equal(owner.choiceFor('snap_1', 3), null);
  assert.equal(owner.choiceFor('snap_1', 2), null);

  owner.deleteView('live');
  assert.equal(owner.choiceFor('live', 3), null);
  owner.record('snap_2', 1, 'orbit');
  owner.clear();
  assert.equal(owner.choiceFor('snap_2', 1), null);
  assert.throws(() => owner.copyView('', 'snap_1'), /view id/i);
  assert.throws(() => owner.copyView('live', ''), /view id/i);
  assert.throws(() => owner.deleteView(''), /view id/i);
});

test('every applied navigation mode is weighed against the dimension default', () => {
  // The viewer cannot see whether a caller is a person or a restore, so it
  // decides ownership from the mode itself: only a mode that differs from the
  // view's dimension default is recorded as that view's choice for that
  // dimension. Without this, a dataset's advertised starting state -- which
  // pins the very mode the dimension already implies -- would be remembered
  // as a choice for the whole session.
  const start = viewerSource.indexOf('  function settleViewNavigationOwnership(viewId, mode)');
  assert.ok(start >= 0, 'viewer must define settleViewNavigationOwnership');
  const body = viewerSource.slice(start, viewerSource.indexOf('\n  }\n', start));
  assert.match(body, /getPublishedDimensionLevel\(/);
  assert.match(body, /mode === getDefaultNavigationMode\(dimensionLevel\)/);
  assert.match(body, /navigationModeOwnership\.release\(exactViewId, dimensionLevel\)/);
  assert.match(body, /navigationModeOwnership\.record\(exactViewId, dimensionLevel, mode\)/);
  assert.doesNotMatch(
    viewerSource,
    /function settleSharedNavigationOwnership|recordSharedUserChoice|promoteViewUserChoice/,
    'there is no shared navigation choice: each view owns its mode'
  );

  // Every publication boundary goes through that helper; none may record
  // ownership on its own.
  for (const [label, signature] of [
    ['setNavigationMode', '    setNavigationMode(mode) {'],
    ['setViewNavigationMode', '    setViewNavigationMode(viewId, mode) {'],
    ['setViewCameraState', '    setViewCameraState(viewId, camState) {'],
    ['createSnapshotView', '    createSnapshotView(config) {']
  ]) {
    const start = viewerSource.indexOf(signature);
    assert.ok(start >= 0, `viewer must define ${label}`);
    const body = viewerSource.slice(start, viewerSource.indexOf('\n    },', start));
    assert.match(
      body,
      /settleViewNavigationOwnership\(/,
      `${label} must weigh its mode against the dimension default`
    );
    assert.doesNotMatch(
      body,
      /navigationModeOwnership\.record\(/,
      `${label} must not claim ownership unconditionally`
    );
  }

  // The focused view's mode is shared only with the views linked to its
  // camera, and each of them records it for itself.
  const navStart = viewerSource.indexOf('    setNavigationMode(mode) {');
  const navBody = viewerSource.slice(navStart, viewerSource.indexOf('\n    },', navStart));
  assert.match(
    navBody,
    /for \(const viewId of cameraFollowers\) \{[\s\S]*?settleViewNavigationOwnership\(viewId, exactMode\)/
  );
  // A kept view starts from its source's choices in every dimension.
  const snapStart = viewerSource.indexOf('    createSnapshotView(config) {');
  const snapBody = viewerSource.slice(snapStart, viewerSource.indexOf('\n    },', snapStart));
  assert.match(snapBody, /navigationModeOwnership\.copyView\(sourceViewId, id\)/);
});

test('a view showing another dimension navigates by its recorded choice or that dimension\'s default', () => {
  const start = viewerSource.indexOf('  function applyDimensionNavigationDefault(viewId, dimensionLevel)');
  assert.ok(start >= 0);
  const body = viewerSource.slice(start, viewerSource.indexOf('\n  }\n', start));
  assert.match(
    body,
    /navigationModeOwnership\.choiceFor\(exactViewId, dimensionLevel\)\s*\?\?\s*getDefaultNavigationMode\(dimensionLevel\)/
  );
  assert.match(body, /applyViewNavigationMode\(exactViewId, mode\)/);
  assert.doesNotMatch(
    body,
    /camerasLocked/,
    'linking cameras never decides one view\'s mode for another view of another dimension'
  );
});

test('viewer applies dimension-derived defaults only at data and dimension-changing embedding boundaries', () => {
  // The live points are published by one function (`setData`, and cells
  // added or removed in place, `resizeLiveCells`, which keep the camera).
  const setDataStart = viewerSource.indexOf('\n  function publishLiveData(');
  const setDataEnd = viewerSource.indexOf('\n  }\n', setDataStart);
  const setViewEmbeddingStart = viewerSource.indexOf('setViewEmbedding(viewId, embedding)');
  const setViewEmbeddingEnd = viewerSource.indexOf('\n    /**', setViewEmbeddingStart + 1);
  const setNavigationStart = viewerSource.indexOf('setNavigationMode(mode)');
  const setNavigationEnd = viewerSource.indexOf('\n    getNavigationMode()', setNavigationStart);

  assert.ok(setDataStart >= 0 && setDataEnd > setDataStart);
  assert.ok(setViewEmbeddingStart >= 0 && setViewEmbeddingEnd > setViewEmbeddingStart);
  assert.ok(setNavigationStart >= 0 && setNavigationEnd > setNavigationStart);

  assert.match(
    viewerSource.slice(setDataStart, setDataEnd),
    /if \(!keepView\) \{\s*resetViewCameraForDimension\(LIVE_VIEW_ID, dimensionLevel\);\s*applyDimensionNavigationDefault\(LIVE_VIEW_ID,\s*dimensionLevel\);\s*\}/
  );
  assert.match(viewerSource, /setData\(payload\) \{\s*publishLiveData\(payload, \{ keepView: false \}\);/);
  assert.match(viewerSource, /resizeLiveCells\(payload\) \{[\s\S]*?publishLiveData\(payload, \{ keepView: true \}\);/);
  // Every layout is normalized to the same extent, so switching between two
  // representations of one dimension keeps the camera and its navigation
  // mode; a dimension change applies the view's choice for, or the default
  // of, the new dimension.
  assert.match(
    viewerSource.slice(setViewEmbeddingStart, setViewEmbeddingEnd),
    /if \(oldLevel !== level\) \{\s*applyDimensionNavigationDefault\(vid,\s*level\);\s*\}/
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

test('the navigation selector forwards exact values to the viewer', () => {
  assert.doesNotMatch(
    cameraControlsSource,
    /selectValue === 'free'\s*\?\s*'free'[\s\S]*?'orbit'/
  );
  assert.match(
    cameraControlsSource,
    /viewer\.setNavigationMode\(navigationModeSelect\.value\)/
  );

  for (const [label, source] of [
    ['Navigation controls', cameraControlsSource],
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

test('representation, view-row, and session boundaries preserve exact camera ownership', () => {
  // The picker forwards the exact layout key it lists; the keyboard forwards
  // the exact dimension its key names. Neither parses or coerces.
  assert.doesNotMatch(representationControlsSource, /parseInt\(|Number\(select\.value\)/);
  assert.match(
    representationControlsSource,
    /state\.setViewRepresentation\(viewId, layoutKey, \{ followsDefault: false \}\)/
  );
  assert.match(
    representationControlsSource,
    /state\.cycleRepresentation\(state\.getActiveViewId\(\), dimension\)/
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

test('dataset-derived navigation changes synchronize the Navigation panel once', () => {
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
  assert.doesNotMatch(
    uiCoordinatorSource,
    /cinematicCamera\.syncNavigationMode/,
    'Camera Path has no navigation controls of its own to synchronize'
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
  assert.match(syncBody, /cameraControls\.syncNavigationMode\(viewer\.getViewNavigationMode\(viewId\)\)/);
  assert.doesNotMatch(
    uiCoordinatorSource,
    /syncNavigationUiForView\(state\.getActiveViewId\(\)\s*\|\|/
  );
});
