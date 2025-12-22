/**
 * @fileoverview Centroid overlay (points + labels) for figure export.
 *
 * The interactive viewer renders centroids as a separate point layer (larger)
 * and labels them via the DOM overlay. For WYSIWYG exports we reproduce this
 * overlay using the same view projection matrices as the scatter plot.
 *
 * This module is intentionally small and pure: it does not query global DOM
 * state and relies on the caller to provide centroid buffers + label strings.
 *
 * @module ui/modules/figure-export/components/centroid-overlay
 */

import { escapeHtml } from '../../../../utils/dom-utils.js';
import { forEachProjectedPoint } from '../utils/point-projector.js';

/**
 * @param {any} flags
 * @returns {{ points: boolean, labels: boolean }}
 */
function normalizeFlags(flags) {
  return {
    points: Boolean(flags?.points),
    labels: Boolean(flags?.labels),
  };
}

function getLabelAtIndex(labelTexts, index) {
  if (!Array.isArray(labelTexts) || !Number.isFinite(index)) return '';
  const s = labelTexts[index];
  return s == null ? '' : String(s);
}

/**
 * Render centroid points + labels as SVG markup (plot-space coordinates).
 *
 * @param {object} options
 * @param {Float32Array|null} options.positions
 * @param {Uint8Array|null} options.colors
 * @param {string[]|null} [options.labelTexts]
 * @param {{ points?: boolean; labels?: boolean }|null} [options.flags]
 * @param {any} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {number} options.pointRadiusPx - centroid point radius in plot-space px
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @param {string} [options.fontFamily]
 * @param {number} [options.labelFontSizePx]
 * @param {string} [options.labelColor]
 * @param {string} [options.haloColor]
 * @returns {string}
 */
export function renderSvgCentroidOverlay({
  positions,
  colors,
  labelTexts = null,
  flags = null,
  renderState,
  plotRect,
  pointRadiusPx,
  crop = null,
  fontFamily = 'Arial, Helvetica, sans-serif',
  labelFontSizePx = 12,
  labelColor = '#111',
  haloColor = '#ffffff',
}) {
  const f = normalizeFlags(flags);
  if ((!f.points && !f.labels) || !positions || !colors || !renderState?.mvpMatrix) return '';

  const labelSize = Math.max(6, Math.round(Number(labelFontSizePx) || 12));
  const haloW = Math.max(1.5, Math.round(labelSize * 0.28));
  const strokeW = Math.max(0.5, Math.min(2.5, Number(pointRadiusPx || 1) * 0.18));

  const parts = [];
  parts.push(`<g font-family="${escapeHtml(fontFamily)}" fill="${escapeHtml(labelColor)}">`);

  forEachProjectedPoint({
    positions,
    colors,
    transparency: null,
    renderState,
    plotRect,
    radiusPx: Math.max(0.5, Number(pointRadiusPx) || 0.5),
    visibilityMask: null,
    crop,
    sortByDepth: false,
    onPoint: (x, y, r, g, b, a, radius, index) => {
      if (a < 0.01) return;

      if (f.points) {
        const fill = `rgb(${r},${g},${b})`;
        if (a >= 0.999) {
          parts.push(
            `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}" stroke="#111" stroke-width="${strokeW.toFixed(2)}"/>`
          );
        } else {
          parts.push(
            `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}" fill-opacity="${a.toFixed(3)}" stroke="#111" stroke-width="${strokeW.toFixed(2)}" stroke-opacity="${a.toFixed(3)}"/>`
          );
        }
      }

      if (f.labels) {
        const text = getLabelAtIndex(labelTexts, index);
        if (!text) return;
        const safe = escapeHtml(text);
        const tx = x.toFixed(2);
        const ty = y.toFixed(2);
        // Draw a halo for readability, then the label on top.
        parts.push(
          `<text x="${tx}" y="${ty}" font-size="${labelSize}" text-anchor="middle" dy="0.35em" stroke="${escapeHtml(haloColor)}" stroke-width="${haloW}" stroke-linejoin="round" fill="none">${safe}</text>`
        );
        parts.push(
          `<text x="${tx}" y="${ty}" font-size="${labelSize}" text-anchor="middle" dy="0.35em" fill="${escapeHtml(labelColor)}">${safe}</text>`
        );
      }
    }
  });

  parts.push(`</g>`);
  return parts.join('');
}

/**
 * Draw centroid points + labels on a Canvas2D context (plot-space coordinates).
 *
 * @param {object} options
 * @param {CanvasRenderingContext2D} options.ctx
 * @param {Float32Array|null} options.positions
 * @param {Uint8Array|null} options.colors
 * @param {string[]|null} [options.labelTexts]
 * @param {{ points?: boolean; labels?: boolean }|null} [options.flags]
 * @param {any} options.renderState
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {number} options.pointRadiusPx - centroid point radius in plot-space px
 * @param {{ enabled?: boolean; x?: number; y?: number; width?: number; height?: number } | null} [options.crop]
 * @param {string} [options.fontFamily]
 * @param {number} [options.labelFontSizePx]
 * @param {string} [options.labelColor]
 * @param {string} [options.haloColor]
 */
export function drawCanvasCentroidOverlay({
  ctx,
  positions,
  colors,
  labelTexts = null,
  flags = null,
  renderState,
  plotRect,
  pointRadiusPx,
  crop = null,
  fontFamily = 'Arial, Helvetica, sans-serif',
  labelFontSizePx = 12,
  labelColor = '#111',
  haloColor = 'rgba(255,255,255,0.95)',
}) {
  const f = normalizeFlags(flags);
  if ((!f.points && !f.labels) || !ctx || !positions || !colors || !renderState?.mvpMatrix) return;

  const labelSize = Math.max(6, Math.round(Number(labelFontSizePx) || 12));
  const strokeW = Math.max(1, Math.round(labelSize * 0.28));

  ctx.save();
  ctx.font = `${labelSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  forEachProjectedPoint({
    positions,
    colors,
    transparency: null,
    renderState,
    plotRect,
    radiusPx: Math.max(0.5, Number(pointRadiusPx) || 0.5),
    visibilityMask: null,
    crop,
    sortByDepth: false,
    onPoint: (x, y, r, g, b, a, radius, index) => {
      if (a < 0.01) return;

      if (f.points) {
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(17,17,17,${a})`;
        ctx.lineWidth = Math.max(0.5, Math.min(2.5, radius * 0.18));
        ctx.stroke();
      }

      if (f.labels) {
        const text = getLabelAtIndex(labelTexts, index);
        if (!text) return;
        // Halo + fill.
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = haloColor;
        ctx.fillStyle = labelColor;
        ctx.strokeText(text, x, y + labelSize * 0.35);
        ctx.fillText(text, x, y + labelSize * 0.35);
      }
    }
  });

  ctx.restore();
}

