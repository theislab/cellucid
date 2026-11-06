/**
 * The response headers the deployable community-annotation worker exposes to
 * a cross-origin page (`Access-Control-Expose-Headers`).
 *
 * Browser specs that stand in for the worker must expose the same headers:
 * without them the page cannot read `Retry-After`, `ETag` or the
 * `X-RateLimit-*` budget, so the app falls back to its default backoff and a
 * synthetic delay is silently ignored. The list is the Worker's own
 * (`worker-contract.js`), so the stand-in cannot drift;
 * `tests/community-annotation-operation-header-contract.test.mjs` checks it
 * against a real worker response.
 */
export { WORKER_EXPOSED_RESPONSE_HEADERS } from '../../../assets/js/app/community-annotations/worker-contract.js';
