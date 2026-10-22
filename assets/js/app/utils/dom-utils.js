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
 * Characters XML 1.0 cannot carry at all, not even as a character reference:
 * C0 controls other than tab, line feed and carriage return, the
 * noncharacters U+FFFE and U+FFFF, and unpaired UTF-16 surrogates.
 */
const XML_UNREPRESENTABLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escape text for an XML document such as an exported SVG.
 *
 * Markup characters are escaped as in `escapeHtml()`. Characters XML cannot
 * represent are replaced with U+FFFD, so a label taken from the data (a
 * category name containing a control character, for example) can never make
 * the whole document unparseable.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeXml(value) {
  return escapeHtml(value).replace(XML_UNREPRESENTABLE, '\uFFFD');
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
