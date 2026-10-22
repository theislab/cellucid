/**
 * The per-view camera model of `rendering/viewer.js`.
 *
 * Every view owns a camera state, navigation mode included. The focused view
 * is drawn from the global camera scalars and, with "Link cameras" on, so is
 * every other view that shows the same representation (layout) -- never a view
 * of another representation, since one camera cannot serve a 3D and a 2D view
 * or two embeddings of different shape. That rule is what fixed "the camera
 * sticks to planar": with one shared camera, a 2D view's planar default made
 * every linked 3D view planar.
 *
 * The viewer needs a WebGL2 context to construct, so these tests run the
 * viewer's own camera-follower functions, cut verbatim from its source, over a
 * small in-memory environment that stands in for the closure they read. The
 * render loop and the presentation path are then checked to read the same
 * follower set.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewerSource = readFileSync(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8'
);

/** The text of one brace-delimited definition starting at `signature`. */
function cut(signature, { from = 0 } = {}) {
  const start = viewerSource.indexOf(signature, from);
  assert.ok(start >= 0, `viewer.js must define ${signature.trim()}`);
  assert.ok(signature.endsWith('{'), 'a signature ends with its body brace');
  let depth = 0;
  // The body brace is the signature's last character; a destructured
  // parameter before it is not the body.
  for (let index = start + signature.length - 1; index < viewerSource.length; index++) {
    const character = viewerSource[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return viewerSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unbalanced definition: ${signature}`);
}

const FUNCTIONS = [
  '  function viewExists(viewId) {',
  '  function computeCameraFollowers() {',
  '  function persistFocusedCamera() {',
  '  function refreshCameraFollowers() {',
  '  function unifyLinkedCameras() {',
  '  function transferViewFocus(nextViewId, { saveOutgoing }) {',
  '  function getViewNavigationMode(viewId) {',
].map(signature => cut(signature)).join('\n');
const METHODS = [
  '    setCamerasLocked(locked) {',
  '    getCameraLinkGroups() {',
].map(signature => cut(signature)).join(',\n')
  // The viewer's own flag, read from the stand-in environment.
  .replace(/\bliveViewHidden\b/g, 'env.liveViewHidden');

function camera(seed, navigationMode = 'orbit') {
  return {
    navigationMode,
    orbit: {
      radius: seed + 2,
      targetRadius: seed + 2,
      theta: seed / 10,
      phi: 1,
      target: [seed, 0, 0],
    },
    freefly: { position: [seed, 0, 3], yaw: 0, pitch: 0 },
  };
}

/**
 * The viewer's camera closure, over `views`: `[viewId, layoutKey, camera]` in
 * presentation order (the live view first). The live view starts focused,
 * with cameras linked, as the viewer does.
 */
function createCameraModel(views) {
  const env = {
    layoutKeys: new Map(views.map(([viewId, layoutKey]) => [viewId, layoutKey])),
    stored: new Map(views.map(([viewId, , state]) => [viewId, structuredClone(state)])),
    global: structuredClone(views[0][2]),
    snapshots: views.slice(1).map(([id]) => ({ id })),
    modeChanges: [],
    published: [],
    liveViewHidden: false,
  };
  const factory = new Function('env', `
    const LIVE_VIEW_ID = 'live';
    let focusedViewId = 'live';
    let camerasLocked = true;
    let cameraFollowers = new Set(['live']);
    let navigationMode = env.global.navigationMode;
    let velocityTheta = 0, velocityPhi = 0, velocityPanX = 0, velocityPanY = 0, velocityPanZ = 0;
    const freeflyVelocity = [0, 0, 0];
    const vec3 = { set(target, x, y, z) { target[0] = x; target[1] = y; target[2] = z; } };
    const viewLayoutKeys = env.layoutKeys;
    const snapshotViews = env.snapshots;
    const snapshotViewsById = new Map(env.snapshots.map(snapshot => [snapshot.id, snapshot]));
    const getCurrentCameraStateInternal = () => structuredClone({ ...env.global, navigationMode });
    const getStoredViewCameraState = viewId => structuredClone(env.stored.get(viewId));
    const setViewCameraState = (viewId, state) => { env.stored.set(viewId, structuredClone(state)); };
    const applyCameraStateTemporarily = state => {
      env.global = structuredClone(state);
      navigationMode = state.navigationMode;
    };
    const assertCameraState = state => state;
    const assertKnownViewId = viewId => {
      if (viewId !== 'live' && !snapshotViewsById.has(viewId)) throw new RangeError('unknown ' + viewId);
      return viewId;
    };
    const assertNavigationMode = mode => mode;
    const getViewCameraState = viewId => cameraFollowers.has(viewId)
      ? getCurrentCameraStateInternal()
      : getStoredViewCameraState(viewId);
    const updateViewTitleActiveState = () => {};
    const navigationModeChangeHandler = (viewId, mode) => env.modeChanges.push([viewId, mode]);
    const publishPresentedViewStateChange = (reason, viewId) => env.published.push([reason, viewId]);
    ${FUNCTIONS}
    const api = { ${METHODS} };
    return {
      api,
      transferViewFocus,
      getViewNavigationMode,
      refreshCameraFollowers,
      persistFocusedCamera,
      get followers() { return [...cameraFollowers].sort(); },
      get focused() { return focusedViewId; },
      get navigationMode() { return navigationMode; },
      setGlobal(state) { env.global = structuredClone(state); navigationMode = state.navigationMode; },
      showLayout(viewId, layoutKey) { env.layoutKeys.set(viewId, layoutKey); },
    };
  `);
  const model = factory.call({}, env);
  model.refreshCameraFollowers();
  return { env, model };
}

test('linked cameras group views by representation, never across representations', () => {
  const { model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1)],
    ['snap_1', 'X_umap_3d', camera(2)],
    ['snap_2', 'X_umap_2d', camera(3, 'planar')],
    ['snap_3', 'X_pca_3d', camera(4)],
  ]);
  // Linked: the focused view and the other view of its embedding follow the
  // live camera; the 2D view and the other 3D embedding keep their own.
  assert.deepEqual(model.followers, ['live', 'snap_1']);
  assert.deepEqual(model.api.getCameraLinkGroups(), [['live', 'snap_1']]);

  // Unlinked: only the focused view follows the live camera.
  model.api.setCamerasLocked(false);
  assert.deepEqual(model.followers, ['live']);
  assert.deepEqual(model.api.getCameraLinkGroups(), []);
  assert.throws(() => model.api.setCamerasLocked('true'), /exact boolean/);
});

test('every view navigates by its own mode: a 2D view never makes a 3D view planar', () => {
  const { env, model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1, 'orbit')],
    ['snap_1', 'X_umap_2d', camera(2, 'planar')],
  ]);
  // Linking is on, but the two views show different representations.
  assert.deepEqual(model.followers, ['live']);
  assert.equal(model.getViewNavigationMode('live'), 'orbit');
  assert.equal(model.getViewNavigationMode('snap_1'), 'planar');

  // Focusing the 2D view loads its camera and its mode; the 3D view keeps
  // orbiting in its own stored camera.
  model.transferViewFocus('snap_1', { saveOutgoing: true });
  assert.equal(model.focused, 'snap_1');
  assert.equal(model.navigationMode, 'planar');
  assert.equal(model.getViewNavigationMode('live'), 'orbit');
  assert.deepEqual(env.modeChanges, [['snap_1', 'planar']]);

  // And back: the 3D view orbits again, from where it was.
  model.transferViewFocus('live', { saveOutgoing: true });
  assert.equal(model.navigationMode, 'orbit');
  assert.deepEqual(env.global.orbit, camera(1).orbit);
  assert.equal(model.getViewNavigationMode('snap_1'), 'planar');
  assert.deepEqual(env.modeChanges, [['snap_1', 'planar'], ['live', 'orbit']]);
});

test('a focus change stores the live camera in every linked view, then loads the incoming one', () => {
  const { env, model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1)],
    ['snap_1', 'X_umap_3d', camera(2)],
    ['snap_2', 'X_pca_3d', camera(3)],
  ]);
  // The user turns the linked pair.
  model.setGlobal(camera(9));
  model.transferViewFocus('snap_2', { saveOutgoing: true });
  assert.deepEqual(env.stored.get('live'), camera(9));
  assert.deepEqual(env.stored.get('snap_1'), camera(9), 'the linked view keeps what it showed');
  assert.deepEqual(env.global, camera(3), 'the incoming view brings its own camera');
  assert.deepEqual(model.followers, ['snap_2']);

  // Focusing either view of the linked pair draws both from the live camera.
  model.transferViewFocus('snap_1', { saveOutgoing: true });
  assert.deepEqual(model.followers, ['live', 'snap_1']);
  assert.deepEqual(env.global, camera(9));
});

test('removing the focused view keeps its linked views on the live camera, and drops its own', () => {
  const { env, model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1)],
    ['snap_1', 'X_umap_3d', camera(2)],
  ]);
  model.transferViewFocus('snap_1', { saveOutgoing: true });
  model.setGlobal(camera(7));
  assert.deepEqual(env.stored.get('live'), camera(1), 'not stored until focus moves');
  // `saveOutgoing: false` is the removal of the focused pane.
  env.stored.set('snap_1', camera(0));
  model.transferViewFocus('live', { saveOutgoing: false });
  assert.deepEqual(env.stored.get('live'), camera(7));
  assert.deepEqual(env.global, camera(7), 'the linked live view keeps the shared camera');
  assert.deepEqual(env.stored.get('snap_1'), camera(0), 'the removed pane is not saved');
});

test('linking gives each group of one representation one camera; unlinking keeps every view as it is', () => {
  const { env, model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1)],
    ['snap_1', 'X_pca_2d', camera(2, 'planar')],
    ['snap_2', 'X_pca_2d', camera(3, 'free')],
    ['snap_3', 'X_umap_3d', camera(4)],
  ]);
  model.api.setCamerasLocked(false);
  model.setGlobal(camera(8));
  // Unlinking stored the live camera in the views that followed it.
  assert.deepEqual(model.followers, ['live']);

  model.api.setCamerasLocked(true);
  // The focused group follows the live camera; the other group takes the
  // camera of its first view, mode included.
  assert.deepEqual(model.followers, ['live', 'snap_3']);
  assert.deepEqual(env.stored.get('snap_2'), camera(2, 'planar'));
  assert.deepEqual(env.published.map(([reason]) => reason), ['camera-lock', 'camera-lock']);
  // Linking twice publishes nothing.
  model.api.setCamerasLocked(true);
  assert.equal(env.published.length, 2);

  // Unlinking leaves each view with exactly what it showed.
  model.setGlobal(camera(5));
  model.api.setCamerasLocked(false);
  assert.deepEqual(env.stored.get('snap_3'), camera(5));
  assert.deepEqual(env.stored.get('live'), camera(5));
});

test('a hidden live view is in no link group', () => {
  const { env, model } = createCameraModel([
    ['live', 'X_umap_3d', camera(1)],
    ['snap_1', 'X_umap_3d', camera(2)],
  ]);
  assert.deepEqual(model.api.getCameraLinkGroups(), [['live', 'snap_1']]);
  env.liveViewHidden = true;
  assert.deepEqual(model.api.getCameraLinkGroups(), []);
});

test('the render loop, interaction and presentation read the one follower set', () => {
  // No camera decision anywhere reads the link toggle directly: it is folded
  // into `cameraFollowers` once, on change.
  const reads = [...viewerSource.matchAll(/\bcamerasLocked\b/g)].length;
  const definitionAndOwners = [
    cut('  function computeCameraFollowers() {'),
    cut('  function unifyLinkedCameras() {'),
    cut('    setCamerasLocked(locked) {'),
    cut('    getCameraLinkGroups() {'),
  ].join('\n');
  const owned = [...definitionAndOwners.matchAll(/\bcamerasLocked\b/g)].length;
  const declaration = 1;
  const getter = [...viewerSource.matchAll(/getCamerasLocked\(\) \{ return camerasLocked; \}/g)].length;
  const presentationKey = [...viewerSource.matchAll(/layoutKey = JSON\.stringify\(\{\s*camerasLocked,/g)].length;
  const viewEmbeddingJoin = [...viewerSource.matchAll(/if \(camerasLocked && layoutChanged && vid !== focusedViewId\)/g)].length;
  assert.equal(
    reads,
    owned + declaration + getter + presentationKey + viewEmbeddingJoin,
    'every other read of camerasLocked would be a second camera rule'
  );

  for (const [label, pattern] of [
    ['render loop', /const followsCamera = cameraFollowers\.has\(view\.id\);/],
    ['per-pane camera distance', /const followsCamera = cameraFollowers\.has\(vid\);/],
    ['interaction viewport', /if \(!cameraFollowers\.has\(clickedViewId\) && viewCount > 1\)/],
    ['presented view state', /const followsFocusedCamera = cameraFollowers\.has\(owner\.viewId\);/],
  ]) {
    assert.match(viewerSource, pattern, label);
  }
  assert.doesNotMatch(
    viewerSource,
    /settleSharedNavigationOwnership|Locked mode: non-active views use active view's matrix/,
    'there is no shared camera or shared mode'
  );
});
