import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  NotificationCenter,
  NotificationType,
} from '../assets/js/app/notification-center.js';
import {
  formatBytes,
  formatCompactNumber,
  formatDuration,
} from '../assets/js/app/notification-center/formatters.js';

function createCancelButton() {
  const attributes = new Map();
  return {
    attributes,
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
}

test('notification cancellation publishes rejection and restores the control', async () => {
  const center = new NotificationCenter();
  const observed = [];
  center.error = (message, options) => {
    observed.push({ message, options });
  };
  const button = createCancelButton();
  const failure = new Error('synthetic cancellation failure');

  const outcome = await center._runCancelHandler(button, async () => {
    throw failure;
  });

  assert.equal(outcome, false);
  assert.equal(button.disabled, false);
  assert.equal(button.attributes.has('aria-disabled'), false);
  assert.deepEqual(observed, [{
    message: 'Cancel failed: synthetic cancellation failure',
    options: {
      category: 'default',
      title: 'Cancellation Error',
    },
  }]);
});

test('notification cancellation disables repeated activation after success', async () => {
  const center = new NotificationCenter();
  const button = createCancelButton();
  let calls = 0;

  const outcome = await center._runCancelHandler(button, () => {
    calls += 1;
  });

  assert.equal(outcome, true);
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.attributes.get('aria-disabled'), 'true');
});

test('notification and formatter inputs reject coercion and missing trackers', () => {
  const center = new NotificationCenter();

  assert.throws(
    () => center._updateNotification('missing', { message: 'update' }),
    /does not exist/i,
  );
  assert.throws(
    () => center._createNotificationElement('id', {
      type: NotificationType.INFO,
      category: 'unregistered-category',
      message: 'invalid',
    }),
    /unknown notification category/i,
  );
  assert.throws(() => formatBytes('1024'), /bytes must be/i);
  assert.throws(() => formatDuration(Number.NaN), /duration must be/i);
  assert.throws(() => formatCompactNumber('1000'), /number must be finite/i);
  assert.throws(
    () => center.updateDownload('missing', 0),
    /tracker.*does not exist/i,
  );
  assert.throws(
    () => center.error('exact message', null),
    /options must be a plain object/i,
  );
  assert.throws(
    () => center.hasNotification(''),
    /notification id must be a non-empty string/i,
  );
});

test('notification existence reflects pressure or manual retirement without exposing storage', () => {
  const center = new NotificationCenter();
  const notification = {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.LOADING },
  };
  center.notifications.set('async-owner', notification);

  assert.equal(center.hasNotification('async-owner'), true);
  center.notifications.delete('async-owner');
  assert.equal(center.hasNotification('async-owner'), false);
});

test('notification pressure evicts oldest non-active work and never active owners', () => {
  const center = new NotificationCenter();
  center.maxNotifications = 2;
  const dismissed = [];
  center.dismiss = id => {
    dismissed.push(id);
    return center.notifications.delete(id);
  };
  const record = type => ({
    dismissTimer: null,
    element: {},
    options: { type },
  });
  center.notifications.set(
    'active-oldest',
    record(NotificationType.LOADING),
  );
  center.notifications.set(
    'terminal-middle',
    record(NotificationType.SUCCESS),
  );

  center._evictNonActiveUntil(center.maxNotifications - 1);

  assert.deepEqual(dismissed, ['terminal-middle']);
  assert.equal(center.hasNotification('active-oldest'), true);
  assert.equal(center.notifications.size, 1);

  center.notifications.set(
    'active-newer',
    record(NotificationType.PROGRESS),
  );
  center._evictNonActiveUntil(center.maxNotifications - 1);

  // Both active generations remain owned even though a new notification will
  // temporarily take the center beyond its nominal visual cap.
  assert.deepEqual(dismissed, ['terminal-middle']);
  assert.equal(center.notifications.size, 2);

  center.notifications.set(
    'active-overflow',
    record(NotificationType.LOADING),
  );
  center.notifications.get('active-oldest').options.type =
    NotificationType.ERROR;
  center._evictNonActiveUntil(center.maxNotifications);

  assert.deepEqual(dismissed, [
    'terminal-middle',
    'active-oldest',
  ]);
  assert.equal(center.hasNotification('active-newer'), true);
});

test('download zero-byte totals remain exact and tracker adoption is transactional', () => {
  const center = new NotificationCenter();
  const shown = [];
  center.show = options => {
    shown.push(options);
    return options.id;
  };

  const id = center.startDownload('Empty dataset', 0);
  assert.equal(center.downloadTrackers.has(id), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, NotificationType.PROGRESS);
  assert.equal(shown[0].progress, 100);

  const failedCenter = new NotificationCenter();
  failedCenter.show = () => {
    throw new Error('DOM publication rejected');
  };
  assert.throws(
    () => failedCenter.startDownload('Rejected dataset', 1),
    /DOM publication rejected/,
  );
  assert.equal(failedCenter.downloadTrackers.size, 0);
});

test('stale auto-dismiss timers cannot dismiss a newer id generation', async () => {
  const center = new NotificationCenter();
  const older = {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.INFO },
  };
  const newer = {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.INFO },
  };
  center.notifications.set('shared-id', older);
  center._scheduleDismiss('shared-id', older, 1);
  center.notifications.set('shared-id', newer);

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(center.notifications.get('shared-id'), newer);
});

test('owned notification files contain no swallowed console failure path', async () => {
  const urls = [
    '../assets/js/app/notification-center.js',
    '../assets/js/app/notification-center/download-tracking.js',
    '../assets/js/app/notification-center/benchmark-notifications.js',
  ].map(path => new URL(path, import.meta.url));
  const source = (await Promise.all(urls.map(url => readFile(url, 'utf8')))).join('\n');

  assert.doesNotMatch(source, /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/[/*][^\n]*\s*)?\}/);
  assert.doesNotMatch(source, /console\.(?:warn|error)\s*\(/);
});

test('a notification renders the line breaks its message carries', async () => {
  // Notification messages are written as several sentences, and two of them are
  // a key/value list built with `bits.join('\n')`. `escapeHtml` does not touch
  // `\n` (`assets/js/app/utils/dom-utils.js:23-26`), so the newline reaches the
  // DOM intact — and with the default `white-space: normal` the browser folds
  // it into a space, turning a role failure and its status into the run-on
  // "Unable to determine your role for … . Not Found Disconnected annotation
  // repo." (CEL-0178). The break belongs to the message, so the rule that
  // honours it belongs to the element the message is written into, not to the
  // call sites.
  const [css, controls] = await Promise.all([
    readFile(
      new URL('../assets/css/components/_notifications.css', import.meta.url),
      'utf8'
    ),
    readFile(
      new URL(
        '../assets/js/app/ui/modules/community-annotation-controls.js',
        import.meta.url
      ),
      'utf8'
    ),
  ]);

  const rule = /\.notification-message \{([^}]*)\}/.exec(css);
  assert.ok(rule !== null, '.notification-message must still have a rule');
  assert.match(
    rule[1],
    /^\s*white-space: pre-line;$/m,
    '.notification-message must honour the newlines its messages carry'
  );

  // The rule is only worth having while messages still carry newlines, so it is
  // pinned to a message that does. Both are `notifications.info(bits.join(…))`.
  const joined = [
    ...controls.matchAll(/notifications\.\w+\(\s*bits\.join\('\\n'\)/g),
  ];
  assert.equal(
    joined.length,
    2,
    'the multi-line list messages must still be the reason for the rule'
  );
});

test('a card retired to make room is kept in the overflow list, never lost', () => {
  const center = new NotificationCenter();
  center.maxNotifications = 1;
  center.dismiss = id => center.notifications.delete(id);
  center.notifications.set('first-error', {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.ERROR, title: 'Load failed', message: 'Disk full' },
  });
  center.notifications.set('second', {
    dismissTimer: null,
    element: {},
    options: { type: NotificationType.SUCCESS, message: 'Saved' },
  });
  center._evictNonActiveUntil(center.maxNotifications);
  assert.deepEqual(center.overflowMessages, [
    { type: NotificationType.ERROR, title: 'Load failed', message: 'Disk full' },
  ]);
  assert.equal(center.hasNotification('second'), true);
});
