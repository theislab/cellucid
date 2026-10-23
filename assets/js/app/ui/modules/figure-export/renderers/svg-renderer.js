/**
 * @fileoverview SVG renderer for figure export.
 *
 * PURPOSE:
 * Generates publication-quality SVG figures that can be edited in vector
 * graphics software (Illustrator, Inkscape, etc.) for journal submissions.
 *
 * ARCHITECTURE:
 * - Generates SVG as a string (no DOM manipulation) for performance
 * - Supports three explicit export strategies based on editability needs
 * - Maintains vector annotations (axes, legend, title) even in hybrid mode
 *
 * EXPORT STRATEGIES:
 *
 * 1. FULL-VECTOR ('full-vector'):
 *    - All points as SVG <circle> elements
 *    - Best for: Small datasets (<50k points), maximum editability
 *    - Warning: Can produce very large files and slow rendering
 *
 * 2. OPTIMIZED-VECTOR ('optimized-vector'):
 *    - Density-preserving point reduction (viewport-space grid sampling)
 *    - Preserves visual appearance while reducing file size
 *    - Best for: Medium datasets (50k-200k points)
 *
 * 3. HYBRID ('hybrid'):
 *    - Points rasterized as embedded PNG using WebGL shaders
 *    - Annotations remain vector (editable text, crisp at any zoom)
 *    - Best for: Large datasets (>200k) or when 3D shading is important
 *    - Produces WYSIWYG output matching the viewer's 3D appearance
 *
 * LAYOUT SYSTEM (IMPORTANT):
 * The payload.width and payload.height parameters represent the desired PLOT
 * CONTENT size, NOT the total output size. The actual SVG dimensions are
 * EXPANDED to accommodate legend, axes, and title without shrinking the plot.
 *
 * METADATA:
 * SVG files include RDF/Dublin Core metadata with dataset info, export
 * timestamp, and description for archival purposes.
 *
 * CROSS-BROWSER NOTES:
 * - SVG generated as string, no DOM dependencies
 * - Embedded images use base64 data URLs for portability
 * - The requested font-family string is preserved verbatim
 *
 * MAIN THREAD:
 * The page writes the annotations. The figure-export worker
 * (`utils/figure-export-worker.js`) writes the point markup as a Blob
 * (`svg-point-markup.js`), computes the axis bounds, and draws and encodes the
 * Hybrid point raster and the backdrop-look image, so no per-cell pass or
 * encode runs on the page, and the file is assembled from Blob parts without
 * ever being one string.
 *
 * @module ui/modules/figure-export/renderers/svg-renderer
 */

import { escapeXml } from '../../../../utils/dom-utils.js';
import {
  computeSingleViewLayout,
  computeGridDims,
  computeGridPaneLayout,
  LAYOUT_CONSTANTS,
} from '../utils/layout.js';
import { renderSvgAxes } from '../components/axes-builder.js';
import {
  renderSvgLegend,
  resolveSharedGridLegend,
} from '../components/legend-builder.js';
import { renderSvgOrientationIndicator } from '../components/orientation-indicator.js';
import { renderSvgCentroidOverlay } from '../components/centroid-overlay.js';
import {
  buildReferenceGridModel,
  renderSvgReferenceGrid,
  resolveReferenceGridSurface,
} from '../components/reference-grid.js';
import {
  figureDrawsBackdropLook,
  renderBackdropLookForPlot,
  renderSvgBackdropLookImage,
} from '../components/backdrop-look-export.js';
import {
  assertCropRect01,
  cropRect01ToPx,
  fitCropIntoRect,
  planCropRaster,
} from '../utils/crop.js';
import { hashStringToSeed } from '../utils/hash.js';
import {
  openFigureExportWorkerSession,
  pointPassRenderState,
  pointRasterArgs,
  requestPngDataUrl,
  requestVisibleBounds,
} from '../utils/figure-export-worker-client.js';
import { scalePointDiameterToRaster } from '../utils/point-size.js';
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';
import { resolveFigureInk } from '../utils/figure-ink.js';
import { computeLetterboxedRect } from '../utils/letterbox.js';
import { assertCameraState } from '../../../../../rendering/camera-state-contract.js';
import {
  assertFigureExportPayload,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';
import { clamp } from '../../../../utils/number-utils.js';
import {
  buildProvenanceDescription,
  buildProvenanceJson,
  readProvenanceSourceFile,
  readProvenanceViews,
  unanimousFieldKey,
} from '../utils/figure-provenance.js';
import { panelLetter } from '../utils/panel-label.js';
import {
  buildSelectionBadge,
  countHighlightedVisiblePoints,
} from '../utils/selection-badge.js';

function applyExportBackgroundToRenderState(renderState, background, backgroundColor) {
  if (background === 'viewer' || background === 'transparent') return renderState;

  const rgb = hexToRgb01(backgroundColor);
  if (rgb === null) {
    throw new TypeError('SVG export backgroundColor must be an exact #RRGGBB color.');
  }

  return {
    ...renderState,
    fogColor: new Float32Array(rgb),
    bgColor: new Float32Array(rgb),
  };
}

function renderSvgSelectionBadge(badge, fontFamily, fontSize, ink) {
  return (
    `<g font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" fill="${ink.surfaceInk}">` +
    `<rect x="${badge.x}" y="${badge.y}" width="${badge.width}" height="${badge.height}" rx="4" fill="${ink.surface}" fill-opacity="0.85" stroke="${ink.frame}" stroke-width="1"/>` +
    `<text x="${badge.textX}" y="${badge.textY}" stroke="none">${escapeXml(badge.label)}</text>` +
    `</g>`
  );
}

	function buildSvgMetadata(meta, payload) {
	  const dataset = meta?.datasetName || meta?.datasetId || '';
	  const exportedAt = String(meta?.exportedAt || new Date().toISOString());
	  const website = 'https://cellucid.com';
	  const sourceFile = readProvenanceSourceFile(meta);

	  // Every exported panel is described; `colorField` is only claimed when all
	  // of them really carry the same field.
	  const description = buildProvenanceDescription(meta);
	  const colorField = unanimousFieldKey(readProvenanceViews(meta));
	  const json = buildProvenanceJson(meta, payload, 'svg');

	  return `<metadata>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:cellucid="https://cellucid.com/ns#">
    <rdf:Description rdf:about="">
      <dc:creator>Cellucid</dc:creator>
      <dc:publisher>cellucid.com</dc:publisher>
      <dc:relation>${escapeXml(website)}</dc:relation>
      <dc:date>${escapeXml(exportedAt)}</dc:date>
      ${dataset ? `<dc:source>${escapeXml(dataset)}</dc:source>` : ''}
      ${meta?.datasetId ? `<dc:identifier>${escapeXml(String(meta.datasetId))}</dc:identifier>` : ''}
      ${description ? `<dc:description>${escapeXml(description)}</dc:description>` : ''}
      ${colorField ? `<cellucid:colorField>${escapeXml(colorField)}</cellucid:colorField>` : ''}
      ${sourceFile ? `<cellucid:sourceFile>${escapeXml(String(sourceFile))}</cellucid:sourceFile>` : ''}
      <cellucid:json>${escapeXml(json)}</cellucid:json>
    </rdf:Description>
  </rdf:RDF>
</metadata>`;
	}

/**
 * Rasterize points to a data URL for embedding in SVG (hybrid mode).
 *
 * The worker draws the exact WebGL2 point pass for 3D-shaded spheres matching
 * the viewer, places it for a crop, and encodes it.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {object} options
 * @returns {Promise<string>} Base64 data URL of the point pass
 */
async function rasterizePointsToDataUrl(session, {
  positions,
  dimension,
  colors,
  transparency,
  lodMembership = null,
  drawOrder = null,
  renderState,
  plotRect,
  radiusPx,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  crop = null,
  overlayPositions = null,
  overlayColors = null,
  overlayPointDiameterViewportPx = null,
  signal = null
}) {
  throwIfFigureExportAborted(signal);
  if (!positions || !colors) {
    throw new TypeError('SVG Hybrid export requires positions and colors');
  }
  if (!renderState?.mvpMatrix) {
    throw new TypeError('SVG Hybrid export requires a complete renderState');
  }
  if (
    !Number.isFinite(plotRect?.width) ||
    plotRect.width <= 0 ||
    !Number.isFinite(plotRect?.height) ||
    plotRect.height <= 0
  ) {
    throw new TypeError('SVG Hybrid export requires a positive plot rectangle');
  }
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    throw new TypeError('SVG Hybrid export requires a positive point radius');
  }

  const rasterScale = 2;
  const pxW = Math.round(plotRect.width * rasterScale);
  const pxH = Math.round(plotRect.height * rasterScale);
  const crop01 = assertCropRect01(crop);

  const srcViewportW = renderState.viewportWidth;
  const srcViewportH = renderState.viewportHeight;
  if (
    !Number.isFinite(srcViewportW) ||
    srcViewportW <= 0 ||
    !Number.isFinite(srcViewportH) ||
    srcViewportH <= 0
  ) {
    throw new TypeError('SVG Hybrid export requires positive render-state viewport dimensions');
  }
  // Unframed, the raster is the whole plot and letterboxes the whole view.
  // Framed, it is the crop's place in the plot, on whole raster pixels, and
  // draws just the crop at those pixels (see png-renderer.js planPointRaster).
  let rasterPlan;
  if (crop01 === null) {
    rasterPlan = {
      x: 0,
      y: 0,
      width: pxW,
      height: pxH,
      zoom: computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: pxW, dstHeight: pxH }).scale,
      exact: true,
    };
  } else {
    const fitted = fitCropIntoRect({
      crop01,
      viewportWidth: srcViewportW,
      viewportHeight: srcViewportH,
      destRect: { x: 0, y: 0, width: pxW, height: pxH },
    });
    const x = Math.round(fitted.x);
    const y = Math.round(fitted.y);
    const deviceRect = {
      x,
      y,
      width: Math.max(1, Math.round(fitted.x + fitted.width) - x),
      height: Math.max(1, Math.round(fitted.y + fitted.height) - y),
    };
    const zoomLimit = await session.request('spriteZoomLimit', {});
    throwIfFigureExportAborted(signal);
    rasterPlan = {
      ...deviceRect,
      ...planCropRaster({
        crop01,
        viewportWidth: srcViewportW,
        viewportHeight: srcViewportH,
        deviceRect,
        zoomLimit,
      }),
      deviceRect,
    };
  }
  const pointDiameterViewportPx = radiusPx * 2;

  const hasAnyOverlayInput =
    overlayPositions != null ||
    overlayColors != null ||
    overlayPointDiameterViewportPx != null;
  if (
    hasAnyOverlayInput &&
    (!overlayPositions || !overlayColors ||
      !Number.isFinite(overlayPointDiameterViewportPx) ||
      overlayPointDiameterViewportPx <= 0)
  ) {
    throw new TypeError(
      'SVG Hybrid centroid overlay requires positions, colors, and a positive point diameter together'
    );
  }

  const raster = pointRasterArgs(session, {
    positions,
    dimension,
    colors,
    transparency,
    lodMembership,
    drawOrder,
    renderState,
    outputWidthPx: rasterPlan.width,
    outputHeightPx: rasterPlan.height,
    viewRect01: crop01,
    pointSizePx: scalePointDiameterToRaster(
      pointDiameterViewportPx,
      rasterPlan.zoom
    ),
    overlayPoints: hasAnyOverlayInput
      ? {
        positions: overlayPositions,
        colors: overlayColors,
        pointSizePx: scalePointDiameterToRaster(
          overlayPointDiameterViewportPx,
          rasterPlan.zoom
        )
      }
      : null,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity
  });
  // The PNG is stretched over the whole plot rectangle (pxW x pxH is the
  // plot at rasterScale), so a crop's raster sits at its letterboxed place
  // inside it: one to one, unless it was zoomed past the GPU's sprite range
  // (`planCropRaster`).
  const placement = crop01 === null
    ? null
    : {
      canvasWidth: pxW,
      canvasHeight: pxH,
      exact: rasterPlan.exact,
      ...rasterPlan.deviceRect,
    };
  return session.request('rasterizePointsPngDataUrl', { raster, placement });
}

/**
 * The point markup of a Full or Optimized Vector panel, written in the worker.
 *
 * @param {ReturnType<typeof openFigureExportWorkerSession>} session
 * @param {object} options - `writeSvgPointMarkup` options
 * @returns {Promise<Blob>}
 */
function requestSvgPointMarkup(session, {
  positions,
  colors,
  transparency,
  lodMembership,
  drawOrder,
  highlightArray,
  renderState,
  fogRenderState,
  ...rest
}) {
  return session.request('svgPointMarkup', {
    ...rest,
    positions: session.share(positions),
    colors: session.share(colors),
    transparency: session.share(transparency),
    lodMembership: lodMembership === null
      ? null
      : {
        dimensionLevel: lodMembership.dimensionLevel,
        indices: session.share(lodMembership.indices),
        lodLevel: lodMembership.lodLevel,
        pointCount: lodMembership.pointCount,
      },
    drawOrder: session.share(drawOrder),
    highlightArray: session.share(highlightArray),
    renderState: pointPassRenderState(renderState),
    fogRenderState: pointPassRenderState(fogRenderState),
  });
}

/**
 * A backdrop-look raster as the PNG data URL of its `<image>`, encoded in the
 * worker.
 */
async function backdropLookDataUrl(session, lookRaster, signal) {
  const bitmap = await createImageBitmap(lookRaster);
  try {
    throwIfFigureExportAborted(signal);
  } catch (error) {
    bitmap.close();
    throw error;
  }
  return requestPngDataUrl(session, bitmap);
}

/**
 * The SVG file from its parts: strings and the worker's point-markup Blobs.
 * Adjacent strings are joined first, so the bytes are exactly those of the
 * whole document encoded at once.
 */
function svgBlobFromParts(parts) {
  const blobParts = [];
  let text = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      text.push(part);
      continue;
    }
    if (text.length > 0) blobParts.push(text.join(''));
    text = [];
    blobParts.push(part);
  }
  if (text.length > 0) blobParts.push(text.join(''));
  return new Blob(blobParts, { type: 'image/svg+xml' });
}

/**
 * Render figure to SVG blob.
 *
 * IMPORTANT: The payload.width and payload.height are interpreted as the desired
 * PLOT CONTENT size. The actual SVG dimensions will be LARGER to accommodate
 * legend, axes, and title without shrinking the plot area.
 *
 * @param {object} options
 * @param {any} options.payload
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Blob>}
 */
export async function renderFigureToSvgBlob({ payload, signal = null }) {
  throwIfFigureExportAborted(signal);
  assertFigureExportPayload(payload);
  if (payload.format !== 'svg') {
    throw new TypeError('SVG renderer requires payload.format exactly "svg".');
  }
  if (!Number.isInteger(payload?.width) || payload.width <= 0) {
    throw new TypeError('SVG export width must be a positive integer');
  }
  if (!Number.isInteger(payload?.height) || payload.height <= 0) {
    throw new TypeError('SVG export height must be a positive integer');
  }
  const desiredPlotWidth = payload.width;
  const desiredPlotHeight = payload.height;
  const title = payload.title.trim();
  const opts = payload.options;
  const meta = payload.meta;
  const views = payload.views;

  const includeAxes = opts.includeAxes;
  const includeLegend = opts.includeLegend;
  const legendPosition = opts.legendPosition;
  const strategy = opts.strategy;
  const showOrientation = opts.showOrientation;
  const depthSort3d = opts.depthSort3d;
  const crop = opts.crop;

  const fontFamily = opts.fontFamily;
  const baseFontSize = opts.fontSizePx;
  const legendFontSize = opts.legendFontSizePx;
  const tickFontSize = opts.tickFontSizePx;
  const axisLabelFontSize = opts.axisLabelFontSizePx;
  const titleFontSize = opts.titleFontSizePx;
  const centroidLabelFontSize = opts.centroidLabelFontSizePx;
  // Point size comes from the interactive viewer (WYSIWYG).
  const selectionMutedOpacity = opts.selectionMutedOpacity;
  const totalHighlighted = payload.selection.totalCount;
  const emphasizeSelection = opts.emphasizeSelection && totalHighlighted > 0;
  const highlightCount = emphasizeSelection
    ? payload.selection.visibleCount
    : totalHighlighted;
  const highlightArray = payload.selection.highlightArray;

  const viewerBgHex = rgb01ToHex(views[0].renderState.bgColor);
  if (viewerBgHex === null) {
    throw new Error('SVG export render state has no exact viewer background color.');
  }
  const background = opts.background;
  const backgroundColor = background === 'custom'
    ? opts.backgroundColor
    : (background === 'viewer' ? viewerBgHex : '#ffffff');

  // Annotation ink follows the figure's own paper: a near-black title on a
  // dark-background export cannot be read.
  const ink = resolveFigureInk({ background, backgroundColor });

  // The reference grid is a viewer-owned background layer: it sits behind the
  // points in every panel, exactly as `drawGrid()` does on screen.
  const referenceGrid = opts.referenceGrid;
  const referenceGridSurface = resolveReferenceGridSurface({
    appearance: referenceGrid,
    background,
    backgroundColor,
  });

  const singleView = views.length === 1;
  const singleViewId = singleView ? views[0].id : null;

  const singleScientificState = singleView
    ? views[0].scientificState
    : null;
  const singleLegendFieldKey = singleView && includeLegend
    ? singleScientificState.fieldKey
    : null;
  const singleLegendModel = singleView && includeLegend
    ? singleScientificState.legendModel
    : null;

  // For single view, compute layout first to get the expanded total dimensions
  let svgWidth, svgHeight;
  /** @type {ReturnType<typeof computeSingleViewLayout> | null} */
  let singleLayout = null;
  let singleAxesEligible = false;
  let singleDim = 3;
  let singleNavMode = null;
  let singleCameraState = null;

  if (singleView) {
    const view = views[0];
    singleCameraState = assertCameraState(
      view.cameraState,
      `SVG camera state for "${singleViewId}"`
    );
    singleNavMode = singleCameraState.navigationMode;
    singleDim = singleScientificState.dimensionLevel;
    singleAxesEligible = includeAxes;

    singleLayout = computeSingleViewLayout({
      width: desiredPlotWidth,
      height: desiredPlotHeight,
      title,
      includeAxes: singleAxesEligible,
      includeLegend,
      legendPosition,
      legendModel: singleLegendModel,
      legendFontSizePx: legendFontSize
    });

    // Use expanded dimensions for SVG
    svgWidth = singleLayout.totalWidth;
    svgHeight = singleLayout.totalHeight;
  } else {
    // For multi-view, use the original dimensions (grid layout handles internally)
    svgWidth = desiredPlotWidth;
    svgHeight = desiredPlotHeight;
  }

  const session = openFigureExportWorkerSession({ signal });
  try {
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`
  );
  parts.push(buildSvgMetadata(meta, payload));

  if (background !== 'transparent') {
    parts.push(`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="${escapeXml(backgroundColor)}"/>`);
  }

  if (singleView) {
    const view = views[0];
    const viewId = singleViewId || String(view?.id || 'live');
    const data = view?.data || {};
    const positions = data.positions || null;
    const colors = data.colors || null;
    const transparency = data.transparency || null;

    const renderState = view?.renderState || null;
    if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for SVG render');

    const dim = singleDim;
    const cameraState = singleCameraState;
    const navMode = singleNavMode;
    const axesEligible = singleAxesEligible;
    const shouldDepthSort = depthSort3d && dim > 2 && navMode !== 'planar';

    const lodMembership = view.scientificState.lodMembership;
    // The order the pane draws at full detail (a reduced level draws a
    // prefix of it, `lodMembership.indices`).
    const drawOrder = view.scientificState.drawOrder;
    const pointDiameterViewportPx =
      renderState.pointSize * view.scientificState.lodSizeMultiplier;
    const pointRadiusViewportPx = pointDiameterViewportPx / 2;

    const layout = singleLayout || computeSingleViewLayout({
      width: desiredPlotWidth,
      height: desiredPlotHeight,
      title,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition,
      legendModel: singleLegendModel,
      legendFontSizePx: legendFontSize
    });

    if (title) {
      const titleSize = Math.max(14, titleFontSize);
      const tx = layout.titleRect ? (layout.titleRect.x + layout.titleRect.width / 2) : (layout.outerPadding + (layout.totalWidth - layout.outerPadding * 2) / 2);
      parts.push(
        `<text x="${tx}" y="${(layout.titleRect?.y ?? layout.outerPadding) + titleSize}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" font-size="${titleSize}" fill="${ink.text}">${escapeXml(title)}</text>`
      );
    }

    const plotRect = layout.plotRect;
    const clipId = `clip_single`;
    parts.push(`<defs><clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath></defs>`);
    const useCameraAxes =
      dim > 2 &&
      navMode !== 'planar' &&
      Boolean(renderState.viewMatrix);
    const visibleBounds = await requestVisibleBounds(session, {
      camera: useCameraAxes,
      positions,
      dimension: dim,
      transparency,
      lodMembership,
      renderState,
      crop,
      normTransform: view.scientificState.normTransform,
    });
    throwIfFigureExportAborted(signal);
    const hasVisibleCells = visibleBounds !== null;

    // Legend (may contribute defs for gradients).
    if (includeLegend && layout.legendRect) {
      const legend = renderSvgLegend({
        legendRect: layout.legendRect,
        fieldKey: singleLegendFieldKey,
        model: singleLegendModel,
        fontFamily,
        fontSize: legendFontSize,
        idPrefix: `legend_${hashStringToSeed(meta?.datasetId || meta?.datasetName || 'cellucid')}`,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
      if (legend.defs) parts.push(legend.defs);
      if (legend.svg) parts.push(legend.svg);
    }

    // Plot background + frame.
    const plotFill = background === 'transparent' ? 'none' : escapeXml(backgroundColor);
    parts.push(`<rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" fill="${plotFill}" stroke="${ink.frame}" stroke-width="1"/>`);

    // Points + centroid overlay (WYSIWYG).
    parts.push(`<g clip-path="url(#${clipId})">`);

    parts.push(renderSvgReferenceGrid(buildReferenceGridModel({
      appearance: referenceGrid,
      renderState,
      plotRect,
      crop,
      surface: referenceGridSurface,
    }), 'reference_layer'));
    if (figureDrawsBackdropLook(referenceGrid, referenceGridSurface, renderState)) {
      // The look is a raster at the hybrid point raster's density.
      const lookRaster = await renderBackdropLookForPlot({
        renderState,
        plotRect,
        crop,
        width: Math.max(1, Math.round(plotRect.width * 2)),
        height: Math.max(1, Math.round(plotRect.height * 2)),
        signal,
      });
      throwIfFigureExportAborted(signal);
      const lookDataUrl = await backdropLookDataUrl(session, lookRaster, signal);
      throwIfFigureExportAborted(signal);
      parts.push(renderSvgBackdropLookImage(lookDataUrl, plotRect));
    }

    const centroidPositions = data?.centroidPositions || null;
    const centroidColors = data?.centroidColors || null;
    const centroidLabelTexts = Array.isArray(data?.centroidLabelTexts) ? data.centroidLabelTexts : null;
    const centroidFlags = data?.centroidFlags || null;
    const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
      ? opts.includeCentroidPoints
      : Boolean(centroidFlags?.points);
    const includeCentroidLabels = typeof opts.includeCentroidLabels === 'boolean'
      ? opts.includeCentroidLabels
      : Boolean(centroidFlags?.labels);
    const hasCentroidPoints =
      centroidPositions instanceof Float32Array &&
      centroidPositions.length > 0 &&
      centroidColors instanceof Uint8Array &&
      centroidColors.length === (centroidPositions.length / 3) * 4;

    const crop01 = assertCropRect01(crop);
    const srcViewportW = Math.max(1, renderState?.viewportWidth || 1);
    const srcViewportH = Math.max(1, renderState?.viewportHeight || 1);
    const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
    const cropW = cropPx ? cropPx.width : srcViewportW;
    const cropH = cropPx ? cropPx.height : srcViewportH;
    const plotScale = computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;

    // Viewer draws centroids at ~4× base point size (without LOD multipliers).
    const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));
    const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * plotScale);

    let centroidPointsRasterized = false;

    if (strategy === 'hybrid') {
      const renderStateForPoints = applyExportBackgroundToRenderState(renderState, background, backgroundColor);
      const dataUrl = await rasterizePointsToDataUrl(session, {
        positions,
        dimension: dim,
        colors,
        transparency,
        lodMembership,
        drawOrder,
        renderState: renderStateForPoints,
        plotRect,
        radiusPx: pointRadiusViewportPx,
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity,
        crop,
        overlayPositions: includeCentroidPoints && hasCentroidPoints ? centroidPositions : null,
        overlayColors: includeCentroidPoints && hasCentroidPoints ? centroidColors : null,
        overlayPointDiameterViewportPx: includeCentroidPoints && hasCentroidPoints ? centroidDiameterViewportPx : null,
        signal,
      });
      throwIfFigureExportAborted(signal);
      centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;
      parts.push(
        `<image x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" href="${dataUrl}" preserveAspectRatio="none"/>`
      );
    } else if (strategy === 'full-vector' || strategy === 'optimized-vector') {
      // The worker writes the circles.
      parts.push(await requestSvgPointMarkup(session, {
        strategy,
        positions,
        dimension: dim,
        colors,
        transparency,
        lodMembership,
        drawOrder,
        renderState,
        // A sculpted point fogs toward the fog colour: here, the paper.
        fogRenderState: applyExportBackgroundToRenderState(renderState, background, backgroundColor),
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity,
        plotRect,
        crop,
        pointRadiusViewportPx,
        radiusPx: pointRadiusViewportPx * plotScale,
        sortByDepth: shouldDepthSort,
        targetCount: opts.optimizedTargetCount,
        seed: hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId),
      }));
      throwIfFigureExportAborted(signal);
    }

    const centroidSvg = renderSvgCentroidOverlay({
      positions: centroidPositions,
      colors: centroidColors,
      labelTexts: centroidLabelTexts,
      flags: {
        points: includeCentroidPoints && !centroidPointsRasterized,
        labels: includeCentroidLabels,
      },
      renderState,
      plotRect,
      pointRadiusPx: centroidRadiusPlotPx,
      crop,
      fontFamily,
      labelFontSizePx: centroidLabelFontSize,
      labelColor: ink.text,
      haloColor: background === 'transparent' ? ink.halo : backgroundColor,
    });
    if (centroidSvg) parts.push(centroidSvg);

    parts.push(`</g>`);

    // Plot annotations are overlays: emit them after the point/centroid pass so
    // dense point clouds cannot obscure orientation or selection state.
    if (showOrientation && renderState.viewMatrix && dim > 2 && navMode !== 'planar') {
      const orientationFontSize = clamp(Math.round(baseFontSize * 0.9), 11, 22);
      parts.push(renderSvgOrientationIndicator({
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: orientationFontSize,
        ink
      }));
    }

    if (emphasizeSelection) {
      const badge = buildSelectionBadge({
        count: highlightCount,
        plotRect,
        fontSizePx: baseFontSize,
      });
      if (badge) parts.push(renderSvgSelectionBadge(badge, fontFamily, baseFontSize, ink));
    }

    // Axes (2D uses embedding coordinates; 3D uses camera-space coordinates).
    if (axesEligible && visibleBounds !== null) {
      parts.push(renderSvgAxes({
        plotRect,
        bounds: visibleBounds,
        xLabel: opts.xLabel,
        yLabel: opts.yLabel,
        fontFamily,
        tickFontSize,
        labelFontSize: axisLabelFontSize,
        color: ink.text
      }));
    }
    if (!hasVisibleCells) {
      parts.push(
        `<g clip-path="url(#${clipId})">` +
        `<text x="${plotRect.x + plotRect.width / 2}" y="${plotRect.y + plotRect.height / 2}" ` +
        `text-anchor="middle" dominant-baseline="middle" font-family="${escapeXml(fontFamily)}" ` +
        `font-size="${baseFontSize}" fill="${ink.mutedText}">No visible cells</text>` +
        `</g>`
      );
    }
  } else {
    const outerPadding = LAYOUT_CONSTANTS.OUTER_PADDING;
    const titleHeight = title ? LAYOUT_CONSTANTS.TITLE_HEIGHT : 0;
    const contentX = outerPadding;
    const contentY = outerPadding + titleHeight;
    const contentW = Math.max(1, svgWidth - outerPadding * 2);
    const contentH = Math.max(1, svgHeight - outerPadding * 2 - titleHeight);
    const { cols, rows } = computeGridDims(views.length || 1);
    const gap = 16;

    if (title) {
      const titleSize = Math.max(14, titleFontSize);
      const tx = outerPadding + contentW / 2;
      parts.push(
        `<text x="${tx}" y="${outerPadding + titleSize}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" font-size="${titleSize}" fill="${ink.text}">${escapeXml(title)}</text>`
      );
    }

    // One legend may stand for the whole grid only when the panels agree; a
    // panel that disagrees keeps its own legend inside its cell (below).
    const sharedLegend = includeLegend
      ? resolveSharedGridLegend(views)
      : null;
    const wantsSharedLegend = sharedLegend !== null;
    const minimumGridWidth = Math.min(
      contentW,
      cols * (includeAxes ? 150 : 96)
    );
    const minimumGridHeight = Math.min(
      contentH,
      rows * (includeAxes ? 150 : 96)
    );
    const availableRightLegendWidth =
      contentW - gap - minimumGridWidth;
    const availableBottomLegendHeight =
      contentH - gap - minimumGridHeight;
    const legendW =
      wantsSharedLegend &&
      legendPosition === 'right' &&
      availableRightLegendWidth >= 96
        ? Math.min(240, availableRightLegendWidth)
        : 0;
    const legendH =
      wantsSharedLegend &&
      legendPosition === 'bottom' &&
      availableBottomLegendHeight >= 72
        ? Math.min(140, availableBottomLegendHeight)
        : 0;
    const rendersSharedLegend = legendW > 0 || legendH > 0;
    // Whatever the shared legend cannot say — because the panels disagree, or
    // because the figure has no room for it beside the grid — is said per
    // panel. A coloured figure without any legend cannot be read at all.
    const rendersPanelLegends = includeLegend && !rendersSharedLegend;

    const gridW = Math.max(1, contentW - (legendW ? (gap + legendW) : 0));
    const gridH = Math.max(1, contentH - (legendH ? (gap + legendH) : 0));
    const gridX = contentX;
    const gridY = contentY;
    const cellW = gridW / cols;
    const cellH = gridH / rows;

    const legendRect = rendersSharedLegend
      ? (legendPosition === 'right'
        ? { x: gridX + gridW + gap, y: gridY, width: legendW, height: gridH }
        : { x: gridX, y: gridY + gridH + gap, width: gridW, height: legendH })
      : null;

    for (let idx = 0; idx < views.length; idx++) {
      const view = views[idx];
      const viewId = String(view?.id || 'live');
      const viewLabel = String(view?.label || viewId);
      const data = view?.data || {};
      const positions = data.positions || null;
      const colors = data.colors || null;
      const transparency = data.transparency || null;

      const panelLegendModel = rendersPanelLegends
        ? view.scientificState.legendModel
        : null;
      const panelLegendFieldKey = rendersPanelLegends
        ? view.scientificState.fieldKey
        : null;

      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cellX = gridX + col * cellW;
      const cellY = gridY + row * cellH;
      const {
        labelX,
        labelY,
        panelRect,
        plotRect,
        legendRect: panelLegendRect,
      } = computeGridPaneLayout({
        cellX,
        cellY,
        cellWidth: cellW,
        cellHeight: cellH,
        includeAxes,
        fontSize: baseFontSize,
        legendModel: panelLegendModel,
        legendPosition,
        legendFontSizePx: legendFontSize,
      });

      const clipId = `clip_${idx}`;
      const panelClipId = `panel_clip_${idx}`;
      parts.push(
        `<defs>` +
        `<clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath>` +
        `<clipPath id="${panelClipId}"><rect x="${panelRect.x}" y="${panelRect.y}" width="${panelRect.width}" height="${panelRect.height}"/></clipPath>` +
        `</defs>`
      );
      const cellFill = background === 'transparent' ? 'none' : escapeXml(backgroundColor);
      parts.push(`<rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" fill="${cellFill}" stroke="${ink.frame}" stroke-width="1"/>`);
      parts.push(`<g clip-path="url(#${clipId})">`);

      const renderState = view?.renderState || null;
      if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for SVG multiview render');

      parts.push(renderSvgReferenceGrid(buildReferenceGridModel({
        appearance: referenceGrid,
        renderState,
        plotRect,
        crop,
        surface: referenceGridSurface,
      }), `reference_layer_${idx}`));
      if (figureDrawsBackdropLook(referenceGrid, referenceGridSurface, renderState)) {
        const lookRaster = await renderBackdropLookForPlot({
          renderState,
          plotRect,
          crop,
          width: Math.max(1, Math.round(plotRect.width * 2)),
          height: Math.max(1, Math.round(plotRect.height * 2)),
          signal,
        });
        throwIfFigureExportAborted(signal);
          const lookDataUrl = await backdropLookDataUrl(session, lookRaster, signal);
        throwIfFigureExportAborted(signal);
        parts.push(renderSvgBackdropLookImage(lookDataUrl, plotRect));
      }

      const dim = view.scientificState.dimensionLevel;
      const cameraState = assertCameraState(
        view.cameraState,
        `SVG camera state for "${viewId}"`
      );
      const navMode = cameraState.navigationMode;
      const lodMembership = view.scientificState.lodMembership;
      // The order the pane draws at full detail (a reduced level draws a
      // prefix of it, `lodMembership.indices`).
      const drawOrder = view.scientificState.drawOrder;
      const pointRadiusViewportPx =
        (renderState.pointSize * view.scientificState.lodSizeMultiplier) / 2;
      const useCameraAxes =
        dim > 2 &&
        navMode !== 'planar' &&
        Boolean(renderState.viewMatrix);
      const visibleBounds = await requestVisibleBounds(session, {
        camera: useCameraAxes,
        positions,
        dimension: dim,
        transparency,
        lodMembership,
        renderState,
        crop,
        normTransform: view.scientificState.normTransform,
      });
      throwIfFigureExportAborted(signal);
      const hasVisibleCells = visibleBounds !== null;

      const crop01 = assertCropRect01(crop);
      const srcViewportW = Math.max(1, renderState?.viewportWidth || 1);
      const srcViewportH = Math.max(1, renderState?.viewportHeight || 1);
      const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
      const cropW = cropPx ? cropPx.width : srcViewportW;
      const cropH = cropPx ? cropPx.height : srcViewportH;
      const radiusPlot = pointRadiusViewportPx * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;

      const centroidPositions = data?.centroidPositions || null;
      const centroidColors = data?.centroidColors || null;
      const centroidLabelTexts = Array.isArray(data?.centroidLabelTexts) ? data.centroidLabelTexts : null;
      const centroidFlags = data?.centroidFlags || null;
      const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
        ? opts.includeCentroidPoints
        : Boolean(centroidFlags?.points);
      const includeCentroidLabels = typeof opts.includeCentroidLabels === 'boolean'
        ? opts.includeCentroidLabels
        : Boolean(centroidFlags?.labels);
      const hasCentroidPoints =
        centroidPositions instanceof Float32Array &&
        centroidPositions.length > 0 &&
        centroidColors instanceof Uint8Array &&
        centroidColors.length === (centroidPositions.length / 3) * 4;
      const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));
      const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale);
      let centroidPointsRasterized = false;

      if (strategy === 'hybrid') {
        const renderStateForPoints = applyExportBackgroundToRenderState(
          renderState,
          background,
          backgroundColor
        );
        const dataUrl = await rasterizePointsToDataUrl(session, {
          positions,
          dimension: dim,
          colors,
          transparency,
          lodMembership,
          drawOrder,
          renderState: renderStateForPoints,
          plotRect,
          radiusPx: pointRadiusViewportPx,
          highlightArray,
          emphasizeSelection,
          selectionMutedOpacity,
          crop,
          overlayPositions: includeCentroidPoints && hasCentroidPoints ? centroidPositions : null,
          overlayColors: includeCentroidPoints && hasCentroidPoints ? centroidColors : null,
          overlayPointDiameterViewportPx: includeCentroidPoints && hasCentroidPoints ? centroidDiameterViewportPx : null,
          signal,
        });
        throwIfFigureExportAborted(signal);
        centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;
        parts.push(
          `<image x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" href="${dataUrl}" preserveAspectRatio="none"/>`
        );
      } else if (strategy === 'full-vector' || strategy === 'optimized-vector') {
        // The worker writes the circles.
        // Each panel carries its own fog anchors, so the fog is per panel.
        parts.push(await requestSvgPointMarkup(session, {
          strategy,
          positions,
          dimension: dim,
          colors,
          transparency,
          lodMembership,
          drawOrder,
          renderState,
          // A sculpted point fogs toward the fog colour: here, the paper.
          fogRenderState: applyExportBackgroundToRenderState(renderState, background, backgroundColor),
          highlightArray,
          emphasizeSelection,
          selectionMutedOpacity,
          plotRect,
          crop,
          pointRadiusViewportPx,
          radiusPx: radiusPlot,
          sortByDepth: depthSort3d && dim > 2 && navMode !== 'planar',
          targetCount: opts.optimizedTargetCount,
          seed: hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId),
        }));
        throwIfFigureExportAborted(signal);
      }

      const centroidSvg = renderSvgCentroidOverlay({
        positions: centroidPositions,
        colors: centroidColors,
        labelTexts: centroidLabelTexts,
        flags: {
          points: includeCentroidPoints && !centroidPointsRasterized,
          labels: includeCentroidLabels
        },
        renderState,
        plotRect,
        pointRadiusPx: centroidRadiusPlotPx,
        crop,
        fontFamily,
        labelFontSizePx: centroidLabelFontSize,
        labelColor: ink.text,
        haloColor: background === 'transparent' ? ink.halo : backgroundColor,
      });
      if (centroidSvg) parts.push(centroidSvg);

      parts.push(`</g>`);

      if (
        showOrientation &&
        renderState.viewMatrix &&
        dim > 2 &&
        navMode !== 'planar'
      ) {
        const orientationFontSize = clamp(
          Math.round(baseFontSize * 0.9),
          11,
          22
        );
        parts.push(
          `<g clip-path="url(#${panelClipId})">` +
          renderSvgOrientationIndicator({
            plotRect,
            viewMatrix: renderState.viewMatrix,
            cameraState,
            fontFamily,
            fontSize: orientationFontSize,
            ink,
          }) +
          `</g>`
        );
      }

      if (includeAxes && visibleBounds !== null) {
        parts.push(
          `<g clip-path="url(#${panelClipId})">` +
          renderSvgAxes({
            plotRect,
            bounds: visibleBounds,
            xLabel: opts.xLabel,
            yLabel: opts.yLabel,
            fontFamily,
            tickFontSize,
            labelFontSize: axisLabelFontSize,
            color: ink.text,
          }) +
          `</g>`
        );
      }

      if (!hasVisibleCells) {
        parts.push(
          `<g clip-path="url(#${clipId})">` +
          `<text x="${plotRect.x + plotRect.width / 2}" y="${plotRect.y + plotRect.height / 2}" ` +
          `text-anchor="middle" dominant-baseline="middle" font-family="${escapeXml(fontFamily)}" ` +
          `font-size="${baseFontSize}" fill="${ink.mutedText}">No visible cells</text>` +
          `</g>`
        );
      }

      // Selection badges are counted from this panel's own snapshot: each
      // panel carries its own filters, so the active view's count would be a
      // false claim on every other panel.
      if (emphasizeSelection) {
        const badge = buildSelectionBadge({
          count: countHighlightedVisiblePoints({
            highlightArray,
            transparency,
            lodMembership,
          }),
          plotRect,
          fontSizePx: baseFontSize,
        });
        if (badge) {
          parts.push(
            `<g clip-path="url(#${panelClipId})">` +
            renderSvgSelectionBadge(badge, fontFamily, baseFontSize, ink) +
            `</g>`
          );
        }
      }

      if (panelLegendRect && panelLegendModel) {
        const legend = renderSvgLegend({
          legendRect: panelLegendRect,
          fieldKey: panelLegendFieldKey,
          model: panelLegendModel,
          fontFamily,
          fontSize: legendFontSize,
          // Gradient ids must stay unique per panel: two panels sharing one id
          // would silently paint the second colorbar with the first ramp.
          idPrefix: `legend_${hashStringToSeed(meta?.datasetId || meta?.datasetName || 'cellucid')}_panel${idx}`,
          backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
          ink,
        });
        if (legend.defs) parts.push(legend.defs);
        if (legend.svg) {
          parts.push(
            `<g clip-path="url(#${panelClipId})">${legend.svg}</g>`
          );
        }
      }

      parts.push(
        `<g clip-path="url(#${panelClipId})">` +
        `<text x="${labelX}" y="${labelY}" font-family="${escapeXml(fontFamily)}" ` +
        `font-size="${baseFontSize}" fill="${ink.text}">${escapeXml(panelLetter(idx))}. ${escapeXml(viewLabel)}</text>` +
        `</g>`
      );
    }

    if (rendersSharedLegend && legendRect) {
      const legend = renderSvgLegend({
        legendRect,
        fieldKey: sharedLegend.fieldKey,
        model: sharedLegend.model,
        fontFamily,
        fontSize: legendFontSize,
        idPrefix: `legend_${hashStringToSeed(meta?.datasetId || meta?.datasetName || 'cellucid')}`,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
      if (legend.defs) parts.push(legend.defs);
      if (legend.svg) parts.push(legend.svg);
    }
  }

  parts.push(`</svg>`);
  throwIfFigureExportAborted(signal);
  return svgBlobFromParts(parts);
  } finally {
    session.close();
  }
}
