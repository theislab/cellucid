/**
 * @fileoverview Small color helpers for export/renderers.
 *
 * @module ui/modules/figure-export/utils/color-utils
 */

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function toHexByte(v01) {
  const b = Math.max(0, Math.min(255, Math.round(clamp01(v01) * 255)));
  return b.toString(16).padStart(2, '0');
}

/**
 * @param {Float32Array|number[]|null|undefined} rgb01
 * @returns {string|null} Hex color like "#rrggbb"
 */
export function rgb01ToHex(rgb01) {
  if (!rgb01 || rgb01.length < 3) return null;
  return `#${toHexByte(rgb01[0])}${toHexByte(rgb01[1])}${toHexByte(rgb01[2])}`;
}

/**
 * @param {string|null|undefined} hex
 * @returns {[number, number, number]|null} RGB in 0..1
 */
export function hexToRgb01(hex) {
  const raw = String(hex || '').trim();
  const m = raw.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const s = m[1];
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [r / 255, g / 255, b / 255];
}

