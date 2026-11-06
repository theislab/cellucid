/**
 * No browser spec depends on a host it does not own, as no contract test does
 * (`scripts/network-guard-preload.mjs`). A request that left this machine and
 * was answered by the real host makes a run depend on that host and on the
 * machine's network: run 42129386525 failed on WebKit alone because a spec's
 * made-up API key really went to api.anthropic.com, whose 401 WebKit reports
 * on the console. A spec plays each host it reads from with `page.route`.
 *
 * Only watched, never intercepted: a catch-all route would turn off the HTTP
 * cache for every spec. A response a route fulfilled names no server address,
 * so what names one came from the real host. The specs of the live providers
 * (`npm run test:live-agents`) are about those hosts, and a test whose subject
 * is a real host names it (`allowOutsideHost`), for that test only.
 */
const WATCHING = process.env.CELLUCID_LIVE_AGENTS !== '1';
const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|\[::1\])$/;

/** What the watched contexts reached, and what is still being asked: this worker runs one test at a time. */
const reached = new Set();
const asking = new Set();
const allowed = new Set();

/** This test's subject is `hostname`, a real host: its requests are not held against it. */
export function allowOutsideHost(hostname) {
  allowed.add(hostname);
}

function isOutside(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !LOOPBACK.test(url.hostname);
}

export function watchOutsideRequests(context) {
  if (!WATCHING) return;
  context.on('request', request => {
    if (!isOutside(request.url())) return;
    const answer = request.response()
      .then(response => response?.serverAddr() ?? null)
      .then(server => { if (server !== null && !allowed.has(new URL(request.url()).hostname)) reached.add(request.url()); })
      .catch(() => {})
      .finally(() => asking.delete(answer));
    asking.add(answer);
  });
}

/**
 * Fail the test that reached a host outside this machine, naming each address.
 * A request a test leaves waiting on its own route answers nothing: its wait ends here.
 */
export async function expectNoOutsideRequests() {
  if (asking.size > 0) {
    const waited = new Promise((_, reject) => { setTimeout(() => reject(new Error('still waiting')), 5000); });
    await Promise.race([Promise.all(asking), waited]).catch(() => {});
    asking.clear();
  }
  const addresses = [...reached];
  reached.clear();
  allowed.clear();
  if (addresses.length > 0) {
    throw new Error(`The test reached hosts outside this machine; play them with page.route:\n${addresses.join('\n')}`);
  }
}
