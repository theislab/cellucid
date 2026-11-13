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
 * Text as HTML writes it, in an element or a quoted attribute: `& < > " '`
 * as entities. The one HTML escape of the app (the history report, the
 * share dialog's embed code, the analysis views); `escapeXml` builds on it.
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

/**
 * Hold `element`'s place in its parent while it is shown elsewhere (above the
 * page, inside a dialog): an empty comment stands in it. A remembered next
 * sibling is not a place: the last child would go back after everything its
 * parent gained meanwhile, and one before a sibling that left, or that is
 * itself away, would have nowhere to go.
 *
 * @param {Element} element
 * @returns {() => boolean} Put the element back in its place, exactly; false,
 *   the element untouched, when there is none (it had no parent, or the
 *   placeholder left with what the parent dropped).
 */
export function holdPlace(element) {
  const parent = element.parentNode;
  if (parent === null) return () => false;
  const placeholder = element.ownerDocument.createComment('');
  parent.insertBefore(placeholder, element);
  return () => {
    if (placeholder.parentNode === null) return false;
    placeholder.replaceWith(element);
    return true;
  };
}
