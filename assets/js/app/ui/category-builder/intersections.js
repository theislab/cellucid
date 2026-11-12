/**
 * @fileoverview Intersection helpers for CategoryBuilder overlap strategy.
 *
 * @module ui/category-builder/intersections
 */

import { formatCells } from '../../../utils/format-units.js';
import { parseIntersectionKey } from '../../utils/page-membership.js';

function requirePageLabels(labels) {
  if (
    !Array.isArray(labels)
    || labels.length === 0
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

/**
 * Produce a default label for a combination of pages, e.g. "A & B".
 * @param {string} key - The combination's key (`intersectionKey`)
 * @param {string[]} labels - The pages' labels, by position
 * @returns {string}
 */
export function formatIntersectionLabel(key, labels) {
  requirePageLabels(labels);
  return parseIntersectionKey(key, labels.length)
    .map(position => labels[position])
    .join(' & ');
}

/**
 * Render editable labels for intersection rows and keep `labelsByKey` in sync.
 *
 * @param {object} options
 * @param {HTMLElement} options.listEl
 * @param {Array<{key: string, count: number}>} options.rows
 * @param {string[]} options.pageLabels
 * @param {Record<string, string>} options.labelsByKey
 * @param {() => void} options.onLabelsChanged
 * @param {AbortSignal} options.signal
 */
export function renderIntersectionLabelInputs(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).sort().join(',') !==
      'labelsByKey,listEl,onLabelsChanged,pageLabels,rows,signal'
  ) {
    throw new TypeError(
      'Intersection input options must use the exact current schema'
    );
  }
  const {
    listEl,
    rows,
    pageLabels,
    labelsByKey,
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
    labelsByKey === null
    || typeof labelsByKey !== 'object'
    || Array.isArray(labelsByKey)
    || Object.getPrototypeOf(labelsByKey) !== Object.prototype
  ) {
    throw new TypeError(
      'Intersection labelsByKey must be a plain object'
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
      || Object.keys(row).sort().join(',') !== 'count,key'
      || typeof row.key !== 'string'
      || !Number.isSafeInteger(row.count)
      || row.count < 1
    ) {
      throw new TypeError(
        `Intersection input row ${index} is malformed`
      );
    }
    formatIntersectionLabel(row.key, pageLabels);
    if (active.has(row.key)) {
      throw new Error(
        `Intersection input ${row.key} is duplicated`
      );
    }
    active.add(row.key);
  }
  for (const key of Object.keys(labelsByKey)) {
    if (!active.has(key)) delete labelsByKey[key];
  }

  const fragment = ownerDocument.createDocumentFragment();

  rows.forEach((row) => {
    const key = row.key;
    if (!Object.hasOwn(labelsByKey, key)) {
      labelsByKey[key] = formatIntersectionLabel(key, pageLabels);
    } else if (typeof labelsByKey[key] !== 'string') {
      throw new TypeError(
        `Intersection label ${key} must be a string`
      );
    }

    const rowEl = ownerDocument.createElement('div');
    rowEl.className = 'cat-builder-intersection-row';

    const meta = ownerDocument.createElement('div');
    meta.className = 'cat-builder-intersection-meta';
    meta.textContent = formatCells(row.count);

    const input = ownerDocument.createElement('input');
    input.type = 'text';
    input.className = 'obs-select cat-builder-intersection-input';
    input.value = labelsByKey[key];
    input.dataset.pages = key;
    input.addEventListener('input', () => {
      labelsByKey[key] = input.value;
      onLabelsChanged();
    }, { signal });

    rowEl.appendChild(meta);
    rowEl.appendChild(input);
    fragment.appendChild(rowEl);
  });
  listEl.replaceChildren(fragment);
}
