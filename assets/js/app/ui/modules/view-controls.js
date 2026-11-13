/**
 * @fileoverview Split-view (small multiples) controls.
 *
 * Owns UI state for:
 * - Active view selection (live vs snapshot)
 * - View layout mode (grid vs single)
 * - Snapshot creation/removal and the "Link cameras" toggle, which links
 *   only views that show the same representation
 * - One row per view: what it shows ("UMAP · 3D"), its coloring field, its
 *   navigation mode, and whether its camera is linked
 *
 * Cross-module refresh (field selectors, legends, filters) is delegated via
 * callbacks whenever the active view changes.
 *
 * Every change these controls make is an action (`app/actions/definitions/
 * views.js`), implemented here: `view.keep`, `view.remove`, `view.clear`,
 * `view.layout.set`, `view.focus`, `view.cameras.link` and
 * `cells.visibility.set`. A control dispatches; a click on a pane, which the
 * viewer has already focused, is recorded by observation (`view.focus`).
 * Views are named as the Compare views list numbers them
 * (`app/actions/targets/views.js`); a view given a name of its own
 * (`view.rename`, here: double-click its row, or F2 on it) shows it beside
 * its number in its row, its pane chip and the Navigation panel. The layout mode is the viewer's
 * (`getViewLayout`); the selector shows it.
 *
 * @module ui/modules/view-controls
 */

import { setControlAvailability } from '../core/control-availability.js';
import { getNotificationCenter } from '../../notification-center.js';
import { failureDetails, sayFailure } from '../../../utils/errors.js';
import { getActions, getStateDomains } from '../../actions/index.js';
import { PER_VIEW_DOMAINS } from '../../actions/domains.js';
import { getCurrentHistory } from '../../history/current.js';
import { throwIfAborted } from '../../../utils/abort.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { dispatchFromControl } from '../../actions/control-dispatch.js';
import {
  checkViewLabel,
  resolveViewName,
  viewLabelOf,
  viewNameAt,
  viewNameOf,
  viewWords,
  withViewLabel,
} from '../../actions/targets/views.js';
import {
  clearPublishedSnapshotViews,
  publishSnapshotView,
  retireSnapshotView,
} from '../../view-snapshot-publication.js';
import { viewerNeedsUiRetirement } from '../core/viewer-lifecycle.js';
import { visitingViews } from '../../state/domains/view-list.js';
import { formatCountOf, countNoun } from '../../../utils/format-units.js';
import { NO_DATASET_LABEL, noDatasetOpenTo, openADatasetTo } from '../no-dataset.js';

const LIVE_VIEW_ID = 'live';
const VIEW_LAYOUT_MODES = new Set(['grid', 'single']);
const RENDER_MODES = new Set(['points', 'smoke']);
/** Why Volumetric smoke cannot be chosen while views are kept. */
export const SMOKE_NEEDS_ONE_VIEW = 'volumetric smoke draws one view; remove the kept views first (Clear, beside Layout)';
const NAV_MODE_LABELS = Object.freeze({
  orbit: 'Orbit',
  planar: 'Planar',
  free: 'Free-fly',
});
const NAV_MODE_NAMES = Object.freeze({
  orbit: 'Orbit',
  planar: 'Planar',
  free: 'Free-fly',
});
const NAV_MODE_CYCLE = Object.freeze(['orbit', 'planar', 'free']);

function requireViewId(viewId, label = 'View id') {
  if (typeof viewId !== 'string' || viewId.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return viewId;
}

function requireMethod(owner, methodName, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${label} must provide ${methodName}().`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be exactly true or false.`);
  }
  return value;
}

function requireLayoutMode(value) {
  if (!VIEW_LAYOUT_MODES.has(value)) {
    throw new RangeError('View layout mode must be exactly "grid" or "single".');
  }
  return value;
}

function requireRenderMode(value) {
  if (!RENDER_MODES.has(value)) {
    throw new RangeError('Render mode must be exactly "points" or "smoke".');
  }
  return value;
}

function requireNavigationMode(value) {
  if (!Object.hasOwn(NAV_MODE_LABELS, value)) {
    throw new RangeError(
      `Navigation mode must be orbit, planar, or free; received ${String(value)}.`
    );
  }
  return value;
}

function requireNonEmptyText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireTypedArray(value, Type, length, label) {
  if (!(value instanceof Type) || value.length !== length) {
    throw new TypeError(
      `${label} must be ${Type.name} with exactly ${formatCountOf(length, 'entry', 'entries')}.`
    );
  }
  return value;
}

function requireNullableTypedArray(value, Type, label) {
  if (value !== null && !(value instanceof Type)) {
    throw new TypeError(`${label} must be ${Type.name} or null.`);
  }
  return value;
}

function requireSnapshotPayload(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new TypeError('Snapshot payload must be one object.');
  }
  if (!Number.isSafeInteger(payload.pointCount) || payload.pointCount <= 0) {
    throw new RangeError(
      'A kept view requires a positive safe-integer point count.'
    );
  }
  const pointCount = payload.pointCount;
  requireNonEmptyText(payload.label, 'Snapshot label');
  if (
    payload.fieldKey !== null &&
    (typeof payload.fieldKey !== 'string' || payload.fieldKey.length === 0)
  ) {
    throw new TypeError('Snapshot fieldKey must be a non-empty string or null.');
  }
  if (
    payload.fieldKind !== null &&
    payload.fieldKind !== 'category' &&
    payload.fieldKind !== 'continuous'
  ) {
    throw new TypeError(
      'Snapshot fieldKind must be category, continuous, or null.'
    );
  }
  if ((payload.fieldKey === null) !== (payload.fieldKind === null)) {
    throw new TypeError(
      'Snapshot fieldKey and fieldKind must both be null or both be present.'
    );
  }
  requireTypedArray(
    payload.colors,
    Uint8Array,
    pointCount * 4,
    'Snapshot colors'
  );
  requireTypedArray(
    payload.transparency,
    Uint8Array,
    pointCount,
    'Snapshot transparency'
  );
  requireNullableTypedArray(
    payload.centroidPositions,
    Float32Array,
    'Snapshot centroid positions'
  );
  requireNullableTypedArray(
    payload.centroidColors,
    Uint8Array,
    'Snapshot centroid colors'
  );
  const centroidCount = payload.centroidPositions === null
    ? 0
    : payload.centroidPositions.length / 3;
  if (!Number.isInteger(centroidCount)) {
    throw new TypeError(
      'Snapshot centroid positions must contain complete XYZ triples.'
    );
  }
  if ((payload.centroidPositions === null) !== (payload.centroidColors === null)) {
    throw new TypeError(
      'Snapshot centroid positions and colors must be published together.'
    );
  }
  if (
    payload.centroidColors !== null &&
    payload.centroidColors.length !== centroidCount * 4
  ) {
    throw new TypeError(
      'Snapshot centroid colors must contain one RGBA tuple per centroid.'
    );
  }
  if (
    typeof payload.outlierThreshold !== 'number' ||
    !Number.isFinite(payload.outlierThreshold) ||
    payload.outlierThreshold < 0 ||
    payload.outlierThreshold > 1
  ) {
    throw new RangeError(
      'Snapshot outlier threshold must be finite and between 0 and 1.'
    );
  }
  if (
    !Array.isArray(payload.filtersText) ||
    payload.filtersText.some(line => typeof line !== 'string')
  ) {
    throw new TypeError('Snapshot filtersText must be an array of strings.');
  }
  if (![1, 2, 3].includes(payload.dimensionLevel)) {
    throw new RangeError('Snapshot dimension must be exactly 1, 2, or 3.');
  }
  return payload;
}

function requireSnapshotInventory(viewer) {
  const snapshots = viewer.getSnapshotViews();
  if (!Array.isArray(snapshots)) {
    throw new TypeError('Viewer snapshot inventory must be an array.');
  }
  const ids = new Set();
  for (const snapshot of snapshots) {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      throw new TypeError('Every viewer snapshot must be an object.');
    }
    const id = requireViewId(snapshot.id, 'Snapshot id');
    requireNonEmptyText(snapshot.label, `Snapshot "${id}" label`);
    if (ids.has(id)) {
      throw new TypeError(`Viewer published duplicate snapshot id "${id}".`);
    }
    ids.add(id);
  }
  return snapshots;
}

/**
 * @typedef {object} ViewCallbacks
 * @property {(viewId: string) => void} onActiveViewChanged
 * @property {(viewId: string) => void} onNavigationUiSyncRequested
 */

export function initViewControls({ state, viewer, dom, renderDom, callbacks }) {
  for (const methodName of [
    'clearSnapshotViews',
    'createViewFromSource',
    'getActiveViewId',
    'getDimensionManager',
    'getSnapshotPayload',
    'describeViewEmbedding',
    'removeView',
    'setActiveView',
    'setCellVisibility',
    'syncSnapshotContexts',
  ]) {
    requireMethod(state, methodName, 'View-control state');
  }
  for (const methodName of [
    'clearSnapshotViews',
    'createSnapshotView',
    'getCameraLinkGroups',
    'getCamerasLocked',
    'getFocusedViewId',
    'getLiveViewHidden',
    'getLiveViewLabel',
    'getSnapshotViews',
    'getViewCameraState',
    'getViewLayout',
    'getViewName',
    'getViewNavigationMode',
    'removeSnapshotView',
    'setCamerasLocked',
    'setLiveViewHidden',
    'setNavigationMode',
    'setViewFocusHandler',
    'setViewLayout',
    'setViewName',
    'setViewNavigationMode',
    'setViewTitlePrefixes',
  ]) {
    requireMethod(viewer, methodName, 'View-control viewer');
  }
  for (const callbackName of [
    'onActiveViewChanged',
    'onNavigationUiSyncRequested',
  ]) {
    if (
      callbacks === null ||
      typeof callbacks !== 'object' ||
      typeof callbacks[callbackName] !== 'function'
    ) {
      throw new TypeError(
        `View controls require callbacks.${callbackName}().`
      );
    }
  }
  if (
    dom === null ||
    typeof dom !== 'object' ||
    renderDom === null ||
    typeof renderDom !== 'object'
  ) {
    throw new TypeError('View controls require exact DOM records.');
  }
  if (!(dom.controls instanceof HTMLElement)) {
    throw new TypeError('View controls require the controls element.');
  }
  const ownerDocument = dom.controls.ownerDocument;
  const domEntries = [
    ['keep view button', dom.keepViewBtn, HTMLButtonElement],
    ['clear button', dom.clearBtn, HTMLButtonElement],
    ['camera lock button', dom.cameraLockBtn, HTMLButtonElement],
    ['layout selector', dom.layoutModeSelect, HTMLSelectElement],
    ['badges box', dom.badgesBox, HTMLElement],
    ['badges list', dom.badgesList, HTMLElement],
    ['layout row', dom.layoutRow, HTMLElement],
    ['navigation target row', dom.navigationTarget, HTMLElement],
    ['navigation target badge', dom.navigationTargetBadge, HTMLElement],
    ['render mode selector', renderDom.renderModeSelect, HTMLSelectElement],
  ];
  for (const [label, element, ElementType] of domEntries) {
    if (!(element instanceof ElementType)) {
      throw new TypeError(`View controls require the ${label}.`);
    }
    if (element.ownerDocument !== ownerDocument) {
      throw new TypeError(
        'View-control elements must belong to one document.'
      );
    }
  }

  const splitKeepViewBtn = dom.keepViewBtn;
  const splitClearBtn = dom.clearBtn;
  const cameraLockBtn = dom.cameraLockBtn;
  const viewLayoutModeSelect = dom.layoutModeSelect;
  const splitViewBadgesBox = dom.badgesBox;
  const splitViewBadges = dom.badgesList;
  const layoutRow = dom.layoutRow;
  const navigationTarget = dom.navigationTarget;
  const navigationTargetBadge = dom.navigationTargetBadge;
  const renderModeSelect = renderDom.renderModeSelect;
  // Whether the runtime has cells to keep. The coordinator publishes it on
  // every runtime publication (`ui-coordinator.js` `publishCellPresence`).
  let cellsPresent = false;

  /**
   * The three pieces of view state this module draws are read from their
   * owners on every use. None of them is mirrored here.
   *
   * Each owner reconciles itself, and none of them can announce it. The
   * DataState returns the active view to the live view whenever a view context
   * is retired (`view-context-core.js` `removeView` / `syncSnapshotContexts`);
   * the viewer returns focus to the live view and un-hides it whenever its
   * snapshot inventory empties (`viewer.js` `removeSnapshotView` /
   * `clearSnapshotViews`); the viewer holds the layout mode, which the
   * selector only shows (a session or a history step puts it back there).
   * A restore of the views can empty the inventory (`state/domains/views.js`),
   * so a private copy of any of the three would be stale from the next line
   * onwards, and the badge render that the same rebuild schedules would throw
   * on a view that no longer exists.
   */
  function currentActiveViewId() {
    return requireViewId(state.getActiveViewId(), 'Active view id');
  }
  function currentLayoutMode() {
    return requireLayoutMode(viewer.getViewLayout().mode);
  }
  /** The mode the views are laid out in: smoke shows one view. */
  function effectiveLayoutMode() {
    return requireRenderMode(renderModeSelect.value) === 'points'
      ? currentLayoutMode()
      : 'single';
  }
  function isLiveViewHidden() {
    return requireBoolean(
      viewer.getLiveViewHidden(),
      'Viewer live-view visibility'
    );
  }
  let destroyed = false;
  let destructionPromise = null;

  function reportUiFailure(action, error) {
    getNotificationCenter().error(
      `${action}: ${sayFailure(error)}`,
      { category: 'render', duration: 10000, ...failureDetails(error) }
    );
  }

  /**
   * Draw the controls from their owners again after `error`, and say what
   * failed when even that fails. A refusal changed nothing and needs no
   * redraw.
   */
  function reconciledFailure(error) {
    if (error instanceof ActionRefused) return error;
    try {
      syncFromStateAndViewer(true);
      return error;
    } catch (reconciliationError) {
      // Said after the action's own words ("Keep view failed: …"), which
      // its caller gives: this says only what followed the failure.
      return new AggregateError(
        [error, reconciliationError],
        'The view controls could not be drawn again after it.'
      );
    }
  }

  /** Run one action's change; a failure redraws the controls and is thrown. */
  function inAction(action, operation) {
    if (destroyed) {
      throw new ActionRefused('The view controls are closed.', { code: 'unavailable' });
    }
    try {
      return operation();
    } catch (error) {
      throw reconciledFailure(error);
    }
  }

  /** Run a change the viewer already made (a pane focused by a click). */
  function runUiAction(action, operation) {
    if (destroyed) return false;
    try {
      return operation();
    } catch (error) {
      reportUiFailure(action, reconciledFailure(error));
      return false;
    }
  }

  function requireCurrentInventory() {
    const snapshots = requireSnapshotInventory(viewer);
    const activeViewId = currentActiveViewId();
    const validIds = new Set([
      LIVE_VIEW_ID,
      ...snapshots.map(snapshot => snapshot.id),
    ]);
    if (!validIds.has(activeViewId)) {
      throw new RangeError(
        `Active view "${activeViewId}" is not in the viewer inventory.`
      );
    }
    if (isLiveViewHidden() && activeViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot be the active view.');
    }
    return snapshots;
  }

  /**
   * Lay the views out in `layoutMode` (by default the layout they have)
   * around the active view, and show the mode in the selector. The viewer
   * keeps the person's layout while smoke is on: smoke draws the live view
   * alone in either layout, and only the selector says "single" meanwhile
   * (`effectiveLayoutMode`). Writing "single" into the viewer from a refresh
   * in smoke would undo a starting view's "grid" as it is put back.
   * @param {'grid'|'single'} [layoutMode]
   */
  function pushViewLayoutToViewer(layoutMode = currentLayoutMode()) {
    const exactMode = requireLayoutMode(layoutMode);
    requireCurrentInventory();
    viewer.setViewLayout(exactMode, currentActiveViewId());
    viewLayoutModeSelect.value = effectiveLayoutMode();
  }

  function syncActiveViewSelectOptions() {
    requireCurrentInventory();
  }

  /**
   * Publish one active view to the owner, then draw from the owner.
   *
   * A caller does not assign a private mirror and let this push it. Passing the
   * id is what keeps the owner the only copy: the value this notifies with is
   * the value the DataState accepted.
   *
   * @param {string} viewId
   * @param {boolean} [notifyActiveView]
   */
  function activateView(viewId, notifyActiveView = true) {
    const exactViewId = requireViewId(viewId, 'Activated view id');
    if (typeof notifyActiveView !== 'boolean') {
      throw new TypeError(
        'Active-view UI notification ownership must be one exact boolean.'
      );
    }
    const publishedViewId = state.setActiveView(exactViewId);
    if (publishedViewId !== exactViewId) {
      throw new Error(
        `State published active view "${String(publishedViewId)}" instead of "${exactViewId}".`
      );
    }
    if (notifyActiveView) {
      callbacks.onActiveViewChanged(exactViewId);
    }
  }

  function snapshotIds(snapshots = requireSnapshotInventory(viewer)) {
    return snapshots.map(snapshot => snapshot.id);
  }

  function removeSnapshot(snapshotId) {
    let after;
    try {
      after = retireSnapshotView({
        state,
        viewer,
        snapshotId,
      });
    } catch (error) {
      try {
        syncFromStateAndViewer();
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          `Snapshot "${snapshotId}" removal failed and its UI could not be reconciled.`
        );
      }
      throw error;
    }
    return after;
  }

  function createNavigationIndicator(viewId, currentMode) {
    const exactViewId = requireViewId(viewId);
    const exactMode = requireNavigationMode(currentMode);

    const navIndicator = ownerDocument.createElement('button');
    navIndicator.type = 'button';
    navIndicator.className = 'split-badge-nav';
    navIndicator.textContent = NAV_MODE_LABELS[exactMode];
    navIndicator.title =
      `Navigation: ${NAV_MODE_NAMES[exactMode]}. Press to switch (Orbit, Planar, Free-fly).`;
    navIndicator.setAttribute(
      'aria-label',
      `Navigation of this view: ${NAV_MODE_NAMES[exactMode]}. Switch.`
    );
    navIndicator.dataset.viewId = exactViewId;

    // The next mode of the cycle for this view, as the camera's action
    // (`camera.navigation.set`, `camera-controls.js`): it redraws these rows.
    navIndicator.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (destroyed) return;
      const targetViewId = requireViewId(
        event.currentTarget.dataset.viewId,
        'Navigation badge view id'
      );
      const freshCurrentMode = requireNavigationMode(
        viewer.getViewNavigationMode(targetViewId)
      );
      const nextMode = NAV_MODE_CYCLE[
        (NAV_MODE_CYCLE.indexOf(freshCurrentMode) + 1) % NAV_MODE_CYCLE.length
      ];
      void dispatchFromControl(
        'camera.navigation.set',
        { view: viewNameOf(viewer, targetViewId), mode: nextMode },
        { failure: 'Navigation change failed', category: 'render' }
      );
    });

    return navIndicator;
  }

  /**
   * One view's row: its number, what it shows ("UMAP · 3D") with its coloring
   * field under it, whether its camera is linked, its navigation mode, and
   * (when the view can be removed) its remove button. The row is a list item;
   * its main part is the button that selects the view, so the picker below
   * and every other view control edit it.
   */
  function createViewBadge({
    viewId,
    index,
    label,
    name,
    shows,
    showsTitle,
    linkedWith,
    active,
    cameraFocused,
    navigationMode,
    onRemove
  }) {
    const badge = ownerDocument.createElement('div');
    badge.className = 'split-badge';
    badge.setAttribute('role', 'listitem');
    badge.dataset.viewId = viewId;
    const select = () => {
      if (destroyed) return;
      void dispatchFromControl(
        'view.focus',
        { view: viewNameOf(viewer, viewId) },
        { failure: 'View selection failed', category: 'render' }
      );
    };
    badge.addEventListener('click', select);

    const main = ownerDocument.createElement('button');
    main.type = 'button';
    main.className = 'split-badge-select';
    badgeSelectButtons.set(badge, main);
    main.setAttribute('aria-label', `${viewWords(viewNameAt(index - 1), name)}: ${shows}, colored by ${label}`);
    // F2 (as a highlight page's tab) or a double-click names the view.
    main.setAttribute('aria-keyshortcuts', 'F2');
    main.title = `${name === null ? '' : `${name}\n`}${showsTitle}\nColored by ${label}\nDouble-click or F2 to name this view`;
    main.addEventListener('keydown', event => {
      if (event.key !== 'F2') return;
      event.preventDefault();
      event.stopPropagation();
      startViewRename(viewId);
    });
    main.addEventListener('click', event => {
      event.stopPropagation();
      select();
    });

    const pill = ownerDocument.createElement('span');
    pill.className = 'split-badge-pill';
    pill.textContent = String(index);

    const cameraIndicator = ownerDocument.createElement('span');
    cameraIndicator.className = 'split-badge-camera';
    cameraIndicator.setAttribute('aria-hidden', 'true');
    cameraIndicator.textContent = '\u2316';

    const representation = ownerDocument.createElement('span');
    representation.className = 'split-badge-label';
    representation.textContent = shows;
    if (name === null) {
      main.append(pill, cameraIndicator, representation);
    } else {
      // A named view: its name first, what it shows after it, quieter.
      const nameText = ownerDocument.createElement('span');
      nameText.className = 'split-badge-name';
      nameText.textContent = name;
      representation.classList.add('split-badge-label-after-name');
      main.append(pill, cameraIndicator, nameText, representation);
    }
    badge.appendChild(main);

    // Second line: the field the view is colored by, whether its camera is
    // linked, and its navigation mode. The first line keeps its full width
    // for what the view shows.
    const meta = ownerDocument.createElement('div');
    meta.className = 'split-badge-meta';
    const field = ownerDocument.createElement('span');
    field.className = 'split-badge-sub';
    field.textContent = label;
    field.title = `Colored by ${label}`;
    meta.appendChild(field);

    if (linkedWith.length > 0) {
      const link = ownerDocument.createElement('span');
      link.className = 'split-badge-link';
      link.textContent = 'linked';
      const names = linkedWith.map(position => viewNameAt(position - 1));
      const others = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      link.title = `Shares one camera with ${others}: they show the same embedding.`;
      meta.appendChild(link);
    }
    meta.appendChild(createNavigationIndicator(viewId, navigationMode));

    if (onRemove !== null) {
      const removeBtn = ownerDocument.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'split-badge-remove';
      removeBtn.setAttribute('aria-label', `Remove ${viewNameAt(index - 1)}`);
      removeBtn.title = 'Remove this view';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      });
      badge.appendChild(removeBtn);
    }
    badge.appendChild(meta);
    applyViewBadgeState(badge, { active, cameraFocused });
    return badge;
  }

  /**
   * A row's state: whether its view is the selected one and whether it is the
   * view the camera controls drive (several views open). Set on the row in
   * place, so a selection keeps the row's nodes (`renderSplitViewBadges`).
   * @param {HTMLElement} badge
   * @param {{active: boolean, cameraFocused: boolean}} state
   */
  function applyViewBadgeState(badge, { active, cameraFocused }) {
    badge.classList.toggle('active', active);
    badge.classList.toggle('active-camera', cameraFocused);
    const pressed = active ? 'true' : 'false';
    const main = badgeSelectButtons.get(badge);
    if (main !== undefined && main.getAttribute('aria-pressed') !== pressed) main.setAttribute('aria-pressed', pressed);
  }

  /** Each row's button that selects its view (`applyViewBadgeState`). */
  const badgeSelectButtons = new WeakMap();

  // The view being named in its row now (`startViewRename`), or null. The
  // list is not rebuilt under its field meanwhile (a visibility frame asks
  // for a rebuild on every filter change); it is drawn again as it closes.
  let renaming = null;

  /**
   * Name a view in place: its row's first line becomes a text field with its
   * name. Enter, or leaving the field, names it (`view.rename`; an empty
   * field takes the name away), Escape leaves it as it was. A name the
   * action would refuse ("View 3") is said on the field, which stays open.
   * @param {string} viewId
   */
  function startViewRename(viewId) {
    if (destroyed || renaming !== null) return;
    const row = [...splitViewBadges.children].find(child => child.dataset.viewId === viewId) ?? null;
    const main = row?.querySelector('.split-badge-select') ?? null;
    if (row === null || main === null) return;
    const number = viewNameOf(viewer, viewId);
    const current = viewLabelOf(viewer, viewId);
    const input = ownerDocument.createElement('input');
    input.type = 'text';
    input.className = 'split-badge-name-input';
    input.value = current ?? '';
    input.placeholder = number;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Name ${number} (empty: no name)`);
    input.title = 'Enter to name the view, Escape to leave it; empty takes the name away.';
    main.hidden = true;
    row.insertBefore(input, main.nextSibling);
    renaming = viewId;
    let finished = false;

    const finish = commit => {
      if (finished) return;
      const typed = input.value.trim();
      const next = typed === '' ? null : typed;
      if (commit && next !== null) {
        try {
          checkViewLabel(next);
        } catch (error) {
          if (!(error instanceof ActionRefused)) throw error;
          input.setCustomValidity(error.message);
          input.reportValidity();
          input.focus();
          return;
        }
      }
      finished = true;
      renaming = null;
      input.remove();
      main.hidden = false;
      // Named by its number now: a view removed meanwhile is not named.
      let name = null;
      try {
        name = viewNameOf(viewer, viewId);
      } catch {
        name = null;
      }
      renderSplitViewBadges();
      const again = [...splitViewBadges.children].find(child => child.dataset.viewId === viewId);
      again?.querySelector('.split-badge-select')?.focus({ preventScroll: true });
      if (commit && name !== null && next !== viewLabelOf(viewer, viewId)) {
        void dispatchFromControl(
          'view.rename',
          { view: name, name: next },
          { failure: 'Naming the view failed', category: 'render' }
        );
      }
    };
    // The row selects its view on a click and the page has key shortcuts:
    // neither reaches through the field.
    for (const type of ['click', 'mousedown', 'dblclick']) {
      input.addEventListener(type, event => event.stopPropagation());
    }
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.focus();
    input.select();
  }

  /** A double-click on a view's row names it (not on its remove or navigation button). */
  const handleBadgeDoubleClick = event => {
    if (destroyed) return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest('.split-badge') ?? null;
    if (row === null || target.closest('.split-badge-remove, .split-badge-nav, .split-badge-name-input') !== null) return;
    event.preventDefault();
    startViewRename(row.dataset.viewId);
  };
  splitViewBadges.addEventListener('dblclick', handleBadgeDoubleClick);

  /** Select an open view: the sidebar edits it, the camera controls drive it. */
  function selectView(viewId) {
    activateView(viewId);
    pushViewLayoutToViewer();
    renderSplitViewBadges();
    callbacks.onNavigationUiSyncRequested(viewId);
  }

  /**
   * Remove the live view's row: the live view is hidden and the kept views
   * stay, however many there are (the × removes the view its row shows).
   * The first kept view is selected when the live view was. With one
   * kept view left, that view shows alone and has no ×; Clear views (or
   * `view.clear`) brings the live view back.
   */
  function removeLiveView() {
    const currentSnapshots = requireSnapshotInventory(viewer);
    if (currentSnapshots.length === 0) {
      throw new ActionRefused('The live view is the only view; keep a view before removing it.');
    }
    if (currentActiveViewId() === LIVE_VIEW_ID) {
      activateView(currentSnapshots[0].id);
      pushViewLayoutToViewer();
    }
    viewer.setLiveViewHidden(true);
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  function removeSnapshotView(snapId) {
    if (isLiveViewHidden() && requireSnapshotInventory(viewer).length === 1) {
      throw new ActionRefused('The last view cannot be removed.');
    }
    const removedActiveView = snapId === currentActiveViewId();
    const remainingSnaps = removeSnapshot(snapId);
    const remainingActiveViewId = currentActiveViewId();
    const activeStillExists =
      remainingActiveViewId === LIVE_VIEW_ID ||
      remainingSnaps.some(
        snapshot => snapshot.id === remainingActiveViewId
      );
    if (removedActiveView || !activeStillExists) {
      if (isLiveViewHidden()) {
        if (remainingSnaps.length === 0) {
          throw new Error(
            'Viewer kept the live view hidden without any snapshot.'
          );
        }
        activateView(remainingSnaps[0].id);
      } else {
        activateView(LIVE_VIEW_ID);
      }
      pushViewLayoutToViewer();
    }
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  /** The remove control of one view's row: the `view.remove` action. */
  function dispatchRemoveView(viewId) {
    if (destroyed) return;
    void dispatchFromControl(
      'view.remove',
      { view: viewNameOf(viewer, viewId) },
      { failure: 'View removal failed', category: 'render' }
    );
  }

  // The badges are rebuilt from scratch when what a row says changes, and the
  // coordinator asks for a render on every visibility frame (each filter or
  // highlight change): a render with the same views, labels and modes keeps
  // the rows. A selection or a camera focus changes only the rows' state, set
  // on the rows in place (`applyViewBadgeState`): a click selects its view
  // and redraws, and a row replaced between the two presses of a
  // double-click would lose the double-click on WebKit, which sends no dblclick
  // when the second press's row is gone by its release.
  let renderedBadgeKey = null;
  let renderedPrefixKey = null;

  /**
   * The open views in row order, each with what it shows. Read from the
   * owners on every call.
   */
  function describeOpenViews(snapshots = requireCurrentInventory()) {
    const liveViewHidden = isLiveViewHidden();
    const views = [];
    const describe = (viewId, label, onRemove) => {
      const embedding = state.describeViewEmbedding(viewId);
      views.push({
        viewId,
        label,
        name: viewLabelOf(viewer, viewId),
        shows: embedding === null ? '—' : `${embedding.name} · ${embedding.dimension}D`,
        showsTitle: embedding === null
          ? NO_DATASET_LABEL
          : `Shows ${embedding.name} (${embedding.label}), ${embedding.dimension}D` +
            (embedding.isDefault ? `, the dataset's ${embedding.dimension}D default` : ''),
        layoutKey: embedding?.layoutKey ?? null,
        navigationMode: requireNavigationMode(viewer.getViewNavigationMode(viewId)),
        onRemove,
      });
    };
    if (!liveViewHidden) {
      describe(
        LIVE_VIEW_ID,
        requireNonEmptyText(viewer.getLiveViewLabel(), 'Live-view label'),
        snapshots.length > 0 ? () => dispatchRemoveView(LIVE_VIEW_ID) : null
      );
    }
    for (const snap of snapshots) {
      const snapId = snap.id;
      describe(
        snapId,
        requireNonEmptyText(snap.label, `Snapshot "${snapId}" label`),
        !liveViewHidden || snapshots.length > 1
          ? () => dispatchRemoveView(snapId)
          : null
      );
    }
    return views;
  }

  /**
   * "View 2" (with its name: 'View 2 "Early"') for an open view while
   * several are open, else null: the name the representation picker and the
   * Navigation panel give the view they edit.
   *
   * @param {string} viewId
   * @returns {string|null}
   */
  function describeViewPosition(viewId) {
    if (destroyed) return null;
    const views = describeOpenViews();
    if (views.length <= 1) return null;
    const position = views.findIndex(view => view.viewId === viewId);
    return position === -1 ? null : viewWords(viewNameAt(position), views[position].name);
  }

  /** Whether any two open views show the same representation. */
  function hasLinkableViews(views) {
    const seen = new Set();
    for (const view of views) {
      if (view.layoutKey === null) continue;
      if (seen.has(view.layoutKey)) return true;
      seen.add(view.layoutKey);
    }
    return false;
  }

  // A restore visiting the views (`visitingViews`) focuses each in turn, a
  // removed live view among them, and awaits field reads between them: the
  // list is drawn from the person's focus once the visit ends.
  let badgesAfterVisit = false;
  function renderSplitViewBadgesAfterVisit() {
    if (badgesAfterVisit) return;
    badgesAfterVisit = true;
    const frame = ownerDocument.defaultView.requestAnimationFrame.bind(ownerDocument.defaultView);
    const again = () => {
      if (destroyed) return;
      if (visitingViews()) {
        frame(again);
        return;
      }
      badgesAfterVisit = false;
      renderSplitViewBadges();
    };
    frame(again);
  }

  function renderSplitViewBadges() {
    if (destroyed) return false;
    if (visitingViews()) {
      renderSplitViewBadgesAfterVisit();
      return false;
    }
    const snapshots = requireCurrentInventory();
    // One read of each owner for one render pass. Every handler attached below
    // reads its own, because it runs long after this pass finished.
    const activeViewId = currentActiveViewId();
    const camerasLocked = requireBoolean(
      viewer.getCamerasLocked(),
      'Viewer camera lock'
    );
    const focusedId = requireViewId(
      viewer.getFocusedViewId(),
      'Focused view id'
    );
    const views = describeOpenViews(snapshots);
    const positionOf = new Map(views.map((view, position) => [view.viewId, position + 1]));
    const linkGroups = viewer.getCameraLinkGroups();
    const linkedWith = viewId => {
      const group = linkGroups.find(members => members.includes(viewId));
      return group === undefined
        ? []
        : group.filter(member => member !== viewId)
          .map(member => positionOf.get(member))
          .filter(position => position !== undefined);
    };

    const badgeKey = JSON.stringify([
      camerasLocked,
      linkGroups,
      views.map(view => [
        view.viewId,
        view.label,
        view.name,
        view.shows,
        view.showsTitle,
        view.navigationMode,
        view.onRemove !== null
      ])
    ]);
    const stateOf = view => ({
      active: view.viewId === activeViewId,
      cameraFocused: views.length > 1 && focusedId === view.viewId
    });
    if (renaming === null && badgeKey === renderedBadgeKey && splitViewBadges.children.length === views.length) {
      for (const row of splitViewBadges.children) {
        const view = views.find(each => each.viewId === row.dataset.viewId);
        if (view !== undefined) applyViewBadgeState(row, stateOf(view));
      }
    } else if (renaming === null) {
      const focusedElementView = ownerDocument.activeElement?.closest?.('.split-badge')?.dataset.viewId ?? null;
      const focusedClass = ownerDocument.activeElement?.className ?? null;
      splitViewBadges.innerHTML = '';
      views.forEach((view, position) => {
        splitViewBadges.appendChild(createViewBadge({
          ...view,
          index: position + 1,
          linkedWith: linkedWith(view.viewId),
          ...stateOf(view)
        }));
      });
      renderedBadgeKey = badgeKey;
      // A rebuilt row keeps keyboard focus on the control that had it.
      if (focusedElementView !== null && typeof focusedClass === 'string') {
        const row = splitViewBadges.querySelector(
          `.split-badge[data-view-id="${focusedElementView}"]`
        );
        const target = row?.querySelector(`.${focusedClass.split(' ')[0]}`);
        target?.focus({ preventScroll: true });
      }
    }
    renderNavigationTarget(views, focusedId, linkedWith(focusedId));
    updateCameraLockUI(views);
    // The pane chips on the plot name each view the way its row does.
    const prefixes = views.length > 1
      ? views.map((view, position) => [
        view.viewId,
        `${position + 1}${view.name === null ? '' : ` · ${view.name}`} · ${view.shows.replace(' · ', ' ')}`,
      ])
      : [];
    const prefixKey = JSON.stringify(prefixes);
    if (prefixKey !== renderedPrefixKey) {
      renderedPrefixKey = prefixKey;
      viewer.setViewTitlePrefixes(new Map(prefixes));
    }

    syncActiveViewSelectOptions();
  }

  /**
   * The Navigation panel's "Applies to" row. With one view there is nothing to
   * say. With several, its settings drive the camera-focused view -- and the
   * views linked to its camera, which show the same embedding; the row names
   * that target with the same number and text as its Compare views row.
   */
  function renderNavigationTarget(views, focusedId, linkedPositions) {
    if (views.length <= 1) {
      navigationTarget.hidden = true;
      navigationTargetBadge.replaceChildren();
      return;
    }
    const position = views.findIndex(view => view.viewId === focusedId);
    if (position === -1) {
      throw new Error(`Focused view "${focusedId}" is not an open view.`);
    }
    const pill = ownerDocument.createElement('span');
    pill.className = 'split-badge-pill';
    pill.textContent = String(position + 1);
    const text = ownerDocument.createElement('span');
    text.className = 'split-badge-label';
    const named = views[position].name === null ? views[position].shows : `${views[position].name} · ${views[position].shows}`;
    text.textContent = linkedPositions.length === 0
      ? named
      : `${named} · with ${countNoun(linkedPositions.length, 'view')} ${linkedPositions.join(', ')}`;
    // The same camera mark and ring as the focused view's own row.
    const cameraIndicator = ownerDocument.createElement('span');
    cameraIndicator.className = 'split-badge-camera';
    cameraIndicator.setAttribute('aria-hidden', 'true');
    cameraIndicator.textContent = '\u2316';
    navigationTargetBadge.classList.add('active-camera');
    navigationTargetBadge.replaceChildren(pill, cameraIndicator, text);
    navigationTarget.hidden = false;
  }

  /**
   * "Link cameras" links only views that show the same representation, so it
   * is available only when two open views do; otherwise it says why.
   */
  function updateCameraLockUI(views = describeOpenViews()) {
    const locked = requireBoolean(
      viewer.getCamerasLocked(),
      'Viewer camera lock'
    );
    const linkable = hasLinkableViews(views);
    cameraLockBtn.disabled = !linkable;
    // A toggle button keeps one name; its pressed state says whether it is on.
    // Unavailable, it shows as off: no two views share a camera.
    cameraLockBtn.setAttribute('aria-pressed', linkable && locked ? 'true' : 'false');
    cameraLockBtn.textContent = 'Link cameras';
    if (views.length <= 1) {
      cameraLockBtn.title = 'Keep a view first: linking needs two views of the same embedding.';
    } else if (!linkable) {
      cameraLockBtn.title =
        'No two views show the same embedding. Cameras link only between views of one embedding.';
    } else {
      cameraLockBtn.title = locked
        ? 'Views of the same embedding share one camera. Press to give each view its own.'
        : 'Each view has its own camera. Press to link views that show the same embedding.';
    }
  }

  function syncRenderModeState(mode, publishLayout) {
    const exactMode = requireRenderMode(mode);
    if (typeof publishLayout !== 'boolean') {
      throw new TypeError(
        'Render-mode layout publication must be one exact boolean.'
      );
    }
    if (renderModeSelect.value !== exactMode) {
      throw new Error(
        `Render-mode controls cannot publish "${exactMode}" while the selector owns ` +
        `"${renderModeSelect.value}".`
      );
    }
    const modeIsPoints = exactMode === 'points';
    // Smoke draws the live view alone (no view can be kept while it is on),
    // which either layout presents the same way: the person's layout choice
    // stays as it is, so turning smoke on and off changes no view state.
    if (!modeIsPoints && publishLayout && (isLiveViewHidden() || currentActiveViewId() !== LIVE_VIEW_ID)) {
      throw new Error(
        'Smoke render mode requires the visible live view to own focus.'
      );
    }
    viewLayoutModeSelect.value = effectiveLayoutMode();
    splitKeepViewBtn.disabled = !modeIsPoints || !cellsPresent;
    splitKeepViewBtn.title = !cellsPresent
      ? openADatasetTo('keep views')
      : modeIsPoints
        ? 'Freeze the current view as a panel'
        : 'Switch to “Points” mode to keep views';
    setControlAvailability(viewLayoutModeSelect, modeIsPoints
      ? null
      : 'volumetric smoke draws one view; switch Render mode to Points to lay out views');
  }

  /**
   * A view of no cells cannot be kept, so Keep view follows the runtime.
   *
   * @param {boolean} present
   */
  function setCellsPresent(present) {
    if (typeof present !== 'boolean') {
      throw new TypeError('View-control cell presence must be one boolean.');
    }
    if (destroyed) return;
    cellsPresent = present;
    syncRenderModeState(requireRenderMode(renderModeSelect.value), false);
  }

  function syncRenderModeUI(mode) {
    if (destroyed) return false;
    syncRenderModeState(mode, true);
  }

  function reconcileSplitViewUI(notifyActiveView) {
    if (typeof notifyActiveView !== 'boolean') {
      throw new TypeError(
        'Split-view reconciliation notification ownership must be one exact boolean.'
      );
    }
    const renderMode = requireRenderMode(renderModeSelect.value);
    const modeIsPoints = renderMode === 'points';
    const snapshots = requireCurrentInventory();
    state.syncSnapshotContexts(snapshotIds(snapshots));

    const hasSnaps = snapshots.length > 0;
    const hasMultipleViews = snapshots.length > 0;
    splitViewBadgesBox.hidden = !hasMultipleViews;
    layoutRow.hidden = !hasMultipleViews;
    syncActiveViewSelectOptions();

    syncRenderModeState(renderMode, false);
    splitClearBtn.disabled = !hasSnaps;
    splitClearBtn.title = hasSnaps ? 'Remove all kept views' : 'No kept views to remove.';
    // Smoke draws one view: while views are kept its choice is off and says
    // why, as Keep view is off in smoke (`setting.set` gives the reason).
    const smokeChoice = Array.from(renderModeSelect.options).find(option => option.value === 'smoke');
    if (smokeChoice !== undefined) setControlAvailability(smokeChoice, hasSnaps ? SMOKE_NEEDS_ONE_VIEW : null);
    // Keep the button state in sync when linking or the views change
    // programmatically (e.g., session restore).
    updateCameraLockUI();

    if (!modeIsPoints && isLiveViewHidden()) {
      viewer.setLiveViewHidden(false);
    }

    activateView(
      modeIsPoints ? currentActiveViewId() : LIVE_VIEW_ID,
      notifyActiveView
    );
    pushViewLayoutToViewer();
  }

  function updateSplitViewUI() {
    if (destroyed) return false;
    reconcileSplitViewUI(true);
  }

  /**
   * Keep the active view as a new panel and select it.
   * @returns {string} the kept view's id
   */
  function keepView() {
    if (requireRenderMode(renderModeSelect.value) !== 'points') {
      throw new ActionRefused('Views can be kept in the Points render mode only; switch Render mode to Points first.');
    }
    if (!cellsPresent) {
      throw new ActionRefused(noDatasetOpenTo('keep a view'));
    }
    const sourceViewId = currentActiveViewId();
    const sourceLayoutMode = currentLayoutMode();
    const payload = requireSnapshotPayload(state.getSnapshotPayload());
    let createdId = null;
    try {
      const snapshotConfig = {
        label: payload.label,
        fieldKey: payload.fieldKey,
        fieldKind: payload.fieldKind,
        colors: payload.colors,
        transparency: payload.transparency,
        centroidPositions: payload.centroidPositions,
        centroidColors: payload.centroidColors,
        dimensionLevel: payload.dimensionLevel,
        sourceViewId,
        meta: { filtersText: [...payload.filtersText] },
        cameraState: viewer.getViewCameraState(sourceViewId),
      };

      const created = publishSnapshotView({
        state,
        viewer,
        config: snapshotConfig,
      });
      createdId = requireViewId(created.id, 'Created snapshot id');
      activateView(createdId);
      // A kept view is shown beside the others.
      pushViewLayoutToViewer('grid');
      renderSplitViewBadges();
      updateSplitViewUI();
      return createdId;
    } catch (error) {
      const rollbackFailures = [];
      const rollback = operation => {
        try {
          operation();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      };
      if (createdId !== null) {
        rollback(() => retireSnapshotView({
          state,
          viewer,
          snapshotId: createdId,
        }));
      }
      rollback(() => {
        const restoredViewId = state.setActiveView(sourceViewId);
        if (restoredViewId !== sourceViewId) {
          throw new Error(
            `State did not restore source view "${sourceViewId}".`
          );
        }
      });
      rollback(() => viewer.setViewLayout(sourceLayoutMode, sourceViewId));
      rollback(() => syncFromStateAndViewer(true));
      throw rollbackFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...rollbackFailures],
            'Kept-view creation failed and rollback was incomplete.'
          );
    }
  }

  /**
   * Give the kept view `viewId` what the selected view shows at the last
   * step of the branch `branch` of the history shown (its coloring,
   * filters, hidden cells and camera): each per-view domain's value with
   * that view's entry taken from the branch's last step, put back through
   * the domain's owner. What the branch names that the state shown now lacks
   * (a field made on that branch only) is refused, naming it, and the kept
   * view goes with the failed action. `signal`: the action's (its Stop): a
   * field read for it ends with it, and the kept view goes as with a failure.
   */
  async function showBranchIn(viewId, branch, signal) {
    const history = getCurrentHistory();
    if (history === null || history.active === null) {
      throw new ActionRefused('The history of this dataset has not started; there is no branch to keep a view of.', { code: 'unavailable' });
    }
    const tip = history.tipNamed(branch);
    const selected = history.valueAt(tip, 'views').focus;
    const position = [LIVE_VIEW_ID, ...viewer.getSnapshotViews().map(snapshot => snapshot.id)].indexOf(viewId);
    const domains = getStateDomains();
    for (const id of PER_VIEW_DOMAINS) {
      throwIfAborted(signal);
      const owner = domains.owner(id);
      const now = await owner.capture();
      const entry = history.valueAt(tip, id).views[selected];
      await owner.restore({ ...now, views: now.views.map((value, index) => (index === position ? entry : value)) }, { signal });
    }
    throwIfAborted(signal);
  }

  /**
   * Remove every kept view; the live view shows alone.
   * @returns {number} the views removed
   */
  function clearViews() {
    const removed = requireSnapshotInventory(viewer).length;
    if (removed === 0) {
      throw new ActionRefused('There are no kept views to remove.');
    }
    clearPublishedSnapshotViews({ state, viewer });
    // `clearPublishedSnapshotViews()` already returned the DataState's active
    // view to the live view and the viewer's live view to visible; this only
    // has to publish the layout the cleared interface uses.
    activateView(LIVE_VIEW_ID);
    pushViewLayoutToViewer('grid');
    renderSplitViewBadges();
    updateSplitViewUI();
    return removed;
  }

  /** Lay the views out side by side or show the selected one alone. */
  function setLayout(layoutMode) {
    const exactMode = requireLayoutMode(layoutMode);
    if (exactMode === 'grid' && requireRenderMode(renderModeSelect.value) !== 'points') {
      throw new ActionRefused('The Smoke render mode shows one view; switch Render mode to Points to show views side by side.');
    }
    pushViewLayoutToViewer(exactMode);
    renderSplitViewBadges();
    updateSplitViewUI();
  }

  function setCamerasLinked(linked) {
    viewer.setCamerasLocked(requireBoolean(linked, 'Camera link'));
    renderSplitViewBadges();
    callbacks.onNavigationUiSyncRequested(currentActiveViewId());
  }

  /**
   * The open cells among `cells` (original positions), as the ascending,
   * duplicate-free cell list the visibility mask takes.
   */
  function openCellList(cells) {
    let positions;
    try {
      ({ positions } = state.cellIdentity.fromOriginal(cells));
    } catch (error) {
      if (error instanceof RangeError) throw new ActionRefused(error.marked ?? error.message);
      throw error;
    }
    let unique = 0;
    for (let index = 0; index < positions.length; index++) {
      if (index === 0 || positions[index] !== positions[index - 1]) positions[unique++] = positions[index];
    }
    return unique === positions.length ? positions : positions.slice(0, unique);
  }

  function setCellVisibility(cells, visible) {
    if (!Number.isSafeInteger(state.pointCount) || state.pointCount === 0) {
      throw new ActionRefused(noDatasetOpenTo('hide or show cells'));
    }
    const exactVisible = requireBoolean(visible, 'Cell visibility');
    if (cells === null) {
      state.setCellVisibility(null, exactVisible);
      return { cells: state.pointCount, not_open: 0 };
    }
    const positions = openCellList(cells);
    const named = new Set(cells).size;
    if (positions.length === 0) {
      // Said, so a host or an agent learns why nothing changed.
      throw new ActionRefused(
        `None of the ${formatCountOf(named, 'cell')} named is open in this subsample.`,
        { code: 'not-open' }
      );
    }
    state.setCellVisibility(positions, exactVisible);
    return { cells: positions.length, not_open: named - positions.length };
  }

  function focusViewFromOverlay(viewId) {
    const newViewId = requireViewId(viewId, 'Focused view id');
    const snapshots = requireSnapshotInventory(viewer);
    if (
      newViewId !== LIVE_VIEW_ID &&
      !snapshots.some(snapshot => snapshot.id === newViewId)
    ) {
      throw new RangeError(`Focused view "${newViewId}" does not exist.`);
    }
    if (isLiveViewHidden() && newViewId === LIVE_VIEW_ID) {
      throw new RangeError('A hidden live view cannot receive focus.');
    }
    const viewChanged = currentActiveViewId() !== newViewId;

    if (viewChanged) {
      const publishedViewId = state.setActiveView(newViewId);
      if (publishedViewId !== newViewId) {
        throw new Error(
          `State did not publish focused view "${newViewId}".`
        );
      }
    }

    syncActiveViewSelectOptions();
    renderSplitViewBadges();
    updateSplitViewUI();

    if (viewChanged) {
      callbacks.onActiveViewChanged(newViewId);
      callbacks.onNavigationUiSyncRequested(newViewId);
    }
  }

  // A click on a pane: the viewer focused it already, so the selection is
  // recorded by observation, synchronously, once the sidebar follows.
  const handleViewFocus = viewId => {
    runUiAction('View focus failed', () => {
      focusViewFromOverlay(viewId);
      getActions()
        .recordObserved('view.focus', { view: viewNameOf(viewer, viewId) }, {}, withViewLabel(viewLabelOf(viewer, viewId), null))
        .catch(error => console.error('[ViewControls] View focus could not be recorded.', error));
    });
  };
  viewer.setViewFocusHandler(handleViewFocus);

  const handleKeepViewClick = () => {
    if (destroyed) return;
    void dispatchFromControl('view.keep', {}, { failure: 'Keep view failed', category: 'render' });
  };
  const handleClearViewsClick = () => {
    if (destroyed) return;
    void dispatchFromControl('view.clear', {}, { failure: 'Clear views failed', category: 'render' });
  };
  const handleCameraLockClick = () => {
    if (destroyed) return;
    void dispatchFromControl(
      'view.cameras.link',
      { linked: !requireBoolean(viewer.getCamerasLocked(), 'Viewer camera lock') },
      { failure: 'Camera lock change failed', category: 'render' }
    );
  };
  splitKeepViewBtn.addEventListener('click', handleKeepViewClick);
  splitClearBtn.addEventListener('click', handleClearViewsClick);
  cameraLockBtn.addEventListener('click', handleCameraLockClick);
  updateCameraLockUI();
  const handleLayoutModeChange = () => {
    if (destroyed) return;
    const layout = viewLayoutModeSelect.value;
    void dispatchFromControl(
      'view.layout.set',
      { layout },
      { failure: 'View layout change failed', category: 'render' }
    ).then(result => {
      // Not applied: the selector shows the layout the views have.
      if (result === null && !destroyed) viewLayoutModeSelect.value = effectiveLayoutMode();
    });
  };
  viewLayoutModeSelect.addEventListener(
    'change',
    handleLayoutModeChange
  );

  // The actions these controls implement (`definitions/views.js`).
  const actions = getActions();
  const withdrawals = [
    actions.provide('view.keep', async ({ branch, name }, { signal }) => {
      const label = name === undefined ? null : checkViewLabel(name);
      const keptId = inAction('Keep view failed', () => {
        const id = keepView();
        if (label !== null) {
          viewer.setViewName(id, label);
          renderSplitViewBadges();
        }
        return id;
      });
      if (branch !== undefined) await showBranchIn(keptId, branch, signal);
      return { view: viewNameOf(viewer, keptId) };
    }),
    actions.provide('view.remove', ({ view }) => inAction('View removal failed', () => {
      const viewId = resolveViewName(viewer, view);
      // Read before it goes: the step names the view it removed.
      const label = viewLabelOf(viewer, viewId);
      if (viewId === LIVE_VIEW_ID) removeLiveView();
      else removeSnapshotView(viewId);
      return withViewLabel(label, { view });
    })),
    actions.provide('view.rename', ({ view, name }) => inAction('Naming the view failed', () => {
      const viewId = resolveViewName(viewer, view);
      const label = name === null ? null : checkViewLabel(name);
      const was = viewLabelOf(viewer, viewId);
      viewer.setViewName(viewId, label);
      renderSplitViewBadges();
      return was === null ? { view } : { view, was };
    })),
    actions.provide('view.clear', () => inAction('Clear views failed', () => ({ views: clearViews() }))),
    actions.provide('view.layout.set', ({ layout }) => inAction('View layout change failed', () => {
      setLayout(layout);
      return { layout };
    })),
    actions.provide('view.focus', ({ view }) => inAction('View selection failed', () => {
      const viewId = resolveViewName(viewer, view);
      selectView(viewId);
      return withViewLabel(viewLabelOf(viewer, viewId), { view });
    })),
    actions.provide('view.cameras.link', ({ linked }) => inAction('Camera lock change failed', () => {
      setCamerasLinked(linked);
      return { linked };
    })),
    actions.provide('cells.visibility.set', ({ cells, visible }) => inAction(
      'Cell visibility change failed',
      () => setCellVisibility(cells, visible)
    )),
  ];

  renderSplitViewBadges();
  updateSplitViewUI();

  function syncFromStateAndViewer(forceActiveViewNotification = false) {
    if (destroyed) {
      throw new Error('View controls are unavailable after destroy().');
    }
    if (typeof forceActiveViewNotification !== 'boolean') {
      throw new TypeError(
        'View reconciliation notification ownership must be one exact boolean.'
      );
    }
    const previousActiveViewId = currentActiveViewId();
    const snapshots = requireSnapshotInventory(viewer);
    const snapshotIdSet = new Set(
      snapshots.map(snapshot => snapshot.id)
    );
    const liveViewHidden = isLiveViewHidden();
    const activeViewExists =
      previousActiveViewId === LIVE_VIEW_ID ||
      snapshotIdSet.has(previousActiveViewId);
    if (
      !activeViewExists ||
      (liveViewHidden && previousActiveViewId === LIVE_VIEW_ID)
    ) {
      const nextActiveViewId =
        liveViewHidden && snapshots.length > 0
          ? snapshots[0].id
          : LIVE_VIEW_ID;
      const publishedViewId = state.setActiveView(nextActiveViewId);
      if (publishedViewId !== nextActiveViewId) {
        throw new Error(
          `State did not reconcile active view "${nextActiveViewId}".`
        );
      }
    }
    reconcileSplitViewUI(false);
    // Reconciliation publishes the corrected focus/layout first so badges
    // cannot retain a camera marker for a snapshot that was just retired.
    renderSplitViewBadges();
    const activeViewId = currentActiveViewId();
    if (
      forceActiveViewNotification ||
      activeViewId !== previousActiveViewId
    ) {
      callbacks.onActiveViewChanged(activeViewId);
    }
  }

  return {
    renderSplitViewBadges,
    describeViewPosition,
    setCellsPresent,
    syncRenderModeUI,
    updateSplitViewUI,
    syncFromStateAndViewer,
    destroy() {
      if (destructionPromise !== null) return destructionPromise;
      destroyed = true;
      const failures = [];
      const cleanup = operation => {
        try {
          operation();
        } catch (error) {
          failures.push(error);
        }
      };
      cleanup(() => {
        splitKeepViewBtn.removeEventListener('click', handleKeepViewClick);
      });
      cleanup(() => {
        splitClearBtn.removeEventListener('click', handleClearViewsClick);
      });
      cleanup(() => {
        cameraLockBtn.removeEventListener('click', handleCameraLockClick);
      });
      cleanup(() => {
        splitViewBadges.removeEventListener('dblclick', handleBadgeDoubleClick);
      });
      cleanup(() => {
        viewLayoutModeSelect.removeEventListener(
          'change',
          handleLayoutModeChange
        );
      });
      for (const withdraw of withdrawals) cleanup(withdraw);
      cleanup(() => splitViewBadges.replaceChildren());
      if (viewerNeedsUiRetirement(viewer)) {
        cleanup(() => viewer.setViewFocusHandler(() => {}));
      }
      destructionPromise = Promise.resolve()
        .then(() => {
          const exactFailures = [...new Set(failures)];
          if (exactFailures.length === 1) throw exactFailures[0];
          if (exactFailures.length > 1) {
            throw new AggregateError(
              exactFailures,
              'View-control teardown was incomplete.'
            );
          }
        });
      return destructionPromise;
    },
  };
}
