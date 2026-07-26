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

const HEADLESS_PLOT_THEME = /** @type {PlotTheme} */ ({
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
 * @param {string} token
 * @returns {number}
 */
function requirePxNumber(value, token) {
  if (typeof value !== 'string') {
    throw new TypeError(`Plot theme token ${token} must resolve to a pixel value`);
  }
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)px$/);
  if (!match) {
    throw new TypeError(`Plot theme token ${token} must resolve to a positive pixel value`);
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`Plot theme token ${token} must be greater than zero`);
  }
  return parsed;
}

/**
 * @param {HTMLElement} root
 * @param {string} token
 * @returns {string}
 */
function requireResolvedVariable(root, token) {
  const value = StyleManager.resolveVariable(root, token);
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('var(')) {
    throw new TypeError(`Plot theme token ${token} must resolve to a concrete value`);
  }
  return value;
}

/**
 * @param {string} color
 * @param {number} alpha
 * @returns {string}
 */
function withAlpha(color, alpha) {
  if (typeof color !== 'string' || color.length === 0) {
    throw new TypeError('Plot theme color must be a non-empty string');
  }
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new RangeError('Plot theme alpha must be between zero and one');
  }

  const rgbaMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((p) => p.trim());
    const expectedParts = color.toLowerCase().startsWith('rgba(') ? 4 : 3;
    if (parts.length !== expectedParts) {
      throw new TypeError(`Unsupported Plot theme color: ${color}`);
    }
    const numericPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
    if (!parts.slice(0, 3).every(part => numericPattern.test(part))) {
      throw new TypeError(`Unsupported Plot theme color: ${color}`);
    }
    const [r, g, b] = parts.slice(0, 3).map(Number);
    if (![r, g, b].every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
      throw new RangeError(`Plot theme RGB channels must be between zero and 255: ${color}`);
    }
    if (
      expectedParts === 4 &&
      (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(parts[3]) || Number(parts[3]) > 1)
    ) {
      throw new RangeError(`Plot theme source alpha must be between zero and one: ${color}`);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const hex = color.trim();
  const hexMatch = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hexMatch) {
    throw new TypeError(`Unsupported Plot theme color: ${color}`);
  }

  const hexBody = hexMatch[1];
  const full = hexBody.length === 3
    ? hexBody.split('').map((c) => c + c).join('')
    : hexBody;

  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  if (!root) return HEADLESS_PLOT_THEME;

  const themeKey = root.dataset.theme === undefined
    ? 'css-defined-theme'
    : root.dataset.theme;
  if (cachedTheme && cachedThemeKey === themeKey) return cachedTheme;

  const fontFamily = requireResolvedVariable(root, '--font-sans');
  const textSm = requireResolvedVariable(root, '--text-sm');
  const fontSize = requirePxNumber(textSm, '--text-sm');
  const tickFontSize = fontSize;
  const legendFontSize = fontSize;
  const titleFontSize = requirePxNumber(
    requireResolvedVariable(root, '--text-md'),
    '--text-md'
  );

  const plotBg = requireResolvedVariable(root, '--color-surface-elevated');
  const textStrong = requireResolvedVariable(root, '--color-text-primary');
  const text = requireResolvedVariable(root, '--color-text-secondary');
  const textMuted = requireResolvedVariable(root, '--color-text-tertiary');
  const accent = requireResolvedVariable(root, '--color-accent');
  const danger = requireResolvedVariable(root, '--color-danger');
  const success = requireResolvedVariable(root, '--color-success');
  const info = requireResolvedVariable(root, '--color-info');
  const warning = requireResolvedVariable(root, '--color-warning');
  const axisLine = requireResolvedVariable(root, '--color-border-light');
  const grid = requireResolvedVariable(root, '--color-surface-tertiary');

  const hoverBg = requireResolvedVariable(root, '--color-surface-inverse');
  const hoverText = requireResolvedVariable(root, '--color-text-inverse');
  const hoverBorder = hoverBg;

  const legendBorder = axisLine;
  const legendBg = withAlpha(plotBg, 0.85);

  const modeBarColor = textMuted;

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

  if (!plotElement || typeof plotElement !== 'object') {
    throw new TypeError('A rendered Plotly element is required');
  }
  // Plotly owns its rendered axis set on `_fullLayout`.
  // @ts-ignore - Plotly attaches these properties at runtime.
  const layout = plotElement._fullLayout;
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('Rendered Plotly element._fullLayout is required');
  }

  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key) && !/^yaxis\d*$/.test(key)) continue;
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
  if (!plotElement || typeof plotElement !== 'object') {
    throw new TypeError('A rendered Plotly element is required');
  }
  if (typeof window === 'undefined' || !window.Plotly) return;
  if (
    typeof window.Plotly.relayout !== 'function' ||
    typeof window.Plotly.restyle !== 'function'
  ) {
    throw new TypeError('Plotly.relayout and Plotly.restyle are required for theme updates');
  }
  const theme = getPlotTheme();
  const update = buildPlotlyThemeRelayout(plotElement, theme);
  await window.Plotly.relayout(plotElement, update);
  await window.Plotly.restyle(plotElement, {
    'colorbar.tickfont.family': theme.fontFamily,
    'colorbar.tickfont.color': theme.textMuted,
    'colorbar.title.font.family': theme.fontFamily,
    'colorbar.title.font.color': theme.text,
    'marker.line.color': theme.plotBg,
  });
}

/**
 * Apply theme to all plots currently in the DOM.
 *
 * @param {ParentNode} [root=document]
 * @returns {Promise<void>}
 */
export async function applyThemeToAllPlots(root) {
  if (typeof document === 'undefined') return;
  const queryRoot = root === undefined ? document : root;
  if (!queryRoot || typeof queryRoot.querySelectorAll !== 'function') {
    throw new TypeError('Theme application root must support querySelectorAll');
  }

  // Plotly marks plot divs with this class.
  const plots = Array.from(queryRoot.querySelectorAll('.js-plotly-plot'));
  if (plots.length === 0) return;

  // Run sequentially to avoid spamming relayout; plots are typically few.
  for (const el of plots) {
    // @ts-ignore - querySelectorAll returns Element.
    await applyThemeToPlotlyPlot(el);
  }
}
