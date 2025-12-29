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
	import { renderSvgCentroidOverlay } from '../components/centroid-overlay.js';
	import { computeVisibleRealBounds } from '../utils/coordinate-mapper.js';
	import { cropRect01ToPx, normalizeCropRect01 } from '../utils/crop.js';
	import { reducePointsByDensity } from '../utils/density-reducer.js';
	import { blobToDataUrl } from '../utils/export-helpers.js';
	import { hashStringToSeed } from '../utils/hash.js';
import { rasterizePointsWebgl } from '../utils/webgl-point-rasterizer.js';
import { getEffectivePointDiameterPx, getLodVisibilityMask } from '../utils/point-size.js';
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';
	import { clamp, parseNumberOr } from '../../../../utils/number-utils.js';
	import { computeLetterboxedRect } from '../utils/letterbox.js';

function applyExportBackgroundToRenderState(renderState, background, backgroundColor) {
  if (!renderState) return renderState;
  if (background === 'viewer' || background === 'transparent') return renderState;

  const rgb = hexToRgb01(backgroundColor);
  if (!rgb) return renderState;

  return {
    ...renderState,
    fogColor: new Float32Array(rgb),
    bgColor: new Float32Array(rgb),
  };
}

const DEFAULT_HIGHLIGHT_RGB = { r: 102, g: 217, b: 255 }; // ~[0.4, 0.85, 1.0]
const DEFAULT_HIGHLIGHT_SCALE = 1.75;

function highlightValueToAlpha01(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v <= 1.0) return Math.max(0, Math.min(1, v));
  return Math.max(0, Math.min(1, v / 255));
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
	  const crop01 = normalizeCropRect01(crop);
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

	function buildSvgMetadata(meta, payload) {
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

	  const json = JSON.stringify(
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
	        format: 'svg',
	        width: Number.isFinite(payload?.width) ? payload.width : null,
	        height: Number.isFinite(payload?.height) ? payload.height : null,
	        dpi: Number.isFinite(payload?.dpi) ? payload.dpi : null,
	        strategy: payload?.options?.strategy || null,
	        includeAxes: payload?.options?.includeAxes ?? null,
	        includeLegend: payload?.options?.includeLegend ?? null,
	        legendPosition: payload?.options?.legendPosition ?? null,
	        background: payload?.options?.background ?? null,
	        backgroundColor: payload?.options?.backgroundColor ?? null,
	        crop: payload?.options?.crop ?? null,
	      }
	    },
	    null,
	    0
	  );

	  return `<metadata>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:cellucid="https://cellucid.com/ns#">
    <rdf:Description rdf:about="">
      <dc:creator>Cellucid</dc:creator>
      <dc:publisher>cellucid.com</dc:publisher>
      <dc:relation>${escapeHtml(website)}</dc:relation>
      <dc:date>${escapeHtml(exportedAt)}</dc:date>
      ${dataset ? `<dc:source>${escapeHtml(dataset)}</dc:source>` : ''}
      ${meta?.datasetId ? `<dc:identifier>${escapeHtml(String(meta.datasetId))}</dc:identifier>` : ''}
      ${description ? `<dc:description>${escapeHtml(description)}</dc:description>` : ''}
      ${meta?.fieldKey ? `<cellucid:colorField>${escapeHtml(String(meta.fieldKey))}</cellucid:colorField>` : ''}
      ${sourceFile ? `<cellucid:sourceFile>${escapeHtml(String(sourceFile))}</cellucid:sourceFile>` : ''}
      <cellucid:json>${escapeHtml(json)}</cellucid:json>
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
  visibilityMask = null,
  renderState,
  plotRect,
  radiusPx,
  seed = 0,
  highlightArray = null,
  emphasizeSelection = false,
  selectionMutedOpacity = 0.15,
  sortByDepth = false,
  maxSortedPoints = 200000,
  crop = null,
  overlayPositions = null,
  overlayColors = null,
  overlayPointDiameterViewportPx = null
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
  const crop01 = normalizeCropRect01(crop);

  const srcViewportW = Math.max(1, Math.round(renderState?.viewportWidth || 1));
  const srcViewportH = Math.max(1, Math.round(renderState?.viewportHeight || 1));
  const viewportScale = computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: pxW, dstHeight: pxH }).scale;
  const pointDiameterViewportPx = Math.max(1, Number(radiusPx || 1.5) * 2);

  const webglCanvas = rasterizePointsWebgl({
    positions,
    colors,
    transparency,
    visibilityMask,
    renderState,
    outputWidthPx: pxW,
    outputHeightPx: pxH,
    pointSizePx: Math.max(1, pointDiameterViewportPx * viewportScale),
    overlayPoints: (overlayPositions && overlayColors && Number.isFinite(overlayPointDiameterViewportPx))
      ? {
        positions: overlayPositions,
        colors: overlayColors,
        pointSizePx: Math.max(1, Number(overlayPointDiameterViewportPx) * viewportScale)
      }
      : null,
    highlightArray,
    emphasizeSelection,
    selectionMutedOpacity
  });

  if (webglCanvas) {
    if (!crop01) {
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

    /** @type {OffscreenCanvas|HTMLCanvasElement} */
    const out = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(pxW, pxH)
      : (() => {
        const c = document.createElement('canvas');
        c.width = pxW;
        c.height = pxH;
        return c;
      })();
    const outCtx = /** @type {CanvasRenderingContext2D|null} */ (out.getContext('2d', { alpha: true }));
    if (!outCtx) return null;

    const vp = computeLetterboxedRect({ srcWidth: srcViewportW, srcHeight: srcViewportH, dstWidth: pxW, dstHeight: pxH });
    const sx = vp.x + crop01.x * vp.width;
    const sy = vp.y + crop01.y * vp.height;
    const sw = crop01.width * vp.width;
    const sh = crop01.height * vp.height;
    outCtx.drawImage(webglCanvas, sx, sy, sw, sh, 0, 0, pxW, pxH);

    const blob = typeof out.convertToBlob === 'function'
      ? await out.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => {
        /** @type {HTMLCanvasElement} */ (out).toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
          'image/png'
        );
      });
    return blobToDataUrl(blob);
  }

  // WebGL rasterizer returned null - fall back to Canvas2D flat circles
  // This happens when viewMatrix/projectionMatrix/modelMatrix are missing
  // (Canvas2D fallback produces flat circles instead of 3D spheres.)

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
  const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
  const cropW = cropPx ? cropPx.width : srcViewportW;
  const cropH = cropPx ? cropPx.height : srcViewportH;
  const radiusPlot = (Number(radiusPx || 1.5)) * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;

  forEachProjectedPoint({
    positions,
    colors,
    transparency,
    visibilityMask,
    renderState,
    plotRect: localPlot,
    radiusPx: radiusPlot,
    crop,
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
  const crop = opts.crop || null;

  const fontFamily = String(opts.fontFamily || 'Arial, Helvetica, sans-serif');
  const baseFontSize = Math.max(6, Math.round(parseNumberOr(opts.fontSizePx, 12)));
  const legendFontSize = Math.max(6, Math.round(parseNumberOr(opts.legendFontSizePx, baseFontSize)));
  const tickFontSize = Math.max(6, Math.round(parseNumberOr(opts.tickFontSizePx, baseFontSize)));
  const axisLabelFontSize = Math.max(6, Math.round(parseNumberOr(opts.axisLabelFontSizePx, baseFontSize)));
  const titleFontSize = Math.max(10, Math.round(parseNumberOr(opts.titleFontSizePx, Math.max(14, baseFontSize * 1.25))));
  const centroidLabelFontSize = Math.max(6, Math.round(parseNumberOr(opts.centroidLabelFontSizePx, baseFontSize)));
  // Point size comes from the interactive viewer (WYSIWYG).
  const selectionMutedOpacity = clamp(parseNumberOr(opts.selectionMutedOpacity, 0.15), 0, 1);
  const totalHighlighted = typeof state?.getTotalHighlightedCellCount === 'function'
    ? state.getTotalHighlightedCellCount()
    : 0;
  const emphasizeSelection = opts.emphasizeSelection === true && totalHighlighted > 0;
  const highlightCount = emphasizeSelection && typeof state?.getHighlightedCellCount === 'function'
    ? state.getHighlightedCellCount()
    : totalHighlighted;
  const highlightArray = totalHighlighted > 0 ? (state?.highlightArray || null) : null;

  const viewerBgHex = rgb01ToHex(views[0]?.renderState?.bgColor) || '#ffffff';
  const background = opts.background || 'white';
  const backgroundColor = background === 'custom'
    ? String(opts.backgroundColor || '#ffffff')
    : (background === 'viewer' ? viewerBgHex : '#ffffff');

  const singleView = views.length === 1;
  const singleViewId = singleView ? String(views[0]?.id || 'live') : null;

  const singleLegendField = singleView && includeLegend && typeof state.getFieldForView === 'function'
    ? state.getFieldForView(singleViewId)
    : (singleView && includeLegend && typeof state.getActiveField === 'function' ? state.getActiveField() : null);
  const singleLegendModel = singleView && singleLegendField && typeof state.getLegendModel === 'function'
    ? state.getLegendModel(singleLegendField)
    : null;

  // For single view, compute layout first to get the expanded total dimensions
  let svgWidth, svgHeight;
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

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`
  );
  parts.push(buildSvgMetadata(meta, payload));

  if (background !== 'transparent') {
    parts.push(`<rect x="0" y="0" width="${svgWidth}" height="${svgHeight}" fill="${escapeHtml(backgroundColor)}"/>`);
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
    const cameraState = singleCameraState || view?.cameraState || null;
    const navMode = singleNavMode;
    const axesEligible = singleAxesEligible;
    const shouldDepthSort = depthSort3d && dim > 2 && navMode !== 'planar';

    const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
    const pointDiameterViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim });
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
        `<text x="${tx}" y="${(layout.titleRect?.y ?? layout.outerPadding) + titleSize}" text-anchor="middle" font-family="${escapeHtml(fontFamily)}" font-size="${titleSize}" fill="#111">${escapeHtml(title)}</text>`
      );
    }

    const plotRect = layout.plotRect;
    const clipId = `clip_single`;
    parts.push(`<defs><clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath></defs>`);

    // Legend (may contribute defs for gradients).
    if (includeLegend && layout.legendRect) {
      const legend = renderSvgLegend({
        legendRect: layout.legendRect,
        fieldKey: singleLegendField?.key || null,
        model: singleLegendModel,
        fontFamily,
        fontSize: legendFontSize,
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
      const orientationFontSize = clamp(Math.round(baseFontSize * 0.9), 11, 22);
      parts.push(renderSvgOrientationIndicator({
        plotRect,
        viewMatrix: renderState.viewMatrix,
        cameraState,
        fontFamily,
        fontSize: orientationFontSize
      }));
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
      parts.push(
        `<g font-family="${escapeHtml(fontFamily)}" font-size="${baseFontSize}" fill="#111">` +
        `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="4" fill="#ffffff" fill-opacity="0.85" stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${boxX + boxPad}" y="${boxY + boxH - boxPad}" stroke="none">${escapeHtml(label)}</text>` +
        `</g>`
      );
    }

    // Points + centroid overlay (WYSIWYG).
    parts.push(`<g clip-path="url(#${clipId})">`);

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

    const crop01 = normalizeCropRect01(crop);
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
      const seed = hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId);
      const renderStateForPoints = applyExportBackgroundToRenderState(renderState, background, backgroundColor);
      const dataUrl = await rasterizePointsToDataUrl({
        positions,
        colors,
        transparency,
        visibilityMask,
        renderState: renderStateForPoints,
        plotRect,
        radiusPx: pointRadiusViewportPx,
        seed,
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity,
        sortByDepth: shouldDepthSort,
        crop,
        overlayPositions: includeCentroidPoints ? centroidPositions : null,
        overlayColors: includeCentroidPoints ? centroidColors : null,
        overlayPointDiameterViewportPx: includeCentroidPoints ? centroidDiameterViewportPx : null,
      });
      if (dataUrl) {
        centroidPointsRasterized = includeCentroidPoints && Boolean(centroidPositions) && Boolean(centroidColors);
        // Add both href and xlink:href for better compatibility across SVG consumers.
        parts.push(
          `<image x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}" href="${dataUrl}" xlink:href="${dataUrl}" preserveAspectRatio="none"/>`
        );
      } else {
        // Fallback: rasterization unavailable (e.g., WebGL2 blocked) -> draw vector circles.
        const radiusPlot = pointRadiusViewportPx * plotScale;
        forEachProjectedPoint({
          positions,
          colors,
          transparency,
          visibilityMask,
          renderState,
          plotRect,
          radiusPx: radiusPlot,
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
            if (aa >= 0.999) {
              parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})"/>`);
            } else {
              parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})" fill-opacity="${aa.toFixed(3)}"/>`);
            }

            const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) : 0;
            if (h > 0) {
              const ringR = radius * DEFAULT_HIGHLIGHT_SCALE;
              const sw = Math.max(0.75, radius * 0.45);
              const op = Math.max(0.25, 0.85 * h);
              parts.push(
                `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${ringR.toFixed(2)}" ` +
                `fill="none" stroke="rgb(${DEFAULT_HIGHLIGHT_RGB.r},${DEFAULT_HIGHLIGHT_RGB.g},${DEFAULT_HIGHLIGHT_RGB.b})" ` +
                `stroke-width="${sw.toFixed(2)}" stroke-opacity="${op.toFixed(3)}"/>`
              );
            }
          }
        });
      }
    } else if (strategy === 'optimized-vector' && renderState) {
      const seed = hashStringToSeed(meta?.datasetId || meta?.datasetName || viewId);
      const reduced = reducePointsByDensity({
        positions,
        colors,
        transparency,
        visibilityMask,
        renderState,
        targetCount: Math.max(1000, Math.floor(opts.optimizedTargetCount || 100000)),
        seed,
        crop
      });

      const viewportW = reduced.viewportWidth;
      const viewportH = reduced.viewportHeight;
      const scale = Math.min(plotRect.width / viewportW, plotRect.height / viewportH);
      const offsetX = plotRect.x + (plotRect.width - viewportW * scale) / 2;
      const offsetY = plotRect.y + (plotRect.height - viewportH * scale) / 2;
      const pointRadiusPx = pointRadiusViewportPx * scale;

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

        const h = highlightArray ? highlightValueToAlpha01(highlightArray[srcIndex] ?? 0) : 0;
        if (h > 0) {
          const ringR = pointRadiusPx * DEFAULT_HIGHLIGHT_SCALE;
          const sw = Math.max(0.75, pointRadiusPx * 0.45);
          const op = Math.max(0.25, 0.85 * h);
          parts.push(
            `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${ringR.toFixed(2)}" ` +
            `fill="none" stroke="rgb(${DEFAULT_HIGHLIGHT_RGB.r},${DEFAULT_HIGHLIGHT_RGB.g},${DEFAULT_HIGHLIGHT_RGB.b})" ` +
            `stroke-width="${sw.toFixed(2)}" stroke-opacity="${op.toFixed(3)}"/>`
          );
        }
      }
    } else {
      const radiusPlot = pointRadiusViewportPx * plotScale;
      forEachProjectedPoint({
        positions,
        colors,
        transparency,
        visibilityMask,
        renderState,
        plotRect,
        radiusPx: radiusPlot,
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
          if (aa >= 0.999) {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})"/>`);
          } else {
            parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="rgb(${rr},${gg},${bb})" fill-opacity="${aa.toFixed(3)}"/>`);
          }

          const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) : 0;
          if (h > 0) {
            const ringR = radius * DEFAULT_HIGHLIGHT_SCALE;
            const sw = Math.max(0.75, radius * 0.45);
            const op = Math.max(0.25, 0.85 * h);
            parts.push(
              `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${ringR.toFixed(2)}" ` +
              `fill="none" stroke="rgb(${DEFAULT_HIGHLIGHT_RGB.r},${DEFAULT_HIGHLIGHT_RGB.g},${DEFAULT_HIGHLIGHT_RGB.b})" ` +
              `stroke-width="${sw.toFixed(2)}" stroke-opacity="${op.toFixed(3)}"/>`
            );
          }
        }
      });
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
      labelColor: '#111',
      haloColor: background === 'transparent' ? '#ffffff' : backgroundColor,
    });
    if (centroidSvg) parts.push(centroidSvg);

    parts.push(`</g>`);

    // Axes (2D uses embedding coordinates; 3D uses camera-space coordinates).
    if (axesEligible && renderState) {
      const norm = typeof state?.dimensionManager?.getNormTransform === 'function'
        ? state.dimensionManager.getNormTransform(dim)
        : null;
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
            normTransform: norm
          })
      ) || { minX: -1, maxX: 1, minY: -1, maxY: 1 };
      if (bounds) {
        const axisXLabel = opts?.xLabel == null ? 'X' : String(opts.xLabel);
        const axisYLabel = opts?.yLabel == null ? 'Y' : String(opts.yLabel);
        parts.push(renderSvgAxes({
          plotRect,
          bounds,
          xLabel: axisXLabel,
          yLabel: axisYLabel,
          fontFamily,
          tickFontSize,
          labelFontSize: axisLabelFontSize,
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
      const titleSize = Math.max(14, titleFontSize);
      const tx = outerPadding + contentW / 2;
      parts.push(
        `<text x="${tx}" y="${outerPadding + titleSize}" text-anchor="middle" font-family="${escapeHtml(fontFamily)}" font-size="${titleSize}" fill="#111">${escapeHtml(title)}</text>`
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

      const renderState = view?.renderState || null;
      if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for SVG multiview render');

      const dim = typeof state.getViewDimensionLevel === 'function'
        ? state.getViewDimensionLevel(viewId)
        : (state.getDimensionLevel?.() ?? 3);
      const navMode = view?.cameraState?.navigationMode || 'orbit';
      const visibilityMask = getLodVisibilityMask({ viewer, viewId, dimensionLevel: dim });
      const pointRadiusViewportPx = getEffectivePointDiameterPx({ viewer, renderState, viewId, dimensionLevel: dim }) / 2;

      const crop01 = normalizeCropRect01(crop);
      const srcViewportW = Math.max(1, renderState?.viewportWidth || 1);
      const srcViewportH = Math.max(1, renderState?.viewportHeight || 1);
      const cropPx = cropRect01ToPx(crop01, srcViewportW, srcViewportH);
      const cropW = cropPx ? cropPx.width : srcViewportW;
      const cropH = cropPx ? cropPx.height : srcViewportH;
      const radiusPlot = pointRadiusViewportPx * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale;

      forEachProjectedPoint({
        positions,
        colors,
        transparency,
        renderState,
        plotRect,
        radiusPx: radiusPlot,
        visibilityMask,
        crop,
        sortByDepth: depthSort3d && dim > 2 && navMode !== 'planar',
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
      const centroidDiameterViewportPx = Math.max(1, (Number(renderState?.pointSize || 5) * 4.0));
      const centroidRadiusPlotPx = Math.max(0.5, (centroidDiameterViewportPx / 2) * computeLetterboxedRect({ srcWidth: cropW, srcHeight: cropH, dstWidth: plotRect.width, dstHeight: plotRect.height }).scale);

      const centroidSvg = renderSvgCentroidOverlay({
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
        haloColor: background === 'transparent' ? '#ffffff' : backgroundColor,
      });
      if (centroidSvg) parts.push(centroidSvg);

      parts.push(`</g>`);

      parts.push(
        `<text x="${plotRect.x}" y="${plotRect.y - 4}" font-family="${escapeHtml(fontFamily)}" font-size="${baseFontSize}" fill="#111">${escapeHtml(String.fromCharCode(65 + idx))}. ${escapeHtml(viewLabel)}</text>`
      );
    }

    if (wantsSharedLegend && legendRect) {
      const model = sharedField && typeof state.getLegendModel === 'function' ? state.getLegendModel(sharedField) : null;
      const legend = renderSvgLegend({
        legendRect,
        fieldKey: sharedFieldKey,
        model,
        fontFamily,
        fontSize: legendFontSize,
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
