import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initDimensionControls
} from '../assets/js/app/ui/modules/dimension-controls.js';

function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

test('dimension teardown fences a settling state owner and removes every listener', async t => {
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLSelectElement = globalThis.HTMLSelectElement;
  t.after(() => {
    if (originalHTMLElement === undefined) {
      delete globalThis.HTMLElement;
    } else {
      globalThis.HTMLElement = originalHTMLElement;
    }
    if (originalHTMLSelectElement === undefined) {
      delete globalThis.HTMLSelectElement;
    } else {
      globalThis.HTMLSelectElement = originalHTMLSelectElement;
    }
  });

  class FakeHTMLElement {}
  class FakeHTMLSelectElement extends FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLSelectElement = FakeHTMLSelectElement;

  const options = [];
  const ownerDocument = {
    createElement(tagName) {
      assert.equal(tagName, 'option');
      return { textContent: '', value: '' };
    }
  };
  let domListener = null;
  let domSignal = null;
  const select = Object.assign(new FakeHTMLSelectElement(), {
    ownerDocument,
    value: '',
    _innerHTML: '',
    addEventListener(eventName, listener, optionsValue) {
      assert.equal(eventName, 'change');
      domListener = listener;
      domSignal = optionsValue.signal;
    },
    appendChild(option) {
      options.push(option);
    }
  });
  Object.defineProperty(select, 'innerHTML', {
    configurable: true,
    get() {
      return this._innerHTML;
    },
    set(value) {
      this._innerHTML = value;
      options.length = 0;
    }
  });
  const controlsElement = Object.assign(new FakeHTMLElement(), {
    ownerDocument,
    style: { display: '' }
  });

  const dimensionChange = createDeferred();
  let dimensionListener = null;
  let unsubscribeCalls = 0;
  let badgeCalls = 0;
  const state = {
    getActiveViewId: () => 'live',
    getAvailableDimensions: () => [2, 3],
    getViewDimensionLevel: () => 2,
    on(eventName, listener) {
      assert.equal(eventName, 'dimension:changed');
      dimensionListener = listener;
      return () => {
        unsubscribeCalls++;
        dimensionListener = null;
      };
    },
    setDimensionLevel() {
      return dimensionChange.promise;
    }
  };

  const controls = initDimensionControls({
    state,
    dom: { controls: controlsElement, select },
    callbacks: {
      onViewBadgesMaybeChanged() {
        badgeCalls++;
      }
    }
  });
  const operation = controls.handleDimensionChange(
    3,
    'live',
    { silent: true }
  );
  assert.equal(select.value, '3');

  const destruction = controls.destroy();
  assert.equal(controls.destroy(), destruction);
  let destructionSettled = false;
  void destruction.then(() => {
    destructionSettled = true;
  });
  await Promise.resolve();
  assert.equal(destructionSettled, false);
  assert.equal(domSignal.aborted, true);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(dimensionListener, null);

  const terminalValue = select.value;
  dimensionChange.reject(new Error('late dimension failure'));
  await assert.doesNotReject(operation);
  await assert.doesNotReject(destruction);
  assert.equal(destructionSettled, true);
  assert.equal(select.value, terminalValue);
  assert.equal(badgeCalls, 0);

  assert.equal(typeof domListener, 'function');
  domListener({ target: { value: 'invalid-after-destroy' } });
  assert.equal(badgeCalls, 0);
  assert.throws(
    () => controls.updateDimensionSelectUI(),
    /unavailable after destroy/
  );
  await assert.rejects(
    controls.handleDimensionChange(2, 'live', { silent: true }),
    /unavailable after destroy/
  );
});
