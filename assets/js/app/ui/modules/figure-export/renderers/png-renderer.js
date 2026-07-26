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
	import { computeVisibleRealBounds } from '../utils/coordinate-mapper.js';
	import { assertCropRect01, cropRect01ToPx } from '../utils/crop.js';
	import { embedPngTextChunks } from '../utils/png-metadata.js';
import { rasterizePointsWebgl } from '../utils/webgl-point-rasterizer.js';
import { getEffectivePointDiameterPx, getLodVisibilityMask } from '../utils/point-size.js';
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';
	import { computeLetterboxedRect } from '../utils/letterbox.js';
import { assertCameraState } from '../../../../../rendering/camera-state-contract.js';
import { assertFigureExportPayload } from '../figure-export-contract.js';

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

	function computeVisibleCameraBounds({
	  positions,
	  transparency = null,
	  visibilityMask = null,
	  mvpMatrix,
	  viewMatrix,
	  viewportWidth = 1,
	  viewportHeight = 1,
	  crop = null,
	}) {
	  if (!positions || !mvpMatrix || !viewMatrix) return null;

	  const n = Math.floor(positions.length / 3);
	  const m = mvpMatrix;
	  const v = viewMatrix;
	  const vw = Math.max(1, Number(viewportWidth) || 1);
	  const vh = Math.max(1, Number(viewportHeight) || 1);
	  const crop01 = assertCropRect01(crop);
	  const cropPx = cropRect01ToPx(crop01, vw, vh);
	  const hasCrop = Boolean(
	    cropPx &&
	      (cropPx.width < vw - 0.5 || cropPx.height < vh - 0.5 || cropPx.x > 0.5 || cropPx.y > 0.5)
	  );

	  let minX = Infinity;
	  let maxX = -Infinity;
	  let minY = Infinity;
	  let maxY = -Infinity;
	  let any = false;

	  for (let i = 0; i < n; i++) {
	    if (visibilityMask && (visibilityMask[i] ?? 0) <= 0) continue;
	    const rawAlpha = transparency ? (transparency[i] ?? 1.0) : 1.0;
	    let alpha = Number.isFinite(rawAlpha) ? rawAlpha : 1.0;
	    if (alpha < 0) alpha = 0;
	    else if (alpha > 1) alpha = 1;
	    if (alpha < 0.01) continue;

	    const ix = i * 3;
	    const x = positions[ix];
	    const y = positions[ix + 1];
	    const z = positions[ix + 2];

	    const clipX = m[0] * x + m[4] * y + m[8] * z + m[12];
	    const clipY = m[1] * x + m[5] * y + m[9] * z + m[13];
	    const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
	    if (!Number.isFinite(clipW) || clipW <= 0) continue;

	    const ndcX = clipX / clipW;
	    const ndcY = clipY / clipW;
	    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;

	    if (hasCrop && cropPx) {
	      const vx = (ndcX * 0.5 + 0.5) * vw;
	      const vy = (-ndcY * 0.5 + 0.5) * vh;
	      if (vx < cropPx.x || vx > cropPx.x + cropPx.width || vy < cropPx.y || vy > cropPx.y + cropPx.height) continue;
	    }

	    const camX = v[0] * x + v[4] * y + v[8] * z + v[12];
	    const camY = v[1] * x + v[5] * y + v[9] * z + v[13];
	    if (!Number.isFinite(camX) || !Number.isFinite(camY)) continue;
	    if (camX < minX) minX = camX;
	    if (camX > maxX) maxX = camX;
	    if (camY < minY) minY = camY;
	    if (camY > maxY) maxY = camY;
	    any = true;
	  }

	  if (!any) return null;
	  return { minX, maxX, minY, maxY };
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
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {any} options.payload
 * @returns {Promise<Blob>}
 */
export async function renderFigureToPngBlob({ state, viewer, payload }) {
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
  if (
    typeof state.getTotalHighlightedCellCount !== 'function' ||
    typeof state.getHighlightedCellCount !== 'function' ||
    typeof state.getFieldForView !== 'function' ||
    typeof state.getLegendModel !== 'function' ||
    typeof state.getViewDimensionLevel !== 'function' ||
    typeof state.dimensionManager?.getNormTransform !== 'function'
  ) {
    throw new TypeError('PNG export state is missing its exact current export methods.');
  }
  const totalHighlighted = state.getTotalHighlightedCellCount();
  const emphasizeSelection = opts.emphasizeSelection && totalHighlighted > 0;
  const highlightCount = emphasizeSelection
    ? state.getHighlightedCellCount()
    : totalHighlighted;
  const highlightArray = totalHighlighted > 0 ? state.highlightArray : null;

  const background = opts.background;
  const backgroundColor = background === 'custom'
    ? opts.backgroundColor
    : (background === 'viewer' ? viewerBgHex : '#ffffff');

  const singleView = views.length === 1;
  const singleViewId = singleView ? views[0].id : null;
  const singleLegendField = singleView && includeLegend
    ? state.getFieldForView(singleViewId)
    : null;
  const singleLegendModel = singleView && singleLegendField
    ? state.getLegendModel(singleLegendField)
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
    singleDim = state.getViewDimensionLevel(singleViewId);
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
    const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
    const pointDiameterViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim });
    const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
      ? opts.includeCentroidPoints
      : Boolean(centroidFlags?.points);
    const includeCentroidLabels = typeof opts.includeCentroidLabels === 'boolean'
      ? opts.includeCentroidLabels
      : Boolean(centroidFlags?.labels);

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
      visibilityMask,
      outputWidthPx: outW,
      outputHeightPx: outH,
      pointSizePx: Math.max(1, pointDiameterViewportPx * viewportScale),
      overlayPoints: (includeCentroidPoints && centroidPositions && centroidColors)
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

    centroidPointsRasterized = includeCentroidPoints &&
      Boolean(centroidPositions) &&
      Boolean(centroidColors);
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
        fieldKey: singleLegendField?.key || null,
        model: singleLegendModel,
        fontFamily,
        fontSize: legendFontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
    }

    // Axes (2D uses embedding coordinates; 3D uses camera-space coordinates).
    if (axesEligible && renderState) {
      const useCameraAxes = dim > 2 && navMode !== 'planar' && renderState?.viewMatrix;
      const bounds = (
        useCameraAxes
          ? computeVisibleCameraBounds({
            positions,
            transparency,
            visibilityMask,
            mvpMatrix: renderState.mvpMatrix,
            viewMatrix: renderState.viewMatrix,
            viewportWidth: renderState.viewportWidth,
            viewportHeight: renderState.viewportHeight,
            crop,
          })
          : computeVisibleRealBounds({
            positions,
            transparency,
            visibilityMask,
            mvpMatrix: renderState.mvpMatrix,
            viewportWidth: renderState.viewportWidth,
            viewportHeight: renderState.viewportHeight,
            crop,
            normTransform: state.dimensionManager.getNormTransform(dim)
          })
      );
      if (bounds === null) {
        throw new Error('PNG axes require at least one visible point.');
      }
      drawCanvasAxes({
        ctx,
        plotRect,
        bounds,
        xLabel: opts.xLabel,
        yLabel: opts.yLabel,
        fontFamily,
        tickFontSize,
        labelFontSize: axisLabelFontSize,
        color: '#111'
      });
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
    const cellPadding = 10;

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
    let sharedField = null;
    let sharedFieldKey = null;
    if (includeLegend && typeof state.getFieldForView === 'function') {
      for (const v of views) {
        const f = state.getFieldForView(String(v?.id || 'live'));
        if (!f) {
          sharedFieldKey = null;
          sharedField = null;
          break;
        }
        if (sharedFieldKey == null) {
          sharedFieldKey = f.key || null;
          sharedField = f;
        } else if (sharedFieldKey !== (f.key || null)) {
          sharedFieldKey = null;
          sharedField = null;
          break;
        }
      }
    }

    const wantsSharedLegend = includeLegend && Boolean(sharedFieldKey) && sharedField;
    const legendW = wantsSharedLegend && legendPosition === 'right' ? 240 : 0;
    const legendH = wantsSharedLegend && legendPosition === 'bottom' ? 140 : 0;

    const gridW = Math.max(1, contentW - (legendW ? (gap + legendW) : 0));
    const gridH = Math.max(1, contentH - (legendH ? (gap + legendH) : 0));
    const gridX = contentX;
    const gridY = contentY;
    const cellW = gridW / cols;
    const cellH = gridH / rows;

    const legendRect = wantsSharedLegend
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
      const plotRect = {
        x: cellX + cellPadding,
        y: cellY + cellPadding,
        width: Math.max(1, cellW - cellPadding * 2),
        height: Math.max(1, cellH - cellPadding * 2),
      };

      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();

      const renderState = view?.renderState || null;
      if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for PNG multiview render');

      const dim = state.getViewDimensionLevel(viewId);
      const navMode = assertCameraState(
        view.cameraState,
        `PNG camera state for "${viewId}"`
      ).navigationMode;
      const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
      const pointDiameterViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim });
      const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
        ? opts.includeCentroidPoints
        : Boolean(centroidFlags?.points);
      const includeCentroidLabels = typeof opts.includeCentroidLabels === 'boolean'
        ? opts.includeCentroidLabels
        : Boolean(centroidFlags?.labels);

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
        visibilityMask,
        outputWidthPx: outW,
        outputHeightPx: outH,
        pointSizePx: Math.max(1, pointDiameterViewportPx * viewportScale),
        overlayPoints: (includeCentroidPoints && centroidPositions && centroidColors)
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

      centroidPointsRasterized = includeCentroidPoints &&
        Boolean(centroidPositions) &&
        Boolean(centroidColors);
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

      ctx.fillStyle = '#111';
      ctx.font = `${baseFontSize}px ${fontFamily}`;
      ctx.fillText(`${String.fromCharCode(65 + idx)}. ${viewLabel}`, plotRect.x, plotRect.y - 4);
    }

    if (wantsSharedLegend && legendRect) {
      const model = sharedField && typeof state.getLegendModel === 'function' ? state.getLegendModel(sharedField) : null;
      drawCanvasLegend({
        ctx,
        legendRect,
        fieldKey: sharedFieldKey,
        model,
        fontFamily,
        fontSize: legendFontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
    }
  }

  ctx.restore();

  const rawBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG encoding failed.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });

  return embedPngTextChunks(
    rawBlob,
    buildPngTextMetadata(payload.meta, payload)
  );
}
