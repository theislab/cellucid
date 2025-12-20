// @ts-check

import { StyleManager } from '../../../utils/style-manager.js';

/**
 * @typedef {Object} PlotTheme
 * @property {string} fontFamily
 * @property {number} fontSize
 * @property {number} tickFontSize
 * @property {number} legendFontSize
 * @property {number} titleFontSize
 * @property {string} plotBg
 * @property {string} textStrong
 * @property {string} text
 * @property {string} textMuted
 * @property {string} accent
 * @property {string} danger
 * @property {string} success
 * @property {string} info
 * @property {string} warning
 * @property {string} axisLine
 * @property {string} grid
 * @property {{ bg: string; border: string; text: string }} hover
 * @property {{ bg: string; border: string; text: string }} legend
 * @property {string} modeBarColor
 */

const FALLBACK_THEME = /** @type {PlotTheme} */ ({
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontSize: 11,
  tickFontSize: 11,
  legendFontSize: 11,
  titleFontSize: 12,
  plotBg: '#ffffff',
  textStrong: '#111827',
  text: '#374151',
  textMuted: '#6b7280',
  accent: '#1ed8ff',
  danger: '#dc2626',
  success: '#16a34a',
  info: '#3b82f6',
  warning: '#eab308',
  axisLine: '#e5e7eb',
  grid: '#f3f4f6',
  hover: { bg: '#111827', border: '#111827', text: '#ffffff' },
  legend: { bg: 'rgba(255, 255, 255, 0.85)', border: '#e5e7eb', text: '#374151' },
  modeBarColor: '#9ca3af',
});

let cachedTheme = /** @type {PlotTheme | null} */ (null);
let cachedThemeKey = '';

/**
 * @param {string} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePxNumber(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @param {string} color
 * @param {number} alpha
 * @returns {string}
 */
function withAlpha(color, alpha) {
  if (!color) return color;
  const a = Math.max(0, Math.min(1, alpha));

  const rgbaMatch = color.match(/^rgba?\\(([^)]+)\\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((p) => p.trim());
    if (parts.length >= 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if ([r, g, b].every((n) => Number.isFinite(n))) {
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      }
    }
  }

  const hex = color.trim();
  const hexMatch = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hexMatch) return color;

  const hexBody = hexMatch[1];
  const full = hexBody.length === 3
    ? hexBody.split('').map((c) => c + c).join('')
    : hexBody;

  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * @returns {HTMLElement | null}
 */
function getRootElement() {
  if (typeof document === 'undefined') return null;
  return document.documentElement;
}

/**
 * @returns {PlotTheme}
 */
export function getPlotTheme() {
  const root = getRootElement();
  if (!root) return FALLBACK_THEME;

  const themeKey = root.dataset.theme || '';
  if (cachedTheme && cachedThemeKey === themeKey) return cachedTheme;

  const fontFamily = StyleManager.getVariable(root, '--font-sans') || FALLBACK_THEME.fontFamily;
  const fontSize = parsePxNumber(StyleManager.resolveVariable(root, '--text-sm'), FALLBACK_THEME.fontSize);
  const tickFontSize = parsePxNumber(StyleManager.resolveVariable(root, '--text-sm'), FALLBACK_THEME.tickFontSize);
  const legendFontSize = parsePxNumber(StyleManager.resolveVariable(root, '--text-sm'), FALLBACK_THEME.legendFontSize);
  const titleFontSize = parsePxNumber(StyleManager.resolveVariable(root, '--text-md'), FALLBACK_THEME.titleFontSize);

  const plotBg = StyleManager.resolveVariable(root, '--color-surface-elevated') || FALLBACK_THEME.plotBg;
  const textStrong = StyleManager.resolveVariable(root, '--color-text-primary') || FALLBACK_THEME.textStrong;
  const text = StyleManager.resolveVariable(root, '--color-text-secondary') || FALLBACK_THEME.text;
  const textMuted = StyleManager.resolveVariable(root, '--color-text-tertiary') || FALLBACK_THEME.textMuted;
  const accent = StyleManager.resolveVariable(root, '--color-accent') || FALLBACK_THEME.accent;
  const danger = StyleManager.resolveVariable(root, '--color-danger') || FALLBACK_THEME.danger;
  const success = StyleManager.resolveVariable(root, '--color-success') || FALLBACK_THEME.success;
  const info = StyleManager.resolveVariable(root, '--color-info') || FALLBACK_THEME.info;
  const warning = StyleManager.resolveVariable(root, '--color-warning') || FALLBACK_THEME.warning;
  const axisLine = StyleManager.resolveVariable(root, '--color-border-light') || FALLBACK_THEME.axisLine;
  const grid = StyleManager.resolveVariable(root, '--color-surface-tertiary') || FALLBACK_THEME.grid;

  const hoverBg = StyleManager.resolveVariable(root, '--color-surface-inverse') || FALLBACK_THEME.hover.bg;
  const hoverText = StyleManager.resolveVariable(root, '--color-text-inverse') || FALLBACK_THEME.hover.text;
  const hoverBorder = hoverBg;

  const legendBorder = axisLine;
  const legendBg = withAlpha(plotBg, 0.85);

  const modeBarColor = StyleManager.resolveVariable(root, '--color-text-tertiary') || FALLBACK_THEME.modeBarColor;

  cachedTheme = {
    fontFamily,
    fontSize,
    tickFontSize,
    legendFontSize,
    titleFontSize,
    plotBg,
    textStrong,
    text,
    textMuted,
    accent,
    danger,
    success,
    info,
    warning,
    axisLine,
    grid,
    hover: { bg: hoverBg, border: hoverBorder, text: hoverText },
    legend: { bg: legendBg, border: legendBorder, text },
    modeBarColor,
  };
  cachedThemeKey = themeKey;

  return cachedTheme;
}

/**
 * Clear the cached theme (useful after a theme change).
 */
export function invalidatePlotThemeCache() {
  cachedTheme = null;
  cachedThemeKey = '';
}

/**
 * Build a Plotly `relayout` update map that applies the current CSS theme.
 * Includes all x/y axes present on the plot element.
 *
 * @param {HTMLElement} plotElement - A Plotly container (div.js-plotly-plot)
 * @param {PlotTheme} [theme]
 * @returns {Record<string, any>}
 */
export function buildPlotlyThemeRelayout(plotElement, theme = getPlotTheme()) {
  const update = /** @type {Record<string, any>} */ ({
    plot_bgcolor: theme.plotBg,
    paper_bgcolor: 'transparent',
    'font.family': theme.fontFamily,
    'font.color': theme.text,
    'legend.font.color': theme.legend.text,
    'legend.bgcolor': theme.legend.bg,
    'legend.bordercolor': theme.legend.border,
    'legend.borderwidth': 1,
    'hoverlabel.bgcolor': theme.hover.bg,
    'hoverlabel.bordercolor': theme.hover.border,
    'hoverlabel.font.family': theme.fontFamily,
    'hoverlabel.font.color': theme.hover.text,
  });

  // Plotly stores layout on the plot element in most builds.
  // Prefer _fullLayout if available, otherwise fall back to layout.
  // @ts-ignore - Plotly attaches these properties at runtime.
  const layout = plotElement?._fullLayout || plotElement?.layout || {};
  if (!layout || typeof layout !== 'object') return update;

  for (const key of Object.keys(layout)) {
    if (!/^xaxis\\d*$/.test(key) && !/^yaxis\\d*$/.test(key)) continue;
    update[`${key}.gridcolor`] = theme.grid;
    update[`${key}.linecolor`] = theme.axisLine;
    update[`${key}.tickfont.color`] = theme.textMuted;
    update[`${key}.title.font.color`] = theme.text;
    update[`${key}.zerolinecolor`] = theme.axisLine;
  }

  // Update annotations created by plot definitions to match the active theme.
  // @ts-ignore - Plotly attaches `layout` at runtime.
  const baseAnnotations = plotElement?.layout?.annotations;
  if (Array.isArray(baseAnnotations) && baseAnnotations.length > 0) {
    update.annotations = baseAnnotations.map((ann) => {
      if (!ann || typeof ann !== 'object') return ann;
      const next = { ...ann };
      const font = ann.font && typeof ann.font === 'object' ? { ...ann.font } : null;

      if (font) {
        font.family = theme.fontFamily;
        const hasBoldText = typeof ann.text === 'string' && ann.text.includes('<b>');
        const currentColor = typeof font.color === 'string' ? font.color : '';
        const borderColor = typeof ann.bordercolor === 'string' ? ann.bordercolor : '';
        if (borderColor && currentColor && borderColor === currentColor) {
          // Keep page-specific colored annotations (e.g., correlation boxes).
        } else if (hasBoldText) {
          font.color = theme.textStrong;
        } else {
          font.color = theme.text;
        }
        next.font = font;
      }

      if (typeof ann.bgcolor === 'string') next.bgcolor = theme.legend.bg;
      if (typeof ann.arrowcolor === 'string') next.arrowcolor = theme.textMuted;
      return next;
    });
  }

  // Update dashed guide/threshold lines (common across plots) to match the theme.
  // @ts-ignore - Plotly attaches `layout` at runtime.
  const baseShapes = plotElement?.layout?.shapes;
  if (Array.isArray(baseShapes) && baseShapes.length > 0) {
    update.shapes = baseShapes.map((shape) => {
      if (!shape || typeof shape !== 'object') return shape;
      const line = shape.line && typeof shape.line === 'object' ? { ...shape.line } : null;
      if (line && line.dash === 'dash') {
        line.color = theme.textMuted;
        return { ...shape, line };
      }
      return shape;
    });
  }

  return update;
}

/**
 * Apply the current Plotly theme to a rendered plot element.
 * Safe no-op if Plotly is not loaded.
 *
 * @param {HTMLElement} plotElement
 * @returns {Promise<void>}
 */
export async function applyThemeToPlotlyPlot(plotElement) {
  if (!plotElement) return;
  // Avoid forcing a Plotly load just for theme updates.
  if (typeof window === 'undefined' || !window.Plotly || typeof window.Plotly.relayout !== 'function') return;

  try {
    const theme = getPlotTheme();
    const update = buildPlotlyThemeRelayout(plotElement, theme);
    await window.Plotly.relayout(plotElement, update);

    // Update common trace-level theme affordances (e.g., colorbar fonts, pie slice borders).
    if (typeof window.Plotly.restyle === 'function') {
      await window.Plotly.restyle(plotElement, {
        'colorbar.tickfont.family': theme.fontFamily,
        'colorbar.tickfont.color': theme.textMuted,
        'colorbar.title.font.family': theme.fontFamily,
        'colorbar.title.font.color': theme.text,
        'marker.line.color': theme.plotBg,
      });
    }
  } catch (_err) {
    // Ignore theme relayout errors (plot may be mid-destroy).
  }
}

/**
 * Apply theme to all plots currently in the DOM.
 *
 * @param {ParentNode} [root=document]
 * @returns {Promise<void>}
 */
export async function applyThemeToAllPlots(root = document) {
  if (typeof document === 'undefined') return;
  if (!root) return;

  // Plotly marks plot divs with this class.
  const plots = Array.from(root.querySelectorAll('.js-plotly-plot'));
  if (plots.length === 0) return;

  // Run sequentially to avoid spamming relayout; plots are typically few.
  for (const el of plots) {
    // @ts-ignore - querySelectorAll returns Element.
    await applyThemeToPlotlyPlot(el);
  }
}
