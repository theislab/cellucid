/**
 * R9V-9 (bug hunt round 9): the overlay's numeric-input contract named
 * `#velocity-trail-fade` "Trail fade" while the control, the history and the
 * docs say "Trail persistence", so a rejected value named a control the
 * person cannot find; and Particle size read "12" at 11.5 and at 12. Each
 * contract entry carries its control's label and range from `index.html`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  initVelocityOverlayControls,
  VELOCITY_NUMERIC_INPUTS,
} from '../assets/js/app/ui/modules/velocity-overlay-controls.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const domCache = readFileSync(new URL('../assets/js/app/ui/core/dom-cache.js', import.meta.url), 'utf8');
const idOf = Object.fromEntries([...domCache.matchAll(/(velocity\w+Input): byId\('([\w-]+)'\)/g)].map(m => [m[1], m[2]]));

test('every overlay slider contract names its control as the page does, with the page’s range', () => {
  for (const [name, contract] of Object.entries(VELOCITY_NUMERIC_INPUTS)) {
    const id = idOf[contract.domKey];
    assert.ok(id, `${name}: ${contract.domKey} is collected by dom-cache.js`);
    const label = new RegExp(`<label for="${id}">([^<]+)</label>`).exec(html);
    assert.ok(label, `${id} has a label`);
    assert.equal(contract.label, label[1].trim(), `${id}: the contract names it as the page does`);
    const input = new RegExp(`<input id="${id}" type="range" min="([^"]+)" max="([^"]+)" step="([^"]+)"`).exec(html);
    assert.ok(input, `${id} is a range`);
    assert.equal(contract.minimum, Number(input[1]), `${id} minimum`);
    assert.equal(contract.maximum, Number(input[2]), `${id} maximum`);
    assert.equal(contract.integer, Number.isInteger(Number(input[3])), `${id}: whole steps or not`);
  }
});

test('Particle size reads every half step apart', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try {
    const element = value => ({
      value, checked: false, disabled: false, hidden: false, title: '', textContent: '', dataset: {},
      options: [], innerHTML: '', addEventListener() {}, removeEventListener() {}, appendChild() {},
    });
    const readout = size => {
      const dom = {};
      for (const key of [
        'velocityControls', 'velocitySettings', 'velocityInfo', 'velocityEnabledCheckbox', 'velocityFieldSelect',
        'velocityColormapSelect', 'velocitySyncLodCheckbox',
      ]) dom[key] = element('');
      for (const [name, contract] of Object.entries(VELOCITY_NUMERIC_INPUTS)) {
        dom[contract.domKey] = element(String(name === 'size' ? size : contract.minimum));
        dom[contract.domKey.replace(/Input$/, 'Display')] = element('');
      }
      const controls = initVelocityOverlayControls({
        dom,
        state: {
          getAvailableVectorFields: () => [], getDefaultVectorFieldId: () => null, getActiveViewId: () => 'live',
          getViewLayoutKey: () => 'X_umap', viewContexts: new Map(), getDimensionManager: () => ({}),
          ensureVectorField: async () => true, on() {}, off() {},
        },
        viewer: { setVectorFieldOverlayEnabled() {}, setVectorFieldConfig() {}, setActiveVectorField() {} },
      });
      controls.destroy();
      return dom.velocitySizeDisplay.textContent;
    };
    assert.deepEqual(['0.5', '1', '9.5', '11.5', '12', '30'].map(readout), ['0.5', '1.0', '9.5', '11.5', '12', '30']);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
