/**
 * The machine as plans read it: every rate the app measures of the machine
 * and the link it runs on, and then weighs in a plan, is read through this
 * module under one name, so that a rate held here takes the measurement's
 * place wherever it is read -- on the page, in the reader worker and in the
 * workers that one starts.
 *
 * Why one place. The reader plans from what it measures: which cells genes
 * are read for from the link's round trip and rate and from how fast chunks
 * decode here; whether every cell opens in the file's order from how long
 * making another order took; whether a kept gene index is read or built
 * again from how fast kept copies were read; which pass indexes a share from
 * what a pass's work cost. A measurement follows how busy the machine is,
 * so the same file on the same link is planned otherwise on a loaded
 * machine: a request a busy machine answers itself 370 ms late is a slow
 * link to the reader, which then read genes for a sample of a 238 KB file's
 * 1,500 open cells, in another order, so a larger share was read anew where
 * it is shown in place at rest (`tests/browser/held-machine.spec.mjs`; what
 * failed `open-cells-in-place.spec.mjs` beside other runs, 2026-11-06).
 * Nothing can be asserted of a plan whose inputs the runner chooses. Held,
 * each input is a number a test or a benchmark names:
 * `holdMachine({decodeBytesPerMs: 1e6})`.
 *
 * Nothing is held unless `holdMachine` is called, and nothing in the app
 * calls it: every measure is then what its module measures, exactly as
 * before this module existed. The callers are the tests
 * (`tests/helpers/machine-at-rest.mjs`; the browser specs' device,
 * `tests/browser/helpers/device.mjs`) and the benchmarks.
 *
 * **Workers.** A hold is a realm's: a worker has its own instance of this
 * module. What a thread holds when it starts a worker is handed to that
 * worker with its start, in the fragment of its address
 * (`workers/worker-script.js` `handToWorkers`), and the worker's instance
 * begins with it, before any of its code plans. A
 * hold changed later reaches the workers started after it.
 *
 * **The measures** (`MEASURES`): the name, what it is, and where the
 * measurement it stands in for is made.
 *
 * | Name | Held value | Measured by |
 * | --- | --- | --- |
 * | `link` | `{latencyMs, bytesPerMs}`: a round trip and a rate, at rest (the round trip under load is the round trip, a request costs nothing more) | `formats/io/link.js` `LinkMeter`; read by the reader as `plannedLink`. What earlier visits and the page's own downloads measured of the host is not weighed either (`data/host-link-memory.js` `plannedHostLink`) |
 * | `decodeBytesPerMs` | decoded bytes a millisecond, every decoder together | `formats/io/decode-pool.js` `decodePoolStats`, as `data/anndata/progressive-open.js` `decodingRate` |
 * | `orderMadeMs` | milliseconds making every cell's order takes | `data/anndata/subsample-plan.js` `geneSampleOf` |
 * | `keptReadBytesPerMs` | bytes a millisecond a kept gene index is read at, or null: not measured | `data/sparse-column-index.js` `keptReadMs` |
 * | `indexPassMs` | `{index, view, placeWhole, placeOwn}`, milliseconds an entry (each a number or left out), or null: none measured | `data/anndata/prefix-column-index.js` `PassRates` |
 * | `shownCellMs` | milliseconds showing a cell adds to an opening, or null: not measured | `data/opening-cost.js` `shownMsPerCell` |
 * | `cores` | the cores a pool is sized by | `navigator.hardwareConcurrency`, read by `formats/io/decode-pool.js`, `formats/zarr/open.js`, `data/anndata/write/pool-encoder.js`, `formats/io/decoder-memory.js`, `app/analysis/shared/performance-config.js` |
 *
 * A new rate that feeds a plan gets a name here and is read with
 * `measureOf`; a pin of its own beside this module would not reach the
 * workers, and the tests' device would not know of it
 * (`tests/machine-seam-contract.test.mjs` holds the list to the app's
 * sources).
 *
 * @module utils/machine
 */

import { handToWorkers, handedByStarter } from '../workers/worker-script.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const notNegative = value => finite(value) && value >= 0;

/** The keys a held `indexPassMs` may give. */
const INDEX_PASS_KINDS = Object.freeze(['index', 'view', 'placeWhole', 'placeOwn']);

/**
 * The measures a machine is held at: for each, whether a value may be held
 * (`holds`) and how it is said when it may not (`is`).
 */
const MEASURES = Object.freeze({
  link: Object.freeze({
    holds: value => value !== null && typeof value === 'object'
      && Object.keys(value).every(key => key === 'latencyMs' || key === 'bytesPerMs')
      && notNegative(value.latencyMs) && positive(value.bytesPerMs),
    is: '{latencyMs, bytesPerMs}: a round trip of 0 or more milliseconds and a rate above 0 bytes a millisecond',
  }),
  decodeBytesPerMs: Object.freeze({ holds: positive, is: 'a number of bytes a millisecond above 0' }),
  orderMadeMs: Object.freeze({ holds: notNegative, is: '0 or more milliseconds' }),
  keptReadBytesPerMs: Object.freeze({ holds: value => value === null || positive(value), is: 'a number of bytes a millisecond above 0, or null' }),
  indexPassMs: Object.freeze({
    holds: value => value === null || (typeof value === 'object'
      && Object.keys(value).every(key => INDEX_PASS_KINDS.includes(key) && positive(value[key]))),
    is: `null, or milliseconds an entry above 0 under any of ${INDEX_PASS_KINDS.join(', ')}`,
  }),
  shownCellMs: Object.freeze({ holds: value => value === null || notNegative(value), is: '0 or more milliseconds a cell, or null' }),
  cores: Object.freeze({ holds: value => Number.isInteger(value) && value >= 1, is: 'a whole number of cores, 1 or more' }),
});

/** The names a machine is held under. */
export const MACHINE_MEASURES = Object.freeze(Object.keys(MEASURES));

/** The key a thread's holds are handed to the workers it starts under (`worker-script.js`). */
const HANDED_KEY = 'machine';

function checked(measures) {
  if (measures === null || measures === undefined) return null;
  if (typeof measures !== 'object' || Array.isArray(measures)) throw new TypeError('A held machine is an object of measures, or null.');
  const held = {};
  for (const [name, value] of Object.entries(measures)) {
    const measure = MEASURES[name];
    if (measure === undefined) throw new TypeError(`Unknown machine measure "${name}" (the measures: ${MACHINE_MEASURES.join(', ')}).`);
    if (!measure.holds(value)) throw new RangeError(`A held ${name} is ${measure.is} (got ${JSON.stringify(value) ?? String(value)}).`);
    held[name] = value !== null && typeof value === 'object' ? Object.freeze({ ...value }) : value;
  }
  return Object.keys(held).length === 0 ? null : Object.freeze(held);
}

/**
 * What this realm holds: the measures named, each at its value; null when
 * every measure is measured. A worker begins with what the thread that
 * started it held then.
 * @type {Readonly<Object<string, unknown>>|null}
 */
let holds = checked(handedByStarter(HANDED_KEY) ?? null);

handToWorkers(HANDED_KEY, () => holds ?? undefined);

/**
 * Hold the measures named in `measures` at their values, in this realm and
 * in every worker it starts from now on; every measure left out is
 * measured. Null (or nothing) holds none: the machine as it measures
 * itself. Each call replaces the holds of the call before it.
 *
 * For tests and benchmarks (module doc).
 *
 * @param {Object<string, unknown>|null} [measures] - By name (`MACHINE_MEASURES`, module doc)
 */
export function holdMachine(measures = null) {
  holds = checked(measures);
}

/** What this realm holds (`holdMachine`), or null: frozen, by name. */
export function heldMachine() {
  return holds;
}

/** Whether the measure `name` is held in this realm. */
export function isHeld(name) {
  if (MEASURES[name] === undefined) throw new TypeError(`Unknown machine measure "${String(name)}".`);
  return holds !== null && Object.hasOwn(holds, name);
}

/**
 * The cores `environment` reports (`navigator.hardwareConcurrency`), or null
 * when it reports none: this realm's as held when they are (`cores`). A
 * stand-in environment (tests) is a machine of its own, never held.
 *
 * @param {{navigator?: {hardwareConcurrency?: number}}} [environment]
 * @returns {number|null}
 */
export function reportedCores(environment = globalThis) {
  if (environment === globalThis && isHeld('cores')) return holds.cores;
  const reported = environment?.navigator?.hardwareConcurrency;
  return Number.isSafeInteger(reported) && reported > 0 ? reported : null;
}

/**
 * The measure `name` as plans read it: what it is held at, else what
 * `measure()` measures now (called only when it is not held).
 *
 * @template T
 * @param {string} name - One of `MACHINE_MEASURES`
 * @param {() => T} measure
 * @returns {T}
 */
export function measureOf(name, measure) {
  return isHeld(name) ? holds[name] : measure();
}
