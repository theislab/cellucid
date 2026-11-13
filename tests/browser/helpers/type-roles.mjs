/**
 * The sidebar's type scale as the browser computes it ("Type scale" in
 * assets/css/README.md): every element of one role computes one size, a panel
 * title one step above the one size headings, labels, controls and buttons
 * share, hints and readouts one step below it.
 */
import { expect } from './test.mjs';

const ROLES = Object.freeze({
  title: '#sidebar .accordion-section > summary',
  heading: '#sidebar .section-title',
  label: '#sidebar label:not(.checkbox-inline), #sidebar .field-label',
  control: '#sidebar select.obs-select, #sidebar input.obs-select',
  // A quiet button (an action nested in a row) speaks at the size of the text around it.
  button: '#sidebar .btn:not(.btn-compact):not(.btn-quiet)',
  compactButton: '#sidebar .btn-compact',
  hint: '#sidebar .field-help, #sidebar .status-line',
  readout: '#sidebar .slider-value',
});

/** Distinct computed font sizes (px) of every visible element of each role. */
export function roleSizes(page) {
  return page.evaluate(roles => {
    const out = {};
    for (const [role, selector] of Object.entries(roles)) {
      const sizes = new Set();
      for (const element of document.querySelectorAll(selector)) {
        if (element.getClientRects().length === 0) continue;
        if (!(element.textContent || element.value || '').trim()) continue;
        sizes.add(Number.parseFloat(getComputedStyle(element).fontSize));
      }
      out[role] = [...sizes].sort((a, b) => a - b);
    }
    return out;
  }, ROLES);
}

export function expectTypeOrder(sizes) {
  for (const [role, values] of Object.entries(sizes)) {
    expect(values.length, `${role} is drawn`).toBeGreaterThan(0);
    expect(values, `every ${role} computes one size`).toHaveLength(1);
  }
  const size = role => sizes[role][0];
  const base = size('heading');
  for (const role of ['label', 'control', 'button', 'compactButton']) {
    expect(size(role), `${role} is the base size`).toBe(base);
  }
  expect(size('title') - base, 'a panel title is one step above the base').toBe(1);
  expect(base - size('hint'), 'a hint is one step below the base').toBe(1);
  expect(base - size('readout'), 'a readout is one step below the base').toBe(1);
}
