// One rule for work in progress (notification-center.js, NOTICE_AFTER_MS): a
// loading or progress card appears only once its work has run that long;
// work that ends sooner ends without a card, and without a success card
// unless its publisher announces an outcome the person asked for. A failure
// is always shown. Every publisher of progress waits the same.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { NOTICE_AFTER_MS, NotificationCenter } from '../assets/js/app/notification-center.js';

class FakeElement {
  constructor() {
    this.hidden = false;
    this.id = '';
    this.classList = { add() {}, remove() {} };
    this.dataset = {};
    this.className = '';
    this.parentNode = null;
  }
  // Every part a card has (its content, message, title), one stand-in each.
  querySelector(selector) {
    this.parts ??= new Map();
    if (selector === '.notification-dismiss' || selector.includes('progress') || selector.includes('speed')) return null;
    if (!this.parts.has(selector)) this.parts.set(selector, new FakeElement());
    return this.parts.get(selector);
  }
  prepend() {}
  append() {}
  after() {}
  removeAttribute() {}
  remove() { this.removed = true; }
  appendChild(child) { child.parentNode = this; return child; }
  setAttribute() {}
  addEventListener() {}
}

/** A center whose timers run on a clock the test moves. */
function createCenter(t) {
  const timers = [];
  let now = 0;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const hadRaf = Object.hasOwn(globalThis, 'requestAnimationFrame');
  const hadDocument = Object.hasOwn(globalThis, 'document');
  globalThis.document = { createElement: () => new FakeElement() };
  globalThis.setTimeout = (callback, delay) => {
    const timer = { at: now + delay, callback, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    if (timer) timer.cleared = true;
  };
  globalThis.requestAnimationFrame = callback => callback();
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (!hadRaf) delete globalThis.requestAnimationFrame;
    if (!hadDocument) delete globalThis.document;
  });
  const center = new NotificationCenter();
  center.initialized = true;
  center.container = new FakeElement();
  center._createNotificationElement = id => Object.assign(new FakeElement(), { id });
  const advance = ms => {
    now += ms;
    for (const timer of timers.filter(entry => !entry.cleared && entry.at <= now)) {
      timer.cleared = true;
      timer.callback();
    }
  };
  return { center, advance };
}

test('work that ends before it has run NOTICE_AFTER_MS ends without a card', t => {
  const { center, advance } = createCenter(t);
  assert.equal(NOTICE_AFTER_MS, 1000);
  const id = center.loading('Reading field cell_type', { category: 'data' });
  assert.equal(center.isShown(id), false);
  advance(NOTICE_AFTER_MS - 1);
  assert.equal(center.isShown(id), false);
  center.complete(id, 'Loaded field cell_type');
  assert.equal(center.hasNotification(id), false, 'no success card follows a card never shown');

  const calculation = center.startCalculation('Building an index', 'spatial');
  advance(400);
  center.completeCalculation(calculation, 'Index ready', 400);
  assert.equal(center.hasNotification(calculation), false);
});

test('work that runs longer is shown, and its success card follows', t => {
  const { center, advance } = createCenter(t);
  const id = center.progress('Reading genes', 10, { category: 'data' });
  advance(NOTICE_AFTER_MS);
  assert.equal(center.isShown(id), true);
  center.complete(id, 'Genes read');
  assert.equal(center.hasNotification(id), true);
  assert.equal(center.notifications.get(id).options.type, 'success');
});

test('a failure is always shown, and an announced outcome too', t => {
  const { center } = createCenter(t);
  const failed = center.loading('Reading genes', { category: 'data' });
  center.fail(failed, 'Cellucid could not read genes: HTTP 503');
  assert.equal(center.isShown(failed), true);
  assert.equal(center.notifications.get(failed).options.type, 'error');

  const saved = center.progress('Exporting cells…', 0, { category: 'download' });
  center.complete(saved, 'Exported cells: cells.csv', { announce: true });
  assert.equal(center.isShown(saved), true);
  assert.equal(center.notifications.get(saved).options.type, 'success');
  assert.equal('announce' in center.notifications.get(saved).options, false);
  assert.throws(() => center.info('x', { announce: true }), /announce/);
});

test('a card never shown leaves at once when dismissed', t => {
  const { center, advance } = createCenter(t);
  const id = center.loading('Reading', { category: 'data' });
  const element = center.notifications.get(id).element;
  center.dismiss(id);
  assert.equal(element.removed, true);
  advance(NOTICE_AFTER_MS);
  assert.equal(center.hasNotification(id), false);
});

test('a publisher that has already waited shows its card at once', t => {
  const { center } = createCenter(t);
  const id = center.progress('Differential expression…', 0, { category: 'analysis' });
  center.reveal(id);
  assert.equal(center.isShown(id), true);
});

test('every publisher of progress waits the same, and none keeps a threshold of its own', () => {
  for (const file of [
    'assets/js/app/read-progress-notifications.js',
    'assets/js/app/jobs/cancellable-job.js',
    'assets/js/app/notification-center.js',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /SHOW_AFTER_MS|NOTIFY_AFTER_MS|QUICK_CALCULATION_MS|= 700;|= 250;/, file);
  }
});
