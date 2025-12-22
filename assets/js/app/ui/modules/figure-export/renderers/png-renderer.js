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
 * - Falls back to Canvas2D flat circles if WebGL2 unavailable or data missing
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
 * POINT RENDERING STRATEGIES:
 * 1. WebGL2 rasterizer (preferred): 3D sphere shading matching viewer
 * 2. Canvas2D fallback: Flat circles when WebGL2 unavailable
 * 3. Optimized-vector mode: Density-preserving reduction for large datasets
 *
 * CROSS-BROWSER COMPATIBILITY:
 * - Uses OffscreenCanvas when available (faster, worker-friendly)
 * - Falls back to HTMLCanvasElement for broader compatibility
 * - Both toBlob and convertToBlob supported
 *
 * METADATA:
 * PNG files include tEXt chunks with dataset info, export timestamp,
 * and JSON-encoded metadata for programmatic access.
 *
 * @module ui/modules/figure-export/renderers/png-renderer
 */

import { forEachProjectedPoint } from '../utils/point-projector.js';
import { computeSingleViewLayout, computeGridDims } from '../utils/layout.js';
import { drawCanvasAxes } from '../components/axes-builder.js';
import { drawCanvasLegend } from '../components/legend-builder.js';
import { drawCanvasOrientationIndicator } from '../components/orientation-indicator.js';
import { drawCanvasCentroidOverlay } from '../components/centroid-overlay.js';
import { computeVisibleRealBounds } from '../utils/coordinate-mapper.js';
import { cropRect01ToPx, normalizeCropRect01 } from '../utils/crop.js';
import { reducePointsByDensity } from '../utils/density-reducer.js';
import { embedPngTextChunks } from '../utils/png-metadata.js';
import { hashStringToSeed } from '../utils/hash.js';
import { rasterizePointsWebgl } from '../utils/webgl-point-rasterizer.js';
import { getEffectivePointDiameterPx, getLodVisibilityMask } from '../utils/point-size.js';
import { clamp, parseNumberOr } from '../../../../utils/number-utils.js';
import { computeLetterboxedRect } from '../utils/letterbox.js';

function buildPngTextMetadata(meta) {
  const dataset = meta?.datasetName || meta?.datasetId || '';
  const descriptionParts = [];
  if (meta?.fieldKey) descriptionParts.push(`Field: ${meta.fieldKey}`);
  if (meta?.viewLabel) descriptionParts.push(`View: ${meta.viewLabel}`);
  if (Array.isArray(meta?.filters) && meta.filters.length) {
    const lines = meta.filters.filter((l) => l && !/No filters active/i.test(String(l)));
    if (lines.length) descriptionParts.push(`Filters: ${lines.join('; ')}`);
  }
  const description = descriptionParts.join(' • ');

  const comment = JSON.stringify(
    {
      datasetName: meta?.datasetName || null,
      datasetId: meta?.datasetId || null,
      sourceType: meta?.sourceType || null,
      fieldKey: meta?.fieldKey || null,
      fieldKind: meta?.fieldKind || null,
      viewId: meta?.viewId || null,
      exportedAt: meta?.exportedAt || null,
    },
    null,
    0
  );

  return {
    Software: 'Cellucid',
    'Creation Time': String(meta?.exportedAt || new Date().toISOString()),
    ...(dataset ? { Source: String(dataset) } : {}),
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
  // User-specified dimensions represent desired PLOT content size
  const desiredPlotWidth = Math.max(1, Math.round(payload?.width || 1200));
  const desiredPlotHeight = Math.max(1, Math.round(payload?.height || 900));
  const dpi = Math.max(72, Math.round(payload?.dpi || 300));
  const title = String(payload?.title || '').trim();
  const opts = payload?.options || {};
  const views = Array.isArray(payload?.views) ? payload.views : [];

  const fontFamily = String(opts.fontFamily || 'Arial, Helvetica, sans-serif');
  const baseFontSize = Math.max(6, Math.round(parseNumberOr(opts.fontSizePx, 12)));
  const legendFontSize = Math.max(6, Math.round(parseNumberOr(opts.legendFontSizePx, baseFontSize)));
  const tickFontSize = Math.max(6, Math.round(parseNumberOr(opts.tickFontSizePx, baseFontSize)));
  const axisLabelFontSize = Math.max(6, Math.round(parseNumberOr(opts.axisLabelFontSizePx, baseFontSize)));
  const titleFontSize = Math.max(10, Math.round(parseNumberOr(opts.titleFontSizePx, Math.max(14, baseFontSize * 1.25))));
  const centroidLabelFontSize = Math.max(6, Math.round(parseNumberOr(opts.centroidLabelFontSizePx, baseFontSize)));
  // Point size comes from the interactive viewer (WYSIWYG).
  const includeAxes = opts.includeAxes !== false;
  const includeLegend = opts.includeLegend !== false;
  const legendPosition = opts.legendPosition === 'bottom' ? 'bottom' : 'right';
  const strategy = opts.strategy || 'full-vector';
  const showOrientation = opts.showOrientation !== false;
  const depthSort3d = opts.depthSort3d !== false;
  const crop = opts.crop || null;
  const crop01 = normalizeCropRect01(crop);
  const selectionMutedOpacity = clamp(parseNumberOr(opts.selectionMutedOpacity, 0.15), 0, 1);
  const totalHighlighted = typeof state?.getTotalHighlightedCellCount === 'function'
    ? state.getTotalHighlightedCellCount()
    : 0;
  const emphasizeSelection = opts.emphasizeSelection === true && totalHighlighted > 0;
  const highlightCount = emphasizeSelection && typeof state?.getHighlightedCellCount === 'function'
    ? state.getHighlightedCellCount()
    : totalHighlighted;
  const highlightArray = emphasizeSelection ? (state?.highlightArray || null) : null;

  const background = opts.background || 'white';
  const backgroundColor = background === 'custom'
    ? String(opts.backgroundColor || '#ffffff')
    : '#ffffff';

  const singleView = views.length === 1;
  const singleViewId = singleView ? String(views[0]?.id || 'live') : null;
  const singleLegendField = singleView && includeLegend && typeof state.getFieldForView === 'function'
    ? state.getFieldForView(singleViewId)
    : (singleView && includeLegend && typeof state.getActiveField === 'function' ? state.getActiveField() : null);
  const singleLegendModel = singleView && singleLegendField && typeof state.getLegendModel === 'function'
    ? state.getLegendModel(singleLegendField)
    : null;

  // Compute actual output dimensions based on desired plot size and annotations
  let canvasWidth, canvasHeight;
  /** @type {ReturnType<typeof computeSingleViewLayout> | null} */
  let singleLayout = null;
  let singleAxesEligible = false;
  let singleDim = 3;
  let singleNavMode = 'orbit';
  let singleCameraState = null;

  if (singleView) {
    const view = views[0];
    singleCameraState = view?.cameraState || viewer?.getViewCameraState?.(singleViewId) || viewer?.getCameraState?.() || null;
    singleNavMode = singleCameraState?.navigationMode || 'orbit';
    singleDim = typeof state?.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(singleViewId)
      : (state?.getDimensionLevel?.() ?? 3);
    // Allow axes when the camera is locked to a 2D planar navigation mode, even if the
    // underlying embedding is stored as 3D (e.g., z=0 but rendered with 3D shading).
    singleAxesEligible = includeAxes && (singleDim <= 2 || singleNavMode === 'planar');

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

  /** @type {OffscreenCanvas|HTMLCanvasElement} */
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(pxW, pxH)
    : (() => {
      const c = document.createElement('canvas');
      c.width = pxW;
      c.height = pxH;
      return c;
    })();

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
    const cameraState = singleCameraState || view?.cameraState || null;
    const navMode = singleNavMode;
    const axesEligible = singleAxesEligible;
    const shouldDepthSort = depthSort3d && dim > 2 && navMode !== 'planar';

    const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
    const pointDiameterViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim });
    const pointRadiusViewportPx = pointDiameterViewportPx / 2;
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
      ctx.fillStyle = '#111';
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, layout.titleRect?.x ?? layout.outerPadding, (layout.titleRect?.y ?? layout.outerPadding) + titleSize);
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

    if (strategy === 'optimized-vector' && renderState) {
      const reduced = reducePointsByDensity({
        positions,
        colors,
        transparency,
        visibilityMask,
        renderState,
        targetCount: Math.max(1000, Math.floor(opts.optimizedTargetCount || 100000)),
        seed: hashStringToSeed(payload?.meta?.datasetId || payload?.meta?.datasetName || viewId),
        crop
      });

      const viewportW = reduced.viewportWidth;
      const viewportH = reduced.viewportHeight;
      const s = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
      const ox = plotRect.x + (plotRect.width - viewportW * s) / 2;
      const oy = plotRect.y + (plotRect.height - viewportH * s) / 2;
      const pointRadiusPx = pointRadiusViewportPx * s;
      const outN = reduced.x.length;

      for (let i = 0; i < outN; i++) {
        let a = reduced.alpha[i] ?? 1.0;
        const srcIndex = reduced.index?.[i] ?? i;
        const x = ox + reduced.x[i] * s;
        const y = oy + reduced.y[i] * s;
        const j = i * 4;
        let r = reduced.rgba[j];
        let g = reduced.rgba[j + 1];
        let b = reduced.rgba[j + 2];
        if (emphasizeSelection && highlightArray && (highlightArray[srcIndex] ?? 0) <= 0) {
          r = 160;
          g = 160;
          b = 160;
          a *= selectionMutedOpacity;
        }
        if (a < 0.01) continue;
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        if (pointRadiusPx <= 1) {
          const sz = pointRadiusPx * 2;
          ctx.fillRect(x - pointRadiusPx, y - pointRadiusPx, sz, sz);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, pointRadiusPx, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      const outW = Math.max(1, Math.round(plotRect.width * scale));
      const outH = Math.max(1, Math.round(plotRect.height * scale));
      const srcViewportW = Math.max(1, Math.round(renderState?.viewportWidth || 1));
      const srcViewportH = Math.max(1, Math.round(renderState?.viewportHeight || 1));
      const viewportScale = computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: outW, dstHeight: outH }).scale;
      const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));

      const webglCanvas = rasterizePointsWebgl({
        positions,
        colors,
        transparency,
        renderState,
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

      if (webglCanvas) {
        // WebGL rasterizer succeeded - draw shader-accurate points.
        centroidPointsRasterized = includeCentroidPoints && Boolean(centroidPositions) && Boolean(centroidColors);
        if (crop01 && renderState?.viewportWidth && renderState?.viewportHeight) {
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
          ctx.drawImage(webglCanvas, sx, sy, sw, sh, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        } else {
          ctx.drawImage(webglCanvas, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        }
      } else {
        // WebGL rasterizer returned null - fall back to Canvas2D flat circles.
        const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
        const cropW = cropPx ? cropPx.width : srcViewportW;
        const cropH = cropPx ? cropPx.height : srcViewportH;
        const radiusPlot = pointRadiusViewportPx * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;

        const result = forEachProjectedPoint({
          positions,
          colors,
          transparency,
          renderState,
          plotRect,
          radiusPx: radiusPlot,
          visibilityMask,
          crop,
          sortByDepth: shouldDepthSort,
          onPoint: (x, y, r, g, b, a, radius, index) => {
            let rr = r;
            let gg = g;
            let bb = b;
            let aa = a;
            if (emphasizeSelection && highlightArray && (highlightArray[index] ?? 0) <= 0) {
              rr = 160;
              gg = 160;
              bb = 160;
              aa = aa * selectionMutedOpacity;
            }
            if (aa < 0.01) return;
            ctx.fillStyle = `rgba(${rr},${gg},${bb},${aa})`;
            if (radius <= 1) {
              const sz = radius * 2;
              ctx.fillRect(x - radius, y - radius, sz, sz);
            } else {
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        });

        // Log if no points were drawn (helps diagnose missing data issues)
        if (result.drawn === 0) {
          console.warn(
            '[FigureExport] PNG renderer: 0 points drawn!',
            { hasPositions: !!positions, positionsLength: positions?.length,
              hasColors: !!colors, colorsLength: colors?.length,
              hasMvpMatrix: !!renderState?.mvpMatrix, skipped: result.skipped }
          );
        }
      }
    }

    ctx.restore();

    if ((includeCentroidPoints || includeCentroidLabels) && renderState) {
      const crop01 = normalizeCropRect01(crop);
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
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: Math.max(10, Math.round(baseFontSize * 0.92))
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

    // Axes (2D exports only; avoid misleading axes in 3D projections).
    if (axesEligible && renderState && state?.dimensionManager?.getNormTransform) {
        const norm = state.dimensionManager.getNormTransform(dim);
        const bounds = computeVisibleRealBounds({
          positions,
          transparency,
          visibilityMask,
          mvpMatrix: renderState.mvpMatrix,
          viewportWidth: renderState.viewportWidth,
          viewportHeight: renderState.viewportHeight,
          crop,
          normTransform: norm
        });
        if (bounds) {
          drawCanvasAxes({
            ctx,
            plotRect,
            bounds,
            xLabel: String(opts.xLabel || 'X'),
            yLabel: String(opts.yLabel || 'Y'),
            fontFamily,
            tickFontSize,
            labelFontSize: axisLabelFontSize,
            color: '#111'
          });
        }
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
      ctx.fillStyle = '#111';
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, outerPadding, outerPadding + titleSize);
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

      const dim = typeof state.getViewDimensionLevel === 'function'
        ? state.getViewDimensionLevel(viewId)
        : (state.getDimensionLevel?.() ?? 3);
      const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
      const pointDiameterViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim });
      const pointRadiusViewportPx = pointDiameterViewportPx / 2;
      const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
        ? opts.includeCentroidPoints
        : Boolean(centroidFlags?.points);
      const includeCentroidLabels = typeof opts.includeCentroidLabels === 'boolean'
        ? opts.includeCentroidLabels
        : Boolean(centroidFlags?.labels);

      const outW = Math.max(1, Math.round(plotRect.width * scale));
      const outH = Math.max(1, Math.round(plotRect.height * scale));
      const srcViewportW = Math.max(1, Math.round(renderState?.viewportWidth || 1));
      const srcViewportH = Math.max(1, Math.round(renderState?.viewportHeight || 1));
      const viewportScale = computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: outW, dstHeight: outH }).scale;
      const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
      const cropW = cropPx ? cropPx.width : srcViewportW;
      const cropH = cropPx ? cropPx.height : srcViewportH;
      const plotScale = computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;
      const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));
      const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * plotScale);
      let centroidPointsRasterized = false;

      const webglCanvas = rasterizePointsWebgl({
        positions,
        colors,
        transparency,
        renderState,
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

      if (webglCanvas) {
        // WebGL rasterizer succeeded for this view panel
        centroidPointsRasterized = includeCentroidPoints && Boolean(centroidPositions) && Boolean(centroidColors);
        if (crop01 && renderState?.viewportWidth && renderState?.viewportHeight) {
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
          ctx.drawImage(webglCanvas, sx, sy, sw, sh, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        } else {
          ctx.drawImage(webglCanvas, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
        }
      } else {
        // WebGL rasterizer returned null - fall back to Canvas2D flat circles
        const radiusPlot = pointRadiusViewportPx * plotScale;

        const result = forEachProjectedPoint({
          positions,
          colors,
          transparency,
          renderState,
          plotRect,
          radiusPx: radiusPlot,
          visibilityMask,
          crop,
          sortByDepth: depthSort3d && (typeof state.getViewDimensionLevel === 'function'
            ? state.getViewDimensionLevel(viewId)
            : (state.getDimensionLevel?.() ?? 3)) > 2 &&
            ((view?.cameraState || viewer.getViewCameraState?.(viewId) || viewer.getCameraState?.())?.navigationMode || 'orbit') !== 'planar',
          onPoint: (x, y, r, g, b, a, radius, index) => {
            let rr = r;
            let gg = g;
            let bb = b;
            let aa = a;
            if (emphasizeSelection && highlightArray && (highlightArray[index] ?? 0) <= 0) {
              rr = 160;
              gg = 160;
              bb = 160;
              aa = aa * selectionMutedOpacity;
            }
            if (aa < 0.01) return;
            ctx.fillStyle = `rgba(${rr},${gg},${bb},${aa})`;
            if (radius <= 1) {
              const sz = radius * 2;
              ctx.fillRect(x - radius, y - radius, sz, sz);
            } else {
              ctx.beginPath();
              ctx.arc(x, y, radius, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        });

        // If WebGL2 is unavailable, draw centroids as Canvas2D overlays.
        // (When WebGL succeeds we already rasterize centroid points in a single pass.)
        drawCanvasCentroidOverlay({
          ctx,
          positions: centroidPositions,
          colors: centroidColors,
          labelTexts: centroidLabelTexts,
          flags: { points: includeCentroidPoints, labels: includeCentroidLabels },
          renderState,
          plotRect,
          pointRadiusPx: centroidRadiusPlotPx,
          crop,
          fontFamily,
          labelFontSizePx: centroidLabelFontSize,
          labelColor: '#111',
          haloColor: background === 'transparent' ? 'rgba(255,255,255,0.95)' : backgroundColor,
        });

        // Log if no points were drawn in this view panel
        if (result.drawn === 0) {
          console.warn(`[FigureExport] PNG multi-view panel ${idx}: 0 points drawn!`, { viewId });
        }
      }

      if (webglCanvas && (includeCentroidPoints || includeCentroidLabels)) {
        // WebGL rendered centroid points; draw labels (and CPU points only if needed) on top.
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

  const rawBlob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => {
      const htmlCanvas = /** @type {HTMLCanvasElement} */ (canvas);
      htmlCanvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to encode PNG'));
          return;
        }
        resolve(blob);
      }, 'image/png');
    });

  const meta = payload?.meta || null;
  return embedPngTextChunks(rawBlob, buildPngTextMetadata(meta));
}
