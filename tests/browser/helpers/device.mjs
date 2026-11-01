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
 * hosted runners (software GL, 3 or 4 cores, loaded) those measurements came
 * out otherwise, and at other times, than on a developer's machine, so specs
 * about none of those choices saw the page change state under them, at a
 * time the runner decided (five CI rounds, Web contracts runs 41213981681
 * to 41307458156): culling turned on by an opening and off again by a
 * publication that failed, a verdict reached before the spec watched, an
 * opening "at once" made progressive by the start sample's own record.
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
 * - `openingMsPerCell`: what showing a cell costs, held
 *   (`holdShownCells`): null (nothing measured: an opening is priced by its
 *   reads alone), or milliseconds a cell; the page's own records leave it as
 *   it is. A spec about the record itself says `'measured'`.
 * - `hardwareConcurrency`: the cores the page sees (4, a hosted Linux
 *   runner's), so its pools have the same size everywhere. Workers read
 *   their own `navigator`, which an init script cannot reach: a pool a
 *   worker sizes (the reader worker's decode pool) still follows the
 *   machine; its results do not depend on its size.
 * - `deviceMemory`: the memory the page sees (8 GiB, what Chromium reports
 *   at most), only in an engine that reports any (Chromium).
 *
 * The link's speed and the decoding rate are measured too
 * (`formats/io/link.js`, `formats/io/decode-pool.js`) and left so: every
 * fixture is served from this machine, and its first views are far inside
 * the opening target on any runner.
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
 * @typedef {{gpu?: SimulatedGpu|'real', openingMsPerCell?: number|null|'measured',
 *   hardwareConcurrency?: number, deviceMemory?: number}} Device
 */

export const DEVICE_DEFAULTS = Object.freeze({
  gpu: Object.freeze({ frameMs: 1, perThousandCellsMs: 0, culledMs: null }),
  openingMsPerCell: null,
  hardwareConcurrency: 4,
  deviceMemory: 8,
});

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
  await context.addInitScript(fixDevice, deviceOf(device));
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
function fixDevice({ gpu, openingMsPerCell, hardwareConcurrency, deviceMemory }) {
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

  // The opening cost, held in the page's own module: once the page's import
  // map is parsed (an import before it would load another instance), before
  // the page's entry is imported (at DOMContentLoaded, CELLUCID_PAGE_BOOT in
  // index.html), and only where the page runs its sources through that map
  // (this machine; the page bundle runs anywhere else, and any other
  // document loads nothing of it).
  const sources = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (openingMsPerCell !== 'measured' && sources) {
    const hold = () => {
      const map = document.querySelector('script[type="importmap"]');
      if (map === null || !map.textContent.includes('"./assets/js/data/opening-cost.js"')) return;
      import(new URL('./assets/js/data/opening-cost.js', document.baseURI).href)
        .then(module => module.holdShownCells(openingMsPerCell));
    };
    if (document.readyState === 'loading') {
      document.addEventListener('readystatechange', hold, { once: true });
    } else {
      hold();
    }
  }
}
