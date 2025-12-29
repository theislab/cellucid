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
import { hexToRgb01, rgb01ToHex } from '../utils/color-utils.js';
	import { clamp, parseNumberOr } from '../../../../utils/number-utils.js';
	import { computeLetterboxedRect } from '../utils/letterbox.js';

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

const DEFAULT_HIGHLIGHT_RGBA = { r: 102, g: 217, b: 255 };
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
  // User-specified dimensions represent desired PLOT content size
  const desiredPlotWidth = Math.max(1, Math.round(payload?.width || 1200));
  const desiredPlotHeight = Math.max(1, Math.round(payload?.height || 900));
  const dpi = Math.max(72, Math.round(payload?.dpi || 300));
  const title = String(payload?.title || '').trim();
  const opts = payload?.options || {};
  const views = Array.isArray(payload?.views) ? payload.views : [];
  const viewerBgHex = rgb01ToHex(views[0]?.renderState?.bgColor) || '#ffffff';

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
  const highlightArray = totalHighlighted > 0 ? (state?.highlightArray || null) : null;

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

            const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) : 0;
            if (h > 0) {
              const ringR = radius * DEFAULT_HIGHLIGHT_SCALE;
              const sw = Math.max(1, radius * 0.45);
              const op = Math.max(0.25, 0.85 * h);
              ctx.save();
              ctx.strokeStyle = `rgba(${DEFAULT_HIGHLIGHT_RGBA.r},${DEFAULT_HIGHLIGHT_RGBA.g},${DEFAULT_HIGHLIGHT_RGBA.b},${op})`;
              ctx.lineWidth = sw;
              ctx.beginPath();
              ctx.arc(x, y, ringR, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
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
        drawCanvasAxes({
          ctx,
          plotRect,
          bounds,
          xLabel: axisXLabel,
          yLabel: axisYLabel,
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

            const h = highlightArray ? highlightValueToAlpha01(highlightArray[index] ?? 0) : 0;
            if (h > 0) {
              const ringR = radius * DEFAULT_HIGHLIGHT_SCALE;
              const sw = Math.max(1, radius * 0.45);
              const op = Math.max(0.25, 0.85 * h);
              ctx.save();
              ctx.strokeStyle = `rgba(${DEFAULT_HIGHLIGHT_RGBA.r},${DEFAULT_HIGHLIGHT_RGBA.g},${DEFAULT_HIGHLIGHT_RGBA.b},${op})`;
              ctx.lineWidth = sw;
              ctx.beginPath();
              ctx.arc(x, y, ringR, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
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
  return embedPngTextChunks(rawBlob, buildPngTextMetadata(meta, payload));
}
