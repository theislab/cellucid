/**
 * The one way a contract test reaches a real host: allowed by name, for the
 * test's own duration (`scripts/network-guard-preload.mjs` refuses every
 * other non-loopback request and fails the file that made it). Only a test
 * whose subject is that host uses it; a test of what Cellucid does with a
 * host's answers fakes the host instead. No test uses it today.
 *
 * @module tests/helpers/real-network
 */
import { undoLater } from './teardown.mjs';

const ALLOWED = Symbol.for('cellucid.realNetworkHosts');

/**
 * Let test `t` reach `hostname` (exactly that name) until it ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} hostname
 */
export function allowRealHost(t, hostname) {
  globalThis[ALLOWED] ??= new Set();
  const host = String(hostname).toLowerCase();
  if (globalThis[ALLOWED].has(host)) return;
  globalThis[ALLOWED].add(host);
  undoLater(t, () => globalThis[ALLOWED].delete(host));
}
