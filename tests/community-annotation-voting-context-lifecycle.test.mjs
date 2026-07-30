import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCommunityAnnotationVotingContextLease,
} from '../assets/js/app/ui/modules/community-annotation-voting-modal.js';

function context(overrides = {}) {
  return {
    datasetId: 'dataset-a',
    repoRef: 'owner/repo@main',
    simulated: false,
    userId: 42,
    userKey: 'ghid_42',
    ...overrides,
  };
}

test('community voting context lease fences every dataset, repo, auth, and simulation boundary', () => {
  const lease = createCommunityAnnotationVotingContextLease(context());

  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.isFrozen(lease.context), true);
  assert.equal(lease.isCurrent(context()), true);
  for (const candidate of [
    context({ datasetId: 'dataset-b' }),
    context({ repoRef: 'owner/other@main' }),
    context({ simulated: true }),
    context({ userId: 43 }),
    context({ userKey: 'ghid_43' }),
  ]) {
    assert.equal(lease.isCurrent(candidate), false);
  }
});

test('community voting context retirement synchronously aborts its field-load lease exactly once', async () => {
  const lease = createCommunityAnnotationVotingContextLease(context());
  let abortEvents = 0;
  const fieldLoadRetired = new Promise(resolve => {
    lease.signal.addEventListener('abort', () => {
      abortEvents += 1;
      resolve();
    });
  });

  lease.retire();
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.isCurrent(context()), false);
  await fieldLoadRetired;
  lease.retire();
  assert.equal(abortEvents, 1);
});

test('community voting context lease rejects alternate or partial identities', () => {
  assert.throws(
    () => createCommunityAnnotationVotingContextLease({
      datasetId: 'dataset-a',
      repoRef: 'owner/repo@main',
      userId: 42,
      userKey: 'ghid_42',
    }),
    /exact cache-context keys/,
  );
  const lease = createCommunityAnnotationVotingContextLease(context());
  assert.throws(
    () => lease.isCurrent(context({ userId: null, userKey: ' local ' })),
    /userKey must be an exact string/,
  );
});
