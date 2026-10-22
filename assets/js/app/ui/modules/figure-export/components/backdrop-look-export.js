/**
 * @fileoverview Figure-export reproduction of the viewer's backdrop looks
 * (`Atelier`, `Nebula`, `Abyss`, `Aurora`; `rendering/backdrops/`).
 *
 * WHAT THE VIEWER DRAWS
 * A look is a procedural raster: baked sky cube maps and tiles composited per
 * fragment with star cores, paper grain, light, an optional contact shadow
 * and (Abyss) marine-snow sprites. None of it is line geometry, so unlike the
 * grid and the studio backdrop it cannot become vectors.
 *
 * HOW IT IS REPRODUCED
 * The same renderer and shaders draw the look again, offscreen, for the
 * figure's plot rectangle (`rendering/backdrops/backdrop-look-raster.js`),
 * from the screen's frozen state for the pane — the look, the data tints, the
 * ambient clock and Atelier's contact-shadow map — and the pane's presented
 * camera. Each raster pixel is mapped back to the pane NDC it shows through
 * the same viewport-to-plot placement as the points (`createPlotProjection`),
 * so the look stays registered with the data under any crop or letterbox.
 * PNG gets the raster at device pixels; SVG embeds it as an `<image>` under
 * the points, at the hybrid point raster's 2× density.
 *
 * WHEN IT IS DRAWN
 * Only on the viewer's own paper (`Background: Match viewer`): a look is an
 * opaque picture of the stage, so on White, Transparent or a custom colour
 * the figure keeps the paper it was asked for.
 *
 * KNOWN, BOUNDED DIFFERENCES FROM THE SCREEN
 * - The screen's sub-code-value dither is re-drawn, not copied: grain differs
 *   pixel by pixel at under one code value.
 * - A figure larger than the GPU's largest render target is drawn at that
 *   size and scaled up with high-quality smoothing.
 * - The 0.35 s fade after selecting a look is not reproduced: an export shows
 *   the settled look.
 *
 * @module ui/modules/figure-export/components/backdrop-look-export
 */

import { renderBackdropLookRaster } from '../../../../../rendering/backdrops/backdrop-look-raster.js';
import { createPlotProjection } from '../utils/plot-projection.js';

/**
 * Whether a figure draws the pane's look: a look is active for the pane and
 * the figure's paper is the viewer's own.
 *
 * @param {object|null} appearance - from `utils/viewer-background.js`
 * @param {{ viewerPaper: boolean }|null} surface - `resolveReferenceGridSurface`
 * @param {object|null} renderState
 */
export function figureDrawsBackdropLook(appearance, surface, renderState) {
  return appearance?.kind === 'look'
    && surface?.viewerPaper === true
    && renderState?.backdrop?.look != null;
}

/**
 * The affine map from raster NDC (the plot rectangle) to the pane NDC it
 * shows: `pane = raster * [sx, sy] + [ox, oy]`.
 *
 * @param {object} options
 * @param {{ viewportWidth: number; viewportHeight: number }} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {object|null} [options.crop]
 * @returns {{ ndcTransform: number[]; viewportPerPlot: number }}
 */
export function resolveBackdropLookPlacement({ renderState, plotRect, crop = null }) {
  const projection = createPlotProjection({ renderState, plotRect, crop });
  const origin = projection.viewportToPlot(projection.srcX0, projection.srcY0);
  const vw = projection.viewportW;
  const vh = projection.viewportH;
  const toViewportX = (plotX) => (plotX - origin.x) / projection.scale + projection.srcX0;
  const toViewportY = (plotY) => (plotY - origin.y) / projection.scale + projection.srcY0;
  const centreX = plotRect.x + plotRect.width / 2;
  const centreY = plotRect.y + plotRect.height / 2;
  return {
    ndcTransform: [
      (plotRect.width / projection.scale) / vw,
      (plotRect.height / projection.scale) / vh,
      (2 * toViewportX(centreX)) / vw - 1,
      1 - (2 * toViewportY(centreY)) / vh,
    ],
    // Pane pixels per plot unit.
    viewportPerPlot: 1 / projection.scale,
  };
}

/**
 * Render the pane's look for a plot rectangle at `width` × `height` pixels.
 *
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function renderBackdropLookForPlot({
  renderState,
  plotRect,
  crop = null,
  width,
  height,
  signal = null,
}) {
  const { ndcTransform, viewportPerPlot } = resolveBackdropLookPlacement({ renderState, plotRect, crop });
  // Raster pixels per pane pixel.
  const pixelScale = (width / plotRect.width) / viewportPerPlot;
  return renderBackdropLookRaster({
    renderState,
    width,
    height,
    ndcTransform,
    pixelScale,
    signal,
  });
}

/** The SVG `<image>` of a look raster covering `plotRect`. */
export function renderSvgBackdropLookImage(dataUrl, plotRect) {
  return `<image class="cellucid-backdrop-look" x="${plotRect.x}" y="${plotRect.y}" `
    + `width="${plotRect.width}" height="${plotRect.height}" href="${dataUrl}" preserveAspectRatio="none"/>`;
}

// The export preview draws synchronously: it shows the last raster rendered
// for the same pane state and size, and asks for a new one when it differs.
const previewCache = { key: null, canvas: null, pending: null };

/**
 * The preview's look raster for this state, or null while it is rendered;
 * `onReady` is called once a requested raster lands.
 */
export function peekBackdropLookPreview({ renderState, plotRect, crop, width, height }, onReady) {
  const look = renderState.backdrop.look;
  const key = JSON.stringify([
    look.id, look.tints, look.time, look.shadow?.window ?? null,
    Array.from(renderState.mvpMatrix), renderState.viewportWidth, renderState.viewportHeight,
    plotRect, crop, width, height,
  ]);
  if (previewCache.key === key && previewCache.canvas !== null) return previewCache.canvas;
  if (previewCache.pending !== key) {
    previewCache.pending = key;
    renderBackdropLookForPlot({ renderState, plotRect, crop, width, height })
      .then((canvas) => {
        if (previewCache.pending !== key) return;
        previewCache.key = key;
        previewCache.canvas = canvas;
        previewCache.pending = null;
        onReady();
      })
      .catch((error) => {
        if (previewCache.pending === key) previewCache.pending = null;
        console.warn('[FigureExport] Background-look preview failed:', error);
      });
  }
  return null;
}
