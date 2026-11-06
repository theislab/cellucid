/**
 * The machine as plans read it (`assets/js/utils/machine.js`): the one place
 * a rate measured of the machine or the link enters a plan.
 *
 * - A held measure takes its measurement's place, a measure not held is
 *   measured, and a hold is refused whole when any of it is not a measure.
 * - A thread's holds are handed to every worker it starts, in the fragment
 *   of the worker's address, and a worker's module instance begins with
 *   them; a page never reads its own fragment.
 * - Each measure's readers follow a hold: the link the reader plans on
 *   (its requests still measured by the source's meter), the host's seed,
 *   the decoding rate, the opening cost, the index pass rates, the cores.
 * - The measures are the app's: every one is read somewhere in the
 *   sources, none is pinned beside this module, and the cores a pool is
 *   sized by are read nowhere else.
 * - The tests' machines name measures only: the Node suite's machine at rest
 *   (`helpers/machine-at-rest.mjs`) and the browser specs' device
 *   (`browser/helpers/device.mjs`), whose defaults hold every measure.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { MACHINE_MEASURES, heldMachine, holdMachine, isHeld, measureOf, reportedCores } from '../assets/js/utils/machine.js';
import { handToWorkers, handedByStarter, startWorker } from '../assets/js/workers/worker-script.js';
import { LinkMeter, plannedLink } from '../assets/js/formats/io/link.js';
import { LOCAL_POLICY, REMOTE_POLICY } from '../assets/js/formats/io/byte-source.js';
import { plannedHostLink, pricingLink } from '../assets/js/data/host-link-memory.js';
import { decodingRate } from '../assets/js/data/anndata/progressive-open.js';
import { PassRates, wholeIsCheaper } from '../assets/js/data/anndata/prefix-column-index.js';
import { decodeWorkerCount } from '../assets/js/formats/io/decode-pool.js';
import { analysisWorkerCount } from '../assets/js/app/analysis/shared/performance-config.js';
import { recordShownCells, resetShownCells, shownMsPerCell } from '../assets/js/data/opening-cost.js';
import { DEVICE_DEFAULTS, deviceOf, machineOf } from './browser/helpers/device.mjs';
import { LINK_AT_REST, MACHINE_AT_REST, holdMachineAtRest } from './helpers/machine-at-rest.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every measure is measured again when a test ends, whatever it held. */
function releasing(t) {
  t.after(() => holdMachine(null));
}

test('a held measure takes its measurement\'s place; one not held is measured', t => {
  releasing(t);
  holdMachine(null);
  assert.equal(heldMachine(), null);
  let measured = 0;
  const measure = () => {
    measured++;
    return 7;
  };
  assert.equal(measureOf('decodeBytesPerMs', measure), 7);
  assert.equal(measured, 1);
  holdMachine({ decodeBytesPerMs: 250, keptReadBytesPerMs: null });
  assert.equal(measureOf('decodeBytesPerMs', measure), 250);
  assert.equal(measured, 1, 'a held measure is not measured');
  assert.equal(measureOf('keptReadBytesPerMs', () => 3), null, 'held at nothing measured');
  assert.equal(measureOf('orderMadeMs', () => 12), 12, 'a measure left out is measured');
  assert.equal(isHeld('keptReadBytesPerMs'), true);
  assert.equal(isHeld('orderMadeMs'), false);
  assert.ok(Object.isFrozen(heldMachine()));
  // Each call replaces the holds before it.
  holdMachine({ orderMadeMs: 0 });
  assert.deepEqual(heldMachine(), { orderMadeMs: 0 });
  holdMachine({});
  assert.equal(heldMachine(), null);
});

test('a hold that is not of the machine\'s measures is refused whole', t => {
  releasing(t);
  holdMachine({ decodeBytesPerMs: 5 });
  assert.throws(() => holdMachine({ decodeBytesPerMs: 9, frameMs: 1 }), /Unknown machine measure "frameMs"/);
  assert.throws(() => isHeld('frameMs'), TypeError);
  for (const refused of [
    { decodeBytesPerMs: 0 },
    { decodeBytesPerMs: null },
    { orderMadeMs: -1 },
    { link: { latencyMs: 2 } },
    { link: { latencyMs: 2, bytesPerMs: 0 } },
    { link: { latencyMs: 2, bytesPerMs: 5, concurrency: 6 } },
    { link: null },
    { keptReadBytesPerMs: 0 },
    { indexPassMs: { index: 0 } },
    { indexPassMs: { decode: 1 } },
    { shownCellMs: Number.NaN },
    { cores: 0 },
    { cores: 2.5 },
  ]) {
    assert.throws(() => holdMachine(refused), RangeError, JSON.stringify(refused));
  }
  assert.throws(() => holdMachine([]), TypeError);
  assert.deepEqual(heldMachine(), { decodeBytesPerMs: 5 }, 'a hold refused leaves the hold before it');
});

/** A worker's scope, as `handedByStarter` reads one: an instance of its `DedicatedWorkerGlobalScope`, at an address. */
function workerScope(address) {
  class DedicatedWorkerGlobalScope {}
  const scope = new DedicatedWorkerGlobalScope();
  scope.DedicatedWorkerGlobalScope = DedicatedWorkerGlobalScope;
  scope.location = new URL(address);
  return scope;
}

test('a thread\'s holds are handed to every worker it starts, in the fragment of its address, and to no page', t => {
  releasing(t);
  const started = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  globalThis.Worker = class {
    constructor(script, options) {
      started.push({ script, options });
    }

    addEventListener() {}
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.Worker;
    else Object.defineProperty(globalThis, 'Worker', previous);
  });
  const script = new URL('https://app.example/assets/workers/reader.0123456789ab.js');

  // Nothing held: the worker is started exactly as its caller asked.
  holdMachine(null);
  const asked = { type: 'module', name: 'cellucid-decode' };
  startWorker(script, asked);
  assert.equal(started.at(-1).script, script);
  assert.equal(started.at(-1).options, asked);
  assert.equal(handedByStarter('machine', workerScope(script)), undefined);

  // Held: in the fragment of the worker's address, read when the worker starts.
  const held = { link: { latencyMs: 2, bytesPerMs: 32_000 }, decodeBytesPerMs: 1e6, keptReadBytesPerMs: null, cores: 4 };
  holdMachine(held);
  startWorker(script, asked);
  const { script: address, options } = started.at(-1);
  assert.equal(options, asked, 'the options are the caller\'s, its name with them');
  assert.notEqual(address, script, 'the caller\'s address is not written to');
  assert.equal(script.hash, '');
  // The script asked for is the same: a fragment is no part of a request.
  assert.equal(`${address.origin}${address.pathname}${address.search}`, `${script.origin}${script.pathname}${script.search}`);
  assert.deepEqual(handedByStarter('machine', workerScope(address)), held);
  assert.equal(handedByStarter('another', workerScope(address)), undefined);

  // A hold changed later reaches the workers started after it.
  holdMachine({ decodeBytesPerMs: 10 });
  startWorker(script, asked);
  assert.deepEqual(handedByStarter('machine', workerScope(started.at(-1).script)), { decodeBytesPerMs: 10 });

  // A page's fragment is whatever its link said: never read.
  const page = { location: new URL(address), document: {} };
  assert.equal(handedByStarter('machine', page), undefined);
  // Nor a worker's fragment that is not a hand-over.
  assert.equal(handedByStarter('machine', workerScope('https://app.example/w.js#section')), undefined);
  assert.throws(() => handToWorkers('', () => 1), TypeError);
  assert.throws(() => handToWorkers('key', 1), TypeError);
});

test('a worker\'s machine begins with what its starter handed it, before any of its code plans', async () => {
  // The module's own instance in another thread, whose scope is made a
  // dedicated worker's at the address `startWorker` gives.
  const handed = { link: { latencyMs: 2, bytesPerMs: 32_000 }, decodeBytesPerMs: 123, orderMadeMs: 0, indexPassMs: null, cores: 3 };
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    globalThis.DedicatedWorkerGlobalScope = class { static [Symbol.hasInstance](value) { return value === globalThis; } };
    globalThis.location = new URL(workerData.address);
    const machine = await import(workerData.machine);
    const { decodingRate } = await import(workerData.planner);
    parentPort.postMessage({ held: machine.heldMachine(), cores: machine.reportedCores(), decodingRate: decodingRate() });
  `;
  const answer = fragment => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      workerData: {
        address: `https://app.example/assets/workers/reader.js${fragment}`,
        machine: new URL('../assets/js/utils/machine.js', import.meta.url).href,
        planner: new URL('../assets/js/data/anndata/progressive-open.js', import.meta.url).href,
      },
    });
    worker.once('message', message => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
  const fragmentOf = record => `#handed=${encodeURIComponent(JSON.stringify(record))}`;
  assert.deepEqual(await answer(fragmentOf({ machine: handed })), { held: handed, cores: 3, decodingRate: 123 });
  const measuring = await answer('');
  assert.equal(measuring.held, null, 'a worker handed nothing measures everything');
  assert.equal(measuring.decodingRate, null, 'no chunk decoded yet');
  // What is handed is checked as a hold is: a worker never plans on a measure that is none.
  await assert.rejects(answer(fragmentOf({ machine: { decodeBytesPerMs: -1 } })), RangeError);
});

test('the link the reader plans on is the held link at rest, while its requests are still measured', t => {
  releasing(t);
  let now = 0;
  const meter = new LinkMeter(REMOTE_POLICY, { clock: () => now });
  holdMachine(null);
  assert.equal(plannedLink(meter), meter, 'nothing held: the source\'s own meter');
  assert.equal(plannedLink(null), null);

  holdMachine({ link: { latencyMs: 2, bytesPerMs: 32_000 } });
  const planned = plannedLink(meter);
  // A request the loaded machine answered in 900 ms, at 1 KB/s.
  const started = meter.begin();
  now = 900;
  meter.end(started, 900);
  assert.equal(meter.latencyMs, 900, 'the meter measures the link as it is');
  assert.equal(meter.snapshot().bytesPerMs, 1);
  const snapshot = planned.snapshot();
  assert.equal(snapshot.latencyMs, 2);
  assert.equal(snapshot.loadedLatencyMs, 2);
  assert.equal(snapshot.warmLatencyMs, 2);
  assert.equal(snapshot.bytesPerMs, 32_000);
  assert.equal(snapshot.measured, true);
  assert.equal(snapshot.bandwidthMeasured, true);
  assert.equal(snapshot.requestCostMs, 0);
  assert.equal(snapshot.readsAhead, false, 'below the rate a web host is read ahead at');
  // Derived by the meter's own rules from the held link: a round trip's bytes, a merge gap among its connections.
  assert.equal(snapshot.roundTripBytes, 64_000);
  assert.equal(snapshot.mergeGapBytes, Math.floor(32_000 * 2 / snapshot.shapingConcurrency));
  // What the meter knows without timing anything stays, and what it measured is still reported.
  assert.equal(snapshot.concurrency, meter.concurrency);
  assert.equal(snapshot.deliveredBytes, 900);
  assert.equal(planned.responses, meter.responses, 'how long a stalled request is waited for follows the real link');
  // A local file is read ahead and priced at no less than a disk, held or not.
  const local = plannedLink(new LinkMeter(LOCAL_POLICY)).snapshot();
  assert.equal(local.readsAhead, true);
  assert.equal(local.bytesPerMs, LOCAL_POLICY.bytesPerMs);
  assert.equal(local.onThisMachine, true);

  // A faster held link is read ahead, as a measured one is.
  holdMachine({ link: { latencyMs: 1, bytesPerMs: 1e6 } });
  assert.equal(plannedLink(meter).readsAhead, true);
  // The view made while one link was held keeps it: a reader plans on the link it opened with.
  assert.equal(planned.latencyMs, 2);
});

test('a held link is planned on as held: what earlier visits and the page\'s downloads measured is not weighed', t => {
  releasing(t);
  const seed = { origin: 'http://127.0.0.1:4174', latencyMs: 400, bytesPerMs: 5, evidenceBytes: 1e9, downlinkBytesPerMs: 9, paceMs: 0, thisMachine: true };
  holdMachine(null);
  assert.equal(plannedHostLink(seed), seed);
  assert.equal(plannedHostLink(null), null);
  holdMachine({ link: { latencyMs: 2, bytesPerMs: 32_000 } });
  assert.deepEqual(plannedHostLink(seed), { origin: seed.origin, thisMachine: true });
  // A host on this machine is priced as this machine at rest on top of the held link, as in the app.
  const priced = pricingLink(plannedLink(new LinkMeter(REMOTE_POLICY)).snapshot(), plannedHostLink(seed));
  assert.equal(priced.latencyMs, 2);
  assert.equal(priced.loadedLatencyMs, 2);
  assert.equal(priced.bytesPerMs, LOCAL_POLICY.bytesPerMs);
  // A host elsewhere at the held link itself.
  const remote = pricingLink(plannedLink(new LinkMeter(REMOTE_POLICY)).snapshot(), plannedHostLink({ ...seed, thisMachine: false }));
  assert.equal(remote.bytesPerMs, 32_000);
  assert.equal(remote.latencyMs, 2);
});

test('the decoding rate, the opening cost, the index pass rates and the cores follow a hold', t => {
  releasing(t);
  holdMachine({ decodeBytesPerMs: 4321 });
  assert.equal(decodingRate(), 4321);

  // The opening cost: held, the page's own records are not made.
  resetShownCells();
  holdMachine({ shownCellMs: 0.5 });
  recordShownCells(1000, 9000);
  assert.equal(shownMsPerCell(), 0.5);
  holdMachine(null);
  assert.equal(shownMsPerCell(), null, 'nothing was recorded while it was held');

  // The index pass rates: a share keeping half the entries reads every stored row's only when its own pass is measured dearer.
  const rates = new PassRates();
  rates.noteIndex({ entries: 1000, ms: 1 });
  rates.placing('own').note(1000, 500);
  rates.placing('whole').note(1000, 1);
  assert.equal(rates.msPerEntry('placeOwn'), 0.5);
  assert.equal(wholeIsCheaper({ keptEntries: 500, allEntries: 1000, rates }), true, 'as measured: its own placement is dear');
  holdMachine({ indexPassMs: null });
  assert.equal(rates.msPerEntry('placeOwn'), null, 'held at none measured');
  assert.equal(wholeIsCheaper({ keptEntries: 500, allEntries: 1000, rates }), false, 'as a reader\'s first pass');
  holdMachine({ indexPassMs: { placeOwn: 0.5, placeWhole: 0.001, index: 0.001 } });
  assert.equal(rates.msPerEntry('placeOwn'), 0.5);
  assert.equal(rates.msPerEntry('view'), null, 'a rate the hold does not name is not measured');
  assert.equal(wholeIsCheaper({ keptEntries: 500, allEntries: 1000, rates }), true);

  // The cores: this realm's as held; a stand-in environment is a machine of its own.
  holdMachine({ cores: 4 });
  assert.equal(reportedCores(), 4);
  assert.equal(decodeWorkerCount(Infinity), 2);
  assert.equal(analysisWorkerCount(), 2);
  assert.equal(reportedCores({ navigator: { hardwareConcurrency: 16 } }), 16);
  assert.equal(decodeWorkerCount(Infinity, { navigator: { hardwareConcurrency: 16 } }), 14);
  assert.equal(reportedCores({ navigator: {} }), null);
});

/** Every source file of the app (no vendored code, no generated bundle). */
function sources(directory = path.join(ROOT, 'assets/js')) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') files.push(...sources(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('the measures are the app\'s: each is read in the sources, and none is pinned or read beside the seam', () => {
  const files = sources().map(file => ({ name: path.relative(ROOT, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }));
  const seam = 'assets/js/utils/machine.js';
  const read = new Set();
  for (const { name, text } of files) {
    if (name === seam) continue;
    for (const match of text.matchAll(/\b(?:measureOf|isHeld)\(\s*'([A-Za-z]+)'/g)) read.add(match[1]);
    if (/\breportedCores\(/.test(text)) read.add('cores');
    // A pin of its own would reach no worker, and the tests' device would not know of it.
    assert.doesNotMatch(text, /\bexport function (?:pin|hold)[A-Z]\w*(?:Rate|Ms|Cells|Link|Cores|Machine)\b/, `${name} holds a measure of its own`);
  }
  assert.deepEqual([...read].sort(), [...MACHINE_MEASURES].sort(), 'every measure has a reader, and every measure read is one');
  // The cores a pool is sized by are read through the seam. The benchmark
  // panel reports the browser's own figure to the person, and sizes nothing by it.
  const reporting = new Set(['assets/js/dev/benchmark.js']);
  for (const { name, text } of files) {
    if (name === seam || reporting.has(name)) continue;
    const code = text.split('\n').filter(line => !/^\s*(?:\*|\/\/|\/\*)/.test(line)).join('\n');
    assert.doesNotMatch(code, /\bhardwareConcurrency\b/, `${name} reads the cores beside the seam`);
  }
});

test('the tests\' machines hold measures only, and the specs\' device holds every one', t => {
  releasing(t);
  // The Node suite's machine at rest: valid holds, the link left to each file's own model.
  holdMachineAtRest();
  assert.deepEqual(heldMachine(), MACHINE_AT_REST);
  assert.equal(isHeld('link'), false);
  holdMachineAtRest({ link: LINK_AT_REST, decodeBytesPerMs: undefined });
  assert.equal(isHeld('link'), true);
  assert.equal(isHeld('decodeBytesPerMs'), false, 'a measure given as undefined is measured');
  holdMachineAtRest();

  // The browser specs' device: its defaults hold every measure, at values the seam takes.
  const held = machineOf(deviceOf());
  assert.deepEqual(Object.keys(held).sort(), [...MACHINE_MEASURES].sort());
  holdMachine(held);
  assert.equal(heldMachine().cores, DEVICE_DEFAULTS.hardwareConcurrency);
  assert.equal(heldMachine().shownCellMs, DEVICE_DEFAULTS.openingMsPerCell);
  assert.deepEqual(heldMachine().link, DEVICE_DEFAULTS.link);
  assert.deepEqual(DEVICE_DEFAULTS.link, LINK_AT_REST, 'one link at rest in both suites');
  // A spec whose subject is a measurement leaves it measured; one about a slow link gives its link.
  const measuring = machineOf(deviceOf({ link: 'measured', decodeBytesPerMs: 'measured', openingMsPerCell: 'measured' }));
  assert.deepEqual(Object.keys(measuring).sort(), ['cores', 'indexPassMs', 'keptReadBytesPerMs', 'orderMadeMs']);
  holdMachine(machineOf(deviceOf({ link: { latencyMs: 200, bytesPerMs: 100 } })));
  assert.deepEqual(heldMachine().link, { latencyMs: 200, bytesPerMs: 100 });
  assert.throws(() => deviceOf({ decodeRate: 5 }), /Unknown device input/);
});
