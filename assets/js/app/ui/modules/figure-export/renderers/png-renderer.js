/**
 * @fileoverview PNG renderer for figure export.
 *
 * PURPOSE:
 * Renders publication-quality PNG figures with the same 3D-shaded appearance
 * as the interactive viewer. Supports single-view and multi-view grid layouts.
 *
 * ARCHITECTURE:
 * - Uses Canvas2D surface for layout, background, frame, title, axes, legend
 * - The figure-export worker draws the points with the WebGL2 rasterizer
 *   (preserves 3D sphere shading with lighting/fog; on the page where a
 *   worker has no WebGL2), computes the axis bounds, and encodes the composed
 *   frame; the page composes
 * - Fails visibly if the exact WebGL2 point pass cannot be produced
 *
 * LAYOUT SYSTEM (IMPORTANT):
 * Every rectangle comes from `utils/layout.js`. A plot takes its view's
 * aspect (or the framing crop's) and the view fills it: never letterboxed.
 * The Figure Export panel's figure fills a width: payload.width is the
 * figure's width in figure pixels (1/96 inch, from the panel's millimetres,
 * `utils/figure-size.js`) and payload.height is null; the figure is exactly
 * that wide at its own height (`fillSingleViewWidth`, `fillGridWidth`).
 * A picture of a view gives a box instead (payload.height a number): for a
 * single view the PLOT's bounding box, the plot the largest rectangle of the
 * view's aspect inside it, and the PNG EXPANDED to hold legend, axes, and
 * title around it; for a grid the figure's size, grown where its legends or
 * a readable panel need more (`computeGridFigureLayout`). A legend is as large
 * as its entries need; a figure larger than the browser's canvas can draw is
 * refused before rendering (`utils/figure-canvas.js`), never cut.
 *
 * DPI SCALING:
 * - DPI affects pixel density, not the logical layout
 * - A 1200x900 plot at 300 DPI produces a 3750x2812 pixel PNG
 * - All layout calculations use logical coordinates, then scaled for output
 *
 * POINT RENDERING:
 * WebGL2 reproduces the active viewer shader; annotations use Canvas2D.
 *
 * MAIN THREAD:
 * Every per-cell pass (bounds, packing, the GL point pass) and the PNG encode
 * run in the worker (`utils/figure-export-worker.js`); the composed canvas
 * crosses as its pixels (`pagePixelsInBands`) and is encoded with
 * `OffscreenCanvas.convertToBlob`, the same encoder `toBlob` uses.
 *
 * METADATA:
 * PNG files include UTF-8 iTXt chunks with dataset info, export timestamp,
 * and JSON-encoded metadata for programmatic access.
 *
 * @module ui/modules/figure-export/renderers/png-renderer
 */

	import { computeFigureLayout } from '../utils/layout.js';
	import { createFigureCanvas, browserDrawsCanvas } from '../utils/figure-canvas.js';
	import { drawCanvasAxes } from '../components/axes-builder.js';
	import { drawCanvasLegend } from '../components/legend-builder.js';
	import { drawCanvasOrientationIndicator } from '../components/orientation-indicator.js';
	import { drawCanvasCentroidOverlay } from '../components/centroid-overlay.js';
	import { drawCanvasVectorFieldOf } from '../components/vector-field-figure.js';
	import {
	  buildReferenceGridModel,
	  drawCanvasReferenceGrid,
	  resolveReferenceGridSurface,
	} from '../components/reference-grid.js';
	import {
	  figureDrawsBackdropLook,
	  renderBackdropLookForPlot,
	} from '../components/backdrop-look-export.js';
	import {
	  createPlotPlacement,
	  figureSourceRect,
	  planPlotRaster,
	  sourceRect01,
	} from '../utils/plot-fit.js';
import {
  openFigureExportWorkerSession,
  pagePixelsInBands,
  pointRasterArgs,
  requestPngEncoding,
  requestDrawnCells,
} from '../utils/figure-export-worker-client.js';
import { hexOfRgb01, rgb01OfHex } from '../../../../../utils/hex-color.js';
import { resolveFigureInk } from '../utils/figure-ink.js';
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
import { panelTitle } from '../utils/panel-label.js';
import { scalePointDiameterToRaster } from '../utils/point-size.js';
import { figurePointLayersOf } from '../utils/lod-membership.js';
import {
  buildSelectionBadge,
  countHighlightedVisiblePoints,
  drawCanvasSelectionBadge,
} from '../utils/selection-badge.js';

/**
 * The device pixels a plot rectangle covers on the export canvas, snapped to
 * whole pixels.
 *
 * The plot rectangle is laid out in CSS pixels and the canvas is scaled by
 * `dpi / 96`, so its edges land between device pixels (at 300 dpi a plot at
 * x = 82 starts at 256.25). A point raster drawn into that fractional
 * rectangle was resampled by the 2D canvas: every pixel of it was blended
 * with its neighbors (a quarter-pixel blur), and the bytes depended on how
 * the browser resampled. On the macOS Firefox runners one unchanged view,
 * exported before and after a kept view came and went, differed by one level
 * at the same few antialiased point edges in every run. The raster is
 * therefore rendered at exactly the snapped size and copied one to one onto
 * these pixels.
 *
 * @param {CanvasRenderingContext2D} ctx - with a scale-and-translate transform
 * @param {{x: number, y: number, width: number, height: number}} rect - CSS px
 * @returns {{x: number, y: number, width: number, height: number}} device px
 */
function snapPlotRectToDevicePixels(ctx, rect) {
  const m = ctx.getTransform();
  if (m.b !== 0 || m.c !== 0) {
    throw new Error('PNG export plot rectangles must not be rotated or skewed.');
  }
  const left = Math.round(m.a * rect.x + m.e);
  const top = Math.round(m.d * rect.y + m.f);
  const right = Math.round(m.a * (rect.x + rect.width) + m.e);
  const bottom = Math.round(m.d * (rect.y + rect.height) + m.f);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * Copy a point raster rendered at `deviceRect`'s size onto those device
 * pixels, one to one (see `snapPlotRectToDevicePixels`).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource & {width: number, height: number}} raster
 * @param {{x: number, y: number, width: number, height: number}} deviceRect
 */
function drawRasterAtDevicePixels(ctx, raster, deviceRect) {
  if (raster.width !== deviceRect.width || raster.height !== deviceRect.height) {
    throw new Error('PNG export point raster must match its device rectangle.');
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(raster, deviceRect.x, deviceRect.y);
  ctx.restore();
}

/**
 * Where a plot's point raster goes and how it is drawn.
 *
 * The plot has its view's aspect (or the crop's), so the raster covers the
 * plot's device pixels and draws the whole source — the view, or just the
 * crop — at those pixels (`planPlotRaster`; the rasterizer's `viewRect01`):
 * never letterboxed, and a frame is as sharp as an unframed figure of the
 * same size instead of a magnified part of one.
 *
 * @param {number} zoomLimit - `exportSpriteZoomLimit()`, read in the worker
 * @returns {{deviceRect: object, width: number, height: number, zoom: number,
 *   exact: boolean, viewRect01: object}}
 */
function planPointRaster(ctx, plotRect, crop, renderState, zoomLimit) {
  const source = figureSourceRect({ renderState, crop });
  const deviceRect = snapPlotRectToDevicePixels(ctx, plotRect);
  const plan = planPlotRaster({
    source,
    deviceWidth: deviceRect.width,
    deviceHeight: deviceRect.height,
    zoomLimit,
  });
  return { deviceRect, ...plan, viewRect01: sourceRect01(source) };
}

/** Copy a planned point raster onto its device pixels. */
function drawPointRaster(ctx, raster, plan) {
  if (plan.exact) {
    drawRasterAtDevicePixels(ctx, raster, plan.deviceRect);
    return;
  }
  // Only a raster zoomed past the GPU's sprite range is scaled at the copy.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(
    raster,
    plan.deviceRect.x,
    plan.deviceRect.y,
    plan.deviceRect.width,
    plan.deviceRect.height
  );
  ctx.restore();
}

function applyExportBackgroundToRenderState(renderState, background, backgroundColor) {
  if (!renderState) return renderState;
  if (background === 'viewer' || background === 'transparent') return renderState;

  const rgb = rgb01OfHex(backgroundColor);
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
 * IMPORTANT: payload.width is the width the figure fills (payload.height
 * null), or with payload.height a box: for a single view the desired PLOT
 * CONTENT size, for a grid the figure's size. The PNG is LARGER
 * where legend, axes, and title need it (see LAYOUT SYSTEM above), and is
 * refused, with one sentence, when the browser cannot draw a canvas that
 * large.
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
  if (!Number.isInteger(payload?.dpi) || payload.dpi < 72) {
    throw new TypeError('PNG export DPI must be an integer of at least 72');
  }
  const dpi = payload.dpi;
  const title = payload.title.trim();
  const opts = payload.options;
  const views = payload.views;
  const viewerBgHex = hexOfRgb01(views[0].renderState.bgColor);
  if (viewerBgHex === null) {
    throw new Error('PNG export render state has no exact viewer background color.');
  }

  const fontFamily = opts.fontFamily;
  const baseFontSize = opts.fontSizePx;
  const centroidLabelFontSize = opts.centroidLabelFontSizePx;
  // Point size comes from the interactive viewer (WYSIWYG).
  const includeLegend = opts.includeLegend;
  const showOrientation = opts.showOrientation;
  const crop = opts.crop;
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
  const singleLegendModel = singleView && includeLegend
    ? singleScientificState.legendModel
    : null;

  // The figure's layout, the SVG's own (`computeFigureLayout`): its size,
  // every rectangle, each plot's axes and each legend's plan.
  const figureLayout = computeFigureLayout(payload);
  const { single: singleLayout, grid } = figureLayout;
  const layoutOf = (laid) => laid.single ?? laid.grid;
  const canvasWidth = layoutOf(figureLayout).totalWidth;
  const canvasHeight = layoutOf(figureLayout).totalHeight;
  let singleDim = 3;
  let singleNavMode = null;
  let singleCameraState = null;

  if (singleView) {
    singleCameraState = assertCameraState(
      views[0].cameraState,
      `PNG camera state for "${singleViewId}"`
    );
    singleNavMode = singleCameraState.navigationMode;
    singleDim = singleScientificState.dimensionLevel;
  }

  const scale = dpi / 96;
  const devicePixels = (layout) => ({
    width: Math.max(1, Math.round(layout.totalWidth * scale)),
    height: Math.max(1, Math.round(layout.totalHeight * scale)),
  });
  const { width: pxW, height: pxH } = devicePixels({ totalWidth: canvasWidth, totalHeight: canvasHeight });

  // The browser's own canvas limit is the only limit on a figure's size: past
  // it the export is refused before anything is rendered, never cut.
  const canvas = createFigureCanvas({
    width: pxW,
    height: pxH,
    legendCategoriesIfTooLarge: () => {
      if (!includeLegend) return null;
      const bare = devicePixels(layoutOf(computeFigureLayout(payload, { includeLegend: false })));
      if (!browserDrawsCanvas(bare.width, bare.height)) return null;
      const models = singleView
        ? [singleLegendModel]
        : [grid.sharedLegend?.model ?? null, ...grid.panes.map(pane => pane.legendModel)];
      return Math.max(0, ...models.map(model => (model?.kind === 'category' ? (model.categories || []).length : 0)));
    },
  });

  const ctx = /** @type {CanvasRenderingContext2D|null} */ (canvas.getContext('2d', { alpha: true }));
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const session = openFigureExportWorkerSession({ signal });
  /** @type {ImageBitmap[]} */
  const frames = [];
  try {
  // Read once from the export's GL context: every raster plan needs it.
  const zoomLimit = await session.request('spriteZoomLimit', {});
  throwIfFigureExportAborted(signal);
  ctx.save();
  ctx.scale(scale, scale);

  /**
   * Everything a panel's composition waits for, gathered before the first
   * draw: its axis bounds and point frame from the worker, and its backdrop
   * look. The figure is then composed in one task, as one uninterrupted run
   * of canvas commands: a composition split across tasks is flushed in
   * pieces, and the browser rasterizes antialiased rules differently in
   * pieces than in one run.
   */
  async function preparePanel(view, plotRect) {
    const data = view?.data || {};
    const positions = data.positions || null;
    const colors = data.colors || null;
    const transparency = data.transparency || null;
    const centroidPositions = data.centroidPositions || null;
    const centroidColors = data.centroidColors || null;
    const centroidFlags = data.centroidFlags || null;
    const renderState = view?.renderState || null;
    if (!renderState?.mvpMatrix) throw new Error('Figure export renderState missing for PNG render');
    const dim = view.scientificState.dimensionLevel;
    assertCameraState(
      view.cameraState,
      `PNG camera state for "${String(view?.id || 'live')}"`
    );
    const lodMembership = view.scientificState.lodMembership;
    // The order the pane draws at full detail (a reduced level draws a
    // prefix of it, `lodMembership.indices`).
    const drawOrder = view.scientificState.drawOrder;
    const pointDiameterViewportPx =
      renderState.pointSize * view.scientificState.lodSizeMultiplier;
    const includeCentroidPoints = typeof opts.includeCentroidPoints === 'boolean'
      ? opts.includeCentroidPoints
      : Boolean(centroidFlags?.points);
    const hasCentroidPoints =
      centroidPositions instanceof Float32Array &&
      centroidPositions.length > 0 &&
      centroidColors instanceof Uint8Array &&
      centroidColors.length === (centroidPositions.length / 3) * 4;
    const centroidDiameterViewportPx = renderState.pointSize * 4;

    const hasVisibleCells = await requestDrawnCells(session, {
      positions,
      dimension: dim,
      transparency,
      lodMembership,
      renderState,
      crop,
    });
    throwIfFigureExportAborted(signal);

    let look = null;
    if (figureDrawsBackdropLook(referenceGrid, referenceGridSurface, renderState)) {
      const lookRect = snapPlotRectToDevicePixels(ctx, plotRect);
      const lookRaster = await renderBackdropLookForPlot({
        renderState,
        plotRect,
        crop,
        width: lookRect.width,
        height: lookRect.height,
        signal,
      });
      throwIfFigureExportAborted(signal);
      look = { lookRaster, lookRect };
    }

    const rasterPlan = planPointRaster(ctx, plotRect, crop, renderState, zoomLimit);
    const renderStateForPoints = applyExportBackgroundToRenderState(
      renderState,
      background,
      backgroundColor
    );
    const raster = await session.request('rasterizePoints', pointRasterArgs(session, {
      positions,
      dimension: dim,
      colors,
      transparency,
      renderState: renderStateForPoints,
      lodMembership,
      drawOrder,
      outputWidthPx: rasterPlan.width,
      outputHeightPx: rasterPlan.height,
      viewRect01: rasterPlan.viewRect01,
      pointSizePx: scalePointDiameterToRaster(
        pointDiameterViewportPx,
        rasterPlan.zoom
      ),
      overlayPoints: (includeCentroidPoints && hasCentroidPoints)
        ? {
          positions: centroidPositions,
          colors: centroidColors,
          pointSizePx: scalePointDiameterToRaster(
            centroidDiameterViewportPx,
            rasterPlan.zoom
          ),
        }
        : null,
      highlightArray,
      emphasizeSelection,
      selectionMutedOpacity,
      pointLayers: figurePointLayersOf(colors, view.scientificState.pointLayers, renderStateForPoints.bgColor),
    }));
    frames.push(raster);
    throwIfFigureExportAborted(signal);
    return { hasVisibleCells, look, rasterPlan, raster };
  }

  /** @type {Array<Awaited<ReturnType<typeof preparePanel>>>} */
  const prepared = [];
  if (singleView) {
    prepared.push(await preparePanel(views[0], singleLayout.plotRect));
  } else {
    for (let idx = 0; idx < views.length; idx++) {
      prepared.push(await preparePanel(views[idx], grid.panes[idx].plotRect));
    }
  }

  // ── The composition: one synchronous run of canvas commands. ──────────

  // Fill background with expanded dimensions
  if (background !== 'transparent') {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  }

  if (singleView) {
    const view = views[0];
    const data = view?.data || {};
    const centroidPositions = data.centroidPositions || null;
    const centroidColors = data.centroidColors || null;
    const centroidLabelTexts = Array.isArray(data.centroidLabelTexts) ? data.centroidLabelTexts : null;
    const centroidFlags = data.centroidFlags || null;

    const renderState = view.renderState;
    const dim = singleDim;
    const cameraState = singleCameraState;
    const navMode = singleNavMode;
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

    const layout = singleLayout;
    const { hasVisibleCells, look, rasterPlan, raster } = prepared[0];

    if (layout.titleRect) {
      const titleSize = layout.titleFontPx;
      ctx.save();
      ctx.fillStyle = ink.text;
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillText(title, layout.titleRect.x + layout.titleRect.width / 2, layout.titleRect.y + titleSize);
      ctx.restore();
    }

    const plotRect = layout.plotRect;

    // Plot frame.
    ctx.strokeStyle = ink.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);

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
        surface: referenceGridSurface,
      }),
    });
    if (look !== null) {
      drawRasterAtDevicePixels(ctx, look.lookRaster, look.lookRect);
    }
    drawPointRaster(ctx, raster, rasterPlan);
    const centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;

    ctx.restore();

    // The vector field the view shows, as arrows on a grid, under the centroids.
    drawCanvasVectorFieldOf(ctx, {
      data, dimension: dim, renderState, plotRect, crop, ink, fontFamily,
      fontSizePx: baseFontSize, haloColor: background === 'transparent' ? ink.halo : backgroundColor,
      // Its key is the legend's rows; only a figure without a legend draws it in the plot.
      inPlotKey: !layout.vectorKeyInLegend,
    });

    if ((includeCentroidPoints || includeCentroidLabels) && renderState) {
      const centroidDiameterViewportPx = renderState.pointSize * 4;

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
        pointDiameterViewportPx: centroidDiameterViewportPx,
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
        plotScale: createPlotPlacement({ renderState, plotRect, crop }).scale,
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
    if (layout.legendRect) {
      drawCanvasLegend({
        ctx,
        legendRect: layout.legendRect,
        legendPlan: layout.legendPlan,
        model: singleLegendModel,
        fontFamily,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }

    // Axes: the rulers of what the plot shows, as the layout planned them.
    if (layout.axes !== null && hasVisibleCells) {
      drawCanvasAxes({
        ctx,
        plotRect,
        axes: layout.axes,
        fontFamily,
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
    const { sharedLegend, sharedLegendRect, sharedLegendPlan, panes } = grid;

    if (grid.titleRect) {
      const titleSize = grid.titleFontPx;
      ctx.save();
      ctx.fillStyle = ink.text;
      ctx.font = `${titleSize}px ${fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      ctx.fillText(title, grid.titleRect.x + grid.titleRect.width / 2, grid.titleRect.y + titleSize);
      ctx.restore();
    }

    for (let idx = 0; idx < views.length; idx++) {
      const view = views[idx];
      const viewId = String(view?.id || 'live');
      // A panel is titled by its letter and the name its view was given (`view.rename`), else its label.
      const viewTitle = panelTitle(view, idx);
      const data = view?.data || {};
      const transparency = data.transparency || null;
      const centroidPositions = data.centroidPositions || null;
      const centroidColors = data.centroidColors || null;
      const centroidLabelTexts = Array.isArray(data.centroidLabelTexts) ? data.centroidLabelTexts : null;
      const centroidFlags = data.centroidFlags || null;
      const {
        legendModel: panelLegendModel,
        legendPlan: panelLegendPlan,
        labelX,
        labelY,
        panelRect,
        plotRect,
        legendRect: panelLegendRect,
      } = panes[idx];
      const { hasVisibleCells, look, rasterPlan, raster } = prepared[idx];

      ctx.save();
      ctx.beginPath();
      ctx.rect(plotRect.x, plotRect.y, plotRect.width, plotRect.height);
      ctx.clip();

      const renderState = view.renderState;

      drawCanvasReferenceGrid({
        ctx,
        model: buildReferenceGridModel({
          appearance: referenceGrid,
          renderState,
          plotRect,
          crop,
          surface: referenceGridSurface,
        }),
      });
      if (look !== null) {
        drawRasterAtDevicePixels(ctx, look.lookRaster, look.lookRect);
      }

      const dim = view.scientificState.dimensionLevel;
      const cameraState = assertCameraState(
        view.cameraState,
        `PNG camera state for "${viewId}"`
      );
      const navMode = cameraState.navigationMode;
      const lodMembership = view.scientificState.lodMembership;
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

      const centroidDiameterViewportPx = renderState.pointSize * 4;

      drawPointRaster(ctx, raster, rasterPlan);
      const centroidPointsRasterized = includeCentroidPoints && hasCentroidPoints;

      // The vector field the panel shows, as arrows on a grid, under the centroids.
      drawCanvasVectorFieldOf(ctx, {
        data, dimension: dim, renderState, plotRect, crop, ink, fontFamily,
        fontSizePx: baseFontSize, haloColor: background === 'transparent' ? ink.halo : backgroundColor,
        inPlotKey: !panes[idx].vectorKeyInLegend,
      });

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
          pointDiameterViewportPx: centroidDiameterViewportPx,
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
          plotScale: createPlotPlacement({ renderState, plotRect, crop }).scale,
          viewMatrix: renderState.viewMatrix,
          cameraState,
          fontFamily,
          fontSize: orientationFontSize,
          ink,
        });
        ctx.restore();
      }

      if (panes[idx].axes !== null && hasVisibleCells) {
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
          axes: panes[idx].axes,
          fontFamily,
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

      if (panelLegendRect) {
        drawCanvasLegend({
          ctx,
          legendRect: panelLegendRect,
          legendPlan: panelLegendPlan,
          model: panelLegendModel,
          fontFamily,
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
        viewTitle,
        labelX,
        labelY
      );
      ctx.restore();
    }

    if (sharedLegendRect) {
      drawCanvasLegend({
        ctx,
        legendRect: sharedLegendRect,
        legendPlan: sharedLegendPlan,
        model: sharedLegend.model,
        fontFamily,
        backgroundFill: background === 'transparent' ? 'transparent' : backgroundColor,
        ink
      });
    }
  }

  ctx.restore();
  for (const frame of frames.splice(0)) frame.close();

  // The composed figure crosses to the worker as its pixels, read in bands
  // of rows (`pagePixelsInBands`: no read is a long task); the canvas's own
  // buffer is released before the encode, which is the slow part.
  const pixels = await pagePixelsInBands(canvas, signal);
  canvas.width = 0;
  canvas.height = 0;
  throwIfFigureExportAborted(signal);
  const annotatedBlob = await requestPngEncoding(session, pixels, {
    text: buildPngTextMetadata(payload.meta, payload),
    dpi
  });
  throwIfFigureExportAborted(signal);
  return annotatedBlob;
  } finally {
    for (const frame of frames) frame.close();
    session.close();
  }
}
