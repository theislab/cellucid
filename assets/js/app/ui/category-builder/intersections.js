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
function requirePageLabels(labels) {
  if (
    !Array.isArray(labels)
    || labels.length === 0
    || labels.length > 31
    || labels.some(
      label => (
        typeof label !== 'string'
        || label.length === 0
        || label !== label.trim()
      )
    )
  ) {
    throw new TypeError(
      'Intersection labels must be non-empty trimmed strings'
    );
  }
  return labels;
}

export function formatIntersectionLabel(mask, labels) {
  if (!Number.isSafeInteger(mask) || mask < 1) {
    throw new TypeError(
      'Intersection mask must be a positive safe integer'
    );
  }
  requirePageLabels(labels);
  if (mask >= 2 ** labels.length) {
    throw new RangeError(
      'Intersection mask references a page outside the label inventory'
    );
  }
  const parts = [];
  for (let i = 0; i < labels.length; i++) {
    if (mask & (1 << i)) parts.push(labels[i]);
  }
  if (parts.length < 2) {
    throw new RangeError(
      'Intersection mask must identify at least two pages'
    );
  }
  return parts.join(' & ');
}

/**
 * Render editable labels for intersection rows and keep `labelsByMask` in sync.
 *
 * @param {object} options
 * @param {HTMLElement} options.listEl
 * @param {Array<{mask: number, count: number}>} options.rows
 * @param {string[]} options.pageLabels
 * @param {Record<string, string>} options.labelsByMask
 * @param {() => void} options.onLabelsChanged
 * @param {AbortSignal} options.signal
 */
export function renderIntersectionLabelInputs(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).sort().join(',') !==
      'labelsByMask,listEl,onLabelsChanged,pageLabels,rows,signal'
  ) {
    throw new TypeError(
      'Intersection input options must use the exact current schema'
    );
  }
  const {
    listEl,
    rows,
    pageLabels,
    labelsByMask,
    onLabelsChanged,
    signal
  } = options;
  if (listEl === null || typeof listEl !== 'object') {
    throw new TypeError(
      'Intersection input list must be a document-owned HTMLElement'
    );
  }
  const ownerDocument = listEl.ownerDocument;
  if (ownerDocument === null || ownerDocument === undefined) {
    throw new TypeError(
      'Intersection input list must be a document-owned HTMLElement'
    );
  }
  const view = ownerDocument.defaultView;
  if (
    view === null
    || view === undefined
    || !(listEl instanceof view.HTMLElement)
  ) {
    throw new TypeError(
      'Intersection input list must be a document-owned HTMLElement'
    );
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('Intersection input rows must be an array');
  }
  requirePageLabels(pageLabels);
  if (
    labelsByMask === null
    || typeof labelsByMask !== 'object'
    || Array.isArray(labelsByMask)
    || Object.getPrototypeOf(labelsByMask) !== Object.prototype
  ) {
    throw new TypeError(
      'Intersection labelsByMask must be a plain object'
    );
  }
  if (typeof onLabelsChanged !== 'function') {
    throw new TypeError(
      'Intersection onLabelsChanged must be a function'
    );
  }
  if (!(signal instanceof view.AbortSignal)) {
    throw new TypeError(
      'Intersection input signal must be an AbortSignal from the shared document'
    );
  }
  if (signal.aborted) {
    throw new Error('Intersection input signal is already aborted');
  }

  const active = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (
      row === null
      || typeof row !== 'object'
      || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'count,mask'
      || !Number.isSafeInteger(row.mask)
      || row.mask < 1
      || !Number.isSafeInteger(row.count)
      || row.count < 1
    ) {
      throw new TypeError(
        `Intersection input row ${index} is malformed`
      );
    }
    formatIntersectionLabel(row.mask, pageLabels);
    const maskKey = String(row.mask);
    if (active.has(maskKey)) {
      throw new Error(
        `Intersection input mask ${maskKey} is duplicated`
      );
    }
    active.add(maskKey);
  }
  for (const key of Object.keys(labelsByMask)) {
    if (!active.has(key)) delete labelsByMask[key];
  }

  const fragment = ownerDocument.createDocumentFragment();

  rows.forEach((row) => {
    const maskKey = String(row.mask);
    if (!Object.hasOwn(labelsByMask, maskKey)) {
      labelsByMask[maskKey] = formatIntersectionLabel(
        row.mask,
        pageLabels
      );
    } else if (typeof labelsByMask[maskKey] !== 'string') {
      throw new TypeError(
        `Intersection label ${maskKey} must be a string`
      );
    }

    const rowEl = ownerDocument.createElement('div');
    rowEl.className = 'cat-builder-intersection-row';

    const meta = ownerDocument.createElement('div');
    meta.className = 'cat-builder-intersection-meta';
    meta.textContent = `${row.count.toLocaleString()} cells`;

    const input = ownerDocument.createElement('input');
    input.type = 'text';
    input.className = 'cat-builder-intersection-input';
    input.value = labelsByMask[maskKey];
    input.dataset.mask = maskKey;
    input.addEventListener('input', () => {
      labelsByMask[maskKey] = input.value;
      onLabelsChanged();
    }, { signal });

    rowEl.appendChild(meta);
    rowEl.appendChild(input);
    fragment.appendChild(rowEl);
  });
  listEl.replaceChildren(fragment);
}
