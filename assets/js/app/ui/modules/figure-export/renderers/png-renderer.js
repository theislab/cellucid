/**
 * @fileoverview PNG renderer for figure export.
 *
 * PURPOSE:
 * Renders publication-quality PNG figures with the same 3D-shaded appearance
 * as the interactive viewer. Supports single-view and multi-view grid layouts.
 *
 * ARCHITECTURE:
 * - Uses Canvas2D surface for layout, background, frame, title, axes, legend
 * - Uses WebGL2 rasterizer for points (preserves 3D sphere shading with lighting/fog)
 * - Fails visibly if the exact WebGL2 point pass cannot be produced
 *
 * LAYOUT SYSTEM (IMPORTANT):
 * The payload.width and payload.height parameters represent the desired PLOT
 * CONTENT size, NOT the total output size. The actual PNG dimensions are
 * EXPANDED to accommodate legend, axes, and title without shrinking the plot.
 * This ensures the scientific visualization maintains its intended size.
 *
 * DPI SCALING:
 * - DPI affects pixel density, not the logical layout
 * - A 1200x900 plot at 300 DPI produces a 3750x2812 pixel PNG
 * - All layout calculations use logical coordinates, then scaled for output
 *
 * POINT RENDERING:
 * WebGL2 reproduces the active viewer shader; annotations use Canvas2D.
 *
 * CROSS-BROWSER COMPATIBILITY:
 * - Uses the native canvas surface available in the current browser
 * - One HTMLCanvasElement/toBlob path is used across supported browsers
 *
 * METADATA:
 * PNG files include UTF-8 iTXt chunks with dataset info, export timestamp,
 * and JSON-encoded metadata for programmatic access.
 *
 * @module ui/modules/figure-export/renderers/png-renderer
 */

	import {
	  computeSingleViewLayout,
	  computeGridDims,
	  computeGridPaneLayout,
	  LAYOUT_CONSTANTS,
	} from '../utils/layout.js';
	import { drawCanvasAxes } from '../components/axes-builder.js';
	import {
	  drawCanvasLegend,
	  resolveSharedGridLegend,
	} from '../components/legend-builder.js';
	import { drawCanvasOrientationIndicator } from '../components/orientation-indicator.js';
	import { drawCanvasCentroidOverlay } from '../components/centroid-overlay.js';
	import {
	  buildReferenceGridModel,
	  drawCanvasReferenceGrid,
	  resolveReferenceGridSurfaceRgb,
	} from '../components/reference-grid.js';
	import {
	  computeVisibleCameraBounds,
	  computeVisibleRealBounds,
	} from '../utils/coordinate-mapper.js';
	import { assertCropRect01, cropRect01ToPx } from '../utils/crop.js';
	import { embedPngTextChunks } from '../utils/png-metadata.js';
import {
  rasterizePointsWebgl,
  releaseWebglRasterCanvas,
} from '../utils/webgl-point-rasterizer.js';
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';
import { resolveFigureInk } from '../utils/figure-ink.js';
	import { computeLetterboxedRect } from '../utils/letterbox.js';
import { assertCameraState } from '../../../../../rendering/camera-state-contract.js';
import {
  assertFigureExportPayload,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';
import { canvasToBlob } from '../utils/export-helpers.js';
import { clamp } from '../../../../utils/number-utils.js';
import {
  buildProvenanceDescription,
  buildProvenanceJson,
  readProvenanceSourceFile,
  readProvenanceViews,
  unanimousFieldKey,
} from '../utils/figure-provenance.js';
import { panelLetter } from '../utils/panel-label.js';
import { scalePointDiameterToRaster } from '../utils/point-size.js';
import {
  buildSelectionBadge,
  countHighlightedVisiblePoints,
} from '../utils/selection-badge.js';

function drawCanvasSelectionBadge(ctx, badge, fontFamily, fontSize, ink) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = ink.surface;
  ctx.fillRect(badge.x, badge.y, badge.width, badge.height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink.frame;
  ctx.lineWidth = 1;
  ctx.strokeRect(badge.x, badge.y, badge.width, badge.height);
  ctx.fillStyle = ink.surfaceInk;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(badge.label, badge.textX, badge.textY);
  ctx.restore();
}

function applyExportBackgroundToRenderState(renderState, background, backgroundColor) {
  if (!renderState) return renderState;
  if (background === 'viewer' || background === 'transparent') return renderState;

  const rgb = hexToRgb01(backgroundColor);
  if (!rgb) return renderState;

  // Keep projection/camera matrices unchanged; only align fog + bg for shader output.
  return {
    ...renderState,
    fogColor: new Float32Array(rgb),
    bgColor: new Float32Array(rgb),
  };
}

	/**
	 * The exact UTF-8 `iTXt` chunk map embedded into the exported PNG.
	 *
	 * Exported because it is the PNG's provenance claim: it can then be checked
	 * against the SVG's, which is the only way to know the two formats of one
	 * export say the same thing.
	 *
	 * @param {any} meta
	 * @param {any} payload
	 * @returns {Record<string, string>}
	 */
	export function buildPngTextMetadata(meta, payload) {
	  const dataset = meta?.datasetName || meta?.datasetId || '';
	  const exportedAt = String(meta?.exportedAt || new Date().toISOString());
	  const website = 'https://cellucid.com';

	  const sourceFile = readProvenanceSourceFile(meta);

	  // Every exported panel is described; `Color Field` is only claimed when all
	  // of them really carry the same field.
	  const description = buildProvenanceDescription(meta);
	  const colorField = unanimousFieldKey(readProvenanceViews(meta));
	  const comment = buildProvenanceJson(meta, payload, 'png');

	  return {
	    Software: 'Cellucid (cellucid.com)',
	    Website: website,
	    'Creation Time': exportedAt,
	    ...(dataset ? { Dataset: String(dataset) } : {}),
	    ...(meta?.datasetId ? { 'Dataset ID': String(meta.datasetId) } : {}),
	    ...(colorField ? { 'Color Field': colorField } : {}),
	    ...(sourceFile ? { 'Source File': String(sourceFile) } : {}),
	    ...(description ? { Description: String(description) } : {}),
	    ...(comment ? { Comment: String(comment) } : {}),
	  };
	}

/**
 * Render figure to PNG blob.
 *
 * IMPORTANT: The payload.width and payload.height are interpreted as the desired
 * PLOT CONTENT size. The actual PNG dimensions will be LARGER to accommodate
 * legend, axes, and title without shrinking the plot area.
 *
 * @param {object} options
 * @param {any} options.payload
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Blob>}
 */
export async function renderFigureToPngBlob({ payload, signal = null }) {
  throwIfFigureExportAborted(signal);
  assertFigureExportPayload(payload);
  if (payload.format !== 'png') {
    throw new TypeError('PNG renderer requires payload.format exactly "png".');
  }
  if (!Number.isInteger(payload?.width) || payload.width <= 0) {
    throw new TypeError('PNG export width must be a positive integer');
  }
  if (!Number.isInteger(payload?.height) || payload.height <= 0) {
    throw new TypeError('PNG export height must be a positive integer');
  }
  if (!Number.isInteger(payload?.dpi) || payload.dpi < 72) {
    throw new TypeError('PNG export DPI must be an integer of at least 72');
  }
  const desiredPlotWidth = payload.width;
  const desiredPlotHeight = payload.height;
  const dpi = payload.dpi;
  const title = payload.title.trim();
  const opts = payload.options;
  const views = payload.views;
  const viewerBgHex = rgb01ToHex(views[0].renderState.bgColor);
  if (viewerBgHex === null) {
    throw new Error('PNG export render state has no exact viewer background color.');
  }

  const fontFamily = opts.fontFamily;
  const baseFontSize = opts.fontSizePx;
  const legendFontSize = opts.legendFontSizePx;
  const tickFontSize = opts.tickFontSizePx;
  const axisLabelFontSize = opts.axisLabelFontSizePx;
  const titleFontSize = opts.titleFontSizePx;
  const centroidLabelFontSize = opts.centroidLabelFontSizePx;
  // Point size comes from the interactive viewer (WYSIWYG).
  const includeAxes = opts.includeAxes;
  const includeLegend = opts.includeLegend;
  const legendPosition = opts.legendPosition;
  const showOrientation = opts.showOrientation;
  const crop = opts.crop;
  const crop01 = assertCropRect01(crop);
  const selectionMutedOpacity = opts.selectionMutedOpacity;
  const totalHighlighted = payload.selection.totalCount;
  const emphasizeSelection = opts.emphasizeSelection && totalHighlighted > 0;
  const highlightCount = emphasizeSelection
    ? payload.selection.visibleCount
    : totalHighlighted;
  const highlightArray = payload.selection.highlightArray;

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
  const referenceGridSurfaceRgb = resolveReferenceGridSurfaceRgb({
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

  // Compute actual output dimensions based on desired plot size and annotations
  let canvasWidth, canvasHeight;
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
      `PNG camera state for "${singleViewId}"`
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

    // Use expanded dimensions for canvas
    canvasWidth = singleLayout.totalWidth;
    canvasHeight = singleLayout.totalHeight;
  } else {
    // For multi-view, use the original dimensions (grid layout handles internally)
    canvasWidth = desiredPlotWidth;
    canvasHeight = desiredPlotHeight;
  }

  const scale = dpi / 96;
  const pxW = Math.max(1, Math.round(canvasWidth * scale));
  const pxH = Math.max(1, Math.round(canvasHeight * scale));

  if (typeof document === 'undefined') {
    throw new Error('PNG export requires an HTML document.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;

  const ctx = /** @type {CanvasRenderingContext2D|null} */ (canvas.getContext('2d', { alpha: true }));
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  ctx.save();
  ctx.scale(scale, scale);

  // Fill background with expanded dimensions
  if (background !== 'transparent') {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  if (singleView) {
    const view = views[0];
    const viewId = singleViewId || String(view?.id || 'live');
    const data = view?.data || {};
    const positions = data.positions || null;
    const colors = data.colors || null;
    const transparency = data.transparency || null;
    const centroidPositions = data.centroidPositions || null;
    const centroidColors = data.centroidColors || null;
    const centroidLabelTexts = Array.isArray(data.centroidLabelTexts) ? data.centroidLabelTexts : null;
    const centroidFlags = data.centroidFlags || null;

    const renderState = view?.renderState || null;
    if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for PNG render');

    const dim = singleDim;
    const cameraState = singleCameraState;
    const navMode = singleNavMode;
    const axesEligible = singleAxesEligible;
    const lodMembership = view.scientificState.lodMembership;
    const pointDiameterViewportPx =
      renderState.pointSize * view.scientificState.lodSizeMultiplier;
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
      ctx.save();
      ctx.fillStyle = ink.text;
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillText(title, tx, (layout.titleRect?.y ?? layout.outerPadding) + titleSize);
      ctx.restore();
    }

    const plotRect = layout.plotRect;
    const useCameraAxes =
      dim > 2 &&
      navMode !== 'planar' &&
      Boolean(renderState.viewMatrix);
    const visibleBounds = useCameraAxes
      ? computeVisibleCameraBounds({
        positions,
        transparency,
        lodMembership,
        mvpMatrix: renderState.mvpMatrix,
        viewMatrix: renderState.viewMatrix,
        viewportWidth: renderState.viewportWidth,
        viewportHeight: renderState.viewportHeight,
        crop,
      })
      : computeVisibleRealBounds({
        positions,
        transparency,
        lodMembership,
        mvpMatrix: renderState.mvpMatrix,
        viewportWidth: renderState.viewportWidth,
        viewportHeight: renderState.viewportHeight,
        crop,
        normTransform: view.scientificState.normTransform,
      });
    const hasVisibleCells = visibleBounds !== null;

    // Plot frame.
    ctx.strokeStyle = ink.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

    let centroidPointsRasterized = false;

    // Points (clipped).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

    drawCanvasReferenceGrid({
      ctx,
      model: buildReferenceGridModel({
        appearance: referenceGrid,
        renderState,
        plotRect,
        crop,
        surfaceRgb: referenceGridSurfaceRgb,
      }),
    });

    const outW = Math.max(1, Math.round(plotRect.width * scale));
    const outH = Math.max(1, Math.round(plotRect.height * scale));
    const srcViewportW = renderState.viewportWidth;
    const srcViewportH = renderState.viewportHeight;
    const viewportScale = computeLetterboxedRect({
      srcWidth: srcViewportW,
      srcHeight: srcViewportH,
      dstWidth: outW,
      dstHeight: outH
    }).scale;
    const centroidDiameterViewportPx = renderState.pointSize * 4;

    const renderStateForPoints = applyExportBackgroundToRenderState(
      renderState,
      background,
      backgroundColor
    );
    const webglCanvas = rasterizePointsWebgl({
      positions,
      colors,
      transparency,
      renderState: renderStateForPoints,
      lodMembership,
      outputWidthPx: outW,
      outputHeightPx: outH,
      pointSizePx: scalePointDiameterToRaster(
        pointDiameterViewportPx,
        viewportScale
      ),
      overlayPoints: (includeCentroidPoints && hasCentroidPoints)
        ? {
          positions: centroidPositions,
          colors: centroidColors,
          pointSizePx: scalePointDiameterToRaster(
            centroidDiameterViewportPx,
            viewportScale
          ),
        }
        : null,
      highlightArray,
      emphasizeSelection,
      selectionMutedOpacity
    });

    centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;
    try {
      if (crop01) {
        const vp = computeLetterboxedRect({
          srcWidth: renderState.viewportWidth,
          srcHeight: renderState.viewportHeight,
          dstWidth: webglCanvas.width,
          dstHeight: webglCanvas.height
        });
        const sx = vp.x + crop01.x * vp.width;
        const sy = vp.y + crop01.y * vp.height;
        const sw = crop01.width * vp.width;
        const sh = crop01.height * vp.height;
        ctx.drawImage(
          webglCanvas,
          sx,
          sy,
          sw,
          sh,
          plotRect.x,
          plotRect.y,
          plotRect.width,
          plotRect.height
        );
      } else {
        ctx.drawImage(
          webglCanvas,
          plotRect.x,
          plotRect.y,
          plotRect.width,
          plotRect.height
        );
      }
    } finally {
      releaseWebglRasterCanvas(webglCanvas);
    }

    ctx.restore();

    if ((includeCentroidPoints || includeCentroidLabels) && renderState) {
      const crop01 = assertCropRect01(crop);
      const srcViewportW = Math.max(1, Math.round(renderState?.viewportWidth || 1));
      const srcViewportH = Math.max(1, Math.round(renderState?.viewportHeight || 1));
      const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
      const cropW = cropPx ? cropPx.width : srcViewportW;
      const cropH = cropPx ? cropPx.height : srcViewportH;
      const plotScale = computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;
      const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));
      const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * plotScale);

      drawCanvasCentroidOverlay({
        ctx,
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
    }

    if (showOrientation && renderState?.viewMatrix && dim > 2 && navMode !== 'planar') {
      const orientationFontSize = clamp(Math.round(baseFontSize * 0.9), 11, 22);
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: orientationFontSize,
        ink
      });
    }

    if (emphasizeSelection) {
      const badge = buildSelectionBadge({
        count: highlightCount,
        plotRect,
        fontSizePx: baseFontSize,
      });
      if (badge) drawCanvasSelectionBadge(ctx, badge, fontFamily, baseFontSize, ink);
    }

    // Legend.
    if (includeLegend && layout.legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        fieldKey: singleLegendFieldKey,
        model: singleLegendModel,
        fontFamily,
        fontSize: legendFontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }

    // Axes (2D uses embedding coordinates; 3D uses camera-space coordinates).
    if (axesEligible && visibleBounds !== null) {
      drawCanvasAxes({
        ctx,
        plotRect,
        bounds: visibleBounds,
        xLabel: opts.xLabel,
        yLabel: opts.yLabel,
        fontFamily,
        tickFontSize,
        labelFontSize: axisLabelFontSize,
        color: ink.text
      });
    }
    if (!hasVisibleCells) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();
      ctx.fillStyle = ink.mutedText;
      ctx.font = `${baseFontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        'No visible cells',
        plotRect.x + plotRect.width / 2,
        plotRect.y + plotRect.height / 2
      );
      ctx.restore();
    }
  } else {
    const outerPadding = LAYOUT_CONSTANTS.OUTER_PADDING;
    const titleHeight = title ? LAYOUT_CONSTANTS.TITLE_HEIGHT : 0;
    const contentX = outerPadding;
    const contentY = outerPadding + titleHeight;
    const contentW = Math.max(1, canvasWidth - outerPadding * 2);
    const contentH = Math.max(1, canvasHeight - outerPadding * 2 - titleHeight);
    const { cols, rows } = computeGridDims(views.length || 1);
    const gap = 16;

    if (title) {
      const titleSize = Math.max(14, titleFontSize);
      ctx.save();
      ctx.fillStyle = ink.text;
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillText(title, outerPadding + contentW / 2, outerPadding + titleSize);
      ctx.restore();
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
      const centroidPositions = data.centroidPositions || null;
      const centroidColors = data.centroidColors || null;
      const centroidLabelTexts = Array.isArray(data.centroidLabelTexts) ? data.centroidLabelTexts : null;
      const centroidFlags = data.centroidFlags || null;

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

      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();

      const renderState = view?.renderState || null;
      if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for PNG multiview render');

      drawCanvasReferenceGrid({
        ctx,
        model: buildReferenceGridModel({
          appearance: referenceGrid,
          renderState,
          plotRect,
          crop,
          surfaceRgb: referenceGridSurfaceRgb,
        }),
      });

      const dim = view.scientificState.dimensionLevel;
      const cameraState = assertCameraState(
        view.cameraState,
        `PNG camera state for "${viewId}"`
      );
      const navMode = cameraState.navigationMode;
      const lodMembership = view.scientificState.lodMembership;
      const pointDiameterViewportPx =
        renderState.pointSize * view.scientificState.lodSizeMultiplier;
      const useCameraAxes =
        dim > 2 &&
        navMode !== 'planar' &&
        Boolean(renderState.viewMatrix);
      const visibleBounds = useCameraAxes
        ? computeVisibleCameraBounds({
          positions,
          transparency,
          lodMembership,
          mvpMatrix: renderState.mvpMatrix,
          viewMatrix: renderState.viewMatrix,
          viewportWidth: renderState.viewportWidth,
          viewportHeight: renderState.viewportHeight,
          crop,
        })
        : computeVisibleRealBounds({
          positions,
          transparency,
          lodMembership,
          mvpMatrix: renderState.mvpMatrix,
          viewportWidth: renderState.viewportWidth,
          viewportHeight: renderState.viewportHeight,
          crop,
          normTransform: view.scientificState.normTransform,
        });
      const hasVisibleCells = visibleBounds !== null;
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

      const outW = Math.max(1, Math.round(plotRect.width * scale));
      const outH = Math.max(1, Math.round(plotRect.height * scale));
      const srcViewportW = renderState.viewportWidth;
      const srcViewportH = renderState.viewportHeight;
      const viewportScale = computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: outW, dstHeight: outH }).scale;
      const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
      const cropW = cropPx ? cropPx.width : srcViewportW;
      const cropH = cropPx ? cropPx.height : srcViewportH;
      const plotScale = computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;
      const centroidDiameterViewportPx = renderState.pointSize * 4;
      const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * plotScale);
      let centroidPointsRasterized = false;

      const renderStateForPoints = applyExportBackgroundToRenderState(renderState, background, backgroundColor);
      const webglCanvas = rasterizePointsWebgl({
        positions,
        colors,
        transparency,
        renderState: renderStateForPoints,
        lodMembership,
        outputWidthPx: outW,
        outputHeightPx: outH,
        pointSizePx: scalePointDiameterToRaster(
          pointDiameterViewportPx,
          viewportScale
        ),
        overlayPoints: (includeCentroidPoints && hasCentroidPoints)
          ? {
            positions: centroidPositions,
            colors: centroidColors,
            pointSizePx: scalePointDiameterToRaster(
              centroidDiameterViewportPx,
              viewportScale
            ),
          }
          : null,
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity
      });

      centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;
      try {
        if (crop01) {
          const vp = computeLetterboxedRect({
            srcWidth: renderState.viewportWidth,
            srcHeight: renderState.viewportHeight,
            dstWidth: webglCanvas.width,
            dstHeight: webglCanvas.height
          });
          const sx = vp.x + crop01.x * vp.width;
          const sy = vp.y + crop01.y * vp.height;
          const sw = crop01.width * vp.width;
          const sh = crop01.height * vp.height;
          ctx.drawImage(
            webglCanvas,
            sx,
            sy,
            sw,
            sh,
            plotRect.x,
            plotRect.y,
            plotRect.width,
            plotRect.height
          );
        } else {
          ctx.drawImage(
            webglCanvas,
            plotRect.x,
            plotRect.y,
            plotRect.width,
            plotRect.height
          );
        }
      } finally {
        releaseWebglRasterCanvas(webglCanvas);
      }

      if (includeCentroidPoints || includeCentroidLabels) {
        drawCanvasCentroidOverlay({
          ctx,
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
      }

      ctx.restore();

      // Border.
      ctx.strokeStyle = ink.frame;
      ctx.lineWidth = 1;
      ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

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
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          panelRect.x,
          panelRect.y,
          panelRect.width,
          panelRect.height
        );
        ctx.clip();
        drawCanvasOrientationIndicator({
          ctx,
          plotRect,
          viewMatrix: renderState.viewMatrix,
          cameraState,
          fontFamily,
          fontSize: orientationFontSize,
          ink,
        });
        ctx.restore();
      }

      if (includeAxes && visibleBounds !== null) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          panelRect.x,
          panelRect.y,
          panelRect.width,
          panelRect.height
        );
        ctx.clip();
        drawCanvasAxes({
          ctx,
          plotRect,
          bounds: visibleBounds,
          xLabel: opts.xLabel,
          yLabel: opts.yLabel,
          fontFamily,
          tickFontSize,
          labelFontSize: axisLabelFontSize,
          color: ink.text,
        });
        ctx.restore();
      }

      if (!hasVisibleCells) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          plotRect.x,
          plotRect.y,
          plotRect.width,
          plotRect.height
        );
        ctx.clip();
        ctx.fillStyle = ink.mutedText;
        ctx.font = `${baseFontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          'No visible cells',
          plotRect.x + plotRect.width / 2,
          plotRect.y + plotRect.height / 2
        );
        ctx.restore();
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
          ctx.save();
          ctx.beginPath();
          ctx.rect(panelRect.x, panelRect.y, panelRect.width, panelRect.height);
          ctx.clip();
          drawCanvasSelectionBadge(ctx, badge, fontFamily, baseFontSize, ink);
          ctx.restore();
        }
      }

      if (panelLegendRect && panelLegendModel) {
        drawCanvasLegend({
          ctx,
          legendRect: panelLegendRect,
          fieldKey: panelLegendFieldKey,
          model: panelLegendModel,
          fontFamily,
          fontSize: legendFontSize,
          backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
          ink,
        });
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        panelRect.x,
        panelRect.y,
        panelRect.width,
        panelRect.height
      );
      ctx.clip();
      ctx.fillStyle = ink.text;
      ctx.font = `${baseFontSize}px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(
        `${panelLetter(idx)}. ${viewLabel}`,
        labelX,
        labelY
      );
      ctx.restore();
    }

    if (rendersSharedLegend && legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect,
        fieldKey: sharedLegend.fieldKey,
        model: sharedLegend.model,
        fontFamily,
        fontSize: legendFontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }
  }

  ctx.restore();

  const rawBlob = await canvasToBlob(canvas, 'image/png', {
    signal,
    failureMessage: 'PNG encoding failed.',
  });
  throwIfFigureExportAborted(signal);
  const annotatedBlob = await embedPngTextChunks(
    rawBlob,
    buildPngTextMetadata(payload.meta, payload),
    { signal }
  );
  throwIfFigureExportAborted(signal);
  return annotatedBlob;
}
