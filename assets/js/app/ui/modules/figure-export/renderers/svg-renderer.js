/**
 * @fileoverview SVG renderer for figure export.
 *
 * PURPOSE:
 * Generates publication-quality SVG figures that can be edited in vector
 * graphics software (Illustrator, Inkscape, etc.) for journal submissions.
 *
 * ARCHITECTURE:
 * - Generates SVG as a string (no DOM manipulation) for performance
 * - Supports 4 export strategies based on dataset size and editability needs
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
 * 3. HYBRID ('hybrid') [RECOMMENDED for 3D]:
 *    - Points rasterized as embedded PNG using WebGL shaders
 *    - Annotations remain vector (editable text, crisp at any zoom)
 *    - Best for: Large datasets (>200k) or when 3D shading is important
 *    - Produces WYSIWYG output matching the viewer's 3D appearance
 *
 * 4. RASTER ('raster'):
 *    - Redirects to PNG renderer (no SVG produced)
 *    - Best for: Maximum compatibility, no editability needed
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
 * - Font stacks use web-safe fallbacks
 *
 * @module ui/modules/figure-export/renderers/svg-renderer
 */

import { escapeHtml } from '../../../../utils/dom-utils.js';
import { forEachProjectedPoint } from '../utils/point-projector.js';
import { computeSingleViewLayout, computeGridDims } from '../utils/layout.js';
import { renderSvgAxes } from '../components/axes-builder.js';
import { renderSvgLegend } from '../components/legend-builder.js';
import { renderSvgOrientationIndicator } from '../components/orientation-indicator.js';
import { computeVisibleRealBounds } from '../utils/coordinate-mapper.js';
import { reducePointsByDensity } from '../utils/density-reducer.js';
import { blobToDataUrl } from '../utils/export-helpers.js';
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

function buildSvgMetadata(meta) {
  const dataset = meta?.datasetName || meta?.datasetId || '';
  const descriptionParts = [];
  if (meta?.fieldKey) descriptionParts.push(`Field: ${meta.fieldKey}`);
  if (Array.isArray(meta?.filters) && meta.filters.length) {
    const lines = meta.filters.filter((l) => l && !/No filters active/i.test(String(l)));
    if (lines.length) descriptionParts.push(`Filters: ${lines.join('; ')}`);
  }
  const description = descriptionParts.join(' • ');

  return `<metadata>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/">
    <rdf:Description rdf:about="">
      <dc:creator>Cellucid</dc:creator>
      <dc:date>${escapeHtml(meta?.exportedAt || new Date().toISOString())}</dc:date>
      ${dataset ? `<dc:source>${escapeHtml(dataset)}</dc:source>` : ''}
      ${description ? `<dc:description>${escapeHtml(description)}</dc:description>` : ''}
    </rdf:Description>
  </rdf:RDF>
</metadata>`;
}

/**
 * Rasterize points to a data URL for embedding in SVG (hybrid mode).
 *
 * First attempts WebGL2 rasterizer for 3D-shaded spheres matching the viewer.
 * Falls back to Canvas2D flat circles if WebGL2 unavailable or matrices missing.
 *
 * @param {object} options
 * @returns {Promise<string|null>} Base64 data URL of PNG, or null if data missing
 */
async function rasterizePointsToDataUrl({
  positions,
  colors,
  transparency,
  renderState,
  plotRect,
  radiusPx,
  seed = 0,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  sortByDepth = false,
  maxSortedPoints = 200000
}) {
  // Early validation - cannot rasterize without basic data
  if (!positions || !colors || !renderState?.mvpMatrix) {
    console.warn('[FigureExport] SVG hybrid rasterization skipped - missing data:', {
      hasPositions: !!positions,
      hasColors: !!colors,
      hasMvpMatrix: !!renderState?.mvpMatrix
    });
    return null;
  }

  const rasterScale = 2;
  const pxW = Math.max(1, Math.round(plotRect.width * rasterScale));
  const pxH = Math.max(1, Math.round(plotRect.height * rasterScale));

  const webglCanvas = rasterizePointsWebgl({
    positions,
    colors,
    transparency,
    renderState,
    outputWidthPx: pxW,
    outputHeightPx: pxH,
    pointSizePx: Math.max(1, Number(radiusPx || 1.5) * 2 * rasterScale),
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity
  });

  if (webglCanvas) {
    // WebGL rasterizer succeeded - 3D shading preserved
    console.debug('[FigureExport] SVG hybrid: WebGL rasterization succeeded (3D shading preserved)');
    const blob = typeof webglCanvas.convertToBlob === 'function'
      ? await webglCanvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => {
        /** @type {HTMLCanvasElement} */ (webglCanvas).toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
          'image/png'
        );
      });
    return blobToDataUrl(blob);
  }

  // WebGL rasterizer returned null - fall back to Canvas2D flat circles
  // This happens when viewMatrix/projectionMatrix/modelMatrix are missing
  console.debug('[FigureExport] SVG hybrid: using Canvas2D fallback (flat circles, not 3D spheres)');

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
  if (!ctx) return null;

  ctx.save();
  ctx.scale(rasterScale, rasterScale);

  // Simple deterministic jitter to reduce overplotting artifacts.
  const jitter = (seed % 7) * 0.03;
  const mutedAlpha = clamp(parseNumberOr(selectionMutedOpacity, 0.15), 0, 1);

  const localPlot = { x: 0, y: 0, width: plotRect.width, height: plotRect.height };

  forEachProjectedPoint({
    positions,
    colors,
    transparency,
    renderState,
    plotRect: localPlot,
    radiusPx,
    sortByDepth,
    maxSortedPoints,
    onPoint: (x, y, r, g, b, a, radius, index) => {
      let rr = r;
      let gg = g;
      let bb = b;
      let aa = a;

      if (emphasizeSelection && highlightArray && (highlightArray[index] ?? 0) <= 0) {
        rr = 160;
        gg = 160;
        bb = 160;
        aa = aa * mutedAlpha;
      }

      if (aa < 0.01) return;

      const px = x + jitter;
      const py = y + jitter;
      ctx.fillStyle = `rgba(${rr},${gg},${bb},${aa})`;
      if (radius <= 1) {
        const s = radius * 2;
        ctx.fillRect(px - radius, py - radius, s, s);
      } else {
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });

  ctx.restore();

  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => {
      /** @type {HTMLCanvasElement} */ (canvas).toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    });

  return blobToDataUrl(blob);
}

/**
 * Render figure to SVG blob.
 *
 * IMPORTANT: The payload.width and payload.height are interpreted as the desired
 * PLOT CONTENT size. The actual SVG dimensions will be LARGER to accommodate
 * legend, axes, and title without shrinking the plot area.
 *
 * @param {object} options
 * @param {import('../../../state/core/data-state.js').DataState} options.state
 * @param {object} options.viewer
 * @param {any} options.payload
 * @returns {Promise<{ blob: Blob; suggestedExt: string }>}
 */
export async function renderFigureToSvgBlob({ state, viewer, payload }) {
  // User-specified dimensions represent desired PLOT content size
  const desiredPlotWidth = Math.max(1, Math.round(payload?.width || 1200));
  const desiredPlotHeight = Math.max(1, Math.round(payload?.height || 900));
  const title = String(payload?.title || '').trim();
  const opts = payload?.options || {};
  const meta = payload?.meta || {};
  const views = Array.isArray(payload?.views) ? payload.views : [];

  const includeAxes = opts.includeAxes !== false;
  const includeLegend = opts.includeLegend !== false;
  const legendPosition = opts.legendPosition === 'bottom' ? 'bottom' : 'right';
  const strategy = opts.strategy || 'full-vector';
  const showOrientation = opts.showOrientation !== false;
  const depthSort3d = opts.depthSort3d !== false;

  const fontFamily = String(opts.fontFamily || 'Arial, Helvetica, sans-serif');
  const fontSize = Math.max(6, Math.round(opts.fontSizePx || 12));
  // Point size comes from the viewer's render state (WYSIWYG) - see getPointRadiusFromRenderState
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

  // For single view, compute layout first to get the expanded total dimensions
  let svgWidth, svgHeight;

  if (singleView) {
    const view = views[0];
    const viewId = String(view?.id || 'live');
    const cameraState = view?.cameraState || viewer?.getViewCameraState?.(viewId) || viewer?.getCameraState?.() || null;
    const navMode = cameraState?.navigationMode || 'orbit';
    const dim = typeof state?.getViewDimensionLevel === 'function'
      ? state.getViewDimensionLevel(viewId)
      : (state?.getDimensionLevel?.() ?? 3);
    const axesEligible = includeAxes && dim <= 2 && navMode === 'planar';

    const layout = computeSingleViewLayout({
      width: desiredPlotWidth,
      height: desiredPlotHeight,
      title,
      includeAxes: axesEligible,
      includeLegend,
      legendPosition
    });

    // Use expanded dimensions for SVG
    svgWidth = layout.totalWidth;
    svgHeight = layout.totalHeight;
  } else {
    // For multi-view, use the original dimensions (grid layout handles internally)
    svgWidth = desiredPlotWidth;
    svgHeight = desiredPlotHeight;
  }

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`
  );
  parts.push(buildSvgMetadata(meta));

  if (background !== 'transparent') {
    parts.push(`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="${escapeHtml(backgroundColor)}"/>`);
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
      parts.push(
        `<text x="${layout.titleRect?.x ?? layout.outerPadding}" y="${(layout.titleRect?.y ?? layout.outerPadding) + titleSize}" font-family="${escapeHtml(fontFamily)}" font-size="${titleSize}" fill="#111">${escapeHtml(title)}</text>`
      );
    }

    const plotRect = layout.plotRect;
    const clipId = `clip_single`;
    parts.push(`<defs><clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath></defs>`);

    // Legend (may contribute defs for gradients).
    if (includeLegend && layout.legendRect) {
      const field = typeof state.getFieldForView === 'function'
        ? state.getFieldForView(viewId)
        : (typeof state.getActiveField === 'function' ? state.getActiveField() : null);
      const model = field && typeof state.getLegendModel === 'function' ? state.getLegendModel(field) : null;
      const legend = renderSvgLegend({
        legendRect: layout.legendRect,
        fieldKey: field?.key || null,
        model,
        fontFamily,
        fontSize,
        idPrefix: `legend_${hashStringToSeed(meta?.datasetId || meta?.datasetName || 'cellucid')}`,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
      if (legend.defs) parts.push(legend.defs);
      if (legend.svg) parts.push(legend.svg);
    }

    // Plot background + frame.
    const plotFill = background === 'transparent' ? 'none' : escapeHtml(backgroundColor);
    parts.push(`<rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" fill="${plotFill}" stroke="#e5e7eb" stroke-width="1"/>`);

    if (showOrientation && renderState?.viewMatrix && dim > 2 && navMode !== 'planar') {
      parts.push(renderSvgOrientationIndicator({
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: Math.max(10, Math.round(fontSize * 0.92))
      }));
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
      parts.push(
        `<g font-family="${escapeHtml(fontFamily)}" font-size="${fontSize}" fill="#111">` +
        `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="4" fill="#ffffff" fill-opacity="0.85" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${boxX + boxPad}" y="${boxY + boxH - boxPad}" stroke="none">${escapeHtml(label)}</text>` +
        `</g>`
      );
    }

    // Points.
    parts.push(`<g clip-path="url(#${clipId})">`);

    if (strategy === 'hybrid') {
      const seed = hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId);
      const dataUrl = await rasterizePointsToDataUrl({
        positions,
        colors,
        transparency,
        renderState,
        plotRect,
        radiusPx: pointRadiusPx,
        seed,
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity,
        sortByDepth: shouldDepthSort
      });
      if (dataUrl) {
        parts.push(`<image x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" href="${dataUrl}" preserveAspectRatio="none"/>`);
      }
    } else if (strategy === 'optimized-vector' && renderState) {
      const seed = hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId);
      const reduced = reducePointsByDensity({
        positions,
        colors,
        transparency,
        renderState,
        targetCount: Math.max(1000, Math.floor(opts.optimizedTargetCount || 100000)),
        seed
      });

      const viewportW = reduced.viewportWidth;
      const viewportH = reduced.viewportHeight;
      const scale = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
      const offsetX = plotRect.x + (plotRect.width - viewportW * scale) / 2;
      const offsetY = plotRect.y + (plotRect.height - viewportH * scale) / 2;

      const outN = reduced.x.length;
      for (let i = 0; i < outN; i++) {
        let a = reduced.alpha[i] ?? 1.0;
        const srcIndex = reduced.index?.[i] ?? i;
        const x = offsetX + reduced.x[i] * scale;
        const y = offsetY + reduced.y[i] * scale;
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
        if (a >= 0.999) {
          parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${pointRadiusPx.toFixed(2)}" fill="rgb(${r},${g},${b})"/>`);
        } else {
          parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${pointRadiusPx.toFixed(2)}" fill="rgb(${r},${g},${b})" fill-opacity="${a.toFixed(3)}"/>`);
        }
      }
    } else {
      forEachProjectedPoint({
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
          if (aa >= 0.999) {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})"/>`);
          } else {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})" fill-opacity="${aa.toFixed(3)}"/>`);
          }
        }
      });
    }

    parts.push(`</g>`);

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
          parts.push(renderSvgAxes({
            plotRect,
            bounds,
            xLabel: String(opts.xLabel || 'X'),
            yLabel: String(opts.yLabel || 'Y'),
            fontFamily,
            fontSize,
            color: '#111'
          }));
        }
    }
  } else {
    const outerPadding = 20;
    const titleHeight = title ? 34 : 0;
    const contentX = outerPadding;
    const contentY = outerPadding + titleHeight;
    const contentW = Math.max(1, svgWidth - outerPadding * 2);
    const contentH = Math.max(1, svgHeight - outerPadding * 2 - titleHeight);
    const { cols, rows } = computeGridDims(views.length || 1);
    const gap = 16;
    const cellPadding = 10;

    if (title) {
      const titleSize = Math.max(14, Math.round(fontSize * 1.25));
      parts.push(
        `<text x="${outerPadding}" y="${outerPadding + titleSize}" font-family="${escapeHtml(fontFamily)}" font-size="${titleSize}" fill="#111">${escapeHtml(title)}</text>`
      );
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

      const clipId = `clip_${idx}`;
      parts.push(`<defs><clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath></defs>`);
      const cellFill = background === 'transparent' ? 'none' : escapeHtml(backgroundColor);
      parts.push(`<rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" fill="${cellFill}" stroke="#e5e7eb" stroke-width="1"/>`);
      parts.push(`<g clip-path="url(#${clipId})">`);

      const renderState = typeof viewer.getViewRenderState === 'function'
        ? (view?.renderState || viewer.getViewRenderState(viewId))
        : (typeof viewer.getRenderState === 'function' ? viewer.getRenderState() : null);

      // WYSIWYG: Get point size from viewer's render state
      const pointRadiusPx = getPointRadiusFromRenderState(renderState);

      forEachProjectedPoint({
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
          if (aa >= 0.999) {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})"/>`);
          } else {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})" fill-opacity="${aa.toFixed(3)}"/>`);
          }
        }
      });

      parts.push(`</g>`);

      parts.push(
        `<text x="${plotRect.x}" y="${plotRect.y - 4}" font-family="${escapeHtml(fontFamily)}" font-size="12" fill="#111">${escapeHtml(String.fromCharCode(65 + idx))}. ${escapeHtml(viewLabel)}</text>`
      );
    }

    if (wantsSharedLegend && legendRect) {
      const model = sharedField && typeof state.getLegendModel === 'function' ? state.getLegendModel(sharedField) : null;
      const legend = renderSvgLegend({
        legendRect,
        fieldKey: sharedFieldKey,
        model,
        fontFamily,
        fontSize,
        idPrefix: `legend_${hashStringToSeed(meta?.datasetId || meta?.datasetName || 'cellucid')}`,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor
      });
      if (legend.defs) parts.push(legend.defs);
      if (legend.svg) parts.push(legend.svg);
    }
  }

  parts.push(`</svg>`);
  const svg = parts.join('');
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  return { blob, suggestedExt: 'svg' };
}
