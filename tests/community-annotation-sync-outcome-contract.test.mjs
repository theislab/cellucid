import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSyncOutcome } from '../assets/js/app/ui/modules/community-annotation/github-connection-flow.js';

test('only a completed sync outcome produces the success text', () => {
  assert.equal(
    describeSyncOutcome({ status: 'done' }, 'Publish complete.'),
    'Publish complete.'
  );
  assert.match(
    describeSyncOutcome({ status: 'skipped' }, 'Publish complete.'),
    /Another GitHub sync is still running/
  );
  assert.equal(
    describeSyncOutcome({ status: 'cancelled' }, 'Publish complete.'),
    'Canceled.'
  );
  assert.equal(
    describeSyncOutcome(
      { status: 'failed', error: 'Sign in required.' },
      'Publish complete.'
    ),
    '⚠ Sign in required.'
  );
  assert.throws(
    () => describeSyncOutcome(undefined, 'Publish complete.'),
    /explicit outcome/
  );
  assert.throws(
    () => describeSyncOutcome({ status: 'failed' }, 'Publish complete.'),
    /error message/
  );
  assert.throws(
    () => describeSyncOutcome({ ok: true }, 'Publish complete.'),
    /Unknown GitHub sync outcome/
  );
});
