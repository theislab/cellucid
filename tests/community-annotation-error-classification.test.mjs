/**
 * The community-annotation error classifier answers from what an error
 * states (code, status, where it was asked, the transport's flags), never
 * from its message text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAnnotationContractError,
  isAnnotationRepoStructureError,
  isRateLimitError,
  isRepoNotFoundOrNoAccess,
  isResponseCut,
  isTokenAuthFailure,
  isTransientRoleResolutionFailure,
  isWorkerCompatibilityFailure,
  isWorkerUnreachable,
} from '../assets/js/app/ui/modules/community-annotation/github-error-classification.js';
import { BYTE_SOURCE_FAILURES, ByteSourceError } from '../assets/js/formats/io/byte-source.js';

const withProps = (message, props) => Object.assign(new Error(message), props);

test('message text never decides a class', () => {
  const misleading = withProps('Bad credentials: API rate limit exceeded; Failed to fetch; Expected file at annotations/config.json', {});
  assert.equal(isTokenAuthFailure(misleading), false);
  assert.equal(isRateLimitError(misleading), false);
  assert.equal(isWorkerUnreachable(misleading), false);
  assert.equal(isAnnotationRepoStructureError(misleading), false);
  assert.equal(isTransientRoleResolutionFailure(misleading), false);
});

test('statuses and the transport\'s flags decide', () => {
  assert.equal(isTokenAuthFailure(withProps('x', { status: 401 })), true);
  assert.equal(isTokenAuthFailure(withProps('x', { status: 403 })), false);
  assert.equal(isRateLimitError(withProps('x', { status: 429 })), true);
  assert.equal(isRateLimitError(withProps('x', { status: 403, rateLimited: true })), true);
  assert.equal(isRateLimitError(withProps('x', { status: 403 })), false);
  assert.equal(isRateLimitError(new ByteSourceError(BYTE_SOURCE_FAILURES.RATE_LIMITED, 'x')), true);
  assert.equal(isRepoNotFoundOrNoAccess(withProps('x', { status: 404, github: { path: '/repos/o/r', method: 'GET' } })), true);
  assert.equal(isRepoNotFoundOrNoAccess(withProps('x', { status: 404, github: { path: '/repos/o/r/contents/a', method: 'GET' } })), false);
});

test('codes decide: Worker versions, layout, contract, unreachable, cut answers', () => {
  assert.equal(isWorkerCompatibilityFailure(withProps('x', { code: 'GITHUB_WORKER_OUTDATED' })), true);
  assert.equal(isWorkerCompatibilityFailure(withProps('x', { code: 'GITHUB_WORKER_INCOMPATIBLE' })), true);
  assert.equal(isAnnotationRepoStructureError(withProps('x', { code: 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID' })), true);
  assert.equal(isAnnotationContractError(withProps('x', { code: 'COMMUNITY_ANNOTATION_CONTRACT_INVALID' })), true);
  assert.equal(isAnnotationContractError(withProps('x', { code: 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE' })), true);
  const unreachable = withProps('x', { code: 'GITHUB_WORKER_UNREACHABLE', answeredBefore: true });
  assert.equal(isWorkerUnreachable(unreachable), true);
  assert.equal(isTransientRoleResolutionFailure(unreachable), true);
  const unanswered = new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, 'x', { phase: 'answer' });
  assert.equal(isWorkerUnreachable(unanswered), true);
  const cut = new ByteSourceError(BYTE_SOURCE_FAILURES.NETWORK, 'x', { phase: 'body' });
  assert.equal(isResponseCut(cut), true);
  assert.equal(isWorkerUnreachable(cut), false, 'an answer that began is not an unreachable Worker');
  assert.equal(isResponseCut(withProps('x', { code: 'COMMUNITY_ANNOTATION_RESPONSE_CUT' })), true);
  assert.equal(isTransientRoleResolutionFailure(withProps('x', { code: 'COMMUNITY_ANNOTATION_RESPONSE_CUT', transient: true })), true);
  assert.equal(isTransientRoleResolutionFailure(withProps('x', { status: 503 })), true);
  assert.equal(isTransientRoleResolutionFailure(withProps('x', { status: 422 })), false);
});

test('a programming TypeError is the code\'s own failure, never an unreachable Worker asked again', async () => {
  // A TypeError is not "GitHub unreachable": a broken contract is not retried and not said as GitHub's.
  const programming = new TypeError("Cannot read properties of undefined (reading 'login')");
  assert.equal(isWorkerUnreachable(programming), false);
  assert.equal(isTransientRoleResolutionFailure(programming), false);
  assert.equal(isWorkerUnreachable(new TypeError('Failed to fetch')), false, 'a raw rejection never reaches here');
  // fetch's own rejection, as the one transport names it: unanswered, and asked again.
  const { fetchOnce } = await import('../assets/js/formats/io/byte-source.js');
  const { createHostBook } = await import('../assets/js/formats/io/hosts.js');
  let failure = null;
  try {
    await fetchOnce('https://worker.example/me', {}, {
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
      hosts: createHostBook(),
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(isWorkerUnreachable(failure), true);
  assert.equal(isTransientRoleResolutionFailure(failure), true);
});
