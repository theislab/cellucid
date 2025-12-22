/**
 * @fileoverview Intersection helpers for CategoryBuilder overlap strategy.
 *
 * @module ui/category-builder/intersections
 */

/**
 * Produce a default label for an intersection bitmask, e.g. "A & B".
 * @param {number} mask
 * @param {string[]} labels
 * @returns {string}
 */
export function formatIntersectionLabel(mask, labels) {
  const parts = [];
  for (let i = 0; i < (labels?.length || 0); i++) {
    if (mask & (1 << i)) parts.push(String(labels[i] ?? `Page ${i + 1}`));
  }
  return parts.join(' & ');
}

/**
 * Render editable labels for intersection rows and keep `labelsByMask` in sync.
 *
 * @param {object} options
 * @param {HTMLElement|null} options.listEl
 * @param {Array<{mask: number|string, count: number}>} options.rows
 * @param {string[]} options.pageLabels
 * @param {Record<string, string>} options.labelsByMask
 * @param {() => void} [options.onLabelsChanged]
 */
export function renderIntersectionLabelInputs({
  listEl,
  rows,
  pageLabels,
  labelsByMask,
  onLabelsChanged
}) {
  if (!listEl) return;

  const active = new Set((rows || []).map((r) => String(r.mask)));
  for (const key of Object.keys(labelsByMask || {})) {
    if (!active.has(key)) delete labelsByMask[key];
  }

  listEl.innerHTML = '';

  (rows || []).forEach((row) => {
    const maskKey = String(row.mask);
    if (labelsByMask[maskKey] == null) {
      labelsByMask[maskKey] = formatIntersectionLabel(Number(row.mask) || 0, pageLabels) || 'Overlap';
    }

    const rowEl = document.createElement('div');
    rowEl.className = 'cat-builder-intersection-row';

    const meta = document.createElement('div');
    meta.className = 'cat-builder-intersection-meta';
    meta.textContent = `${row.count.toLocaleString()} cells`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cat-builder-intersection-input';
    input.value = labelsByMask[maskKey];
    input.dataset.mask = maskKey;
    input.addEventListener('input', () => {
      labelsByMask[maskKey] = input.value;
      onLabelsChanged?.();
    });

    rowEl.appendChild(meta);
    rowEl.appendChild(input);
    listEl.appendChild(rowEl);
  });
}

