/**
 * The settings domain names a recorded value as the sidebar reads it, at any
 * step: `history.diff` says "48³" and "Volumetric smoke cloud (beta)" as the
 * sidebar and the step's own label do, not "Grid density: 37" and "Render
 * mode: smoke". A slider's position is not always what it
 * means, and its readout element shows only the value it holds now, so each
 * owner defines the readout of any value (`app/ui/core/control-readout.js`)
 * and uses it for its own readout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsDomain } from '../assets/js/app/state/domains/settings.js';
import { controlReadout, defineControlReadout } from '../assets/js/app/ui/core/control-readout.js';
import { smokeGridScale } from '../assets/js/app/ui/modules/smoke-control-scales.js';

function slider(id, value, { min = '0', max = '100', readout = null, label = id } = {}) {
  const shown = readout === null ? null : { textContent: readout };
  return {
    id, value, min, max,
    labels: [{ textContent: label }],
    closest: selector => (selector === '.slider-row' && shown !== null ? { querySelector: () => shown } : null),
  };
}

function select(id, value, options, label = id) {
  return { id, value, labels: [{ textContent: label }], options: options.map(([v, text]) => ({ value: v, textContent: text })) };
}

function withDocument(elements, run) {
  const previous = globalThis.document;
  globalThis.document = { getElementById: id => elements.find(element => element.id === id) ?? null };
  try { return run(); } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

/** `describe` only, which reads nothing but its two values and the page. */
const domain = withDocument([], () => createSettingsDomain({ sidebar: { querySelectorAll: () => [] }, viewer: null, figureExport: null }));
const record = (type, value) => (type === 'checkbox' ? { type, checked: value } : { type, value });

test('a recorded value reads as the sidebar shows it: an option, an owner\'s readout of that value, on or off', () => {
  const grid = slider('smoke-grid', '80', { readout: '128³', label: 'Grid density' });
  defineControlReadout(grid, position => smokeGridScale(Number(position)).readout);
  const mode = select('render-mode', 'points', [['points', 'Points'], ['smoke', 'Volumetric smoke cloud (beta)']], 'Render mode');
  const fog = slider('fog-density', '50', { readout: '50', label: 'Atmospheric fog' });
  const limit = slider('edge-limit', '33335', { min: '1000', max: '1000000', readout: '33.5K', label: 'Max edges' });
  const edges = { id: 'edges', labels: [{ textContent: 'Show connectivity edges' }] };
  const lines = withDocument([grid, mode, fog, limit, edges], () => domain.describe(
    { controls: { 'smoke-grid': record('range', '80'), 'render-mode': record('select', 'points'), 'fog-density': record('range', '50'), 'edge-limit': record('range', '33335'), edges: record('checkbox', false) }, figureExport: null },
    { controls: { 'smoke-grid': record('range', '37'), 'render-mode': record('select', 'smoke'), 'fog-density': record('range', '10'), 'edge-limit': record('range', '2000'), edges: record('checkbox', true) }, figureExport: null },
  ));
  assert.deepEqual(lines, [
    // The readout of 37 (the slider holds 80 now, reading 128³).
    'Grid density: 48³',
    'Render mode: Volumetric smoke cloud (beta)',
    // No readout defined, and the readout beside it shows the value itself.
    'Atmospheric fog: 10',
    // No readout defined, and the readout beside it is not the value: the position, said as one.
    'Max edges: slider at 2000 of 1000–1000000',
    'Show connectivity edges: on',
  ]);
});

test('a readout of a value the control cannot hold is none, not a failure', () => {
  const grid = slider('smoke-grid', '80');
  defineControlReadout(grid, position => smokeGridScale(Number(position)).readout);
  assert.equal(controlReadout(grid, '37'), '48³');
  assert.equal(controlReadout(grid, '400'), null);
  assert.equal(controlReadout(slider('other', '1'), '1'), null);
  assert.throws(() => defineControlReadout(grid, 'text'), TypeError);
});
