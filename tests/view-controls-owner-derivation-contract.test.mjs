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

  replaceChildren() {
    this.children.length = 0;
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

function createOwners() {
  const dimensionManager = {
    dimensions: new Map([['live', 2]]),
    copyViewDimension(sourceViewId, targetViewId) {
      if (!this.dimensions.has(sourceViewId)) {
        throw new RangeError(`Unknown dimension source "${sourceViewId}".`);
      }
      this.dimensions.set(targetViewId, this.dimensions.get(sourceViewId));
    },
    getViewDimension(viewId) {
      if (!this.dimensions.has(viewId)) {
        throw new RangeError(`Unknown view dimension "${viewId}".`);
      }
      return this.dimensions.get(viewId);
    },
    removeView(viewId) {
      this.dimensions.delete(viewId);
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
          dimensionLevel: 2,
          colorsArray: Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]),
          categoryTransparency: Float32Array.from([1, 1]),
          cellVisibilityMask: Float32Array.from([1, 1]),
          outlierQuantilesArray: Float32Array.from([-1, -1]),
          centroidPositions: new Float32Array(),
          centroidColors: new Uint8Array(),
          centroidOutliers: new Float32Array(),
          centroidLabels: [],
          filteredCount: { shown: 2, total: 2 },
        },
      ]]),
      captureCurrentContext() {
        return viewContextCoreMethods._cloneViewContext.call(
          this,
          this.viewContexts.get('live'),
          'live',
          { cloneArrays: true },
        );
      },
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
          centroidOutliers: null,
          centroidPositions: null,
          colors: Uint8Array.from([21, 22, 23, 255, 31, 32, 33, 255]),
          dimensionLevel: this.dimensionManager.getViewDimension('live'),
          fieldKey: null,
          fieldKind: null,
          filtersText: [],
          label: 'All cells',
          outlierQuantiles: Float32Array.from([-1, -1]),
          outlierThreshold: 0,
          pointCount: 2,
          transparency: Float32Array.from([0.25, 1]),
        };
      },
      getViewDimensionLevel(viewId) {
        return this.dimensionManager.getViewDimension(viewId);
      },
      restoreContext(context) {
        this.viewContexts.set(
          'live',
          viewContextCoreMethods._cloneViewContext.call(
            this,
            context,
            'live',
            { cloneArrays: true },
          ),
        );
        this.activeViewId = 'live';
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
      async setDimensionLevel(level, { viewId }) {
        assert.equal(viewId, 'live');
        this.viewContexts.get('live').dimensionLevel = level;
        this.dimensionManager.dimensions.set('live', level);
        owners.viewer.setViewDimension('live', level);
        await new Promise(resolve => setTimeout(resolve, 0));
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
  const navigationModes = new Map([['live', 'orbit']]);
  const viewCameras = new Map([['live', cameraState()]]);

  function forgetView(viewId) {
    viewerDimensions.delete(viewId);
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
      navigationModes.set(id, 'orbit');
      viewCameras.set(id, structuredClone(config.cameraState));
      return { id, label: config.label };
    },
    getCamerasLocked() {
      return camerasLocked;
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
    setViewDimension(viewId, level) {
      viewerDimensions.set(viewId, level);
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
      async onCycleViewDimension() {},
      onNavigationUiSyncRequested() {},
    },
  });

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
  const liveRemove = liveBadge.children.at(-1);
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
    liveCameraState: cameraState(),
    snapshots: [{
      activeFields: { activeFieldKey: null, activeFieldSource: null },
      cameraState: cameraState(),
      dimensionLevel: 2,
      fieldKey: null,
      fieldKind: null,
      filters: {},
      id: 'snap_1',
      label: 'All cells',
      meta: { filtersText: [] },
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
    pushViewerState() {},
  }, saved);

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
