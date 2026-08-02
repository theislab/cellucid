/**
 * What the viewer presents, decided from options alone.
 *
 * `resolvePresentedViewLayout` turns a requested layout into the exact ordered
 * pane list, and `selectPresentedCameraState` picks the camera one pane is
 * presented with; both are pure functions of their arguments, so the same
 * options always resolve to the same presentation and a caller can compute a
 * presentation without a viewer.
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

/**
 * Resolve the exact framebuffer pane currently presenting one view.
 *
 * This mirrors the render loop's uniform grid arithmetic, including its
 * integer framebuffer dimensions and bottom-origin WebGL viewport Y.
 *
 * @param {{
 *   canvasHeight: number,
 *   canvasWidth: number,
 *   focusedViewId: string,
 *   mode: 'single'|'grid',
 *   viewId: string,
 *   viewIds: string[]
 * }} options
 * @returns {Object}
 */
export function resolvePresentedViewLayout(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError(
      'Presented-view layout requires one exact options object.'
    );
  }
  const {
    canvasHeight,
    canvasWidth,
    focusedViewId,
    mode,
    viewId,
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
  if (mode !== 'single' && mode !== 'grid') {
    throw new TypeError(
      'Presented-view layout mode must be exactly "single" or "grid".'
    );
  }
  const exactViewId = assertViewId(viewId);
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
  const viewIndex = viewIds.indexOf(exactViewId);
  if (viewIndex < 0) {
    throw new RangeError(
      `View "${exactViewId}" is absent from the presented render inventory.`
    );
  }

  const gridMultiview = mode === 'grid' && viewIds.length > 1;
  if (
    !gridMultiview &&
    viewIds.length > 1 &&
    exactViewId !== exactFocusedViewId
  ) {
    throw new RangeError(
      `View "${exactViewId}" is not presented in single-view layout.`
    );
  }
  if (!gridMultiview) {
    return Object.freeze({
      canvasHeight,
      canvasWidth,
      col: 0,
      cols: 1,
      gridMultiview: false,
      layoutMode: mode,
      paneLeftRatio: 0,
      paneWidthRatio: 1,
      row: 0,
      rows: 1,
      scissorEnabled: false,
      viewCount: viewIds.length,
      viewId: exactViewId,
      viewIndex,
      viewportHeight: canvasHeight,
      viewportWidth: canvasWidth,
      viewportX: 0,
      viewportY: 0
    });
  }

  const viewCount = viewIds.length;
  const cols = viewCount <= 3
    ? viewCount
    : Math.ceil(Math.sqrt(viewCount));
  const rows = Math.ceil(viewCount / cols);
  const viewportWidth = Math.floor(canvasWidth / cols);
  const viewportHeight = Math.floor(canvasHeight / rows);
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    throw new RangeError(
      'Presented-view grid panes must have positive framebuffer dimensions.'
    );
  }
  const col = viewIndex % cols;
  const row = Math.floor(viewIndex / cols);
  return Object.freeze({
    canvasHeight,
    canvasWidth,
    col,
    cols,
    gridMultiview: true,
    layoutMode: mode,
    paneLeftRatio: col / cols,
    paneWidthRatio: 1 / cols,
    row,
    rows,
    scissorEnabled: true,
    viewCount,
    viewId: exactViewId,
    viewIndex,
    viewportHeight,
    viewportWidth,
    viewportX: col * viewportWidth,
    viewportY: (rows - 1 - row) * viewportHeight
  });
}

/**
 * Select the camera owner used by the actual point render for one pane.
 * Focused and camera-locked panes consume the current global camera; only an
 * unlocked, non-focused grid pane consumes its stored per-view camera.
 *
 * @param {{
 *   camerasLocked: boolean,
 *   focusedViewId: string,
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
  const exactFocusedViewId = assertViewId(options.focusedViewId);
  const locked = assertExactBoolean(
    options.camerasLocked,
    'Presented-view camera lock'
  );
  const gridMultiview = assertExactBoolean(
    options.gridMultiview,
    'Presented-view grid ownership'
  );
  const useStored = (
    gridMultiview &&
    !locked &&
    exactViewId !== exactFocusedViewId
  );
  const selected = useStored
    ? options.storedCameraState
    : options.globalCameraState;
  return cloneCameraState(
    selected,
    `Presented camera state for view "${exactViewId}"`
  );
}
