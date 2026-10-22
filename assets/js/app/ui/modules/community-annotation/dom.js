/**
 * @fileoverview Element construction and file-download helpers for the
 * community annotation UI.
 *
 * `el()` is deliberately attribute-based (rather than the property-based
 * `createElement()` in `utils/dom-utils.js`): community annotation markup
 * relies on attribute presence semantics for `disabled`/`checked`/`readonly`
 * and on omitting attributes whose value is nullish or `false`.
 *
 * @module ui/modules/community-annotation/dom
 */

import { downloadBlob } from '../../../utils/download.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'disabled' || k === 'checked' || k === 'readonly') {
      // Boolean HTML attributes: presence = true, absence = false
      if (v) node.setAttribute(k, '');
      // Don't set attribute if false (absence means not disabled/checked/readonly)
    } else if (v != null && v !== false) node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function toCleanString(value) {
  return String(value ?? '').trim();
}

export function hasAtLeastUnicodeCodePoints(value, minimum) {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count >= minimum) return true;
  }
  return false;
}

export function downloadJsonAsFile(filename, json) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    /^\s|\s$/.test(filename) ||
    /[\\/:*?"<>|]/.test(filename)
  ) {
    throw new Error('Download filename must be an exact portable filename');
  }
  const payload = JSON.stringify(json, null, 2) + '\n';
  downloadBlob(new Blob([payload], { type: 'application/json' }), filename);
}

const STATUS_ICON_PATHS = Object.freeze({
  dataset: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3',
  github: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 9a8 8 0 0 1 16 0',
  repo: 'M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8M8 12h8M8 16h6',
  copy: 'M8 8h12v12H8zM4 4h12v12H4z',
  gear: 'M12 15.5a3.5 3.5 0 1 0-3.5-3.5 3.5 3.5 0 0 0 3.5 3.5zm7-3.5a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8.4 8.4 0 0 0-1.7-1l-.3-2.6H9.5L9.2 6.1a8.4 8.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8.4 8.4 0 0 0 1.7 1l.3 2.6h5l.3-2.6a8.4 8.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5a7.8 7.8 0 0 0 .1-1z',
  disconnect: 'M10 17l5-5-5-5M15 12H3M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3',
});

const STATUS_TONES = new Set(['ok', 'warn', 'danger']);

/**
 * One decorative status glyph (dataset, GitHub, repo, copy, gear,
 * disconnect), drawn in the current text colour.
 *
 * @param {keyof typeof STATUS_ICON_PATHS} name
 * @returns {SVGSVGElement}
 */
export function createStatusIcon(name) {
  const d = STATUS_ICON_PATHS[name];
  if (typeof d !== 'string') {
    throw new TypeError(`Unknown community annotation status icon "${name}"`);
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('community-annotation-status-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * Set a status chip's tone (`ok`, `warn` or `danger`); the stylesheet reads
 * it from `data-tone`.
 *
 * @param {HTMLElement} chip
 * @param {'ok'|'warn'|'danger'} tone
 */
export function setStatusTone(chip, tone) {
  if (!STATUS_TONES.has(tone)) {
    throw new TypeError(`Unknown community annotation status tone "${tone}"`);
  }
  chip.dataset.tone = tone;
}

/**
 * One status row of the annotation panel and the GitHub sync dialog: a toned
 * chip naming what it reports (Dataset, GitHub, Repo) and its value, then the
 * row's icon actions.
 *
 * @param {object} options
 * @param {keyof typeof STATUS_ICON_PATHS} options.icon
 * @param {'ok'|'warn'|'danger'} [options.tone='warn']
 * @param {string} options.key
 * @param {string} [options.value='']
 * @param {HTMLElement[]} [options.actions=[]]
 * @returns {{row: HTMLElement, chip: HTMLElement, keyEl: HTMLElement, valueEl: HTMLElement}}
 */
export function createStatusRow({ icon, tone = 'warn', key, value = '', actions = [] }) {
  const keyEl = el('span', { className: 'community-annotation-status-key', text: key });
  const valueEl = el('span', { className: 'community-annotation-status-val', text: value });
  const textEl = el('div', { className: 'community-annotation-status-text' }, [keyEl, valueEl]);
  const chip = el('div', { className: 'community-annotation-status-chip' }, [
    createStatusIcon(icon),
    textEl,
  ]);
  setStatusTone(chip, tone);
  const row = el('div', { className: 'community-annotation-status-row' }, [
    chip,
    el('div', { className: 'community-annotation-status-actions' }, actions),
  ]);
  return { row, chip, keyEl, valueEl };
}

