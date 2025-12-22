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
import { computeVisibleRealBounds } from '../utils/coordinate-mapper.js';
import { reducePointsByDensity } from '../utils/density-reducer.js';
import { embedPngTextChunks } from '../utils/png-metadata.js';
import { hashStringToSeed } from '../utils/hash.js';
import { rasterizePointsWebgl } from '../utils/webgl-point-rasterizer.js';
import { clamp, parseNumberOr } from '../../../../utils/number-utils.js';

/**
 * Get point radius from render state for WYSIWYG export.
 * The viewer's pointSize is a diameter; we return radius (diameter / 2).
 * @param {object|null} renderState
 * @returns {number} radius in logical pixels
 */
function getPointRadiusFromRenderState(renderState) {
  const pointSize = renderState?.pointSize;
  if (typeof pointSize === 'number' && Number.isFinite(pointSize) && pointSize > 0) {
    return pointSize / 2; // Convert diameter to radius
  }
  return 2.5; // Fallback: 5px diameter → 2.5px radius
}

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
  const fontSize = Math.max(6, Math.round(opts.fontSizePx || 12));
  // Point size comes from the viewer's render state (WYSIWYG) - see getPointRadiusFromRenderState below
  const includeAxes = opts.includeAxes !== false;
  const includeLegend = opts.includeLegend !== false;
  const legendPosition = opts.legendPosition === 'bottom' ? 'bottom' : 'right';
  const strategy = opts.strategy || 'full-vector';
  const showOrientation = opts.showOrientation !== false;
  const depthSort3d = opts.depthSort3d !== false;
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

  // Compute actual output dimensions based on desired plot size and annotations
  let canvasWidth, canvasHeight;

  if (singleView) {
    const view = views[0];
    const viewId = String(view?.id || 'live');
    const cameraState = view?.cameraState || viewer?.getViewCameraState?.(viewId) || viewer?.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';
    const dim = typeof state?.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(viewId)
      : (state?.getDimensionLevel?.() ?? 3);
    const axesEligible = includeAxes && dim <= 2 && navMode === 'planar';

    const preLayout = computeSingleViewLayout({
      width: desiredPlotWidth,
      height: desiredPlotHeight,
      title,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition
    });

    // Use expanded dimensions for canvas
    canvasWidth = preLayout.totalWidth;
    canvasHeight = preLayout.totalHeight;
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
    const viewId = String(view?.id || 'live');
    const data = view?.data || {};
    const positions = data.positions || null;
    const colors = data.colors || null;
    const transparency = data.transparency || null;

    const renderState = view?.renderState || (
      typeof viewer.getViewRenderState === 'function'
        ? viewer.getViewRenderState(viewId)
        : (typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null)
    );

    const dim = typeof state.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(viewId)
      : (state.getDimensionLevel?.() ?? 3);
    const cameraState = view?.cameraState || viewer.getViewCameraState?.(viewId) || viewer.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';
    const axesEligible = includeAxes && dim <= 2 && navMode === 'planar';
    const shouldDepthSort = depthSort3d && dim > 2 && navMode !== 'planar';

    // WYSIWYG: Get point size from viewer's render state
    const pointRadiusPx = getPointRadiusFromRenderState(renderState);

    // Compute layout with desired plot dimensions (returns expanded total dimensions)
    const layout = computeSingleViewLayout({
      width: desiredPlotWidth,
      height: desiredPlotHeight,
      title,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition
    });

    if (title) {
      const titleSize = Math.max(14, Math.round(fontSize * 1.25));
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
        renderState,
        targetCount: Math.max(1000, Math.floor(opts.optimizedTargetCount || 100000)),
        seed: hashStringToSeed(payload?.meta?.datasetId || payload?.meta?.datasetName || viewId)
      });

      const viewportW = reduced.viewportWidth;
      const viewportH = reduced.viewportHeight;
      const s = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
      const ox = plotRect.x + (plotRect.width - viewportW * s) / 2;
      const oy = plotRect.y + (plotRect.height - viewportH * s) / 2;
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
      const webglCanvas = rasterizePointsWebgl({
        positions,
        colors,
        transparency,
        renderState,
        outputWidthPx: Math.max(1, Math.round(plotRect.width * scale)),
        outputHeightPx: Math.max(1, Math.round(plotRect.height * scale)),
        pointSizePx: Math.max(1, pointRadiusPx * 2 * scale),
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity
      });

      if (webglCanvas) {
        // WebGL rasterizer succeeded - draw 3D-shaded points
        ctx.drawImage(webglCanvas, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      } else {
        // WebGL rasterizer returned null - fall back to Canvas2D flat circles
        // This happens when: positions/colors are missing, matrices are missing, or WebGL2 unavailable
        console.debug('[FigureExport] PNG renderer: using Canvas2D fallback (flat circles, not 3D spheres)');

        const result = forEachProjectedPoint({
          positions,
          colors,
          transparency,
          renderState,
          plotRect,
          radiusPx: pointRadiusPx,
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

    if (showOrientation && renderState?.viewMatrix && dim > 2 && navMode !== 'planar') {
      drawCanvasOrientationIndicator({
        ctx,
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: Math.max(10, Math.round(fontSize * 0.92))
      });
    }

    if (emphasizeSelection && highlightCount > 0) {
      const label = `n = ${highlightCount.toLocaleString()} selected`;
      const boxPad = 6;
      const boxH = Math.max(16, Math.round(fontSize * 1.35));
      const boxW = Math.min(
        Math.max(1, plotRect.width - 16),
        Math.max(90, Math.round(label.length * (fontSize * 0.62) + boxPad * 2))
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
      ctx.font = `${fontSize}px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(label, boxX + boxPad, boxY + boxH - boxPad);
      ctx.restore();
    }

    // Legend.
    if (includeLegend && layout.legendRect) {
      const field = typeof state.getFieldForView === 'function'
        ? state.getFieldForView(viewId)
        : (typeof state.getActiveField === 'function' ? state.getActiveField() : null);
      const model = field && typeof state.getLegendModel === 'function' ? state.getLegendModel(field) : null;
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        fieldKey: field?.key || null,
        model,
        fontFamily,
        fontSize,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
    }

    // Axes (2D planar exports only, to avoid misleading axes in 3D projections).
    if (axesEligible && renderState && state?.dimensionManager?.getNormTransform) {
        const norm = state.dimensionManager.getNormTransform(dim);
        const bounds = computeVisibleRealBounds({
          positions,
          transparency,
          mvpMatrix: renderState.mvpMatrix,
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
            fontSize,
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
      const titleSize = Math.max(14, Math.round(fontSize * 1.25));
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

      const renderState = typeof viewer.getViewRenderState === 'function'
        ? (view?.renderState || viewer.getViewRenderState(viewId))
        : (typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null);

      // WYSIWYG: Get point size from viewer's render state
      const pointRadiusPx = getPointRadiusFromRenderState(renderState);

      const webglCanvas = rasterizePointsWebgl({
        positions,
        colors,
        transparency,
        renderState,
        outputWidthPx: Math.max(1, Math.round(plotRect.width * scale)),
        outputHeightPx: Math.max(1, Math.round(plotRect.height * scale)),
        pointSizePx: Math.max(1, pointRadiusPx * 2 * scale),
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity
      });

      if (webglCanvas) {
        // WebGL rasterizer succeeded for this view panel
        ctx.drawImage(webglCanvas, plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      } else {
        // WebGL rasterizer returned null - fall back to Canvas2D flat circles
        console.debug(`[FigureExport] PNG multi-view panel ${idx}: using Canvas2D fallback`);

        const result = forEachProjectedPoint({
          positions,
          colors,
          transparency,
          renderState,
          plotRect,
          radiusPx: pointRadiusPx,
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

        // Log if no points were drawn in this view panel
        if (result.drawn === 0) {
          console.warn(`[FigureExport] PNG multi-view panel ${idx}: 0 points drawn!`, { viewId });
        }
      }

      ctx.restore();

      // Border.
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

      ctx.fillStyle = '#111';
      ctx.font = `12px ${fontFamily}`;
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
        fontSize,
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
