/**
 * The contract suite never reaches the network: every request to a host
 * other than this machine's loopback is refused, and the test file that
 * made it fails, naming each URL. `scripts/run-web-tests.mjs` preloads it
 * into every run (`npm test`, CI); a test file run on its own takes it with
 *
 *   node --import ./scripts/network-guard-preload.mjs --test tests/<file>.test.mjs
 *
 * A contract test answers every host it reads from with a fake of it. A
 * request that reached the real network was one that outlived the fake (a
 * read a disconnected source left running, retried after the test put the
 * real `fetch` back; requests an opening asked for beside one that failed:
 * `close-stops-reads-contract`, 2026-11-01) or one nobody faked, and it made
 * a run depend on a host it does not own. So:
 *
 * - `fetch` to a non-loopback `http(s)`/`ws(s)` URL rejects at once with a
 *   `TypeError` naming the URL (as a refused connection does), before any
 *   DNS lookup; `data:`, `blob:` and `file:` URLs and loopback hosts
 *   (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) pass.
 * - Underneath, every TCP connection (`net.Socket#connect`: `http`,
 *   `https`, `tls`, `WebSocket`, a `fetch` captured before this ran) to a
 *   non-loopback host is refused with the same error, so no other client
 *   gets past it.
 * - Each refusal is written to stderr with the stack that asked, and when
 *   the file's process exits it fails (exit code 1) with the list of URLs:
 *   a refusal the code caught and retried, or one made after its test had
 *   ended, still fails the file that made it. (In a `worker_threads`
 *   worker, which takes the preload too, a refusal rejects and is written
 *   to stderr; the file fails through the test that awaited it. No contract
 *   test's worker thread fetches.)
 *
 * Opt-in: a test whose subject is a real host (none is, today) allows that
 * host for its own duration only, `allowRealHost(t, 'example.org')`
 * (`tests/helpers/real-network.mjs`); the hosts allowed are kept on
 * `globalThis[Symbol.for('cellucid.realNetworkHosts')]`.
 *
 * Documented in the web developer docs ("Contract tests that hold on every
 * Node version and operating system") and `scripts/README.md`.
 */
import net from 'node:net';

const ALLOWED = Symbol.for('cellucid.realNetworkHosts');
globalThis[ALLOWED] ??= new Set();
/** Every request refused in this thread, in order. */
const refused = [];

/** Whether `hostname` (as a URL or a socket names it) is this machine's loopback. */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function allowed(hostname) {
  return isLoopbackHost(hostname) || globalThis[ALLOWED].has(String(hostname).toLowerCase());
}

/** Record a refused request; the error it fails with (`fetch`'s own words for a connection refused, or a socket's). */
function refuse(what, { socket = false } = {}) {
  refused.push(what);
  const words = `the contract suite never reaches the network, and ${what} is not this machine (scripts/network-guard-preload.mjs)`;
  const error = socket ? Object.assign(new Error(`connect ECONNREFUSED: ${words}`), { code: 'ECONNREFUSED' }) : new TypeError(`fetch failed: ${words}`);
  process.stderr.write(`[network guard] refused ${what}\n${(new Error('asked here').stack ?? '').split('\n').slice(2, 12).join('\n')}\n`);
  return error;
}

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let url = null;
    try {
      url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input));
    } catch {
      // Not an absolute URL: the platform's fetch says so.
    }
    if (url !== null && /^(https?|wss?):$/.test(url.protocol) && !allowed(url.hostname)) {
      return Promise.reject(refuse(url.href));
    }
    return realFetch.call(this, input, init);
  };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first !== null && typeof first === 'object' ? first : null;
  // An IPC path (a pipe, a Unix socket) is this machine.
  const path = options?.path ?? (typeof first === 'string' && !/^\d+$/.test(first) ? first : null);
  if (path === null) {
    const host = options !== null ? options.host ?? options.hostname ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!allowed(host)) {
      const port = options?.port ?? first;
      const error = refuse(`${host}:${port}`, { socket: true });
      process.nextTick(() => this.destroy(error));
      return this;
    }
  }
  return realConnect.apply(this, args);
};

process.on('exit', () => {
  if (refused.length === 0) return;
  process.stderr.write(`[network guard] this test file asked the network ${refused.length === 1 ? 'once' : `${refused.length} times`}; ` +
    `a contract test answers every host with a fake of it:\n${[...new Set(refused)].map(what => `  ${what}`).join('\n')}\n`);
  process.exitCode = 1;
});
