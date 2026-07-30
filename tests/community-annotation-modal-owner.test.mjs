import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimCommunityAnnotationModal,
  closeActiveCommunityAnnotationModal,
  releaseCommunityAnnotationModal,
} from '../assets/js/app/ui/modules/community-annotation-modal-owner.js';

test.afterEach(() => {
  closeActiveCommunityAnnotationModal();
});

test('a new modal synchronously closes the previous exact owner', () => {
  const events = [];
  let releaseFirst = null;
  const first = () => {
    events.push('close:first');
    assert.equal(releaseFirst(), true);
  };
  releaseFirst = claimCommunityAnnotationModal(first);

  const second = () => events.push('close:second');
  const releaseSecond = claimCommunityAnnotationModal(second);
  events.push('claimed:second');

  assert.deepEqual(events, ['close:first', 'claimed:second']);
  assert.equal(releaseFirst(), false);
  assert.equal(releaseSecond(), true);
  assert.equal(closeActiveCommunityAnnotationModal(), false);
});

test('a failing old close remains owner and prevents replacement', () => {
  const failure = new Error('teardown failed');
  let attempts = 0;
  const first = () => {
    attempts += 1;
    throw failure;
  };
  claimCommunityAnnotationModal(first);

  assert.throws(
    () => claimCommunityAnnotationModal(() => {}),
    error => error === failure
  );
  assert.equal(attempts, 1);
  assert.throws(
    () => closeActiveCommunityAnnotationModal({ restoreFocus: false }),
    error => error === failure
  );
  assert.equal(attempts, 2);
  assert.equal(releaseCommunityAnnotationModal(first), true);
});

test('a normally returning old close must release before replacement', () => {
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;
  const first = () => {
    firstCloseCalls += 1;
  };
  claimCommunityAnnotationModal(first);

  assert.throws(
    () => claimCommunityAnnotationModal(() => {
      secondCloseCalls += 1;
    }),
    /returned without releasing its exact owner/
  );
  assert.equal(firstCloseCalls, 1);
  assert.equal(secondCloseCalls, 0);
  assert.equal(closeActiveCommunityAnnotationModal(), true);
  assert.equal(firstCloseCalls, 2);
  assert.equal(releaseCommunityAnnotationModal(first), true);
});

test('stale releases cannot clear a newer owner and close forwards options', () => {
  const first = () => {};
  const releaseFirst = claimCommunityAnnotationModal(first);
  releaseCommunityAnnotationModal(first);

  const received = [];
  let releaseSecond = null;
  const second = options => {
    received.push(options);
    releaseSecond();
  };
  releaseSecond = claimCommunityAnnotationModal(second);

  assert.equal(releaseFirst(), false);
  const options = Object.freeze({ restoreFocus: false });
  assert.equal(closeActiveCommunityAnnotationModal(options), true);
  assert.deepEqual(received, [options]);
  assert.equal(closeActiveCommunityAnnotationModal(), false);
});

test('claiming the same owner is idempotent and identity-bound', () => {
  let closes = 0;
  const close = () => {
    closes += 1;
  };
  const releaseA = claimCommunityAnnotationModal(close);
  const releaseB = claimCommunityAnnotationModal(close);
  assert.equal(closes, 0);
  assert.equal(releaseA(), true);
  assert.equal(releaseB(), false);
});
