// Single source of truth for the loopback ports the browser-test servers bind.
//
// The Playwright config and the static server it launches resolve their
// addresses here, so a run can be moved to a free port in one place. The
// defaults are unchanged from when the ports were literals, so a run that sets
// nothing behaves exactly as before.
//
// The specs resolve their addresses here too, through
// `tests/browser/helpers/origins.mjs`, which wraps this module for the two
// origins and the encoded fixture roots they carry in query parameters. That is
// what makes an override work end to end rather than only moving the servers:
// a page served at the new address asks for its fixtures there as well.
// `tests/browser-test-port-contract.test.mjs` sweeps `tests/browser/` for a
// reintroduced literal.

export const BROWSER_TEST_HOST = '127.0.0.1';
export const DEFAULT_BROWSER_TEST_PORT = 4173;
export const BROWSER_TEST_PORT_VARIABLE = 'CELLUCID_BROWSER_TEST_PORT';
export const BROWSER_TEST_SAMPLE_PORT_VARIABLE =
  'CELLUCID_BROWSER_TEST_SAMPLE_PORT';

const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;

function describePortRange(variable) {
  return (
    `${variable} must be a whole number between ${LOWEST_PORT} and ` +
    `${HIGHEST_PORT}`
  );
}

function readPort(environment, variable, fallback) {
  const raw = environment[variable];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new RangeError(
      `${describePortRange(variable)}; received ${JSON.stringify(raw)}.`
    );
  }
  return Number(raw);
}

function assertPortInRange(value, variable, derivedFrom) {
  if (Number.isInteger(value) && value >= LOWEST_PORT && value <= HIGHEST_PORT) {
    return;
  }
  const origin = derivedFrom === undefined
    ? `received ${value}`
    : `derived ${value} from ${derivedFrom}`;
  throw new RangeError(`${describePortRange(variable)}; ${origin}.`);
}

/**
 * Resolve the two loopback ports a browser-test run uses.
 *
 * The main server hosts the application; the sample server hosts the same tree
 * with permissive CORS so cross-origin data-source paths can be exercised. The
 * sample port defaults to the port immediately after the main one.
 *
 * @param {Record<string, string | undefined>} [environment]
 * @returns {Readonly<{
 *   host: string,
 *   port: number,
 *   samplePort: number,
 *   origin: string,
 *   sampleOrigin: string,
 * }>}
 */
export function resolveBrowserTestPorts(environment = process.env) {
  const port = readPort(
    environment,
    BROWSER_TEST_PORT_VARIABLE,
    DEFAULT_BROWSER_TEST_PORT
  );
  assertPortInRange(port, BROWSER_TEST_PORT_VARIABLE);

  const samplePort = readPort(
    environment,
    BROWSER_TEST_SAMPLE_PORT_VARIABLE,
    port + 1
  );
  assertPortInRange(
    samplePort,
    BROWSER_TEST_SAMPLE_PORT_VARIABLE,
    environment[BROWSER_TEST_SAMPLE_PORT_VARIABLE] === undefined ||
      environment[BROWSER_TEST_SAMPLE_PORT_VARIABLE] === ''
      ? `${BROWSER_TEST_PORT_VARIABLE}=${port}`
      : undefined
  );
  if (samplePort === port) {
    throw new RangeError(
      `${BROWSER_TEST_SAMPLE_PORT_VARIABLE} must differ from ` +
        `${BROWSER_TEST_PORT_VARIABLE}; both resolved to ${port}.`
    );
  }

  return Object.freeze({
    host: BROWSER_TEST_HOST,
    port,
    samplePort,
    origin: `http://${BROWSER_TEST_HOST}:${port}`,
    sampleOrigin: `http://${BROWSER_TEST_HOST}:${samplePort}`,
  });
}

/**
 * The message a run sees when the port it asked for is already taken.
 *
 * A browser-test run that collides must say so and stop, because the cost of
 * the alternative is measured in lost engine coverage: a second run that
 * silently blocks on the port leaves no evidence of why it produced nothing.
 *
 * @param {string} role
 * @param {number} port
 * @param {string} variable
 * @returns {string}
 */
export function describePortInUse(role, port, variable) {
  return (
    `Browser-test ${role} server cannot bind ${BROWSER_TEST_HOST}:${port}: ` +
    'the address is already in use, most likely by another browser-test run. ' +
    `Set ${variable} to a free port and run again ` +
    `(${BROWSER_TEST_SAMPLE_PORT_VARIABLE} defaults to ` +
    `${BROWSER_TEST_PORT_VARIABLE} + 1).`
  );
}
