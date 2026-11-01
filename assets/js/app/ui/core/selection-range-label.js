/**
 * @fileoverview Shared selection range label overlay.
 *
 * The legend (continuous filters) and highlight selection tools both display a
 * floating "min → max" label near the cursor while the user drags selection
 * ranges. This helper provides a single shared DOM element, so modules don't
 * accidentally create duplicate IDs; the bounds are written as every range
 * bound is (`formatBound`).
 *
 * @module ui/core/selection-range-label
 */

import { formatBound } from '../../../utils/format-units.js';

const DEFAULT_ID = 'selection-range-label';

function ensureRangeLabelElement(id) {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const el = document.createElement('div');
  el.id = id;
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

/**
 * Get the shared selection range label instance.
 *
 * @param {object} [options]
 * @param {string} [options.id='selection-range-label'] - DOM element id to reuse.
 * @returns {{ element: HTMLElement, show: (x: number, y: number, minVal: number, maxVal: number) => void, hide: () => void }}
 */
export function getSelectionRangeLabel(options = {}) {
  const id = options.id || DEFAULT_ID;
  const element = ensureRangeLabelElement(id);

  function show(x, y, minVal, maxVal) {
    element.textContent = `${formatBound(minVal)} → ${formatBound(maxVal)}`;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.hidden = false;
  }

  function hide() {
    element.hidden = true;
  }

  return { element, show, hide };
}

