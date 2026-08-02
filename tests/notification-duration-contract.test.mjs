/**
 * How long a notification stays on screen belongs to its type, not to the
 * method that published it.
 *
 * `error()` and `fail()` publish the identical `NotificationType.ERROR`. They
 * differed only in that `error()` wrote a `6000` literal and `fail()` wrote
 * nothing, so `fail()` fell through to the 4000 ms default — which handed the
 * longest, most actionable messages the app produces the shortest time on
 * screen. The h5ad "No exact UMAP embedding found in obsm…" diagnostic
 * (assets/js/data/h5ad.js) reaches the user through `fail()`; the comparable
 * session-fingerprint refusals reach it through `error()`. Nothing about the
 * two messages justified 4000 against 6000; only the call site did.
 *
 * An error is now published without a timer at all. A notification cannot be
 * re-opened once dismissed, and an error names something the user has to do, so
 * a timer can only remove the message before it has been read. The cap on
 * simultaneous notifications is what keeps that bounded: an ERROR is not an
 * active type, so `_evictNonActiveUntil` retires it under pressure exactly like
 * a success (CEL-0220).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import {
  NotificationCenter,
  NotificationType,
} from '../assets/js/app/notification-center.js';
import {
  isSessionRestoreReportedError,
} from '../assets/js/app/session/session-serializer.js';

/** The parts of a published notification `_updateNotification` writes into. */
const PRESENT_PARTS = new Set([
  '.notification-content',
  '.notification-icon',
  '.notification-message',
  '.notification-title',
]);

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.textContent = '';
    this.attributes = new Map();
    this.classList = { add() {}, remove() {} };
    this._parts = new Map();
  }

  /**
   * A freshly published notification has its content, icon, message and title
   * nodes and nothing else — no progress bar, no speed line, no dismiss button
   * yet — which is exactly the shape the terminal transition has to cope with.
   */
  querySelector(selector) {
    if (!PRESENT_PARTS.has(selector)) return null;
    let part = this._parts.get(selector);
    if (part === undefined) {
      part = new FakeElement('div');
      this._parts.set(selector, part);
    }
    return part;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  prepend(child) {
    this.children.unshift(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener() {}

  remove() {}
}

/**
 * A centre whose only stubbed part is the DOM, so every duration decision runs
 * for real and is recorded as the schedule request it produces.
 */
function createRecordingCenter(t) {
  const hadRaf = Object.hasOwn(globalThis, 'requestAnimationFrame');
  const originalRaf = globalThis.requestAnimationFrame;
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const originalDocument = globalThis.document;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  t.after(() => {
    if (hadRaf) globalThis.requestAnimationFrame = originalRaf;
    else delete globalThis.requestAnimationFrame;
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  });

  const center = new NotificationCenter();
  const scheduled = [];
  center.initialized = true;
  center.container = new FakeElement();
  center._createNotificationElement = () => new FakeElement();
  center._scheduleDismiss = (id, notification, duration) => {
    scheduled.push({ id, duration });
  };
  return { center, scheduled };
}

/** The duration one publication resolved to, or null when none was requested. */
function resolvedDuration(scheduled, id) {
  const matches = scheduled.filter(entry => entry.id === id);
  return matches.length === 0 ? null : matches.at(-1).duration;
}

test('the same notification type keeps one lifetime whichever method published it', t => {
  const { center, scheduled } = createRecordingCenter(t);

  const direct = center.error('Dataset could not be opened.', {
    category: 'data',
  });
  const loading = center.loading('Loading h5ad file...', { category: 'data' });
  center.fail(
    loading,
    'No exact UMAP embedding found in obsm. Expected one or more of '
    + 'X_umap_1d, X_umap_2d, or X_umap_3d. Available obsm keys: X_pca.'
  );

  assert.equal(
    center.notifications.get(direct).options.type,
    NotificationType.ERROR
  );
  assert.equal(
    center.notifications.get(loading).options.type,
    NotificationType.ERROR,
    'fail() publishes the same type error() does'
  );
  assert.equal(
    resolvedDuration(scheduled, loading),
    resolvedDuration(scheduled, direct),
    'two ways of publishing one error must not give it two lifetimes'
  );
});

test('an error the user must act on is published without a dismiss timer', t => {
  const { center, scheduled } = createRecordingCenter(t);

  const direct = center.error('Remote server could not be reached.', {
    category: 'connectivity',
  });
  const failed = center.loading('Switching dimension...', {
    category: 'dimension',
  });
  center.fail(failed, '3D position working set exceeds the browser limit.');

  for (const id of [direct, failed]) {
    assert.equal(
      resolvedDuration(scheduled, id),
      0,
      'zero is the "stays until dismissed" duration _scheduleDismiss honours'
    );
  }
  // Every error is dismissible, or "no timer" would be "no way out".
  assert.equal(center.notifications.get(direct).options.dismissible, true);
  assert.equal(center.notifications.get(failed).options.dismissible, true);
});

test('the types that are safe to time out keep the times they had', t => {
  const { center, scheduled } = createRecordingCenter(t);

  const cases = [
    [center.info('Session saved.', { category: 'session' }), 4000],
    [center.success('Disconnected.', { category: 'connectivity' }), 4000],
    [center.warning('Loading directly from Zarr.', { category: 'data' }), 5000],
  ];
  for (const [id, expected] of cases) {
    assert.equal(resolvedDuration(scheduled, id), expected);
  }

  // A completed download is a success and times out like one.
  const active = center.loading('Loading prepared dataset...', {
    category: 'data',
  });
  assert.equal(
    resolvedDuration(scheduled, active),
    null,
    'work in progress never schedules its own removal'
  );
  center.complete(active, 'User data ready: 2K cells');
  assert.equal(resolvedDuration(scheduled, active), 4000);
});

test('an explicit duration still outranks the type default, in both directions', t => {
  const { center, scheduled } = createRecordingCenter(t);

  const pinned = center.error('Connection recovery blocked.', {
    category: 'connectivity',
    duration: 0,
    title: 'Connection recovery blocked',
  });
  assert.equal(resolvedDuration(scheduled, pinned), 0);

  const timed = center.error('Cancel failed: handler rejected.', {
    category: 'default',
    duration: 8000,
  });
  assert.equal(
    resolvedDuration(scheduled, timed),
    8000,
    'a caller that names a duration owns it'
  );

  const briefInfo = center.info('Copied.', { duration: 1500 });
  assert.equal(resolvedDuration(scheduled, briefInfo), 1500);
});

test('a repeating failure cannot fill the screen, sticky or not', t => {
  const { center } = createRecordingCenter(t);
  center.maxNotifications = 5;

  // Twenty failures in a row, published both ways, with nothing dismissing
  // them: the cap is the only thing holding the screen.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt % 2 === 0) {
      center.error(`Attempt ${attempt} failed.`, { category: 'data' });
    } else {
      const id = center.loading(`Attempt ${attempt}...`, { category: 'data' });
      center.fail(id, `Attempt ${attempt} failed.`);
    }
  }

  assert.ok(
    center.notifications.size <= center.maxNotifications,
    `an unattended failure loop published ${center.notifications.size} at once`
  );
  const types = [...center.notifications.values()]
    .map(notification => notification.options.type);
  assert.deepEqual(
    new Set(types),
    new Set([NotificationType.ERROR]),
    'the survivors are the most recent failures, not a mixed backlog'
  );
});

test('work in progress is never evicted to make room for a sticky error', t => {
  const { center } = createRecordingCenter(t);
  center.maxNotifications = 3;

  const download = center.loading('Loading points_3d.bin...', {
    category: 'download',
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    center.error(`Field ${attempt} failed to load.`, { category: 'data' });
  }

  assert.equal(
    center.hasNotification(download),
    true,
    'an error that stays until dismissed must not displace running work'
  );
});

/*
 * Removing the timer exposed a defect the timer had been hiding: a session
 * restore that fails publishes the message twice — once by failing its own
 * "Loading session" progress notification, once by the load button's catch
 * re-announcing the rethrown error. With one copy living 4000 ms and the other
 * 6000 ms, the duplicate looked like a flicker, and the browser test that
 * counts them went green as soon as the shorter one expired. With neither
 * expiring, both stay on screen and the count is wrong (CEL-0220).
 */

test('a restore failure the serializer already published is not announced twice', async () => {
  const [serializer, controls] = await Promise.all([
    readFile(
      new URL('../assets/js/app/session/session-serializer.js', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL(
        '../assets/js/app/ui/modules/session-controls.js',
        import.meta.url
      ),
      'utf8'
    ),
  ]);

  // The mark is only meaningful if it is set exactly where a failure reaches
  // the screen, and nowhere else.
  const publications = [
    ...serializer.matchAll(/notifications\.failDownload\([\s\S]*?\);/g),
  ];
  assert.ok(
    publications.length >= 4,
    `the restore paths must still publish their failures (${publications.length})`
  );
  for (const match of publications) {
    const following = serializer.slice(
      match.index + match[0].length,
      match.index + match[0].length + 120
    );
    assert.match(
      following,
      /markSessionRestoreReported\(err\);/,
      'a failure shown to the user must be marked as shown'
    );
  }

  // And the caller that would otherwise repeat it must consult the mark before
  // publishing, not after.
  const loadFailureStart = controls.indexOf("'Failed to load state:'");
  assert.notEqual(
    loadFailureStart,
    -1,
    'the load handler must still report its failures'
  );
  const loadFailure = controls.slice(loadFailureStart);
  const guard = loadFailure.indexOf('isSessionRestoreReportedError(err)');
  const publish = loadFailure.indexOf('showSessionStatus');
  assert.notEqual(guard, -1, 'the load handler must consult the mark');
  assert.notEqual(publish, -1, 'the load handler must still publish unmarked failures');
  assert.ok(
    guard < publish,
    'the duplicate check must run before the second notification is published'
  );

  // The predicate itself only claims what was actually marked.
  assert.equal(isSessionRestoreReportedError(new Error('unreported')), false);
  assert.equal(isSessionRestoreReportedError(null), false);
  assert.equal(isSessionRestoreReportedError('not an error'), false);
  const reported = new Error('reported');
  Object.defineProperty(
    reported,
    Symbol.for('cellucid.sessionRestoreFailureReported'),
    { value: true }
  );
  assert.equal(isSessionRestoreReportedError(reported), true);
});
