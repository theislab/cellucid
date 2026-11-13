/**
 * The device a spec runs on, fixed: every input the page measures of the
 * device it runs on, and then acts on by itself, is a fixture input of the
 * `test` fixture (`helpers/test.mjs`, option `device`), the same on a
 * developer's Mac and on a loaded hosted runner with software GL.
 *
 * Why: the page measures the device and chooses on its own: level of detail
 * and frustum culling from the GPU's time for a frame of every cell
 * (`rendering/full-detail-frame-cost.js`, `render-controls.js`), a
 * progressive opening from what showing a cell cost its earlier openings
 * (`data/opening-cost.js`), worker pools from the cores the browser reports
 * (`formats/io/decode-pool.js`, `analysis/shared/performance-config.js`),
 * memory budgets from the memory it reports (`data/memory-budget.js`). On
 * hosted runners (software GL, 3 or 4 cores, loaded) those measurements come
 * out otherwise, and at other times, than on a developer's machine, so specs
 * about none of those choices would see the page change state under them, at
 * a time the runner decides: culling turned on by an opening and off again by
 * a publication that failed, a verdict reached before the spec watched, an
 * opening "at once" made progressive by the start sample's own record.
 *
 * The same holds for what the reader plans from, in its worker: which
 * cells genes are read for and in which order a share opens, from the
 * link's round trip and rate and from how fast chunks decode
 * (`data/anndata/subsample-plan.js` `geneSampleOf`); whether a kept gene
 * index is read or built again, from how fast kept copies were read; which
 * pass indexes a share, from what a pass's work cost. A loaded runner
 * measures each otherwise, and plans otherwise: a share raised with Apply
 * is read anew instead of shown in place when genes are read for only part
 * of its cells (`open-cells-in-place.spec.mjs`), where the same page at rest
 * reads them for every cell; `held-machine.spec.mjs` shows it in every
 * engine with the file's answers held back 370 ms
 * (measured: 38_decisions_testing_and_hosted_runners.md).
 *
 * The defaults are a fast device whose measures nothing moves:
 * - `gpu`: the GPU's time for every frame, given exactly through the GPU
 *   timer the page reads where a browser offers one
 *   (`EXT_disjoint_timer_query_webgl2`, simulated in every engine: its
 *   queries report the simulated time, available at the first read): 1 ms,
 *   so nothing is ever too slow. A spec about the automatic choice sets
 *   another (`{frameMs, perThousandCellsMs, culledMs}`, below), at start or
 *   later (`setSimulatedGpu`). A spec whose subject is the real GPU's time
 *   (a benchmark of draws) says `'real'`.
 * - `hardwareConcurrency`: the cores the page and every worker see (4, a
 *   hosted Linux runner's), so their pools have the same size everywhere:
 *   the page's `navigator` reports them, and the workers, whose own
 *   `navigator` an init script cannot reach, are handed them (the
 *   machine's `cores`, below).
 * - `deviceMemory`: the memory the page sees (8 GiB, what Chromium reports
 *   at most), only in an engine that reports any (Chromium). The reader
 *   worker's budgets are the page's (`data/memory-budget.js`
 *   `connectMemoryWorker`).
 * - The machine's measures (`assets/js/utils/machine.js`, the one place a
 *   measured rate enters a plan), held on the page and handed to every
 *   worker it starts, and to theirs (`holdMachine`). Each is a number, or
 *   `'measured'` in a spec whose subject is that measurement:
 *   - `link`: the link the reader plans on, `{latencyMs, bytesPerMs}`:
 *     a round trip of 2 ms and 32 MB/s, a host on a fast local network
 *     (below the rate a web host is read ahead at, `formats/io/link.js`
 *     `READ_AHEAD_BYTES_PER_MS`: the fixtures are read on demand, as a link
 *     opens). A host on this machine is priced as this machine at rest on
 *     top of it, as in the app (`data/host-link-memory.js`
 *     `thisMachinePricing`). The requests themselves are timed and shaped
 *     by the link as it really is, on any runner: how many requests carry a
 *     read is no part of what is held, and a spec asserts none of it. A
 *     spec about a slow link gives its link here
 *     (`{latencyMs: 200, bytesPerMs: 100}`) instead of delaying answers.
 *   - `decodeBytesPerMs`: how fast chunks decode, every decoder together:
 *     1 GB/s, which binds no plan.
 *   - `orderMadeMs`: how long making every cell's order takes: 0.
 *   - `keptReadBytesPerMs`: how fast kept gene indexes were read: null,
 *     none measured (a kept index is read, never priced against building it
 *     again).
 *   - `indexPassMs`: what a gene index pass's work cost an entry: null,
 *     none measured (each share's pass chosen as a reader's first).
 *   - `openingMsPerCell`: what showing a cell costs (the machine's
 *     `shownCellMs`): null (nothing measured: an opening is priced by its
 *     reads alone), or milliseconds a cell; the page's own records are not
 *     made.
 *
 * Measured on purpose, and why a slow runner is safe with each: developer
 * doc 14 (Testing, CI and release process: "Every rate the app measures,
 * and what a test does with it") lists every rate the app measures, with
 * what holds it or why nothing needs to.
 *
 * The holds reach a page that runs its sources (this machine); a page
 * opened as a deployed site (`DEPLOYED_BROWSER_TEST_HOST`) runs its bundle,
 * whose module instances an init script cannot name, and measures
 * everything: a spec opened there asserts nothing that follows from a plan.
 *
 * @module tests/browser/helpers/device
 */

/**
 * @typedef {{frameMs?: number, perThousandCellsMs?: number, culledMs?: number|null}} SimulatedGpu
 *   A frame's GPU time: `frameMs`, plus `perThousandCellsMs` for every
 *   thousand cells the live view drew; or `culledMs` while the viewer culls
 *   (a choice that is measured faster on any basis).
 */

/**
 * @typedef {{latencyMs: number, bytesPerMs: number}} HeldLink
 *
 * @typedef {{gpu?: SimulatedGpu|'real', openingMsPerCell?: number|null|'measured',
 *   hardwareConcurrency?: number, deviceMemory?: number,
 *   link?: HeldLink|'measured', decodeBytesPerMs?: number|'measured', orderMadeMs?: number|'measured',
 *   keptReadBytesPerMs?: number|null|'measured',
 *   indexPassMs?: {index?: number, view?: number, placeWhole?: number, placeOwn?: number}|null|'measured'}} Device
 */

export const DEVICE_DEFAULTS = Object.freeze({
  gpu: Object.freeze({ frameMs: 1, perThousandCellsMs: 0, culledMs: null }),
  openingMsPerCell: null,
  hardwareConcurrency: 4,
  deviceMemory: 8,
  link: Object.freeze({ latencyMs: 2, bytesPerMs: 32_000 }),
  decodeBytesPerMs: 1e6,
  orderMadeMs: 0,
  keptReadBytesPerMs: null,
  indexPassMs: null,
});

/**
 * The device's inputs held through the machine's measures
 * (`assets/js/utils/machine.js`), each under the measure's name.
 */
const MACHINE_MEASURE_OF = Object.freeze({
  link: 'link',
  decodeBytesPerMs: 'decodeBytesPerMs',
  orderMadeMs: 'orderMadeMs',
  keptReadBytesPerMs: 'keptReadBytesPerMs',
  indexPassMs: 'indexPassMs',
  openingMsPerCell: 'shownCellMs',
  hardwareConcurrency: 'cores',
});

/**
 * What a device holds of the machine (`holdMachine`'s argument): every
 * measure it does not leave `'measured'`.
 *
 * @param {Device} device - As `deviceOf` gives it
 * @returns {Object<string, unknown>}
 */
export function machineOf(device) {
  const held = {};
  for (const [input, measure] of Object.entries(MACHINE_MEASURE_OF)) {
    if (device[input] !== 'measured') held[measure] = device[input];
  }
  return held;
}

/**
 * The device a spec asked for, every input it left out at its default.
 *
 * @param {Device} [device]
 */
export function deviceOf(device = {}) {
  const known = new Set(Object.keys(DEVICE_DEFAULTS));
  for (const key of Object.keys(device)) {
    if (!known.has(key)) throw new TypeError(`Unknown device input "${key}".`);
  }
  const gpu = device.gpu === 'real' ? 'real' : simulatedGpuOf(device.gpu ?? {});
  return Object.freeze({ ...DEVICE_DEFAULTS, ...device, gpu });
}

function simulatedGpuOf(gpu) {
  if (gpu === null || typeof gpu !== 'object') throw new TypeError('A simulated GPU is an object, or "real".');
  const exact = { ...DEVICE_DEFAULTS.gpu, ...gpu };
  for (const key of ['frameMs', 'perThousandCellsMs']) {
    if (!(Number.isFinite(exact[key]) && exact[key] >= 0)) throw new RangeError(`${key} is a finite number of milliseconds.`);
  }
  if (exact.culledMs !== null && !(Number.isFinite(exact.culledMs) && exact.culledMs >= 0)) {
    throw new RangeError('culledMs is a finite number of milliseconds, or null.');
  }
  return Object.freeze(exact);
}

/**
 * Fix the device for every page `context` opens from now on.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {Device} [device]
 */
export async function installDevice(context, device) {
  if (fixedContexts.has(context)) return;
  fixedContexts.add(context);
  const exact = deviceOf(device);
  await context.addInitScript(fixDevice, { ...exact, machine: machineOf(exact) });
}

/** Contexts whose device is fixed already (once each: the init script patches prototypes). */
const fixedContexts = new WeakSet();

/**
 * Change the simulated GPU of a page already open (a GPU that turns slow
 * later): frames measured from now on take its time.
 *
 * @param {import('@playwright/test').Page} page
 * @param {SimulatedGpu} gpu
 */
export async function setSimulatedGpu(page, gpu) {
  const exact = simulatedGpuOf(gpu);
  await page.evaluate(next => {
    if (window.__cellucidSimulatedGpu === undefined) throw new Error('This page runs on the real GPU (device: {gpu: "real"}).');
    window.__cellucidSimulatedGpu = next;
  }, exact);
}

/** The init script: runs in every document before any of its scripts. */
function fixDevice({ gpu, hardwareConcurrency, deviceMemory, machine }) {
  Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => hardwareConcurrency });
  if ('deviceMemory' in Navigator.prototype) {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => deviceMemory });
  }

  if (gpu !== 'real' && typeof WebGL2RenderingContext !== 'undefined') {
    window.__cellucidSimulatedGpu = gpu;
    const NAME = 'EXT_disjoint_timer_query_webgl2';
    const TIME_ELAPSED_EXT = 0x88bf;
    const GPU_DISJOINT_EXT = 0x8fbb;
    const QUERY_COUNTER_BITS_EXT = 0x8864;
    const extension = Object.freeze({
      TIME_ELAPSED_EXT,
      TIMESTAMP_EXT: 0x8e28,
      GPU_DISJOINT_EXT,
      QUERY_COUNTER_BITS_EXT,
      queryCounterEXT() {
        throw new Error('The simulated GPU timer times frames (TIME_ELAPSED_EXT), not timestamps.');
      },
    });
    const prototype = WebGL2RenderingContext.prototype;
    const real = {
      getExtension: prototype.getExtension,
      getSupportedExtensions: prototype.getSupportedExtensions,
      beginQuery: prototype.beginQuery,
      endQuery: prototype.endQuery,
      getQuery: prototype.getQuery,
      getQueryParameter: prototype.getQueryParameter,
      getParameter: prototype.getParameter,
    };
    // A query's simulated nanoseconds, once ended; the query open per context.
    const elapsed = new WeakMap();
    const open = new WeakMap();
    // What the viewer drew: the live view's cells, and whether it culls.
    const frameMs = () => {
      const simulated = window.__cellucidSimulatedGpu;
      const viewer = window._cellucidViewer;
      if (simulated.culledMs !== null && viewer?.debugRendererStatus?.().useFrustumCulling === true) return simulated.culledMs;
      const drawn = simulated.perThousandCellsMs > 0 && viewer?.hasRendererStats?.('live')
        ? viewer.getRendererStats('live').visiblePoints
        : 0;
      return simulated.frameMs + simulated.perThousandCellsMs * drawn / 1000;
    };
    prototype.getExtension = function (name) {
      if (String(name).toLowerCase() === NAME.toLowerCase()) return this.isContextLost() ? null : extension;
      return real.getExtension.call(this, name);
    };
    prototype.getSupportedExtensions = function () {
      const list = real.getSupportedExtensions.call(this);
      return list === null ? null : [...new Set([...list, NAME])];
    };
    prototype.beginQuery = function (target, query) {
      if (target !== TIME_ELAPSED_EXT) return real.beginQuery.call(this, target, query);
      elapsed.delete(query);
      open.set(this, query);
    };
    prototype.endQuery = function (target) {
      if (target !== TIME_ELAPSED_EXT) return real.endQuery.call(this, target);
      const query = open.get(this);
      open.delete(this);
      if (query !== undefined) elapsed.set(query, Math.round(frameMs() * 1e6));
    };
    prototype.getQuery = function (target, pname) {
      if (target !== TIME_ELAPSED_EXT) return real.getQuery.call(this, target, pname);
      if (pname === QUERY_COUNTER_BITS_EXT) return 64;
      return open.get(this) ?? null;
    };
    prototype.getQueryParameter = function (query, pname) {
      if (elapsed.has(query)) {
        if (pname === this.QUERY_RESULT_AVAILABLE) return true;
        if (pname === this.QUERY_RESULT) return elapsed.get(query);
      }
      return real.getQueryParameter.call(this, query, pname);
    };
    prototype.getParameter = function (pname) {
      return pname === GPU_DISJOINT_EXT ? false : real.getParameter.call(this, pname);
    };
  }

  // The machine's measures, held in the page's own module
  // (`assets/js/utils/machine.js`), which hands them to every worker the
  // page starts: once the page's import map is parsed (an import before it
  // would load another instance), before the page's entry is imported (at
  // DOMContentLoaded, CELLUCID_PAGE_BOOT in index.html), and only where the
  // page runs its sources through that map (this machine; the page bundle
  // runs anywhere else, and any other document loads nothing of it).
  const sources = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (sources) {
    const hold = () => {
      const map = document.querySelector('script[type="importmap"]');
      if (map === null || !map.textContent.includes('"./assets/js/utils/machine.js"')) return;
      window.__cellucidMachineHeld = import(new URL('./assets/js/utils/machine.js', document.baseURI).href)
        .then(module => {
          module.holdMachine(machine);
          return module.heldMachine();
        });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('readystatechange', hold, { once: true });
    } else {
      hold();
    }
  }
}
