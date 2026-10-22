/**
 * Usage analytics, loaded only if the browser allows it.
 *
 * Privacy blockers refuse `analytics/tracker.js` (EasyPrivacy lists
 * `/analytics/tracker.js`, and uBlock Origin, Brave, AdGuard and iOS content
 * blockers ship that list). While the analytics modules were static imports, that one
 * refused request made the browser abandon the whole module graph, so the app
 * never started and the code-load watch reported a failed file. Analytics is
 * therefore loaded with a dynamic import: a refusal or any other load failure
 * leaves analytics off and the application unaffected. The blocked modules are
 * not renamed or proxied around the blocker; the user's choice stands.
 *
 * `analytics` is the one entry point application code uses. Its methods never
 * throw and never wait: calls made before the modules arrive are queued and
 * delivered once they do, or discarded if they never do, so startup does not
 * wait on analytics either.
 *
 * A dataset request is one {@link DataLoadHandle}. The code that receives the
 * user's request opens it (`openDataLoad`) and the dataset activation joins it
 * (`beginDataLoad` with the same load method), so the reported duration runs
 * from the click or file pick, and a request that fails before activation -
 * an unreadable file, an unreachable server - is still reported. A handle
 * settles once: the first `succeed`, `fail` or `cancel` wins.
 *
 * @module app/optional-analytics
 */

const QUEUE_LIMIT = 100;

/**
 * @typedef {Object} DataLoadHandle
 * @property {(result: {datasetId: string|null, metadata: Object|null,
 *   stateStatus: string, mapping: {origin: string, embeddingCandidates: number, enabledRepresentations: number}|null}) => void} succeed
 * @property {(error: unknown, context?: {datasetId?: string|null,
 *   metadata?: Object|null}) => void} fail
 * @property {() => void} cancel - superseded or abandoned: nothing is sent.
 */

/**
 * @param {() => Promise<{tracker: Object, performance: Object}>} loadModules
 */
export function createOptionalAnalytics(loadModules) {
  let state = 'idle';
  let modules = null;
  let loading = null;
  const queue = [];
  let openRequest = null;

  function invoke(call) {
    try {
      call(modules);
    } catch (error) {
      if (globalThis.window?.cellucidAnalyticsEnabled === true) {
        console.error('[Cellucid] Usage analytics failed; continuing without it.', error);
      } else if (typeof globalThis.reportError === 'function') {
        globalThis.reportError(error);
      } else {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  function run(call) {
    if (state === 'ready') invoke(call);
    else if (state !== 'absent' && queue.length < QUEUE_LIMIT) queue.push(call);
  }

  function createHandle(loadMethod, sourceType, startedAt, known = {}) {
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (openRequest !== null && openRequest.handle === handle) {
        openRequest = null;
      }
      return true;
    };
    const handle = Object.freeze({
      succeed({ datasetId, metadata, stateStatus, mapping }) {
        if (!settle()) return;
        const durationMs = performance.now() - startedAt;
        run(({ tracker }) => tracker.trackDataLoad({
          loadMethod,
          sourceType,
          outcome: 'success',
          durationMs,
          datasetId,
          metadata,
          stateStatus,
          mapping,
        }));
      },
      fail(error, {
        datasetId = known.datasetId ?? null,
        metadata = known.metadata ?? null
      } = {}) {
        if (!settle()) return;
        const durationMs = performance.now() - startedAt;
        run(({ tracker }) => tracker.trackDataLoad({
          loadMethod,
          sourceType,
          outcome: 'failure',
          durationMs,
          datasetId,
          metadata,
          error,
        }));
      },
      cancel() {
        settle();
      },
    });
    return handle;
  }

  return Object.freeze({
    /** Request the modules. Idempotent; resolves whether or not they load. */
    load() {
      if (loading !== null) return loading;
      state = 'loading';
      loading = loadModules().then(
        loaded => {
          modules = loaded;
          state = 'ready';
          for (const call of queue.splice(0)) invoke(call);
        },
        error => {
          state = 'absent';
          queue.length = 0;
          console.info(
            '[Cellucid] Usage analytics did not load (often a privacy blocker); continuing without it.',
            error
          );
        }
      );
      return loading;
    },

    /** Environment user properties and feature-adoption listeners. */
    init() {
      run(({ tracker }) => tracker.initAnalytics());
    },

    /** @param {{dataSourceManager: Object}} options */
    startPerformance({ dataSourceManager }) {
      run(({ performance: perf }) => perf.initPerformanceAnalytics({
        dataSourceManager,
      }));
    },

    /**
     * The user asked for a dataset; activation may follow.
     *
     * @param {string} loadMethod
     * @param {string} sourceType
     * @returns {DataLoadHandle}
     */
    openDataLoad(loadMethod, sourceType) {
      const handle = createHandle(loadMethod, sourceType, performance.now());
      openRequest = { loadMethod, handle };
      return handle;
    },

    /**
     * A dataset activation starts. It joins the open request of the same load
     * method, or starts a request of its own.
     *
     * @param {string} loadMethod
     * @param {string} sourceType
     * @param {{fromNavigation?: boolean, datasetId?: string|null,
     *   metadata?: Object|null}} [options] - a startup load is requested by
     *   the navigation itself, so it is timed from time origin. A dataset
     *   already known here describes a later failure that names none.
     * @returns {DataLoadHandle}
     */
    beginDataLoad(
      loadMethod,
      sourceType,
      { fromNavigation = false, datasetId = null, metadata = null } = {}
    ) {
      if (openRequest !== null && openRequest.loadMethod === loadMethod) {
        const { handle } = openRequest;
        openRequest = null;
        return handle;
      }
      return createHandle(
        loadMethod,
        sourceType,
        fromNavigation ? 0 : performance.now(),
        { datasetId, metadata }
      );
    },

    /** @param {{viewer: Object, hasDataset: boolean}} options */
    trackAppReady(options) {
      run(({ tracker }) => tracker.trackAppReady(options));
    },

    /** @param {{phase: string|null, error: unknown}} options */
    trackStartupFailure(options) {
      run(({ tracker }) => tracker.trackStartupFailure(options));
    },
  });
}

export const analytics = createOptionalAnalytics(async () => {
  const [tracker, performance] = await Promise.all([
    import('../analytics/tracker.js'),
    import('../analytics/performance.js'),
  ]);
  return { tracker, performance };
});
