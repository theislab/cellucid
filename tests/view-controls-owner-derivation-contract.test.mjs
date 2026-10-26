/**
 * View controls must read their owners, never mirror them (CEL-0239).
 *
 * `view-controls.js` used to keep private `activeViewId` and `liveViewHidden`
 * copies of state the DataState and the viewer own. Both owners reconcile
 * themselves when the snapshot inventory empties — `view-context-core.js`
 * returns the active view to `live` (`removeView`, `syncSnapshotContexts`), and
 * `viewer.js` returns focus to the live view and un-hides it
 * (`clearSnapshotViews`) — and neither tells the UI module. A session restore
 * empties the inventory as its first act (`state-serializer/multiview.js`), so
 * the very next badge render read a view that no longer existed and threw.
 *
 * The throw arrived on an animation frame the same rebuild scheduled, which is
 * why it was only ever seen as an uncaught `RangeError` in a browser log. These
 * tests do not wait for a frame: they call the exact function that frame calls
 * (`renderSplitViewBadges`, scheduled at `ui-coordinator.js`
 * `scheduleVisibilityUiUpdate`) at the exact point the inventory moved, and the
 * end-to-end case drives the frame explicitly through the real
 * `restoreMultiview`. Nothing here depends on timing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { viewContextCoreMethods } from
  '../assets/js/app/state/managers/view-context-core.js';
import { initViewControls } from
  '../assets/js/app/ui/modules/view-controls.js';
import { clearPublishedSnapshotViews } from
  '../assets/js/app/view-snapshot-publication.js';
import { restoreMultiview } from
  '../assets/js/app/state-serializer/multiview.js';

/* ------------------------------------------------------------------ *
 * A DOM small enough to read and complete enough to drive the module. *
 * ------------------------------------------------------------------ */

class FakeHTMLElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }

  // `renderSplitViewBadges()` empties the badge list with `innerHTML = ''`, so
  // a fake that kept the previous children would leave the test clicking a
  // badge from an earlier render.
  get innerHTML() {
    return this.children.length === 0 ? '' : '<!-- children -->';
  }

  set innerHTML(value) {
    if (value !== '') {
      throw new Error('The view-control DOM only ever clears innerHTML.');
    }
    this.children.length = 0;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get classList() {
    const owner = this;
    return {
      add(...names) {
        owner.className = [...new Set(
          [...owner.className.split(' '), ...names].filter(Boolean),
        )].join(' ');
      },
      remove(...names) {
        owner.className = owner.className.split(' ')
          .filter(name => name && !names.includes(name))
          .join(' ');
      },
    };
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener(type, listener) {
    const registered = this.listeners.get(type) ?? [];
    const index = registered.indexOf(listener);
    if (index >= 0) registered.splice(index, 1);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  fire(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: this,
        ...event,
      });
    }
  }
}

class FakeHTMLButtonElement extends FakeHTMLElement {}
class FakeHTMLSelectElement extends FakeHTMLElement {}

function installDom(t) {
  const previous = {
    HTMLElement: globalThis.HTMLElement,
    HTMLButtonElement: globalThis.HTMLButtonElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLButtonElement = FakeHTMLButtonElement;
  globalThis.HTMLSelectElement = FakeHTMLSelectElement;

  const ownerDocument = {
    createElement(tagName) {
      return new FakeHTMLElement(ownerDocument, tagName.toUpperCase());
    },
  };
  const element = () => new FakeHTMLElement(ownerDocument, 'DIV');
  const button = () => new FakeHTMLButtonElement(ownerDocument, 'BUTTON');
  const select = value => Object.assign(
    new FakeHTMLSelectElement(ownerDocument, 'SELECT'),
    { value },
  );

  const dom = {
    controls: element(),
    keepViewBtn: button(),
    clearBtn: button(),
    cameraLockBtn: button(),
    layoutModeSelect: select('grid'),
    badgesBox: element(),
    badgesList: element(),
    layoutRow: element(),
    navigationTarget: element(),
    navigationTargetBadge: element(),
  };
  const renderDom = { renderModeSelect: select('points') };
  return { dom, renderDom };
}

/* -------------------------------------------------------- *
 * Owners that reconcile themselves exactly as production does. *
 * -------------------------------------------------------- */

function cameraState(radius = 3) {
  return {
    navigationMode: 'orbit',
    orbit: {
      radius,
      targetRadius: radius,
      theta: 0.25,
      phi: 1,
      target: [0, 0, 0],
    },
    freefly: { position: [0, 0, radius], yaw: 0, pitch: 0 },
  };
}

// Layouts are embedding ids; a view's dimension is its layout's.
const LAYOUT_DIMENSIONS = Object.freeze({ X_umap: 2, X_tsne: 2, X_umap_3d: 3 });
const LAYOUT_NAMES = Object.freeze({ X_umap: 'UMAP', X_tsne: 't-SNE', X_umap_3d: 'UMAP' });

function createOwners() {
  const dimensionManager = {
    dimensions: new Map([['live', 2]]),
    layouts: new Map([['live', 'X_umap']]),
    copyViewLayout(sourceViewId, targetViewId) {
      if (!this.dimensions.has(sourceViewId)) {
        throw new RangeError(`Unknown dimension source "${sourceViewId}".`);
      }
      this.dimensions.set(targetViewId, this.dimensions.get(sourceViewId));
      this.layouts.set(targetViewId, this.layouts.get(sourceViewId));
    },
    getViewDimension(viewId) {
      if (!this.dimensions.has(viewId)) {
        throw new RangeError(`Unknown view dimension "${viewId}".`);
      }
      return this.dimensions.get(viewId);
    },
    getViewLayout(viewId) {
      this.getViewDimension(viewId);
      return this.layouts.get(viewId);
    },
    removeView(viewId) {
      this.dimensions.delete(viewId);
      this.layouts.delete(viewId);
    },
  };

  const visibilityListeners = [];
  const state = Object.assign(
    Object.create(viewContextCoreMethods),
    {
      activeViewId: 'live',
      dimensionManager,
      pointCount: 2,
      viewContexts: new Map([[
        'live',
        {
          id: 'live',
          obsData: null,
          varData: null,
          activeFieldIndex: -1,
          activeVarFieldIndex: -1,
          activeFieldSource: null,
          followsDefault: true,
          colorsArray: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]),
          categoryTransparency: Uint8Array.from([1, 1]),
          cellVisibilityMask: Uint8Array.from([1, 1]),
          centroidPositions: new Float32Array(),
          centroidColors: new Uint8Array(),
          centroidLabels: [],
          filteredCount: { shown: 2, total: 2 },
        },
      ]]),
      clearActiveField() {},
      getAvailableDimensions() {
        return [2, 3];
      },
      getDimensionManager() {
        return this.dimensionManager;
      },
      getFields() {
        return [];
      },
      getVarFields() {
        return [];
      },
      getSnapshotPayload() {
        return {
          centroidColors: null,
          centroidPositions: null,
          colors: Uint8Array.from([21, 22, 23, 255, 31, 32, 33, 255]),
          dimensionLevel: this.dimensionManager.getViewDimension('live'),
          fieldKey: null,
          fieldKind: null,
          filtersText: [],
          label: 'All cells',
          outlierThreshold: 0,
          pointCount: 2,
          transparency: Uint8Array.from([0, 1]),
        };
      },
      getViewDimensionLevel(viewId) {
        return this.dimensionManager.getViewDimension(viewId);
      },
      describeViewEmbedding(viewId) {
        const layoutKey = this.dimensionManager.getViewLayout(viewId);
        return {
          dimension: LAYOUT_DIMENSIONS[layoutKey],
          name: LAYOUT_NAMES[layoutKey],
          label: layoutKey,
          layoutKey,
          isDefault: layoutKey !== 'X_tsne',
        };
      },
      getViewLayoutKey(viewId) {
        return this.dimensionManager.getViewLayout(viewId);
      },
      getViewEmbeddingRef(viewId) {
        return { key: this.dimensionManager.getViewLayout(viewId), columns: null };
      },
      viewFollowsDefault(viewId) {
        const context = this.viewContexts.get(viewId);
        if (context === undefined) {
          throw new RangeError(`Unknown state view "${viewId}".`);
        }
        return context.followsDefault === true;
      },
      // The production `setActiveView` ends in `_notifyVisibilityChange()`
      // (view-context-core.js), which is the signal the UI coordinator turns
      // into the animation frame that renders the badges. Publishing it here is
      // what makes the frame in these tests the production frame.
      setActiveView(viewId) {
        if (!this.viewContexts.has(viewId)) {
          throw new RangeError(`Unknown state view "${viewId}".`);
        }
        const changed = this.activeViewId !== viewId;
        this.activeViewId = viewId;
        if (this.viewer !== undefined) {
          // Mirrors production: selecting a view moves the focus and leaves
          // the layout mode as the viewer had it.
          const mode = typeof this.viewer.getViewLayout === 'function'
            ? this.viewer.getViewLayout().mode
            : 'grid';
          this.viewer.setViewLayout(mode, viewId);
        }
        if (changed) {
          for (const listener of [...visibilityListeners]) listener();
        }
        return viewId;
      },
      // The one representation transaction, reduced to what these tests
      // observe: every owner publishes the layout, and the view records
      // whether it follows its dimension's default.
      async setViewRepresentation(viewId, layoutKey, { followsDefault }) {
        assert.equal(viewId, 'live');
        const dimension = LAYOUT_DIMENSIONS[layoutKey];
        const live = this.viewContexts.get('live');
        live.followsDefault = followsDefault;
        this.dimensionManager.dimensions.set('live', dimension);
        this.dimensionManager.layouts.set('live', layoutKey);
        owners.viewer.setViewEmbedding('live', { dimension, layoutKey });
        await new Promise(resolve => setTimeout(resolve, 0));
      },
      beginBatch() {},
      endBatch() {},
      // The restore entry of the session schema: an embedding reference.
      async restoreViewEmbedding(viewId, ref) {
        assert.equal(ref.columns, null);
        await this.setViewRepresentation(viewId, ref.key, {
          followsDefault: ref.key !== 'X_tsne',
        });
        return ref.key;
      },
      onVisibilityChanged(listener) {
        visibilityListeners.push(listener);
      },
    },
  );

  let nextId = 1;
  let camerasLocked = false;
  let focusedViewId = 'live';
  let liveViewHidden = false;
  let layoutMode = 'grid';
  const snapshots = [];
  const viewerDimensions = new Map([['live', 2]]);
  const viewerLayouts = new Map([['live', 'X_umap']]);
  const navigationModes = new Map([['live', 'orbit']]);
  const viewCameras = new Map([['live', cameraState()]]);

  function forgetView(viewId) {
    viewerDimensions.delete(viewId);
    viewerLayouts.delete(viewId);
    navigationModes.delete(viewId);
    viewCameras.delete(viewId);
  }

  const viewer = {
    // viewer.js `clearSnapshotViews()` resets focus and live-view visibility
    // with the inventory; that reset is exactly what the UI mirror missed.
    clearSnapshotViews() {
      for (const snapshot of snapshots.splice(0)) forgetView(snapshot.id);
      focusedViewId = 'live';
      liveViewHidden = false;
    },
    createSnapshotView(config) {
      const id = `snap_${nextId}`;
      nextId += 1;
      snapshots.push({ id, label: config.label });
      viewerDimensions.set(id, config.dimensionLevel);
      // A kept view starts on its source view's layout.
      viewerLayouts.set(id, viewerLayouts.get(config.sourceViewId));
      navigationModes.set(id, 'orbit');
      viewCameras.set(id, structuredClone(config.cameraState));
      return { id, label: config.label };
    },
    getCamerasLocked() {
      return camerasLocked;
    },
    // viewer.js per-view centroid toggles, which a session restores per view.
    centroidFlags: new Map(),
    setShowCentroidPoints(show, viewId) {
      this.centroidFlags.set(viewId, { ...this.centroidFlags.get(viewId), points: show });
    },
    setShowCentroidLabels(show, viewId) {
      this.centroidFlags.set(viewId, { ...this.centroidFlags.get(viewId), labels: show });
    },
    // viewer.js `setViewTitlePrefixes()`: the pane chips' "N · shows" prefix.
    titlePrefixes: new Map(),
    setViewTitlePrefixes(prefixes) {
      this.titlePrefixes = new Map(prefixes);
    },
    // viewer.js `getCameraLinkGroups()`: while linked, the groups of two or
    // more presented views that show one representation.
    getCameraLinkGroups() {
      if (!camerasLocked) return [];
      const groups = new Map();
      for (const viewId of ['live', ...snapshots.map(snapshot => snapshot.id)]) {
        if (viewId === 'live' && liveViewHidden) continue;
        const layoutKey = viewerLayouts.get(viewId);
        if (!groups.has(layoutKey)) groups.set(layoutKey, []);
        groups.get(layoutKey).push(viewId);
      }
      return [...groups.values()].filter(group => group.length > 1);
    },
    getFocusedViewId() {
      return focusedViewId;
    },
    getLiveViewHidden() {
      return liveViewHidden;
    },
    getLiveViewLabel() {
      return 'Live';
    },
    getSnapshotViews() {
      return snapshots.map(snapshot => ({ ...snapshot }));
    },
    getViewCameraState(viewId) {
      const camera = viewCameras.get(viewId);
      if (camera === undefined) {
        throw new RangeError(`Unknown view camera "${viewId}".`);
      }
      return structuredClone(camera);
    },
    getViewDimension(viewId) {
      if (!viewerDimensions.has(viewId)) {
        throw new RangeError(`Unknown viewer dimension "${viewId}".`);
      }
      return viewerDimensions.get(viewId);
    },
    getViewLayoutKey(viewId) {
      this.getViewDimension(viewId);
      return viewerLayouts.get(viewId);
    },
    getViewNavigationMode(viewId) {
      const mode = navigationModes.get(viewId);
      if (mode === undefined) {
        throw new RangeError(`Unknown view navigation mode "${viewId}".`);
      }
      return mode;
    },
    // viewer.js `removeSnapshotView()` returns focus to the live view and
    // un-hides it once the last snapshot is gone.
    removeSnapshotView(viewId) {
      const index = snapshots.findIndex(snapshot => snapshot.id === viewId);
      if (index < 0) {
        throw new RangeError(`Unknown viewer snapshot "${viewId}".`);
      }
      snapshots.splice(index, 1);
      forgetView(viewId);
      if (focusedViewId === viewId) focusedViewId = 'live';
      if (snapshots.length === 0) liveViewHidden = false;
    },
    setCameraState() {},
    setCamerasLocked(value) {
      camerasLocked = value;
    },
    setLiveViewHidden(value) {
      liveViewHidden = value;
    },
    setNavigationMode(mode) {
      navigationModes.set(focusedViewId, mode);
    },
    setViewCameraState(viewId, camera) {
      viewCameras.set(viewId, structuredClone(camera));
    },
    setViewEmbedding(viewId, { dimension, layoutKey }) {
      viewerDimensions.set(viewId, dimension);
      viewerLayouts.set(viewId, layoutKey);
    },
    setViewFocusHandler() {},
    setViewLayout(mode, activeId) {
      if (activeId !== 'live' && !snapshots.some(s => s.id === activeId)) {
        throw new RangeError(`Unknown layout view "${activeId}".`);
      }
      layoutMode = mode;
      focusedViewId = activeId;
    },
    setViewNavigationMode(viewId, mode) {
      navigationModes.set(viewId, mode);
    },
  };
  const owners = {
    dimensionManager,
    layoutMode: () => layoutMode,
    snapshots,
    state,
    viewer,
  };
  state.viewer = viewer;
  return owners;
}

/**
 * Wire the module the way `ui-coordinator.js` wires it, including the coalesced
 * animation frame that `visibility:changed` schedules.
 */
function mountViewControls(t, owners) {
  const { dom, renderDom } = installDom(t);
  const activeViewNotifications = [];
  const frameErrors = [];
  let pendingFrame = null;

  const controls = initViewControls({
    state: owners.state,
    viewer: owners.viewer,
    dom,
    renderDom,
    callbacks: {
      onActiveViewChanged: viewId => activeViewNotifications.push(viewId),
      onNavigationUiSyncRequested() {},
    },
  });
  // `ui-coordinator.js` `publishCellPresence()`: these owners carry cells.
  controls.setCellsPresent(true);

  // `ui-coordinator.js` `scheduleVisibilityUiUpdate()`: one coalesced frame per
  // burst of visibility changes, and the frame renders the view badges.
  owners.state.onVisibilityChanged(() => {
    if (pendingFrame !== null) return;
    pendingFrame = setTimeout(() => {
      pendingFrame = null;
      try {
        controls.renderSplitViewBadges();
      } catch (error) {
        frameErrors.push(error);
      }
    }, 0);
  });
  t.after(() => {
    if (pendingFrame !== null) clearTimeout(pendingFrame);
  });

  return { activeViewNotifications, controls, dom, frameErrors, renderDom };
}

function keepView(dom) {
  dom.keepViewBtn.fire('click');
}

test('Keep view is offered only while the runtime has cells', t => {
  const owners = createOwners();
  const { controls, dom } = mountViewControls(t, owners);
  assert.equal(dom.keepViewBtn.disabled, false);

  controls.setCellsPresent(false);
  assert.equal(dom.keepViewBtn.disabled, true);
  assert.throws(() => controls.setCellsPresent(0), TypeError);
  assert.equal(dom.keepViewBtn.disabled, true);

  controls.setCellsPresent(true);
  assert.equal(dom.keepViewBtn.disabled, false);
});

test('a cleared inventory leaves no kept view named by the badge renderer', t => {
  const owners = createOwners();
  const { controls, dom } = mountViewControls(t, owners);

  keepView(dom);
  assert.deepEqual(
    owners.viewer.getSnapshotViews().map(snapshot => snapshot.id),
    ['snap_1'],
    'the kept view must exist, or the defect below is never reachable',
  );
  assert.equal(owners.state.getActiveViewId(), 'snap_1');
  assert.equal(
    dom.navigationTarget.hidden,
    false,
    'with two views open, Navigation names the view it drives',
  );

  // The first act of every multiview restore (state-serializer/multiview.js).
  clearPublishedSnapshotViews({ state: owners.state, viewer: owners.viewer });
  assert.equal(
    owners.state.getActiveViewId(),
    'live',
    'the DataState returns the active view to live when a context is retired',
  );

  // Exactly what the animation frame the rebuild scheduled goes on to call.
  assert.doesNotThrow(
    () => controls.renderSplitViewBadges(),
    'the badge renderer must read the current active view, not a stale copy',
  );
  assert.equal(
    dom.navigationTarget.hidden,
    true,
    'with one view left, Navigation has no view to name',
  );
});

test('a cleared inventory leaves no hidden live view in the badge renderer', t => {
  const owners = createOwners();
  const { controls, dom } = mountViewControls(t, owners);

  keepView(dom);
  keepView(dom);
  assert.deepEqual(
    owners.viewer.getSnapshotViews().map(snapshot => snapshot.id),
    ['snap_1', 'snap_2'],
  );

  // The live badge's remove control hides the live view when kept views remain.
  const liveBadge = dom.badgesList.children[0];
  const liveRemove = liveBadge.children.find(child => child.className === 'split-badge-remove');
  liveRemove.fire('click');
  assert.equal(
    owners.viewer.getLiveViewHidden(),
    true,
    'the live view must actually be hidden, or the defect is not reachable',
  );

  clearPublishedSnapshotViews({ state: owners.state, viewer: owners.viewer });
  assert.equal(owners.state.getActiveViewId(), 'live');
  assert.equal(
    owners.viewer.getLiveViewHidden(),
    false,
    'the viewer un-hides the live view when the inventory empties',
  );

  assert.doesNotThrow(
    () => controls.renderSplitViewBadges(),
    'the badge renderer must read live-view visibility from the viewer',
  );
});

test('a multiview restore raises nothing on the frames it schedules', async t => {
  const owners = createOwners();
  const { controls, dom, frameErrors } = mountViewControls(t, owners);

  keepView(dom);
  const savedActiveId = owners.state.getActiveViewId();
  assert.equal(savedActiveId, 'snap_1');

  const saved = {
    camerasLocked: false,
    layout: { activeId: 'snap_1', liveViewHidden: false, mode: 'grid' },
    live: { cameraState: cameraState(), centroids: { points: false, labels: false } },
    snapshots: [{
      activeFields: { activeFieldKey: null, activeFieldSource: null },
      cameraState: cameraState(),
      centroids: { points: false, labels: false },
      embedding: { key: 'X_umap', columns: null },
      filters: {},
      id: 'snap_1',
    }],
  };

  await restoreMultiview({
    state: owners.state,
    viewer: owners.viewer,
    async restoreActiveFields() {
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    async restoreFilters() {
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  }, saved, {
    embedding: { key: 'X_umap', columns: null },
    filters: {},
    activeFields: { activeFieldKey: null, activeFieldSource: null },
  });

  // Drain any frame the restore's last publication scheduled.
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(
    frameErrors.map(error => `${error.name}: ${error.message}`),
    [],
    'no frame scheduled by a restore may raise; an uncaught error here is '
      + 'converted into a restore failure when it lands inside a control '
      + 'event dispatch (state-serializer/ui-controls.js)',
  );
  assert.deepEqual(
    owners.viewer.getSnapshotViews().map(snapshot => snapshot.label),
    ['All cells'],
  );
  assert.equal(owners.state.getActiveViewId(), 'snap_2');
  assert.doesNotThrow(() => controls.renderSplitViewBadges());
});

/** The text of one rendered view row: number, what it shows, its field. */
function rowText(badge) {
  const select = badge.children.find(child => child.className === 'split-badge-select');
  const meta = badge.children.find(child => child.className === 'split-badge-meta');
  return {
    number: select.children.find(child => child.className === 'split-badge-pill').textContent,
    shows: select.children.find(child => child.className === 'split-badge-label').textContent,
    field: meta.children.find(child => child.className === 'split-badge-sub').textContent,
    linked: meta.children.some(child => child.className === 'split-badge-link'),
  };
}

test('each row names what its view shows, with the colouring field under it', t => {
  const owners = createOwners();
  const { dom } = mountViewControls(t, owners);

  keepView(dom);
  assert.deepEqual(
    dom.badgesList.children.map(rowText),
    [
      { number: '1', shows: 'UMAP · 2D', field: 'Live', linked: false },
      { number: '2', shows: 'UMAP · 2D', field: 'All cells', linked: false },
    ],
  );
  // The selected row is a pressed toggle; the other is not.
  const pressed = dom.badgesList.children.map(badge => badge.children
    .find(child => child.className === 'split-badge-select')
    .getAttribute('aria-pressed'));
  assert.deepEqual(pressed, ['false', 'true']);
  assert.equal(
    dom.badgesList.children[1].children
      .find(child => child.className === 'split-badge-select')
      .getAttribute('aria-label'),
    'View 2: UMAP · 2D, coloured by All cells',
  );
  // The pane chips on the plot carry the same number and representation.
  assert.deepEqual([...owners.viewer.titlePrefixes], [
    ['live', '1 · UMAP 2D'],
    ['snap_1', '2 · UMAP 2D'],
  ]);
});

test('Link cameras is offered only between views that show one representation', async t => {
  const owners = createOwners();
  const { controls, dom } = mountViewControls(t, owners);

  // One view: nothing to link.
  controls.renderSplitViewBadges();
  assert.equal(dom.cameraLockBtn.disabled, true);
  assert.equal(dom.cameraLockBtn.getAttribute('aria-pressed'), 'false');
  assert.match(dom.cameraLockBtn.title, /Keep a view first/);

  // Two views of one representation: linkable, and the linked rows say so.
  keepView(dom);
  owners.viewer.setCamerasLocked(true);
  controls.renderSplitViewBadges();
  assert.equal(dom.cameraLockBtn.disabled, false);
  assert.equal(dom.cameraLockBtn.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(dom.badgesList.children.map(rowText).map(row => row.linked), [true, true]);

  // The live view switches to another representation of the same dimension:
  // no two views share one, so the button is unavailable and shows as off,
  // whatever the stored preference, and no row is linked.
  owners.state.setActiveView('live');
  await owners.state.setViewRepresentation('live', 'X_tsne', { followsDefault: false });
  controls.renderSplitViewBadges();
  assert.equal(owners.viewer.getCamerasLocked(), true, 'the preference is kept');
  assert.equal(dom.cameraLockBtn.disabled, true);
  assert.equal(dom.cameraLockBtn.getAttribute('aria-pressed'), 'false');
  assert.match(dom.cameraLockBtn.title, /No two views show the same embedding/);
  assert.deepEqual(
    dom.badgesList.children.map(rowText),
    [
      { number: '1', shows: 't-SNE · 2D', field: 'Live', linked: false },
      { number: '2', shows: 'UMAP · 2D', field: 'All cells', linked: false },
    ],
  );
});
