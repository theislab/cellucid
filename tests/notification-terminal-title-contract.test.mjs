/**
 * A notification's title is only as true as the moment it describes.
 *
 * Work in progress is published with a title that names the work while it
 * runs — "Downloading", "Processing", "Generating data". Completing or failing
 * that notification replaced its message and its type but kept the title, so a
 * finished download stayed on screen as "DOWNLOADING — 2D cell positions (960 B
 * in 15ms)" and a failed figure export read "PROCESSING — <error>". The same
 * tracker also follows files read from disk, where "Downloading" was never
 * true: a broken session file failed as "DOWNLOADING — Loading session: …".
 *
 * The rule now lives in the one place every terminal transition passes through:
 * settling active work retires its in-progress title unless the settling call
 * names a title of its own, and the byte tracker — whose message has no verb
 * without one — says "Loading", then "Loaded" or "Loading failed", which hold
 * for a network fetch and a local file alike.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NotificationCenter,
  NotificationType,
} from '../assets/js/app/notification-center.js';

class FakeNode {
  constructor(className = '') {
    this.className = className;
    this.textContent = '';
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.classList = { add() {}, remove() {} };
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
    return child;
  }

  insertBefore(child, reference) {
    if (reference === null) return this.appendChild(child);
    child.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    return child;
  }

  /** A card's Details go after its message (`notificationDetailsHtml`; this fake parses no HTML). */
  after(node) {
    if (node === undefined || node === null || this.parent === null) return;
    node.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node);
  }

  remove() {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter(node => node !== this);
    this.parent = null;
  }

  setAttribute() {}

  removeAttribute() {}

  addEventListener() {}

  querySelector(selector) {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(/\s+/).includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested !== null) return nested;
    }
    return null;
  }
}

/** The shape `_createNotificationElement` publishes, without a real DOM. */
function fakeNotificationElement(options) {
  const element = new FakeNode('notification');
  element.appendChild(new FakeNode('notification-icon'));
  const content = element.appendChild(new FakeNode('notification-content'));
  if (options.title) {
    content.appendChild(new FakeNode('notification-title')).textContent =
      options.title;
  }
  content.appendChild(new FakeNode('notification-message')).textContent =
    options.message;
  if (
    options.type === NotificationType.LOADING ||
    options.type === NotificationType.PROGRESS
  ) {
    const bar = content.appendChild(
      new FakeNode('notification-progress-container')
    );
    bar.appendChild(new FakeNode('notification-progress-bar')).style = {};
  }
  return element;
}

function createCenter(t) {
  const hadRaf = Object.hasOwn(globalThis, 'requestAnimationFrame');
  const originalRaf = globalThis.requestAnimationFrame;
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const originalDocument = globalThis.document;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = { createElement: () => new FakeNode() };
  t.after(() => {
    if (hadRaf) globalThis.requestAnimationFrame = originalRaf;
    else delete globalThis.requestAnimationFrame;
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  });

  const center = new NotificationCenter();
  center.initialized = true;
  center.container = new FakeNode('notification-center');
  center._createNotificationElement = (id, options) =>
    fakeNotificationElement(options);
  center._scheduleDismiss = () => {};
  // Work in progress is shown at once here, as it is once it has run
  // NOTICE_AFTER_MS: these contracts are about what a shown card says.
  const show = center.show.bind(center);
  center.show = options => {
    const id = show(options);
    const notification = center.notifications.get(id);
    if (notification.element.hidden) center._reveal(notification);
    return id;
  };
  t.after(() => center.dismissAll());
  return center;
}

function shownTitle(center, id) {
  const notification = center.notifications.get(id);
  return {
    dom: notification.element.querySelector('.notification-title')
      ?.textContent ?? null,
    stored: notification.options.title ?? null,
  };
}

test('a finished load is announced as loaded, not still loading', t => {
  const center = createCenter(t);
  const tracker = center.startDownload('2D cell positions');
  assert.deepEqual(shownTitle(center, `download-${tracker}`), {
    dom: 'Loading',
    stored: 'Loading',
  });

  center.updateDownload(tracker, 960);
  center.completeDownload(tracker);
  assert.deepEqual(shownTitle(center, `download-${tracker}`), {
    dom: 'Loaded',
    stored: 'Loaded',
  });
});

test('a failed load says the loading failed', t => {
  const center = createCenter(t);
  const tracker = center.startDownload('3D cell positions');
  center.failDownload(tracker, 'the server answered 404');
  assert.deepEqual(shownTitle(center, `download-${tracker}`), {
    dom: 'Loading failed',
    stored: 'Loading failed',
  });
});

test('a failed load keeps the failure\'s own words under Details, out of its sentence', t => {
  const center = createCenter(t);
  const tracker = center.startDownload('Saved state');
  center.failDownload(tracker, 'it does not hold together as a history, so it was not opened; the history shown is unchanged.', {
    details: 'tracker t-1: a group cuts the run of turn "u1" between steps "s5" and "s6"',
  });
  const { options } = center.notifications.get(`download-${tracker}`);
  assert.equal(options.message, 'Saved state: it does not hold together as a history, so it was not opened; the history shown is unchanged.');
  assert.match(options.details, /tracker t-1/);
  assert.throws(() => center.failDownload(center.startDownload('x'), 'failed', { details: 3 }), /details must be a string/);
});

test('a broken invariant\'s sentence says its words are under Details, where the card has them (F141)', async t => {
  const { failureDetails, sayFailure, failureSentence, INTERNAL_FAILURE, INTERNAL_FAILURE_WITH_DETAILS } = await import('../assets/js/utils/errors.js');
  const bug = new TypeError('values.get is not a function');
  const center = createCenter(t);
  const tracker = center.startDownload('Saved state');
  center.failDownload(tracker, sayFailure(bug), failureDetails(bug));
  assert.equal(center.notifications.get(`download-${tracker}`).options.message, `Saved state: ${INTERNAL_FAILURE_WITH_DETAILS}`);
  const id = center.error(`Export failed: ${sayFailure(bug)}`, { ...failureDetails(bug) });
  assert.equal(center.notifications.get(id).options.message, `Export failed: ${INTERNAL_FAILURE_WITH_DETAILS}`);
  const whole = center.error(failureSentence(bug), { ...failureDetails(bug) });
  assert.equal(center.notifications.get(whole).options.message, `A${INTERNAL_FAILURE_WITH_DETAILS.slice(1)}`);
  // Without Details (a status line, a chat note, a card given none) the sentence is said alone.
  const bare = center.error(`Export failed: ${sayFailure(bug)}`);
  assert.equal(center.notifications.get(bare).options.message, `Export failed: ${INTERNAL_FAILURE}`);
});

test('settled work retires an in-progress title it did not replace', t => {
  const center = createCenter(t);

  const exported = center.startCalculation('Preparing PNG…', 'render');
  center.completeCalculation(exported, 'Export complete', 1200);
  assert.deepEqual(shownTitle(center, exported), { dom: null, stored: null });

  const failed = center.startCalculation('Preparing SVG…', 'render');
  center.failCalculation(failed, 'The renderer lost its context.');
  assert.deepEqual(shownTitle(center, failed), { dom: null, stored: null });

  const generated = center.startDataGeneration('Model Surface', 1_000_000);
  center.completeDataGeneration(generated, 900);
  assert.deepEqual(shownTitle(center, generated), { dom: null, stored: null });

  const report = center.startReport();
  center.completeReport(report, true);
  assert.deepEqual(shownTitle(center, report), { dom: null, stored: null });
});

test('a settling call that names a title keeps it', t => {
  const center = createCenter(t);
  const id = center.loading('Restoring session…', { title: 'Session' });
  center.complete(id, 'Session restored', { title: 'Session restored' });
  assert.deepEqual(shownTitle(center, id), {
    dom: 'Session restored',
    stored: 'Session restored',
  });
});

test('an update while work is still running keeps its title', t => {
  const center = createCenter(t);
  const tracker = center.startDownload('Gene expression');
  center.updateDownload(tracker, 10, 100);
  assert.deepEqual(shownTitle(center, `download-${tracker}`), {
    dom: 'Loading',
    stored: 'Loading',
  });
});
