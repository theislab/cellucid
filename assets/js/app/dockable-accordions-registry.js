/**
 * Dockable Accordions Registry
 *
 * Provides a tiny shared module so feature code (e.g., analysis window copies)
 * can access the single dockable-accordions instance created at app bootstrap,
 * without using globals.
 *
 * @typedef {ReturnType<import('./dockable-accordions.js').initDockableAccordions>} DockableAccordionsInstance
 */

/** @type {DockableAccordionsInstance|null} */
let dockableAccordions = null;

/**
 * @param {DockableAccordionsInstance|null} instance
 */
export function setDockableAccordions(instance) {
  dockableAccordions = instance || null;
}

/**
 * @returns {DockableAccordionsInstance|null}
 */
export function getDockableAccordions() {
  return dockableAccordions;
}

