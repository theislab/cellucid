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

	import { computeSingleViewLayout, computeGridDims } from '../utils/layout.js';
	import { drawCanvasAxes } from '../components/axes-builder.js';
	import { drawCanvasLegend } from '../components/legend-builder.js';
	import { drawCanvasOrientationIndicator } from '../components/orientation-indicator.js';
	import { drawCanvasCentroidOverlay } from '../components/centroid-overlay.js';
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
	import { computeLetterboxedRect } from '../utils/letterbox.js';
import { assertCameraState } from '../../../../../rendering/camera-state-contract.js';
import {
  assertFigureExportPayload,
  throwIfFigureExportAborted,
} from '../figure-export-contract.js';
import { canvasToBlob } from '../utils/export-helpers.js';
import { clamp } from '../../../../utils/number-utils.js';
import {
  areLegendModelsSemanticallyEqual,
} from '../utils/legend-model-equality.js';

function computeGridPaneLayout({
  cellX,
  cellY,
  cellWidth,
  cellHeight,
  includeAxes,
  fontSize,
}) {
  const padding = clamp(Math.round(fontSize * 0.65), 6, 12);
  const innerWidth = Math.max(1, cellWidth - padding * 2);
  const innerHeight = Math.max(1, cellHeight - padding * 2);
  const headerHeight = Math.min(
    Math.max(18, Math.round(fontSize * 1.5)),
    Math.max(0, innerHeight - 1)
  );
  const plotAreaHeight = Math.max(1, innerHeight - headerHeight);
  const minPlotWidth = Math.min(80, Math.max(1, innerWidth * 0.45));
  const minPlotHeight = Math.min(64, Math.max(1, plotAreaHeight * 0.45));
  const axisRight = includeAxes
    ? Math.min(10, Math.max(0, innerWidth - minPlotWidth))
    : 0;
  const axisLeft = includeAxes
    ? Math.min(62, Math.max(0, innerWidth - axisRight - minPlotWidth))
    : 0;
  const axisBottom = includeAxes
    ? Math.min(62, Math.max(0, plotAreaHeight - minPlotHeight))
    : 0;
  const plotRect = {
    x: cellX + padding + axisLeft,
    y: cellY + padding + headerHeight,
    width: Math.max(1, innerWidth - axisLeft - axisRight),
    height: Math.max(1, plotAreaHeight - axisBottom),
  };

  return {
    labelX: plotRect.x,
    labelY: cellY + padding + Math.min(fontSize, Math.max(1, headerHeight)),
    panelRect: {
      x: cellX + 1,
      y: cellY + 1,
      width: Math.max(1, cellWidth - 2),
      height: Math.max(1, cellHeight - 2),
    },
    plotRect,
  };
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

	function buildPngTextMetadata(meta, payload) {
	  const dataset = meta?.datasetName || meta?.datasetId || '';
	  const exportedAt = String(meta?.exportedAt || new Date().toISOString());
	  const website = 'https://cellucid.com';

	  const sourceFile = (
	    meta?.datasetUserPath ||
	    meta?.datasetSourceUrl ||
	    meta?.datasetBaseUrl ||
	    null
	  );

	  const descriptionParts = [];
	  if (meta?.fieldKey) descriptionParts.push(`Field: ${meta.fieldKey}`);
	  if (meta?.viewLabel) descriptionParts.push(`View: ${meta.viewLabel}`);
	  if (sourceFile) descriptionParts.push(`Source: ${sourceFile}`);
	  if (Array.isArray(meta?.filters) && meta.filters.length) {
	    const lines = meta.filters.filter((l) => l && !/No filters active/i.test(String(l)));
	    if (lines.length) descriptionParts.push(`Filters: ${lines.join('; ')}`);
	  }
	  const description = descriptionParts.join(' • ');

	  const comment = JSON.stringify(
	    {
	      generator: website,
	      exporter: meta?.exporter || { name: 'Cellucid', website },
	      exportedAt,
	      dataset: {
	        name: meta?.datasetName || null,
	        id: meta?.datasetId || null,
	        sourceType: meta?.sourceType || null,
	        baseUrl: meta?.datasetBaseUrl || null,
	        userPath: meta?.datasetUserPath || null,
	        source: {
	          name: meta?.datasetSourceName || null,
	          url: meta?.datasetSourceUrl || null,
	          citation: meta?.datasetSourceCitation || null,
	        },
	      },
	      view: {
	        id: meta?.viewId || null,
	        label: meta?.viewLabel || null,
	      },
	      field: {
	        key: meta?.fieldKey || null,
	        kind: meta?.fieldKind || null,
	      },
	      filters: Array.isArray(meta?.filters) ? meta.filters : [],
	      export: {
	        format: 'png',
	        width: Number.isFinite(payload?.width) ? payload.width : null,
	        height: Number.isFinite(payload?.height) ? payload.height : null,
	        dpi: Number.isFinite(payload?.dpi) ? payload.dpi : null,
	        strategy: payload.options.strategy,
	        includeAxes: payload.options.includeAxes,
	        includeLegend: payload.options.includeLegend,
	        legendPosition: payload.options.legendPosition,
	        background: payload.options.background,
	        backgroundColor: payload.options.backgroundColor,
	        crop: payload.options.crop,
	      }
	    },
	    null,
	    0
	  );

	  return {
	    Software: 'Cellucid (cellucid.com)',
	    Website: website,
	    'Creation Time': exportedAt,
	    ...(dataset ? { Dataset: String(dataset) } : {}),
	    ...(meta?.datasetId ? { 'Dataset ID': String(meta.datasetId) } : {}),
	    ...(meta?.fieldKey ? { 'Color Field': String(meta.fieldKey) } : {}),
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
      ctx.fillStyle = '#111';
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
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

    let centroidPointsRasterized = false;

    // Points (clipped).
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
    ctx.clip();

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
      pointSizePx: Math.max(1, pointDiameterViewportPx * viewportScale),
      overlayPoints: (includeCentroidPoints && hasCentroidPoints)
        ? {
          positions: centroidPositions,
          colors: centroidColors,
          pointSizePx: Math.max(1, centroidDiameterViewportPx * viewportScale),
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
        labelColor: '#111',
        haloColor: background === 'transparent' ? 'rgba(255,255,255,0.95)' : backgroundColor,
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
        fontSize: orientationFontSize
      });
    }

    if (emphasizeSelection && highlightCount > 0) {
      const label = `n = ${highlightCount.toLocaleString()} selected`;
      const boxPad = 6;
      const boxH = Math.max(16, Math.round(baseFontSize * 1.35));
      const boxW = Math.min(
        Math.max(1, plotRect.width - 16),
        Math.max(90, Math.round(label.length * (baseFontSize * 0.62) + boxPad * 2))
      );
      const boxX = plotRect.x + 8;
      const boxY = plotRect.y + 8;

      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#111';
      ctx.font = `${baseFontSize}px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(label, boxX + boxPad, boxY + boxH - boxPad);
      ctx.restore();
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
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
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
        color: '#111'
      });
    }
    if (!hasVisibleCells) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();
      ctx.fillStyle = '#6b7280';
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
    const outerPadding = 20;
    const titleHeight = title ? 34 : 0;
    const contentX = outerPadding;
    const contentY = outerPadding + titleHeight;
    const contentW = Math.max(1, canvasWidth - outerPadding * 2);
    const contentH = Math.max(1, canvasHeight - outerPadding * 2 - titleHeight);
    const { cols, rows } = computeGridDims(views.length || 1);
    const gap = 16;

    if (title) {
      const titleSize = Math.max(14, titleFontSize);
      ctx.save();
      ctx.fillStyle = '#111';
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillText(title, outerPadding + contentW / 2, outerPadding + titleSize);
      ctx.restore();
    }

    // Shared legend only if all panels use the same active field.
    let sharedLegendModel = null;
    let sharedFieldKey = null;
    if (includeLegend) {
      for (const v of views) {
        const scientificState = v.scientificState;
        const fieldKey = scientificState.fieldKey;
        if (fieldKey === null || scientificState.legendModel === null) {
          sharedFieldKey = null;
          sharedLegendModel = null;
          break;
        }
        if (sharedFieldKey == null) {
          sharedFieldKey = fieldKey;
          sharedLegendModel = scientificState.legendModel;
        } else if (
          sharedFieldKey !== fieldKey ||
          !areLegendModelsSemanticallyEqual(
            sharedLegendModel,
            scientificState.legendModel
          )
        ) {
          sharedFieldKey = null;
          sharedLegendModel = null;
          break;
        }
      }
    }

    const wantsSharedLegend =
      includeLegend &&
      sharedFieldKey !== null &&
      sharedLegendModel !== null;
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

      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cellX = gridX + col * cellW;
      const cellY = gridY + row * cellH;
      const {
        labelX,
        labelY,
        panelRect,
        plotRect,
      } = computeGridPaneLayout({
        cellX,
        cellY,
        cellWidth: cellW,
        cellHeight: cellH,
        includeAxes,
        fontSize: baseFontSize,
      });

      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();

      const renderState = view?.renderState || null;
      if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for PNG multiview render');

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
        pointSizePx: Math.max(1, pointDiameterViewportPx * viewportScale),
        overlayPoints: (includeCentroidPoints && hasCentroidPoints)
          ? {
            positions: centroidPositions,
            colors: centroidColors,
            pointSizePx: Math.max(1, centroidDiameterViewportPx * viewportScale),
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
          labelColor: '#111',
          haloColor: background === 'transparent' ? 'rgba(255,255,255,0.95)' : backgroundColor,
        });
      }

      ctx.restore();

      // Border.
      ctx.strokeStyle = '#e5e7eb';
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
          color: '#111',
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
        ctx.fillStyle = '#6b7280';
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

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        panelRect.x,
        panelRect.y,
        panelRect.width,
        panelRect.height
      );
      ctx.clip();
      ctx.fillStyle = '#111';
      ctx.font = `${baseFontSize}px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(
        `${String.fromCharCode(65 + idx)}. ${viewLabel}`,
        labelX,
        labelY
      );
      ctx.restore();
    }

    if (rendersSharedLegend && legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect,
        fieldKey: sharedFieldKey,
        model: sharedLegendModel,
        fontFamily,
        fontSize: legendFontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
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
