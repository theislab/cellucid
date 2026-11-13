/**
 * @fileoverview What a slider's value reads as, for any value it can hold:
 * one formatter per slider, defined by the module that owns it and used by
 * that module to write the readout beside the slider, and by the history to
 * name a value of the past (`state/domains/settings.js` `describe`: "Grid
 * density: 48³", not the slider position 37). A slider's position is not
 * always what it means (the point size is a logarithmic curve, a smoke grid
 * a band of sizes), and the readout element shows only the value it holds
 * now.
 *
 * @module app/ui/core/control-readout
 */

/** @type {WeakMap<Element, (value: string) => string>} */
const FORMATS = new WeakMap();

/**
 * Define how `element`'s value reads, and return the formatter: the owner
 * writes its readout with it, so the readout and the history say one thing.
 *
 * @param {Element} element - the slider (or number box)
 * @param {(value: string) => string} format - the readout of a value, given as the control holds it (text)
 * @returns {(value: string) => string}
 */
export function defineControlReadout(element, format) {
  if (element === null || typeof element !== 'object') throw new TypeError('A readout is defined for a control element.');
  if (typeof format !== 'function') throw new TypeError('A control readout is a function of the value.');
  FORMATS.set(element, format);
  return format;
}

/**
 * What `value` of `element` reads as: its owner's readout, else null (the
 * control shows its value as it is).
 *
 * @param {Element} element
 * @param {string|number} value
 * @returns {string|null}
 */
export function controlReadout(element, value) {
  const format = FORMATS.get(element);
  if (format === undefined) return null;
  try {
    return format(String(value));
  } catch {
    // A value the control cannot hold now (a range of another dataset): no readout.
    return null;
  }
}
