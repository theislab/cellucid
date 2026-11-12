/**
 * @fileoverview Classification of GitHub, Worker, and network failures.
 *
 * The community annotation flows react very differently to an expired token, a
 * rate limit, an untrusted Worker origin, a missing repository, a Worker that
 * cannot be reached, and a repository that does not follow the annotation
 * layout. Each caller asks the same questions, so the questions live here.
 *
 * Every answer is read from what the error states -- its `code`, its HTTP
 * `status`, where it was asked (`github.path`) and the flags the transport
 * sets (`rateLimited`) -- never from its message text, which is for people.
 *
 * @module ui/modules/community-annotation/github-error-classification
 */

import { selectAnnotationPublicationMode } from '../../../community-annotations/github-sync.js';
import { WORKER_RESPONSE_CUT, WORKER_UNREACHABLE } from '../../../community-annotations/worker-request.js';
import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  isTransientFailure,
  isUnanswered,
} from '../../../../formats/io/byte-source.js';

export function httpStatusOrNull(err) {
  const n = Number(err?.status);
  return Number.isFinite(n) ? n : null;
}

export function gitHubApiPath(err) {
  return String(err?.github?.path || '').trim();
}

export function workerPath(err) {
  return String(err?.worker?.path || '').trim();
}

function isRepoInfoApiPath(path) {
  return /^\/repos\/[^/]+\/[^/]+$/i.test(String(path || ''));
}

/** GitHub refused the token: HTTP 401 (bad, expired or revoked credentials). */
export function isTokenAuthFailure(err) {
  return httpStatusOrNull(err) === 401;
}

/**
 * GitHub limits this account's requests: HTTP 429, a 403 the transport read
 * as a limit (`rateLimited`: a spent budget or a `Retry-After`, GitHub's
 * secondary limits), or a request the transport gave up on for the limit.
 */
export function isRateLimitError(err) {
  const status = httpStatusOrNull(err);
  if (status === 429) return true;
  if (status === 403 && err?.rateLimited === true) return true;
  return err instanceof ByteSourceError && err.code === BYTE_SOURCE_FAILURES.RATE_LIMITED;
}

export function isWorkerOriginSecurityError(err) {
  const code = String(err?.code || '').trim();
  return code === 'GITHUB_WORKER_ORIGIN_INVALID' || code === 'GITHUB_WORKER_ORIGIN_UNTRUSTED';
}

/**
 * The Worker runs another contract version than this Cellucid: an older one
 * (`GITHUB_WORKER_OUTDATED`: its owner redeploys it) or one this Cellucid
 * does not know (`GITHUB_WORKER_INCOMPATIBLE`: reload Cellucid). The error's
 * own message says which remedy applies.
 */
export function isWorkerCompatibilityFailure(err) {
  const code = String(err?.code || '').trim();
  return code === 'GITHUB_WORKER_INCOMPATIBLE' || code === 'GITHUB_WORKER_OUTDATED';
}

/**
 * No answer this page may read came from the Worker: the transport's
 * `GITHUB_WORKER_UNREACHABLE` (its `answeredBefore` tells a Worker that
 * stopped answering from one never reached), or a request the byte layer
 * reports unanswered (`isUnanswered`: every request to the Worker goes
 * through `fetchOnce`, which names `fetch`'s own rejection so). A bare
 * `TypeError` is never one: it is the code's own broken contract
 * (`utils/errors.js` `isInternalFailure`), and asking again cannot mend it
 * (round 9: one read as "GitHub unreachable" and was retried).
 */
export function isWorkerUnreachable(err) {
  return err?.code === WORKER_UNREACHABLE || isUnanswered(err);
}

/** The Worker's answer began and broke off before it was complete. */
export function isResponseCut(err) {
  if (err?.code === WORKER_RESPONSE_CUT) return true;
  return err instanceof ByteSourceError &&
    (err.code === BYTE_SOURCE_FAILURES.NETWORK || err.code === BYTE_SOURCE_FAILURES.STALLED) &&
    err.details?.phase === 'body';
}

/** A failure that may pass if the same request is made again later. */
export function isTransientRoleResolutionFailure(err) {
  const status = httpStatusOrNull(err);
  return (
    isWorkerUnreachable(err) ||
    isResponseCut(err) ||
    isRateLimitError(err) ||
    isTransientFailure(err) ||
    err?.transient === true ||
    status === 408 ||
    (status !== null && status >= 500)
  );
}

/** The repository itself is gone or no longer readable: its metadata answered 404. */
export function isRepoNotFoundOrNoAccess(err) {
  return httpStatusOrNull(err) === 404 && isRepoInfoApiPath(gitHubApiPath(err));
}

/**
 * The repository does not follow the annotation layout
 * (`COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID`: a missing
 * `annotations/users/` or config, a schema that is not the current one, a
 * branch that does not exist, a users tree GitHub truncated). Its message
 * names the path and the remedy.
 */
export function isAnnotationRepoStructureError(err) {
  return err?.code === 'COMMUNITY_ANNOTATION_REPOSITORY_LAYOUT_INVALID';
}

/**
 * A repository-wide annotation file does not meet the contract
 * (`annotations/config.json` invalid JSON or schema, or too large): the
 * repository's authors fix it; nothing local is wrong.
 */
export function isAnnotationContractError(err) {
  const code = String(err?.code || '').trim();
  return code === 'COMMUNITY_ANNOTATION_CONTRACT_INVALID' || code === 'COMMUNITY_ANNOTATION_FILE_TOO_LARGE';
}

export function getPublishCapability(repoInfo) {
  const publicationMode = selectAnnotationPublicationMode(repoInfo);
  return {
    publicationMode,
    canDirectPush: publicationMode === 'direct',
    allowForking: publicationMode === 'fork-pull-request',
    canPublish: publicationMode !== null,
  };
}

export function describeCannotPublishMessage(repoLabel) {
  return (
    `You do not have permission to publish annotations to ${repoLabel}.\n\n` +
    'GitHub reports you cannot push, and this repo disables forking, so Pull Request publishing is not possible.\n\n' +
    'Ask an author to grant you Write access (or higher), or enable forking for this repo.'
  );
}
