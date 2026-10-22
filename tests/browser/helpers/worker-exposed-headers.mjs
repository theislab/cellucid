/**
 * The response headers the deployable community-annotation worker exposes to
 * a cross-origin page (`Access-Control-Expose-Headers`).
 *
 * Browser specs that stand in for the worker must expose the same headers:
 * without them the page cannot read `Retry-After` or `X-RateLimit-Reset`, so
 * the app falls back to its default backoff and a synthetic delay is silently
 * ignored. `tests/community-annotation-operation-header-contract.test.mjs`
 * compares this list with a real worker response, so the stand-in cannot drift.
 */
export const WORKER_EXPOSED_RESPONSE_HEADERS = Object.freeze([
  'Retry-After',
  'X-Cellucid-Operation-Id',
  'X-Cellucid-Operation-Outcome',
  'X-GitHub-Request-Id',
  'X-RateLimit-Reset',
]);
