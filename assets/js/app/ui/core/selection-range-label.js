/**
 * @fileoverview Shared selection range label overlay.
 *
 * The legend (continuous filters) and highlight selection tools both display a
 * floating "min → max" label near the cursor while the user drags selection
 * ranges. This helper provides a single shared DOM element + consistent
 * formatting so modules don't accidentally create duplicate IDs.
 *
 * @module ui/core/selection-range-label
 */

const DEFAULT_ID = 'selection-range-label';

function formatRangeValue(value) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10000 || (abs > 0 && abs < 0.01)) {
    const exp = Math.floor(Math.log10(abs));
    const mantissa = abs / Math.pow(10, exp);
    const m = mantissa < 10 ? mantissa.toFixed(1).replace(/\.0$/, '') : Math.round(mantissa);
    return `${sign}${m}e${exp}`;
  }
  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 10) return sign + abs.toFixed(1);
  return sign + abs.toFixed(2);
}

function ensureRangeLabelElement(id) {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const el = document.createElement('div');
  el.id = id;
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
    element.textContent = `${formatRangeValue(minVal)} → ${formatRangeValue(maxVal)}`;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.style.display = 'block';
  }

  function hide() {
    element.style.display = 'none';
  }

  return { element, show, hide };
}

