/**
 * A day of use leaves nothing behind.
 *
 * A researcher keeps one tab open all day: opens one dataset after another,
 * colors by genes and fields, keeps views and clears them, opens every
 * analysis in its own window, runs some and closes them all, floats and docks
 * a panel, highlights and clears, exports a figure, plays a camera path,
 * looks at the smoke cloud and the neighbor graph, reads a subsample and
 * every cell again, talks to the agent and starts a new chat, undoes and
 * redoes. Everything one round of that makes must be given back by its
 * owner's teardown (`assets/js/ARCHITECTURE.md`, "Rules that hold
 * everywhere"): so once the page has warmed up, a round on a dataset ends
 * holding exactly what the round before it on that dataset ended with.
 *
 * What is counted, after a forced garbage collection and with every
 * notification dismissed and every idle worker retired
 * (`workers/idle-retirement.js`):
 * - every listener the app's code added and has not removed, by the target's
 *   kind (a detached element is its own kind), the event and the line of
 *   `assets/js` that added it;
 * - every live `AbortController`, by the line that made it and whether it
 *   aborted;
 * - every interval timer not cleared;
 * - the page's workers, by script: only the open dataset's reader once the
 *   pools' idle workers have ended;
 * - the live WebGL objects (buffers, textures, framebuffers, renderbuffers,
 *   programs, shaders, vertex arrays, contexts), canvases and Resize/Mutation
 *   observers (`Runtime.queryObjects`);
 * - the listeners on `window` and `document`, by event (DevTools' own view).
 *
 * A difference names what grew and where it was made: the first thing to
 * read when a lifecycle regresses.
 *
 * Fixtures: the demo catalog's `synthetic-cell-types-2d` and
 * `synthetic-development-3d` (`fixtures/demo-catalog/`), opened in turn.
 */
import { expect, test } from './helpers/test.mjs';
import { encodedAppUrl } from './helpers/origins.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { waitForPageAtRest, whenActionsDone } from './helpers/dataset-ready.mjs';
import { installScriptedModel, openChat, queueReplies, say } from './helpers/agent-chat.mjs';

const START_URL =
  `/?sampleCatalog=${encodedAppUrl('/tests/browser/fixtures/demo-catalog/')}`
  + '&dataset=synthetic-cell-types-2d&acceptance=day-of-use-lifecycle';
const DATASETS = Object.freeze(['synthetic-development-3d', 'synthetic-cell-types-2d']);
const ANALYSES = Object.freeze(['markers', 'differential', 'dotplot', 'signature', 'composition', 'quick', 'detailed', 'correlation']);
// Rounds 1 to 3 warm the page (each dataset's first and second visit, the
// notification log filling): rounds 4 and 6 open the same dataset.
const ROUNDS = 6;
const COMPARED = Object.freeze([4, 6]);
// Fences and timer queries (`WebGLSync`, `WebGLQuery`) are not counted: one
// is in flight or not at a given moment as the GPU answers it (a
// fence can be present after one round and not the round before, nothing else
// differing); what makes them owns them to their answer.
const OBJECT_KINDS = Object.freeze([
  'WebGLBuffer', 'WebGLTexture', 'WebGLFramebuffer', 'WebGLRenderbuffer', 'WebGLProgram', 'WebGLShader',
  'WebGLVertexArrayObject', 'WebGL2RenderingContext', 'HTMLCanvasElement',
  'ResizeObserver', 'MutationObserver',
]);

/**
 * Counts, in the page before its modules run, what the app's code registers
 * and has not released: listeners (by target kind, event, capture and the
 * `assets/js` line that added them), `AbortController`s (by the line that
 * made them) and intervals. Targets and controllers are held weakly, so the
 * count never keeps anything alive.
 */
function installLifecycleCensus() {
  const appLine = () => {
    const frame = (new Error().stack ?? '').split('\n').find(line => line.includes('/assets/js/'));
    if (frame === undefined) return 'outside the app';
    const match = /\/assets\/js\/([^?:)\s]+)[^:)\s]*:(\d+)/.exec(frame);
    return match === null ? frame.trim() : `${match[1]}:${match[2]}`;
  };
  const listeners = new WeakMap();
  const targets = new Set();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const keyOf = (type, options) => `${type}${(typeof options === 'boolean' ? options : options?.capture === true) ? ' (capture)' : ''}`;
  EventTarget.prototype.addEventListener = function addCounted(type, listener, options) {
    const once = typeof options === 'object' && options !== null && options.once === true;
    const signal = typeof options === 'object' && options !== null ? options.signal ?? null : null;
    if (listener !== null && listener !== undefined && !once && signal?.aborted !== true) {
      let byKey = listeners.get(this);
      if (byKey === undefined) {
        byKey = new Map();
        listeners.set(this, byKey);
        targets.add(new WeakRef(this));
      }
      const key = keyOf(type, options);
      let byListener = byKey.get(key);
      if (byListener === undefined) byKey.set(key, byListener = new Map());
      if (!byListener.has(listener)) {
        byListener.set(listener, appLine());
        if (signal !== null) add.call(signal, 'abort', () => byListener.delete(listener), { once: true });
      }
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeCounted(type, listener, options) {
    listeners.get(this)?.get(keyOf(type, options))?.delete(listener);
    return remove.call(this, type, listener, options);
  };
  const controllers = new Set();
  const NativeAbortController = window.AbortController;
  window.AbortController = class AbortController extends NativeAbortController {
    constructor() {
      super();
      controllers.add({ ref: new WeakRef(this), line: appLine() });
    }
  };
  // Observers by the line that made them, watching (observe() called, not
  // disconnected) or idle: a leak names its own source, not only a count.
  const observers = new Set();
  for (const name of ['MutationObserver', 'ResizeObserver']) {
    const Native = window[name];
    window[name] = class extends Native {
      constructor(callback) {
        super(callback);
        this.__census = { ref: new WeakRef(this), line: appLine(), kind: name, watching: false };
        observers.add(this.__census);
      }
      observe(...args) {
        this.__census.watching = true;
        return super.observe(...args);
      }
      disconnect() {
        this.__census.watching = false;
        return super.disconnect();
      }
    };
  }
  const intervals = new Set();
  const setInterval = window.setInterval;
  const clearInterval = window.clearInterval;
  window.setInterval = function countedSetInterval(...args) {
    const id = setInterval.apply(this, args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = function countedClearInterval(id) {
    intervals.delete(id);
    return clearInterval.call(this, id);
  };
  window.__lifecycleCensus = () => {
    const kindOf = target => {
      if (target === window) return 'window';
      if (target === document) return 'document';
      const name = target.constructor?.name ?? 'EventTarget';
      return target instanceof Node && !target.isConnected ? `${name} (detached)` : name;
    };
    const held = {};
    for (const ref of targets) {
      const target = ref.deref();
      if (target === undefined) {
        targets.delete(ref);
        continue;
      }
      for (const [key, byListener] of listeners.get(target)) {
        for (const line of byListener.values()) {
          const name = `${kindOf(target)} ${key} ${line}`;
          held[name] = (held[name] ?? 0) + 1;
        }
      }
    }
    const made = {};
    for (const entry of controllers) {
      const controller = entry.ref.deref();
      if (controller === undefined) {
        controllers.delete(entry);
        continue;
      }
      const name = `${controller.signal.aborted ? 'aborted' : 'open'} ${entry.line}`;
      made[name] = (made[name] ?? 0) + 1;
    }
    const watching = {};
    for (const entry of observers) {
      if (entry.ref.deref() === undefined) {
        observers.delete(entry);
        continue;
      }
      const name = `${entry.kind} ${entry.watching ? 'watching' : 'idle'} ${entry.line}`;
      watching[name] = (watching[name] ?? 0) + 1;
    }
    return { listeners: held, controllers: made, observers: watching, intervals: intervals.size };
  };
}

async function dispatch(page, type, params) {
  const result = await page.evaluate(async ([actionType, actionParams]) => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    try {
      return { outcome: (await getActions().dispatch(actionType, actionParams)).outcome };
    } catch (error) {
      return { error: error.message };
    }
  }, [type, params]);
  expect(result.error, `${type} ${JSON.stringify(params)}`).toBeUndefined();
  return result.outcome;
}

/** The fields one round colors by: the first category, a continuous field and the first gene. */
function roundFields(page) {
  return page.evaluate(() => {
    const state = window._cellucidState;
    const category = state.obsData.fields.find(field => field.kind === 'category');
    const continuous = state.obsData.fields.find(field => field.kind === 'continuous');
    return {
      category: category.key,
      firstCategory: category.categories[0],
      continuous: continuous.key,
      gene: state.varData.fields[0].key,
    };
  });
}

async function playRound(page, round) {
  await dispatch(page, 'dataset.open', { name: DATASETS[round % 2] });
  await waitForPageAtRest(page);
  const fields = await roundFields(page);

  await dispatch(page, 'color.by', { field: { source: 'var', key: fields.gene } });
  await dispatch(page, 'color.by', { field: { source: 'obs', key: fields.continuous } });
  await dispatch(page, 'filter.continuous.range', { field: { source: 'obs', key: fields.continuous }, min: 0, max: 0.5 });
  await dispatch(page, 'filter.continuous.reset', { field: { source: 'obs', key: fields.continuous } });
  await dispatch(page, 'color.by', { field: { source: 'obs', key: fields.category } });

  await dispatch(page, 'view.keep', {});
  await dispatch(page, 'view.keep', {});
  await waitForPageAtRest(page);
  await dispatch(page, 'view.clear', {});

  for (const analysis of ANALYSES) await dispatch(page, 'analysis.open', { analysis, window: true });
  await dispatch(page, 'analysis.markers.set', { options: { groupBy: fields.category } });
  await dispatch(page, 'analysis.run', { analysis: 'markers' });
  await dispatch(page, 'analysis.run', { analysis: 'composition' });
  for (let open = ANALYSES.length; open > 0; open -= 1) await dispatch(page, 'analysis.window.close', { window: 1 });

  await dispatch(page, 'layout.panel.float', { panel: 'Navigation', left: 400, top: 120, width: 320, height: 300 });
  await dispatch(page, 'layout.panel.dock', { panel: 'Navigation' });

  await dispatch(page, 'highlight.category', { field: { source: 'obs', key: fields.category }, categories: [fields.firstCategory], page: 'Page 1' });
  await dispatch(page, 'highlight.clear-all', {});

  await dispatch(page, 'figure.export', {});

  const framing = await dispatch(page, 'camera.framing', { field: { source: 'obs', key: fields.category }, fill: 0.8 });
  await dispatch(page, 'camera-path.keyframe.add', { label: 'Wide', camera: framing.whole.camera });
  await dispatch(page, 'camera-path.keyframe.add', { label: framing.groups[0].label, camera: framing.groups[0].camera });
  await dispatch(page, 'camera-path.duration.set', { seconds: 1 });
  await dispatch(page, 'camera-path.play', {});
  await dispatch(page, 'camera-path.clear', {});

  await dispatch(page, 'setting.set', { setting: 'render-mode', value: 'smoke' });
  // The cloud is built and drawn before it is left.
  await expect.poll(() => page.evaluate(() => window._cellucidViewer.getFrameScheduleState().lastCause)).toBe('smoke');
  await dispatch(page, 'setting.set', { setting: 'render-mode', value: 'points' });
  await dispatch(page, 'setting.set', { setting: 'toggle-connectivity', value: true });
  await waitForPageAtRest(page);
  await dispatch(page, 'setting.set', { setting: 'toggle-connectivity', value: false });

  await dispatch(page, 'cells.open', { mode: 'subsample', fraction: 0.5 });
  await waitForPageAtRest(page);
  await dispatch(page, 'cells.open', { mode: 'all' });
  await waitForPageAtRest(page);

  for (const field of [fields.continuous, fields.category]) {
    await queueReplies(page, [{ text: 'Coloring.', calls: [{ name: 'color_by', args: { field: { source: 'obs', key: field } } }] }, { text: 'Done.' }]);
    await say(page, `Color by ${field}`);
  }
  await page.locator('#agent-chat-new').click();
  await expect(page.locator('#agent-chat-log .agent-msg-user')).toHaveCount(0);

  for (let step = 0; step < 3; step += 1) await dispatch(page, 'history.undo', {});
  for (let step = 0; step < 3; step += 1) await dispatch(page, 'history.redo', {});
  await whenActionsDone(page);
  await waitForPageAtRest(page);
}

async function census(page, cdp) {
  // Notifications and idle workers go by their own clocks; both are ended
  // here so that only what an owner kept is counted.
  await page.evaluate(async () => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    getNotificationCenter().dismissAll();
    const { retireIdleWorkers } = await import('/assets/js/workers/idle-retirement.js');
    retireIdleWorkers();
  });
  await expect.poll(() => page.evaluate(async () => {
    const { getNotificationCenter } = await import('/assets/js/app/notification-center.js');
    return getNotificationCenter().notifications.size;
  })).toBe(0);
  // Every pool's idle workers end (`terminate`, told to the page by each
  // worker's close); the open dataset's reader stays.
  const workerScripts = () => page.workers().map(worker => new URL(worker.url()).pathname.split('/').pop()).sort();
  await expect.poll(workerScripts).toEqual(['anndata-reader-worker.js']);
  const workers = workerScripts();
  await cdp.send('HeapProfiler.collectGarbage');
  const objects = {};
  for (const kind of OBJECT_KINDS) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `${kind}.prototype`, objectGroup: 'census' });
    const { objects: found } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId, objectGroup: 'census' });
    const { result: count } = await cdp.send('Runtime.callFunctionOn', {
      objectId: found.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true, objectGroup: 'census',
    });
    objects[kind] = count.value;
  }
  const globalListeners = {};
  for (const [name, expression] of [['window', 'window'], ['document', 'document']]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression, objectGroup: 'census' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const { type } of listeners) globalListeners[`${name} ${type}`] = (globalListeners[`${name} ${type}`] ?? 0) + 1;
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'census' });
  const held = await page.evaluate(() => window.__lifecycleCensus());
  return { ...held, workers, objects, globalListeners };
}

/** What differs between two censuses, one line each: `what: before -> after`. */
function differences(before, after) {
  const lines = [];
  for (const part of ['listeners', 'controllers', 'observers', 'objects', 'globalListeners']) {
    for (const name of new Set([...Object.keys(before[part]), ...Object.keys(after[part])])) {
      const a = before[part][name] ?? 0;
      const b = after[part][name] ?? 0;
      if (a !== b) lines.push(`${part} ${name}: ${a} -> ${b}`);
    }
  }
  if (before.intervals !== after.intervals) lines.push(`intervals: ${before.intervals} -> ${after.intervals}`);
  if (JSON.stringify(before.workers) !== JSON.stringify(after.workers)) {
    lines.push(`workers: ${before.workers.join(', ')} -> ${after.workers.join(', ')}`);
  }
  return lines;
}

test('a day of use leaves nothing behind: the same round twice ends holding exactly the same', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Live objects and forced garbage collection are read through the Chrome DevTools Protocol');
  test.setTimeout(600_000);
  const errors = [];
  page.on('pageerror', error => errors.push(`page: ${error.stack || error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(installLifecycleCensus);
  await page.addInitScript(installScriptedModel);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await waitForPageAtRest(page);
  // The smallest smoke cloud: the round looks at it, not at its detail.
  await dispatch(page, 'setting.set', { setting: 'smoke-grid', value: 0 });
  await openChat(page);
  const cdp = await page.context().newCDPSession(page);

  const counted = new Map();
  for (let round = 1; round <= ROUNDS; round += 1) {
    await playRound(page, round);
    if (COMPARED.includes(round)) counted.set(round, await census(page, cdp));
  }
  const [first, second] = COMPARED.map(round => counted.get(round));
  expect(differences(first, second), 'what one more round of the same use left behind').toEqual([]);
  // The count is of something: the live view's stores and the app's own
  // listeners.
  expect(first.objects.WebGLBuffer).toBeGreaterThan(0);
  expect(Object.keys(first.listeners).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
