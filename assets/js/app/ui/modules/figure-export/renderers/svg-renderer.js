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
 * Every rectangle comes from `utils/layout.js`. A plot takes its view's
 * aspect (or the framing crop's) and the view fills it: never letterboxed.
 * The Figure Export panel's figure fills a width: payload.width is the
 * figure's width in figure pixels (1/96 inch, from the panel's millimetres,
 * `utils/figure-size.js`) and payload.height is null; the figure is exactly
 * that wide at its own height (`fillSingleViewWidth`, `fillGridWidth`).
 * A picture of a view gives a box instead (payload.height a number): for a
 * single view the PLOT's bounding box, the plot the largest rectangle of the
 * view's aspect inside it, and the SVG EXPANDED to hold legend, axes, and
 * title around it; for a grid the figure's size, grown where its legends or
 * a readable panel need more (`computeGridFigureLayout`). A legend is as large
 * as its entries need, and every entry is written whole.
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
import { computeFigureLayout } from '../utils/layout.js';
import { renderSvgAxes } from '../components/axes-builder.js';
import { renderSvgLegend } from '../components/legend-builder.js';
import { renderSvgOrientationIndicator } from '../components/orientation-indicator.js';
import { renderSvgCentroidOverlay } from '../components/centroid-overlay.js';
import { vectorFieldSvgOf } from '../components/vector-field-figure.js';
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
  createPlotPlacement,
  figureSourceRect,
  planPlotRaster,
  sourceRect01,
} from '../utils/plot-fit.js';
import { fnv1a32 } from '../../../../../utils/fnv1a.js';
import {
  openFigureExportWorkerSession,
  pagePixels,
  pointPassRenderState,
  pointRasterArgs,
  requestPngDataUrl,
  requestDrawnCells,
  shareLodMembership,
} from '../utils/figure-export-worker-client.js';
import { scalePointDiameterToRaster } from '../utils/point-size.js';
import { figurePointLayersOf } from '../utils/lod-membership.js';
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
import { mmOfFigurePx } from '../utils/figure-size.js';
import {
  buildSelectionBadge,
  countHighlightedVisiblePoints,
  renderSvgSelectionBadge,
} from '../utils/selection-badge.js';

/** The resolution of a Hybrid SVG's points, in dots per inch at the figure's size. */
const HYBRID_RASTER_DPI = 300;
/** CSS pixels per inch: the SVG's own unit. */
const CSS_PX_PER_INCH = 96;

function applyExportBackgroundToRenderState(renderState, background, backgroundColor) {
  if (background === 'viewer' || background === 'transparent') return renderState;

  const rgb = rgb01OfHex(backgroundColor);
  if (rgb === null) {
    throw new TypeError('SVG export backgroundColor must be an exact #RRGGBB color.');
  }

  return {
    ...renderState,
    fogColor: new Float32Array(rgb),
    bgColor: new Float32Array(rgb),
  };
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
  pointLayers = null,
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

  // The points are drawn at 300 dpi at the figure's size, as a 300 DPI PNG is: the resolution
  // journals ask of images, not a fixed 2× of the screen.
  const rasterScale = HYBRID_RASTER_DPI / CSS_PX_PER_INCH;
  const pxW = Math.round(plotRect.width * rasterScale);
  const pxH = Math.round(plotRect.height * rasterScale);
  // The plot has the source's aspect (the view, or the crop), so the raster
  // is the whole plot and draws the whole source at those pixels: never
  // letterboxed (see png-renderer.js planPointRaster).
  const source = figureSourceRect({ renderState, crop });
  const zoomLimit = await session.request('spriteZoomLimit', {});
  throwIfFigureExportAborted(signal);
  const rasterPlan = planPlotRaster({ source, deviceWidth: pxW, deviceHeight: pxH, zoomLimit });
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
    viewRect01: sourceRect01(source),
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
    selectionMutedOpacity,
    pointLayers,
  });
  // The PNG is stretched over the whole plot rectangle (pxW x pxH is the
  // plot at rasterScale): one to one, unless it was zoomed past the GPU's
  // sprite range (`planPlotRaster`) and is scaled up to it here.
  const placement = rasterPlan.exact ? null : { width: pxW, height: pxH };
  const frame = await session.request('rasterizePoints', raster);
  try {
    throwIfFigureExportAborted(signal);
  } catch (error) {
    frame.close();
    throw error;
  }
  const pixels = pagePixels(frame);
  return session.request('encodeRasterPngDataUrl', { pixels, placement }, [pixels.data.buffer]);
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
    lodMembership: shareLodMembership(session, lodMembership),
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
function backdropLookDataUrl(session, lookRaster, signal) {
  throwIfFigureExportAborted(signal);
  return requestPngDataUrl(session, pagePixels(lookRaster));
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

/** A length in figure pixels as millimetres, to a thousandth (a micrometre). */
function svgLengthMm(px) {
  return Number(mmOfFigurePx(px).toFixed(3));
}

/**
 * Render figure to SVG blob.
 *
 * IMPORTANT: payload.width is the width the figure fills (payload.height
 * null), or with payload.height a box: for a single view the desired PLOT
 * CONTENT size, for a grid the figure's size. The SVG is LARGER
 * where legend, axes, and title need it (see LAYOUT SYSTEM above).
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
  const title = payload.title.trim();
  const opts = payload.options;
  const meta = payload.meta;
  const views = payload.views;

  const includeLegend = opts.includeLegend;
  const strategy = opts.strategy;
  const showOrientation = opts.showOrientation;
  const depthSort3d = opts.depthSort3d;
  const crop = opts.crop;

  const fontFamily = opts.fontFamily;
  const baseFontSize = opts.fontSizePx;
  const centroidLabelFontSize = opts.centroidLabelFontSizePx;
  // Point size comes from the interactive viewer (WYSIWYG).
  const selectionMutedOpacity = opts.selectionMutedOpacity;
  const totalHighlighted = payload.selection.totalCount;
  const emphasizeSelection = opts.emphasizeSelection && totalHighlighted > 0;
  const highlightCount = emphasizeSelection
    ? payload.selection.visibleCount
    : totalHighlighted;
  const highlightArray = payload.selection.highlightArray;

  const viewerBgHex = hexOfRgb01(views[0].renderState.bgColor);
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
  const singleLegendModel = singleView && includeLegend
    ? singleScientificState.legendModel
    : null;

  // The figure's layout, the PNG's own (`computeFigureLayout`): its size,
  // every rectangle, each plot's axes and each legend's plan.
  const { single: singleLayout, grid } = computeFigureLayout(payload);
  const svgWidth = (singleLayout ?? grid).totalWidth;
  const svgHeight = (singleLayout ?? grid).totalHeight;
  let singleDim = 3;
  let singleNavMode = null;
  let singleCameraState = null;

  if (singleView) {
    singleCameraState = assertCameraState(
      views[0].cameraState,
      `SVG camera state for "${singleViewId}"`
    );
    singleNavMode = singleCameraState.navigationMode;
    singleDim = singleScientificState.dimensionLevel;
  }

  const session = openFigureExportWorkerSession({ signal });
  try {
  const parts = [];
  parts.push(
    // Its size in millimetres (the figure pixel is 1/96 inch): an editor opens it at its
    // printed size, where a bare pixel size is read as 1/96 inch by some and 1/72 by others.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgLengthMm(svgWidth)}mm" height="${svgLengthMm(svgHeight)}mm" viewBox="0 0 ${svgWidth} ${svgHeight}">`
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
    const shouldDepthSort = depthSort3d && dim > 2 && navMode !== 'planar';

    const lodMembership = view.scientificState.lodMembership;
    // The order the pane draws at full detail (a reduced level draws a
    // prefix of it, `lodMembership.indices`).
    const drawOrder = view.scientificState.drawOrder;
    const pointDiameterViewportPx =
      renderState.pointSize * view.scientificState.lodSizeMultiplier;
    const pointRadiusViewportPx = pointDiameterViewportPx / 2;

    const layout = singleLayout;

    if (layout.titleRect) {
      const titleSize = layout.titleFontPx;
      parts.push(
        `<text x="${layout.titleRect.x + layout.titleRect.width / 2}" y="${layout.titleRect.y + titleSize}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" font-size="${titleSize}" fill="${ink.text}">${escapeXml(title)}</text>`
      );
    }

    const plotRect = layout.plotRect;
    const clipId = `clip_single`;
    parts.push(`<defs><clipPath id="${clipId}"><rect x="${plotRect.x}" y="${plotRect.y}" width="${plotRect.width}" height="${plotRect.height}"/></clipPath></defs>`);
    const hasVisibleCells = await requestDrawnCells(session, {
      positions,
      dimension: dim,
      transparency,
      lodMembership,
      renderState,
      crop,
    });
    throwIfFigureExportAborted(signal);

    // Legend (may contribute defs for gradients).
    if (layout.legendRect) {
      const legend = renderSvgLegend({
        legendRect: layout.legendRect,
        legendPlan: layout.legendPlan,
        model: singleLegendModel,
        fontFamily,
        idPrefix: `legend_${fnv1a32(String(meta?.datasetId || meta?.datasetName || 'cellucid'))}`,
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

    // The viewer draws centroids with `u_pointSize` four times the base point
    // size (without LOD multipliers), sized by depth as the cells are.
    const centroidDiameterViewportPx = renderState.pointSize * 4;

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
        pointLayers: figurePointLayersOf(colors, view.scientificState.pointLayers, renderStateForPoints.bgColor),
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
        // A sculpted point fogs toward the fog color: here, the paper.
        fogRenderState: applyExportBackgroundToRenderState(renderState, background, backgroundColor),
        pointLayers: figurePointLayersOf(colors, view.scientificState.pointLayers, applyExportBackgroundToRenderState(renderState, background, backgroundColor).bgColor),
        highlightArray,
        emphasizeSelection,
        selectionMutedOpacity,
        plotRect,
        crop,
        pointDiameterViewportPx,
        sortByDepth: shouldDepthSort,
        targetCount: opts.optimizedTargetCount,
        seed: fnv1a32(String(meta?.datasetId || meta?.datasetName || viewId)),
      }));
      throwIfFigureExportAborted(signal);
    }

    // The vector field the view shows, as arrows on a grid, under the centroids.
    parts.push(vectorFieldSvgOf({
      data, dimension: dim, renderState, plotRect, crop, ink, fontFamily,
      fontSizePx: baseFontSize, haloColor: background === 'transparent' ? ink.halo : backgroundColor,
      // Its key is the legend's rows; only a figure without a legend draws it in the plot.
      inPlotKey: !layout.vectorKeyInLegend,
    }));

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
      pointDiameterViewportPx: centroidDiameterViewportPx,
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
        plotScale: createPlotPlacement({ renderState, plotRect, crop }).scale,
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

    // Axes: the rulers of what the plot shows, as the layout planned them.
    if (layout.axes !== null && hasVisibleCells) {
      parts.push(renderSvgAxes({
        plotRect,
        axes: layout.axes,
        fontFamily,
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
    const { sharedLegend, sharedLegendRect, sharedLegendPlan, panes } = grid;

    if (grid.titleRect) {
      const titleSize = grid.titleFontPx;
      parts.push(
        `<text x="${grid.titleRect.x + grid.titleRect.width / 2}" y="${grid.titleRect.y + titleSize}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" font-size="${titleSize}" fill="${ink.text}">${escapeXml(title)}</text>`
      );
    }

    for (let idx = 0; idx < views.length; idx++) {
      const view = views[idx];
      const viewId = String(view?.id || 'live');
      // A panel is titled by its letter and the name its view was given (`view.rename`), else its label.
      const viewTitle = panelTitle(view, idx);
      const data = view?.data || {};
      const positions = data.positions || null;
      const colors = data.colors || null;
      const transparency = data.transparency || null;

      const {
        legendModel: panelLegendModel,
        legendPlan: panelLegendPlan,
        labelX,
        labelY,
        panelRect,
        plotRect,
        legendRect: panelLegendRect,
      } = panes[idx];

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
      const pointDiameterViewportPx =
        renderState.pointSize * view.scientificState.lodSizeMultiplier;
      const pointRadiusViewportPx = pointDiameterViewportPx / 2;
      const hasVisibleCells = await requestDrawnCells(session, {
        positions,
        dimension: dim,
        transparency,
        lodMembership,
        renderState,
        crop,
      });
      throwIfFigureExportAborted(signal);

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
      const centroidDiameterViewportPx = renderState.pointSize * 4;
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
          pointLayers: figurePointLayersOf(colors, view.scientificState.pointLayers, renderStateForPoints.bgColor),
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
          // A sculpted point fogs toward the fog color: here, the paper.
          fogRenderState: applyExportBackgroundToRenderState(renderState, background, backgroundColor),
          pointLayers: figurePointLayersOf(colors, view.scientificState.pointLayers, applyExportBackgroundToRenderState(renderState, background, backgroundColor).bgColor),
          highlightArray,
          emphasizeSelection,
          selectionMutedOpacity,
          plotRect,
          crop,
          pointDiameterViewportPx,
          sortByDepth: depthSort3d && dim > 2 && navMode !== 'planar',
          targetCount: opts.optimizedTargetCount,
          seed: fnv1a32(String(meta?.datasetId || meta?.datasetName || viewId)),
        }));
        throwIfFigureExportAborted(signal);
      }

      // The vector field the panel shows, as arrows on a grid, under the centroids.
      parts.push(vectorFieldSvgOf({
        data, dimension: dim, renderState, plotRect, crop, ink, fontFamily,
        fontSizePx: baseFontSize, haloColor: background === 'transparent' ? ink.halo : backgroundColor,
        inPlotKey: !grid.panes[idx].vectorKeyInLegend,
      }));

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
        pointDiameterViewportPx: centroidDiameterViewportPx,
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
            plotScale: createPlotPlacement({ renderState, plotRect, crop }).scale,
            viewMatrix: renderState.viewMatrix,
            cameraState,
            fontFamily,
            fontSize: orientationFontSize,
            ink,
          }) +
          `</g>`
        );
      }

      if (panes[idx].axes !== null && hasVisibleCells) {
        parts.push(
          `<g clip-path="url(#${panelClipId})">` +
          renderSvgAxes({
            plotRect,
            axes: panes[idx].axes,
            fontFamily,
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

      if (panelLegendRect) {
        const legend = renderSvgLegend({
          legendRect: panelLegendRect,
          legendPlan: panelLegendPlan,
          model: panelLegendModel,
          fontFamily,
          // Gradient ids must stay unique per panel: two panels sharing one id
          // would silently paint the second colorbar with the first ramp.
          idPrefix: `legend_${fnv1a32(String(meta?.datasetId || meta?.datasetName || 'cellucid'))}_panel${idx}`,
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
        `font-size="${baseFontSize}" fill="${ink.text}">${escapeXml(viewTitle)}</text>` +
        `</g>`
      );
    }

    if (sharedLegendRect) {
      const legend = renderSvgLegend({
        legendRect: sharedLegendRect,
        legendPlan: sharedLegendPlan,
        model: sharedLegend.model,
        fontFamily,
        idPrefix: `legend_${fnv1a32(String(meta?.datasetId || meta?.datasetName || 'cellucid'))}`,
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
