/**
 * Replace `fetch` for a Worker test while enforcing the Cloudflare Workers
 * runtime's `RequestInit` rules the Worker source must satisfy.
 *
 * Node accepts every standard `redirect` mode, but workerd rejects
 * `redirect: 'error'` with a TypeError before any request is sent. A mock that
 * accepted it let a Worker that could never reach its upstream pass every test.
 */
const WORKERD_REDIRECT_MODES = new Set(['follow', 'manual']);

export async function withMockedFetch(mockFetch, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    if (
      init.redirect !== undefined &&
      !WORKERD_REDIRECT_MODES.has(init.redirect)
    ) {
      return Promise.reject(new TypeError(
        `Invalid redirect value ${JSON.stringify(init.redirect)}: ` +
          'the Workers runtime accepts only "follow" or "manual".'
      ));
    }
    return mockFetch(input, init);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}
