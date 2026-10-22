/**
 * Pure geometry for the presented area: the part of the canvas the sidebar
 * does not cover. The sidebar owner measures it (computeLeftOcclusionRatio)
 * and the viewer lays every pane out inside it (presented-view-layout.js);
 * applyHorizontalProjectionCenter shifts a pane's projection so its
 * principal point sits at the centre of what the pane presents.
 */

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be one plain object.`);
  }
  return value;
}

function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be one finite number.`);
  }
  return value;
}

/**
 * Convert sidebar layout geometry to the fraction of the canvas covered from
 * its left edge. Geometry is captured by the UI owner, never by the renderer:
 * `sidebarLeft`/`sidebarWidth` are the sidebar's layout box (without its
 * open/close slide transform), and `sidebarVisible` is false when the sidebar
 * occludes nothing: closed and settled, or the full-screen phone sheet, which
 * the user closes to reach the plot.
 */
export function computeLeftOcclusionRatio(options) {
  const exact = assertPlainObject(options, 'Sidebar occlusion geometry');
  const canvasLeft = assertFiniteNumber(exact.canvasLeft, 'Canvas left');
  const canvasWidth = assertFiniteNumber(exact.canvasWidth, 'Canvas width');
  const sidebarLeft = assertFiniteNumber(exact.sidebarLeft, 'Sidebar left');
  const sidebarWidth = assertFiniteNumber(exact.sidebarWidth, 'Sidebar width');
  if (typeof exact.sidebarVisible !== 'boolean') {
    throw new TypeError('Sidebar visibility must be one boolean.');
  }
  if (canvasWidth <= 0) {
    throw new RangeError('Canvas width must be positive.');
  }
  if (sidebarWidth < 0) {
    throw new RangeError('Sidebar width must not be negative.');
  }
  if (!exact.sidebarVisible) return 0;

  const sidebarRightInCanvas = sidebarLeft + sidebarWidth - canvasLeft;
  return Math.max(0, Math.min(1, sidebarRightInCanvas / canvasWidth));
}

/**
 * Shift a standard perspective matrix so a point on the view axis (the
 * principal point) projects to the requested horizontal NDC coordinate.
 */
export function applyHorizontalProjectionCenter(projectionMatrix, centerNdcX) {
  if (
    !(projectionMatrix instanceof Float32Array) ||
    projectionMatrix.length !== 16
  ) {
    throw new TypeError('Projection matrix must be one 16-element Float32Array.');
  }
  assertFiniteNumber(centerNdcX, 'Projection center NDC X');
  if (centerNdcX < 0 || centerNdcX >= 1) {
    throw new RangeError(
      'Projection center NDC X must be between 0 and less than 1.',
    );
  }
  projectionMatrix[8] = centerNdcX === 0 ? 0 : -centerNdcX;
  return projectionMatrix;
}
