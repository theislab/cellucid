// @ts-check

/**
 * @typedef {keyof typeof StyleManager.zIndex} ZIndexLayerName
 * @typedef {import('../../../types/design-tokens').DesignToken} DesignToken
 */

function isHTMLElement(value) {
  return value instanceof HTMLElement;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {string} property
 * @returns {string}
 */
function normalizeVarName(property) {
  return property.startsWith('--') ? property : `--${property}`;
}

export const StyleManager = {
  // Z-index management (mirrors tokens/_z-index.css semantics).
  zIndex: {
    below: -1,
    base: 0,
    raised: 1,
    dropdown: 100,
    sticky: 200,
    overlay: 300,
    sidebar: 400,
    floating: 500,
    modal: 600,
    popover: 700,
    tooltip: 800,
    notification: 900,
    max: 9999,
  },

  /**
   * Set a CSS custom property on an element.
   * @param {HTMLElement} element
   * @param {DesignToken | string} property - CSS variable name (with or without --)
   * @param {string | number} value
   */
  setVariable(element, property, value) {
    if (!isHTMLElement(element)) return;
    const name = normalizeVarName(property);
    element.style.setProperty(name, String(value));
  },

  /**
   * Read a computed CSS custom property value from an element.
   * @param {HTMLElement} element
   * @param {DesignToken | string} property - CSS variable name (with or without --)
   * @returns {string}
   */
  getVariable(element, property) {
    if (!isHTMLElement(element)) return '';
    const name = normalizeVarName(property);
    return getComputedStyle(element).getPropertyValue(name).trim();
  },

  /**
   * Resolve a computed CSS custom property to its final value by following
   * `var(--token)` references (useful when themes point semantic tokens at primitives).
   *
   * Note: custom properties can hold arbitrary strings; this resolves only when the
   * whole value is a single `var(...)` expression.
   *
   * @param {HTMLElement} element
   * @param {DesignToken | string} property - CSS variable name (with or without --)
   * @param {{ maxDepth?: number }} [options]
   * @returns {string}
   */
  resolveVariable(element, property, options = {}) {
    if (!isHTMLElement(element)) return '';
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 10;
    let value = this.getVariable(element, property);

    /** @type {Set<string>} */
    const seen = new Set();

    for (let depth = 0; depth < maxDepth; depth++) {
      const match = value.match(/^var\\(\\s*(--[^,\\s)]+)\\s*(?:,\\s*(.+))?\\s*\\)$/);
      if (!match) break;
      const nextVar = match[1];
      const fallback = match[2]?.trim() ?? '';
      if (seen.has(nextVar)) break;
      seen.add(nextVar);
      const nextValue = this.getVariable(element, nextVar);
      if (nextValue) {
        value = nextValue;
        continue;
      }
      value = fallback;
      break;
    }

    return value.trim();
  },

  /**
   * Remove a CSS custom property from an element.
   * @param {HTMLElement} element
   * @param {DesignToken | string} property - CSS variable name (with or without --)
   */
  removeVariable(element, property) {
    if (!isHTMLElement(element)) return;
    const name = normalizeVarName(property);
    element.style.removeProperty(name);
  },

  /**
   * Set position/size using CSS custom properties (px values).
   * @param {HTMLElement} element
   * @param {{ x?: number; y?: number; width?: number; height?: number }} rect
   */
  setPosition(element, rect) {
    if (!isHTMLElement(element)) return;
    const x = toFiniteNumber(rect.x);
    const y = toFiniteNumber(rect.y);
    const width = toFiniteNumber(rect.width);
    const height = toFiniteNumber(rect.height);

    if (x !== null) element.style.setProperty('--pos-x', `${x}px`);
    if (y !== null) element.style.setProperty('--pos-y', `${y}px`);
    if (width !== null) element.style.setProperty('--pos-width', `${width}px`);
    if (height !== null) element.style.setProperty('--pos-height', `${height}px`);
  },

  /**
   * Clear position custom properties.
   * @param {HTMLElement} element
   */
  clearPosition(element) {
    if (!isHTMLElement(element)) return;
    element.style.removeProperty('--pos-x');
    element.style.removeProperty('--pos-y');
    element.style.removeProperty('--pos-width');
    element.style.removeProperty('--pos-height');
  },

  /**
   * Set z-index layer by name or number.
   * @param {HTMLElement} element
   * @param {ZIndexLayerName | number} layer
   */
  setLayer(element, layer) {
    if (!isHTMLElement(element)) return;
    const zIndex = typeof layer === 'number'
      ? layer
      : (this.zIndex[layer] ?? this.zIndex.base);
    element.style.setProperty('--z-layer', String(zIndex));
  },

  /**
   * Toggle a data attribute state (truthy values become strings).
   * @param {HTMLElement} element
   * @param {string} key
   * @param {string | boolean | null | undefined} [value]
   */
  setState(element, key, value = true) {
    if (!isHTMLElement(element)) return;
    if (value === false || value === null || value === undefined) {
      // @ts-ignore - dataset is a string map at runtime.
      delete element.dataset[key];
      return;
    }
    element.dataset[key] = value === true ? 'true' : String(value);
  },

  /**
   * Remove a data attribute state.
   * @param {HTMLElement} element
   * @param {string} key
   */
  removeState(element, key) {
    if (!isHTMLElement(element)) return;
    // @ts-ignore - dataset is a string map at runtime.
    delete element.dataset[key];
  },

  /**
   * Check if a data attribute state exists.
   * @param {HTMLElement} element
   * @param {string} key
   * @returns {boolean}
   */
  hasState(element, key) {
    if (!isHTMLElement(element)) return false;
    // @ts-ignore - dataset is a string map at runtime.
    return key in element.dataset;
  },
};
