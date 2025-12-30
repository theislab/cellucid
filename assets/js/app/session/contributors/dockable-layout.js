/**
 * @fileoverview Session contributor: floating dockable panel layout (non-analysis).
 *
 * EAGER chunk (dataset-agnostic):
 * - Persist which sidebar accordion sections were torn off into floating panels
 * - Persist their geometry (x/y/width/height) and open/closed state
 *
 * Notes:
 * - Analysis windows are handled by the dedicated analysis-windows contributor.
 * - Geometry is clamped by dockable-accordions itself; we only provide best-effort inputs.
 *
 * @module session/contributors/dockable-layout
 */

import { StyleManager } from '../../../utils/style-manager.js';

export const id = 'dockable-layout';

/**
 * Hash a string into a stable u32 value (FNV-1a).
 * Used to deterministically cascade panels that would otherwise restore off-screen.
 *
 * @param {string} s
 * @returns {number}
 */
function hashString32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * @returns {{ width: number, height: number } | null}
 */
function getViewportSize() {
  const w = typeof window !== 'undefined' ? window.innerWidth : null;
  const h = typeof window !== 'undefined' ? window.innerHeight : null;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: w, height: h };
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * If saved geometry is invalid or off-screen, choose a safe deterministic position.
 *
 * @param {string} panelId
 * @param {{ width: number, height: number }} viewport
 * @returns {{ left: number, top: number }}
 */
function cascadeToSafePosition(panelId, viewport) {
  const margin = 24;
  const step = 28;
  const cols = Math.max(1, Math.floor((viewport.width - margin * 2) / step));
  const rows = Math.max(1, Math.floor((viewport.height - margin * 2) / step));
  const slots = Math.max(1, cols * rows);

  const idx = hashString32(panelId) % slots;
  const col = idx % cols;
  const row = (idx / cols) | 0;

  return {
    left: margin + col * step,
    top: margin + row * step
  };
}

/**
 * Clamp and sanitize floating panel geometry to the current viewport.
 *
 * @param {string} panelId
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @returns {{ left?: number, top?: number, preferredSize?: { width?: number, height?: number } }}
 */
function normalizeFloatGeometry(panelId, rect) {
  const viewport = getViewportSize();
  const minWidth = 240;
  const minHeight = 180;
  const margin = 24;

  const rawLeft = Number(rect?.left);
  const rawTop = Number(rect?.top);
  const rawWidth = Number(rect?.width);
  const rawHeight = Number(rect?.height);

  const hasSize = Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth > 0 && rawHeight > 0;
  const hasPos = Number.isFinite(rawLeft) && Number.isFinite(rawTop);

  /** @type {{ width?: number, height?: number }} */
  const preferredSize = {};

  if (hasSize) {
    if (viewport) {
      preferredSize.width = clamp(rawWidth, minWidth, Math.max(minWidth, viewport.width - margin * 2));
      preferredSize.height = clamp(rawHeight, minHeight, Math.max(minHeight, viewport.height - margin * 2));
    } else {
      preferredSize.width = rawWidth;
      preferredSize.height = rawHeight;
    }
  }

  if (!viewport || !hasPos) {
    // If we can't reason about viewport bounds, use saved geometry as-is when possible.
    // When position is invalid, fall back to a deterministic cascade.
    if (viewport && !hasPos) {
      const fallback = cascadeToSafePosition(panelId, viewport);
      return { left: fallback.left, top: fallback.top, preferredSize };
    }
    return { left: hasPos ? rawLeft : undefined, top: hasPos ? rawTop : undefined, preferredSize };
  }

  const widthForClamp = preferredSize.width ?? minWidth;
  const heightForClamp = preferredSize.height ?? minHeight;

  const maxLeft = Math.max(margin, viewport.width - margin - widthForClamp);
  const maxTop = Math.max(margin, viewport.height - margin - heightForClamp);

  let left = clamp(rawLeft, margin, maxLeft);
  let top = clamp(rawTop, margin, maxTop);

  // If the saved rect is wildly out of bounds, clamp may still pin to the margin; if that
  // produces a degenerate placement (e.g., viewport too small), cascade to a safe position.
  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    const fallback = cascadeToSafePosition(panelId, viewport);
    left = fallback.left;
    top = fallback.top;
  }

  return { left, top, preferredSize };
}

/**
 * Skip ephemeral or non-session panels.
 * @param {Element} el
 * @returns {boolean}
 */
function isSkipped(el) {
  if (!el) return true;
  if (el.closest?.('[data-state-serializer-skip]')) return true;
  // Analysis windows are session-restored separately.
  if (el.classList?.contains('analysis-window-panel')) return true;
  if (el.dataset?.analysisWindowId) return true;
  return false;
}

/**
 * Derive a stable ID for a dockable panel.
 * Prefer the DOM id, otherwise fall back to the summary label.
 *
 * @param {HTMLDetailsElement} details
 * @returns {string|null}
 */
function getPanelId(details) {
  const domId = String(details.id || '').trim();
  if (domId) return domId;
  const summaryText = details.querySelector('summary')?.textContent?.trim?.() || '';
  return summaryText || null;
}

/**
 * Parse a CSS custom property containing a px number.
 * @param {HTMLElement} el
 * @param {string} varName
 * @returns {number|null}
 */
function readPxVar(el, varName) {
  const raw = StyleManager.getVariable(el, varName);
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text.endsWith('px')) return null;
  const n = Number(text.slice(0, -2));
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the current floating geometry for a panel.
 * Uses StyleManager custom properties, falling back to DOMRect.
 *
 * @param {HTMLDetailsElement} details
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
function readPanelRect(details) {
  const left = readPxVar(details, '--pos-x');
  const top = readPxVar(details, '--pos-y');
  const width = readPxVar(details, '--pos-width');
  const height = readPxVar(details, '--pos-height');

  if (left != null && top != null && width != null && height != null) {
    return { left, top, width, height };
  }

  const rect = details.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

/**
 * Capture floating dockable panel geometry.
 * @param {object} ctx
 * @returns {import('../session-serializer.js').SessionChunk[]}
 */
export function capture(ctx) {
  const floatingRoot = ctx?.dockableAccordions?.floatingRoot || document.getElementById('floating-panels-root');
  if (!floatingRoot) return [];

  /** @type {any[]} */
  const panels = [];

  floatingRoot.querySelectorAll('details.accordion-section').forEach((details) => {
    if (!(details instanceof HTMLDetailsElement)) return;
    if (!details.classList.contains('accordion-floating')) return;
    if (isSkipped(details)) return;

    const panelId = getPanelId(details);
    if (!panelId) return;

    const rect = readPanelRect(details);
    const zRaw = StyleManager.getVariable(details, '--z-layer');
    const z = zRaw ? Number(String(zRaw).trim()) : null;

    panels.push({
      id: panelId,
      open: details.open === true,
      rect,
      z: Number.isFinite(z) ? z : null
    });
  });

  // Sort by z so restore order preserves stacking as much as possible.
  panels.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  return [
    {
      id: 'ui/dockable-layout',
      contributorId: id,
      priority: 'eager',
      kind: 'json',
      codec: 'gzip',
      label: 'Floating panels',
      datasetDependent: false,
      payload: { panels }
    }
  ];
}

/**
 * Restore floating dockable panel geometry.
 *
 * @param {object} ctx
 * @param {any} _chunkMeta
 * @param {{ panels?: any[] }} payload
 */
export function restore(ctx, _chunkMeta, payload) {
  const dockable = ctx?.dockableAccordions;
  if (!dockable?.float || !payload?.panels || !Array.isArray(payload.panels)) return;

  const panels = payload.panels;

  // Restore in z-order so the last floated panel ends up on top.
  for (const p of panels) {
    const panelId = String(p?.id || '').trim();
    if (!panelId) continue;

    const details = findDetailsByPanelId(panelId);
    if (!details || isSkipped(details)) continue;

    const rect = p.rect || {};
    const geom = normalizeFloatGeometry(panelId, rect);

    // Float with best-effort geometry. DockableAccordions clamps to viewport.
    dockable.float(details, {
      left: Number.isFinite(geom.left) ? geom.left : undefined,
      top: Number.isFinite(geom.top) ? geom.top : undefined,
      preferredSize: geom.preferredSize || undefined
    });

    // Restore open/closed state after floating (float forces open=true).
    if (typeof p.open === 'boolean') {
      details.open = p.open;
    }

    // Best-effort z-layer: if present, apply as a hint.
    if (Number.isFinite(p.z)) {
      StyleManager.setLayer(details, p.z);
    }
  }
}

/**
 * Find a dockable accordion <details> element by stable id or summary label.
 * Matches the same semantics as the UI-control serializer.
 *
 * @param {string} panelId
 * @returns {HTMLDetailsElement|null}
 */
function findDetailsByPanelId(panelId) {
  const roots = [document.getElementById('sidebar'), document.getElementById('floating-panels-root')].filter(Boolean);
  for (const root of roots) {
    const matchById = root.querySelector?.(`details.accordion-section#${CSS.escape(panelId)}`);
    if (matchById instanceof HTMLDetailsElement) return matchById;

    const all = root.querySelectorAll?.('details.accordion-section') || [];
    for (const details of all) {
      if (!(details instanceof HTMLDetailsElement)) continue;
      const summaryText = details.querySelector('summary')?.textContent?.trim?.() || '';
      if (summaryText === panelId) return details;
    }
  }
  return null;
}
