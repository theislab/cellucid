/**
 * Whether UI teardown still needs to retire viewer-side callbacks and modes.
 *
 * Viewer disposal and WebGL context loss both terminalize the viewer's own
 * callback, input, and renderer graph. UI owners must still release their DOM
 * listeners and asynchronous work, but repeating viewer mutations after that
 * boundary is both unnecessary and intentionally rejected by the viewer.
 * Optional diagnostics preserve the existing exact fake-viewer contracts in
 * focused unit tests while production viewers publish both methods.
 *
 * @param {object} viewer
 * @returns {boolean}
 */
export function viewerNeedsUiRetirement(viewer) {
  return (
    viewer?.isDisposed?.() !== true
    && viewer?.isContextLost?.() !== true
  );
}
