/**
 * What the viewer presents, decided from options alone.
 *
 * `resolvePresentedLayout` turns the canvas size, the sidebar's left
 * occlusion, and a requested layout into the exact ordered pane list
 * (`getPresentedPane` / `getPresentedPaneAtCssPoint` look panes up), and
 * `selectPresentedCameraState` picks the camera one pane is presented with;
 * all are pure functions of their arguments, so the same options always
 * resolve to the same presentation and a caller can compute a presentation
 * without a viewer.
 *
 * `runSynchronousBorrowedViewDataCallback` is the ownership boundary those
 * answers are handed across: it runs one caller callback strictly
 * synchronously and re-validates ownership before any result, thenable or
 * failure can escape.
 */

import { cloneCameraState } from '../camera-state-contract.js';
import {
  assertExactBoolean,
  assertExactFunction,
  assertViewId
} from './viewer-contracts.js';

/**
 * Execute one borrowed-data callback inside a strictly synchronous ownership
 * boundary. The caller-supplied validator runs before any result can escape,
 * including callback failures and hostile thenable getters.
 *
 * @param {Function} callback
 * @param {Object} payload
 * @param {Function} validateCurrent
 * @returns {*}
 */
export function runSynchronousBorrowedViewDataCallback(
  callback,
  payload,
  validateCurrent
) {
  const exactCallback = assertExactFunction(
    callback,
    'Borrowed-view-data callback'
  );
  const exactValidator = assertExactFunction(
    validateCurrent,
    'Borrowed-view-data validator'
  );
  let result;
  let callbackFailed = false;
  let callbackError;
  try {
    result = exactCallback(payload);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  if (callbackFailed) {
    try {
      exactValidator();
    } catch (validationError) {
      throw new AggregateError(
        [callbackError, validationError],
        'Borrowed-view-data callback failed while its ownership also changed.'
      );
    }
    throw callbackError;
  }

  let resultBoundaryError = null;
  try {
    const thenable = (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof result.then === 'function'
    );
    if (thenable) {
      resultBoundaryError = new TypeError(
        'Borrowed-view-data callback must complete synchronously and must not return a Promise or thenable.'
      );
    }
  } catch (error) {
    resultBoundaryError = error;
  }
  let validationError = null;
  try {
    exactValidator();
  } catch (error) {
    validationError = error;
  }
  if (resultBoundaryError !== null && validationError !== null) {
    throw new AggregateError(
      [resultBoundaryError, validationError],
      'Borrowed-view-data result failed while its ownership also changed.'
    );
  }
  if (validationError !== null) throw validationError;
  if (resultBoundaryError !== null) throw resultBoundaryError;
  return result;
}


function assertPositiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be one positive finite number.`);
  }
  return value;
}

/**
 * Number of grid columns for one pane count: 1-3 panes sit side by side,
 * more panes fill the smallest square-ish grid.
 *
 * @param {number} viewCount
 * @returns {number}
 */
export function getPresentedGridColumns(viewCount) {
  if (!Number.isSafeInteger(viewCount) || viewCount <= 0) {
    throw new RangeError('Presented grid view count must be a positive safe integer.');
  }
  return viewCount <= 3 ? viewCount : Math.ceil(Math.sqrt(viewCount));
}

/**
 * Lay out every presented pane inside the presented area.
 *
 * The presented area is the part of the canvas the sidebar does not cover:
 * everything right of `leftOcclusionRatio` (a fraction of the canvas width,
 * published by the sidebar owner). It is the one source of truth for where a
 * view is on screen; rendering, picking, every highlight tool, projectiles,
 * title chips, centroid labels, and presented-state capture all read the
 * panes resolved here.
 *
 * - Grid multiview divides the presented area into equal integer
 *   framebuffer cells, so no cell lies under the sidebar and every cell has
 *   exactly the same area. Each cell renders with a symmetric projection.
 * - A single view keeps rendering the whole canvas (the scene continues
 *   behind the sidebar), but its projection is shifted so the principal
 *   point - the camera target in Orbit/Planar, the look direction in
 *   Free-fly - sits at the centre of the presented area.
 *
 * Every pane carries two rectangles in canvas-local CSS pixels (top-left
 * origin): `css*`, the rectangle the pane renders into and the one its
 * projection maps NDC onto, and `visibleCss*`, the part of it that is
 * presented. They coincide for grid cells.
 *
 * @param {{
 *   canvasHeight: number,
 *   canvasWidth: number,
 *   cssHeight: number,
 *   cssWidth: number,
 *   focusedViewId: string,
 *   leftOcclusionRatio: number,
 *   mode: 'single'|'grid',
 *   viewIds: string[]
 * }} options
 * @returns {Object} frozen layout
 */
export function resolvePresentedLayout(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError(
      'Presented layout requires one exact options object.'
    );
  }
  const {
    canvasHeight,
    canvasWidth,
    focusedViewId,
    mode,
    viewIds
  } = options;
  if (
    !Number.isSafeInteger(canvasWidth) ||
    canvasWidth <= 0 ||
    !Number.isSafeInteger(canvasHeight) ||
    canvasHeight <= 0
  ) {
    throw new TypeError(
      'Presented-view canvas dimensions must be positive safe integers.'
    );
  }
  const cssWidth = assertPositiveFinite(options.cssWidth, 'Presented CSS width');
  const cssHeight = assertPositiveFinite(options.cssHeight, 'Presented CSS height');
  const leftOcclusionRatio = options.leftOcclusionRatio;
  if (
    typeof leftOcclusionRatio !== 'number' ||
    !(leftOcclusionRatio >= 0 && leftOcclusionRatio <= 1)
  ) {
    throw new RangeError(
      'Presented left occlusion ratio must be a number between 0 and 1.'
    );
  }
  if (mode !== 'single' && mode !== 'grid') {
    throw new TypeError(
      'Presented-view layout mode must be exactly "single" or "grid".'
    );
  }
  const exactFocusedViewId = assertViewId(focusedViewId);
  if (
    !Array.isArray(viewIds) ||
    viewIds.length === 0 ||
    viewIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(viewIds).size !== viewIds.length
  ) {
    throw new TypeError(
      'Presented-view inventory must contain unique non-empty view IDs.'
    );
  }

  const scaleX = cssWidth / canvasWidth;
  const scaleY = cssHeight / canvasHeight;
  const viewCount = viewIds.length;
  const gridMultiview = mode === 'grid' && viewCount > 1;
  const cols = gridMultiview ? getPresentedGridColumns(viewCount) : 1;
  const rows = gridMultiview ? Math.ceil(viewCount / cols) : 1;

  // The presented area always keeps at least one framebuffer pixel per
  // column, so a sidebar that covers (nearly) the whole canvas degrades to
  // narrow panes instead of an invalid layout.
  const maximumLeft = canvasWidth - cols;
  if (maximumLeft < 0 || canvasHeight < rows) {
    throw new RangeError(
      'Presented-view grid panes must have positive framebuffer dimensions.'
    );
  }

  const panes = [];
  let presentedCssLeft;
  if (!gridMultiview) {
    const viewIndex = viewIds.indexOf(exactFocusedViewId);
    if (viewIndex < 0) {
      throw new RangeError(
        `Focused view "${exactFocusedViewId}" is absent from the presented render inventory.`
      );
    }
    // NDC x of the presented area's centre inside the full-canvas pane: the
    // centre of [ratio, 1] in [0, 1] maps to NDC `ratio`.
    const projectionCenterNdcX = Math.min(
      leftOcclusionRatio,
      maximumLeft / canvasWidth
    );
    presentedCssLeft = projectionCenterNdcX * cssWidth;
    panes.push(Object.freeze({
      col: 0,
      cssHeight,
      cssLeft: 0,
      cssTop: 0,
      cssWidth,
      projectionCenterNdcX,
      row: 0,
      scissorEnabled: false,
      viewId: exactFocusedViewId,
      viewIndex,
      viewportHeight: canvasHeight,
      viewportWidth: canvasWidth,
      viewportX: 0,
      viewportY: 0,
      visibleCssHeight: cssHeight,
      visibleCssLeft: presentedCssLeft,
      visibleCssTop: 0,
      visibleCssWidth: cssWidth - presentedCssLeft
    }));
  } else {
    // Cells start on the first framebuffer column fully right of the sidebar
    // edge. The epsilon absorbs ratio round-off so an exact pixel edge does
    // not skip a column.
    const presentedLeft = Math.min(
      maximumLeft,
      Math.max(0, Math.ceil(leftOcclusionRatio * canvasWidth - 1e-6))
    );
    presentedCssLeft = presentedLeft * scaleX;
    const cellWidth = Math.floor((canvasWidth - presentedLeft) / cols);
    const cellHeight = Math.floor(canvasHeight / rows);
    for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
      const col = viewIndex % cols;
      const row = Math.floor(viewIndex / cols);
      const viewportX = presentedLeft + col * cellWidth;
      const topY = row * cellHeight;
      const cssLeft = viewportX * scaleX;
      const cssTop = topY * scaleY;
      const paneCssWidth = cellWidth * scaleX;
      const paneCssHeight = cellHeight * scaleY;
      panes.push(Object.freeze({
        col,
        cssHeight: paneCssHeight,
        cssLeft,
        cssTop,
        cssWidth: paneCssWidth,
        projectionCenterNdcX: 0,
        row,
        scissorEnabled: true,
        viewId: viewIds[viewIndex],
        viewIndex,
        viewportHeight: cellHeight,
        viewportWidth: cellWidth,
        viewportX,
        // WebGL viewports are bottom-origin.
        viewportY: canvasHeight - topY - cellHeight,
        visibleCssHeight: paneCssHeight,
        visibleCssLeft: cssLeft,
        visibleCssTop: cssTop,
        visibleCssWidth: paneCssWidth
      }));
    }
  }

  return Object.freeze({
    canvasHeight,
    canvasWidth,
    cols,
    cssHeight,
    cssWidth,
    gridMultiview,
    layoutMode: mode,
    leftOcclusionRatio,
    panes: Object.freeze(panes),
    presentedArea: Object.freeze({
      cssHeight,
      cssLeft: presentedCssLeft,
      cssTop: 0,
      cssWidth: cssWidth - presentedCssLeft
    }),
    rows,
    viewCount
  });
}

/**
 * Return the pane presenting one view in a resolved layout.
 *
 * @param {Object} layout from resolvePresentedLayout()
 * @param {string} viewId
 * @returns {Object} frozen pane
 */
export function getPresentedPane(layout, viewId) {
  const exactViewId = assertViewId(viewId);
  if (
    layout === null ||
    typeof layout !== 'object' ||
    !Array.isArray(layout.panes)
  ) {
    throw new TypeError('Presented pane lookup requires one resolved layout.');
  }
  for (const pane of layout.panes) {
    if (pane.viewId === exactViewId) return pane;
  }
  throw new RangeError(
    `View "${exactViewId}" is not presented in the current ${layout.layoutMode} layout.`
  );
}

/**
 * Return the pane under one canvas-local CSS point, or null when the point
 * is outside every presented pane. Grid points left of the first column,
 * right of the last, or below the last row snap to the nearest cell, so a
 * drag that strays past a pane edge stays owned by that pane; an empty grid
 * slot (fewer views than cells) returns null.
 *
 * @param {Object} layout from resolvePresentedLayout()
 * @param {number} cssX canvas-local CSS x
 * @param {number} cssY canvas-local CSS y
 * @returns {Object|null}
 */
export function getPresentedPaneAtCssPoint(layout, cssX, cssY) {
  if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) {
    throw new TypeError('Presented pane hit testing requires a finite point.');
  }
  if (!layout.gridMultiview) return layout.panes[0];
  const first = layout.panes[0];
  const col = Math.max(
    0,
    Math.min(
      layout.cols - 1,
      Math.floor((cssX - first.cssLeft) / first.cssWidth)
    )
  );
  const row = Math.max(
    0,
    Math.min(layout.rows - 1, Math.floor(cssY / first.cssHeight))
  );
  return layout.panes[row * layout.cols + col] ?? null;
}

/**
 * Select the camera owner used by the actual point render for one pane.
 * The focused pane, and every pane linked to its camera (same representation,
 * cameras linked), consumes the current global camera; any other grid pane
 * consumes its stored per-view camera.
 *
 * @param {{
 *   followsFocusedCamera: boolean,
 *   globalCameraState: Object,
 *   gridMultiview: boolean,
 *   storedCameraState: Object|null,
 *   viewId: string
 * }} options
 * @returns {Object} caller-owned camera state
 */
export function selectPresentedCameraState(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError(
      'Presented-view camera selection requires one exact options object.'
    );
  }
  const exactViewId = assertViewId(options.viewId);
  const follows = assertExactBoolean(
    options.followsFocusedCamera,
    'Presented-view camera following'
  );
  const gridMultiview = assertExactBoolean(
    options.gridMultiview,
    'Presented-view grid ownership'
  );
  const useStored = gridMultiview && !follows;
  const selected = useStored
    ? options.storedCameraState
    : options.globalCameraState;
  return cloneCameraState(
    selected,
    `Presented camera state for view "${exactViewId}"`
  );
}
