/**
 * @fileoverview DOM Utilities used across the app layer.
 *
 * Centralizes small DOM helpers (HTML escaping, element creation, and safe
 * listener attachment) so UI modules and components stay DRY.
 *
 * @module utils/dom-utils
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape HTML entities by using the browser's DOM serializer.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  const str = value == null ? '' : String(value);
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Create an element with attributes/properties and children.
 * @param {string} tag
 * @param {Object} [attrs]
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') {
      el.className = value;
    } else if (key === 'style' && typeof value === 'object' && value) {
      Object.assign(el.style, value);
    } else if (key.startsWith('data-')) {
      el.setAttribute(key, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el[key] = value;
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child) {
      el.appendChild(child);
    }
  }

  return el;
}

/**
 * Remove all children from an element.
 * @param {HTMLElement} el
 */
export function clearElement(el) {
  while (el?.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * Show an element.
 * @param {HTMLElement} el
 * @param {string} [display='block']
 */
export function showElement(el, display = 'block') {
  if (el) el.style.display = display;
}

/**
 * Hide an element.
 * @param {HTMLElement} el
 */
export function hideElement(el) {
  if (el) el.style.display = 'none';
}

/**
 * Toggle element visibility.
 * @param {HTMLElement} el
 * @param {boolean} [visible]
 * @param {string} [display='block']
 */
export function toggleElement(el, visible, display = 'block') {
  if (!el) return;
  if (visible === undefined) {
    visible = el.style.display === 'none';
  }
  el.style.display = visible ? display : 'none';
}

/**
 * Add an event listener and return a cleanup function.
 * @param {EventTarget} target
 * @param {string} event
 * @param {Function} handler
 * @param {Object} [options]
 * @returns {Function}
 */
export function addListener(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  return () => target.removeEventListener(event, handler, options);
}
