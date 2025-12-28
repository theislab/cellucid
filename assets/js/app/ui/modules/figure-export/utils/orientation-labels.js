/**
 * @fileoverview Helpers for turning camera orientation into label strings.
 *
 * @module ui/modules/figure-export/utils/orientation-labels
 */

import { clamp } from '../../../../utils/number-utils.js';

function toDegrees(rad) {
  return (Number(rad) * 180) / Math.PI;
}

function normalizeDegrees(deg) {
  let d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  while (d <= -180) d += 360;
  while (d > 180) d -= 360;
  return d;
}

function formatDegrees(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '0';
  return d.toFixed(1).replace(/\.0$/, '');
}

/**
 * @param {any} cameraState
 * @returns {string[]}
 */
export function getCameraAngleLines(cameraState) {
  const nav = cameraState?.navigationMode || null;
  if (nav === 'orbit') {
    const theta = cameraState?.orbit?.theta ?? null;
    const phi = cameraState?.orbit?.phi ?? null;
    if (theta == null || phi == null) return [];
    const az = normalizeDegrees(toDegrees(theta));
    const el = clamp(normalizeDegrees(90 - toDegrees(phi)), -90, 90);
    return [`az ${formatDegrees(az)}°`, `el ${formatDegrees(el)}°`];
  }
  if (nav === 'free') {
    const yaw = cameraState?.freefly?.yaw ?? null;
    const pitch = cameraState?.freefly?.pitch ?? null;
    if (yaw == null || pitch == null) return [];
    const az = normalizeDegrees(toDegrees(yaw));
    const el = clamp(normalizeDegrees(toDegrees(pitch)), -90, 90);
    return [`yaw ${formatDegrees(az)}°`, `pit ${formatDegrees(el)}°`];
  }
  return [];
}

function isDefaultAxisLabel(value, expected) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return true;
  return s === String(expected || '').trim().toLowerCase();
}

/**
 * Apply automatic 3D orientation labels (az/el or yaw/pit) to axes.
 *
 * Only activates for 3D navigation (dim > 2 and navMode !== 'planar').
 * If the user has replaced the default axis labels, we append the orientation
 * rather than overwriting it.
 *
 * @param {object} options
 * @param {string} options.xLabel
 * @param {string} options.yLabel
 * @param {any} options.cameraState
 * @param {number} options.dim
 * @param {string} options.navMode
 * @returns {{ xLabel: string, yLabel: string }}
 */
export function applyAuto3dAxisLabels({ xLabel, yLabel, cameraState, dim, navMode }) {
  const baseX = String(xLabel || 'X');
  const baseY = String(yLabel || 'Y');

  if (!(Number(dim) > 2) || String(navMode || '') === 'planar') {
    return { xLabel: baseX, yLabel: baseY };
  }

  const lines = getCameraAngleLines(cameraState);
  if (lines.length < 2) return { xLabel: baseX, yLabel: baseY };

  const xIsDefault = isDefaultAxisLabel(baseX, 'x');
  const yIsDefault = isDefaultAxisLabel(baseY, 'y');

  return {
    xLabel: xIsDefault ? lines[0] : `${baseX} • ${lines[0]}`,
    yLabel: yIsDefault ? lines[1] : `${baseY} • ${lines[1]}`,
  };
}
