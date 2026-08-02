/**
 * @fileoverview Classification of GitHub, Worker, and network failures.
 *
 * The community annotation flows react very differently to an expired token, a
 * rate limit, an untrusted Worker origin, a missing repository, and a repository
 * that is missing the annotation template. Each caller asks the same questions,
 * so the questions live here rather than being re-derived from status codes and
 * message text at every call site.
 *
 * @module ui/modules/community-annotation/github-error-classification
 */

import { selectAnnotationPublicationMode } from '../../../community-annotations/github-sync.js';

export function httpStatusOrNull(err) {
  const n = Number(err?.status);
  return Number.isFinite(n) ? n : null;
}

export function lowerMessage(err) {
  return String(err?.message || '').trim().toLowerCase();
}

export function gitHubApiPath(err) {
  return String(err?.github?.path || '').trim();
}

export function workerPath(err) {
  return String(err?.worker?.path || '').trim();
}

export function isRepoInfoApiPath(path) {
  return /^\/repos\/[^/]+\/[^/]+$/i.test(String(path || ''));
}

export function isTokenAuthFailure(err) {
  if (!err) return false;
  const statusCode = httpStatusOrNull(err);
  const msg = lowerMessage(err);
  if (statusCode === 401) return true;
  if (statusCode === 403) {
    return (
      msg.includes('bad credentials') ||
      msg.includes('invalid token') ||
      msg.includes('requires authentication') ||
      msg.includes('unauthorized') ||
      msg.includes('token expired') ||
      msg.includes('jwt expired')
    );
  }
  return (
    msg.includes('bad credentials') ||
    msg.includes('invalid token') ||
    msg.includes('requires authentication') ||
    msg.includes('unauthorized')
  );
}

export function isRateLimitError(err) {
  const statusCode = httpStatusOrNull(err);
  if (statusCode === 429) return true;
  if (statusCode !== 403) return false;
  const msg = lowerMessage(err);
  return msg.includes('rate limit') || msg.includes('secondary rate limit') || msg.includes('abuse detection');
}

export function isWorkerOriginSecurityError(err) {
  const code = String(err?.code || '').trim();
  return code === 'GITHUB_WORKER_ORIGIN_INVALID' || code === 'GITHUB_WORKER_ORIGIN_UNTRUSTED';
}

export function isWorkerCompatibilityFailure(err) {
  return String(err?.code || '').trim() === 'GITHUB_WORKER_INCOMPATIBLE';
}

export function isNetworkFetchFailure(err) {
  const msg = String(err?.message || '').trim();
  if (err instanceof TypeError) return true;
  return /failed to fetch|load failed|networkerror/i.test(msg);
}

export function isTransientRoleResolutionFailure(err) {
  const status = httpStatusOrNull(err);
  return (
    isNetworkFetchFailure(err) ||
    err?.code === 'TIMEOUT' ||
    status === 408 ||
    isRateLimitError(err) ||
    (status !== null && status >= 500)
  );
}

export function isRepoNotFoundOrNoAccess(err) {
  const statusCode = httpStatusOrNull(err);
  if (statusCode !== 404) return false;
  const path = gitHubApiPath(err);
  // Private repos may appear as 404 when access is lost; treat the repo as not accessible.
  return isRepoInfoApiPath(path);
}

export function isAnnotationRepoStructureError(err) {
  const statusCode = httpStatusOrNull(err);
  const path = gitHubApiPath(err);
  const msg = String(err?.message || '').trim();

  // Required template paths under the repo:
  // - annotations/users/ (directory)
  // - annotations/schema.json (file)
  // - annotations/config.json (file)
  if (statusCode === 404 && /\/contents\/annotations\/(users|schema\.json|config\.json)(?:\/|$)/i.test(path)) {
    return true;
  }
  if (/Expected directory listing at annotations\/users/i.test(msg)) return true;
  if (/Expected file at annotations\/(schema\.json|config\.json)/i.test(msg)) return true;
  if (/Invalid JSON at annotations\/(schema\.json|config\.json)/i.test(msg)) return true;
  return false;
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
