/**
 * @fileoverview An analytics control id must be declared, never read off the
 * control's content.
 *
 * Analytics is live on the production hosts, so whatever this picks as a
 * control identifier is sent to Google Analytics for every click. The click
 * tracker used to fall back through `name`, `aria-label` and finally the
 * button's own text - and in this app every one of those surfaces is built
 * from the loaded data or from something the user typed.
 *
 * Two confirmed instances, both matching the tracker's own selector:
 *
 *   - `categorical-legend.js` labels its per-category highlight button
 *     `Highlight category <name>`, so the category names of whatever the user
 *     opened were sent. In single-cell data those are routinely donor ids,
 *     sample codes or treatment arms.
 *   - `highlight-pages-ui.js` labels its delete button `Delete <page name>`,
 *     where the page name is free text the user typed.
 *
 * The fix is not to rename those labels - they are correct accessible names,
 * and the next data-derived label would reintroduce the leak. It is that an
 * identifier for analytics has to be declared by the developer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const SENSITIVE_CATEGORY = 'donor BRCA1 patient 7';
let sharedClickHandler = null;

function installBrowserGlobals() {
  const listeners = [];
  const events = [];
  const document = {
    getElementById: () => null,
    addEventListener: (type, handler) => listeners.push({ type, handler })
  };
  const window = {
    cellucidAnalyticsEnabled: true,
    gtag: (kind, name, params) => events.push({ kind, name, params })
  };
  globalThis.document = document;
  globalThis.window = window;
  return { listeners, events };
}

function buttonWithAccessibleName(accessibleName, text) {
  return {
    tagName: 'BUTTON',
    id: '',
    name: '',
    dataset: {},
    textContent: text,
    getAttribute: attribute => (
      attribute === 'aria-label' ? accessibleName : null
    ),
    closest: () => null
  };
}

test('a control identifier is never taken from the control content', async () => {
  const { listeners, events } = installBrowserGlobals();
  const tracker = await import('../assets/js/analytics/tracker.js');

  tracker.initAnalytics({ dataSourceManager: null });
  const click = listeners.find(entry => entry.type === 'click');
  assert.ok(click, 'the tracker must attach a click listener');
  sharedClickHandler = click.handler;

  const target = buttonWithAccessibleName(
    `Highlight category ${SENSITIVE_CATEGORY}`,
    '◉'
  );
  click.handler({ target: { closest: () => target }, button: 0 });

  assert.equal(events.length, 1, 'exactly one event must be sent');
  const sent = JSON.stringify(events[0].params);
  for (const fragment of ['donor', 'BRCA1', 'patient']) {
    assert.equal(
      sent.includes(fragment),
      false,
      `the analytics payload must not carry "${fragment}" from the control's `
        + `accessible name; payload was ${sent}`
    );
  }
  assert.equal(
    events[0].params.control_id,
    'button:button',
    'an undeclared control must fall back to its element type, not its content'
  );
});

test('a declared control identifier is still used', async () => {
  // The tracker attaches its click listener once per module instance, so this
  // reuses the listener the first test installed rather than expecting a
  // second one. Sharing the handler is the point: it is the same live path.
  const { listeners, events } = installBrowserGlobals();
  await import('../assets/js/analytics/tracker.js');
  const handler = sharedClickHandler;
  assert.ok(handler, 'the first test must have captured the click listener');
  assert.equal(listeners.length, 0, 'the listener is attached only once');

  const declared = buttonWithAccessibleName('Save the current session', 'Save');
  declared.dataset.analyticsId = 'session:save';
  handler({ target: { closest: () => declared }, button: 0 });

  const last = events[events.length - 1];
  assert.equal(
    last.params.control_id,
    'session:save',
    'a declared identifier must still be reported'
  );
});
