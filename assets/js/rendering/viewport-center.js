/**
 * Pure geometry for keeping target-based cameras centered in the canvas area
 * that is not covered by the sidebar.
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

function assertRatio(value, label, allowOne = true) {
  if (typeof allowOne !== 'boolean') {
    throw new TypeError('Ratio upper-bound ownership must be one boolean.');
  }
  assertFiniteNumber(value, label);
  const upperBoundValid = allowOne ? value <= 1 : value < 1;
  if (value < 0 || !upperBoundValid) {
    throw new RangeError(
      `${label} must be between 0 and ${allowOne ? '1' : 'less than 1'}.`,
    );
  }
  return value;
}

/**
 * Convert sidebar layout geometry to the fraction of the canvas covered from
 * its left edge. Geometry is captured by the UI owner, never by the renderer.
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
 * Return the horizontal NDC coordinate where the pane's camera target should
 * appear. `null` means the pane is completely occluded.
 */
export function computePaneCenterNdcX(
  paneLeftRatio,
  paneWidthRatio,
  leftOcclusionRatio
) {
  const exactPaneLeftRatio = assertRatio(
    paneLeftRatio,
    'Pane left ratio',
    false,
  );
  const exactPaneWidthRatio = assertFiniteNumber(
    paneWidthRatio,
    'Pane width ratio',
  );
  const exactLeftOcclusionRatio = assertRatio(
    leftOcclusionRatio,
    'Left occlusion ratio',
  );
  if (exactPaneWidthRatio <= 0 || exactPaneWidthRatio > 1) {
    throw new RangeError('Pane width ratio must be greater than 0 and at most 1.');
  }
  const paneRightRatio = exactPaneLeftRatio + exactPaneWidthRatio;
  if (paneRightRatio > 1) {
    throw new RangeError('Viewport pane must remain within canvas bounds.');
  }

  const visibleLeftRatio = Math.max(
    exactPaneLeftRatio,
    exactLeftOcclusionRatio
  );
  if (visibleLeftRatio >= paneRightRatio) return null;
  return (visibleLeftRatio - exactPaneLeftRatio) / exactPaneWidthRatio;
}

/**
 * Shift a standard perspective matrix so a target on the view axis projects
 * to the requested horizontal NDC coordinate.
 */
export function applyHorizontalProjectionCenter(projectionMatrix, centerNdcX) {
  if (
    !(projectionMatrix instanceof Float32Array) ||
    projectionMatrix.length !== 16
  ) {
    throw new TypeError('Projection matrix must be one 16-element Float32Array.');
  }
  const exactCenter = assertRatio(
    centerNdcX,
    'Projection center NDC X',
    false,
  );
  projectionMatrix[8] = exactCenter === 0 ? 0 : -exactCenter;
  return projectionMatrix;
}
