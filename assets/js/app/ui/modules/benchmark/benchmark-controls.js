/**
 * @fileoverview The Benchmark panel and Analyze performance: the live
 * statistics while the panel is open (frames, draw time, level of detail,
 * GPU memory), a synthetic dataset generated off the main thread and
 * published as a dataset change like any other (it asks before unkept work
 * is replaced, supersedes the change in flight, and is superseded by the
 * next), the situation report, and the bottleneck analysis.
 *
 * It owns the panel's controls, their listeners and its lazily loaded code
 * (the live runtime, the configuration-matrix harness published as
 * `window._cellucidBenchmarkHarness`, `dev/benchmark.js`). The publication it
 * commits through is `app/dataset/`'s; the renderer controls it reads are
 * `render-controls.js`'s. It is larger than the other modules of this folder
 * because the panel, its synthetic dataset change and its report share one
 * set of controls and loaders; the bottleneck analysis is the one part that
 * could stand alone.
 *
 * @module app/ui/modules/benchmark/benchmark-controls
 */


import { pointSpriteCap } from '../../../../rendering/point-sprite.js';
import { createInMemoryDimensionManager } from '../../../../data/dimension-manager.js';
import { isCancellation } from '../../../../utils/abort.js';
import { debug } from '../../../../utils/debug.js';
import { failureDetails, joinFailure, sayFailure } from '../../../../utils/errors.js';
import { countNoun, formatDuration, formatCompactCount as formatNumber } from '../../../../utils/format-units.js';
import { loadAppCode } from '../../../app-code.js';
import { settlePublishedDatasetUi } from '../../../dataset-reload-outcome.js';
import { copyText } from '../../../utils/clipboard.js';
import { PLACES } from '../../place-names.js';
import { syntheticRepresentations } from './representations.js';


const BENCHMARK_GPU_ESTIMATE_BYTES_PER_POINT = 28;
const MEBIBYTE = 1024 * 1024;

function estimateBenchmarkGpuMemoryMB(pointCount) {
  return Number.isSafeInteger(pointCount) && pointCount >= 0
    ? (
      pointCount *
      BENCHMARK_GPU_ESTIMATE_BYTES_PER_POINT /
      MEBIBYTE
    )
    : null;
}

function formatBenchmarkGpuMemory(rendererStats, pointCount) {
  const exactGpuMemoryMB = rendererStats?.gpuMemoryMB;
  if (
    Number.isFinite(exactGpuMemoryMB) &&
    exactGpuMemoryMB >= 0
  ) {
    return `${exactGpuMemoryMB.toFixed(1)} MB`;
  }
  const estimatedGpuMemoryMB =
    estimateBenchmarkGpuMemoryMB(pointCount);
  return estimatedGpuMemoryMB === null
    ? 'Unavailable'
    : `~${estimatedGpuMemoryMB.toFixed(1)} MB (estimate)`;
}

/**
 * Wire the Benchmark panel and Analyze performance, at the end of start-up
 * (their controls are admitted afterwards, `deferred-control-readiness.js`).
 *
 * @param {{
 *   state: Object, viewer: Object, canvas: HTMLCanvasElement, renderModeSelect: HTMLElement|null,
 *   notifications: Object, ui: Object, datasetReloadCoordinator: Object,
 *   confirmDatasetReplacement: (transaction: Object, change: Object) => Promise<void>,
 *   cancelPublishedDatasetStateAndWait: () => Promise<void>,
 *   isApplicationRetired: () => boolean, getDimensionManager: () => Object,
 *   getActiveStage: () => Object|null, getActivePublication: () => Object|null,
 *   getComparisonModule: () => Object|null,
 *   runtimeRetirementOwner: Object, retireReplacedDimensionManager: (publication: Object) => void,
 *   connectivityRuntimeOwner: Object,
 *   commitSyntheticRuntimeStage: (stage: Object, options?: Object) => Object,
 *   restorePreviousRuntime: (stage: Object|null, publication: Object, options?: Object) => void,
 *   assertCurrentDatasetPublication: (publication: Object) => void,
 *   applicationSignal: AbortSignal,
 * }} options - The getters read what the publication and the start-up assign later;
 *   `applicationSignal` ends the controls' listeners with the application.
 * @returns {Readonly<{stopPerfMonitoring: () => void}>} Stops the live statistics (the teardown runs it).
 */
export function initBenchmarkControls({
  state,
  viewer,
  canvas,
  renderModeSelect,
  notifications,
  ui,
  datasetReloadCoordinator,
  confirmDatasetReplacement,
  cancelPublishedDatasetStateAndWait,
  isApplicationRetired,
  getDimensionManager,
  getActiveStage,
  getActivePublication,
  getComparisonModule,
  runtimeRetirementOwner,
  retireReplacedDimensionManager,
  connectivityRuntimeOwner,
  commitSyntheticRuntimeStage,
  restorePreviousRuntime,
  assertCurrentDatasetPublication,
  applicationSignal
}) {
  // benchmarkReporter will be created lazily when benchmark report is requested
  let benchmarkReporter = null;

  const benchmarkRunBtn = document.getElementById('benchmark-run');
  const benchmarkCountInput = document.getElementById('benchmark-count');
  const benchmarkPatternSelect = document.getElementById('benchmark-pattern');
  const benchmarkRepresentationsSelect = document.getElementById('benchmark-representations');
  const benchmarkStatsEl = document.getElementById('benchmark-stats');
  const benchPresets = document.querySelectorAll('.benchmark-preset');
  const benchmarkReportBtn = document.getElementById('benchmark-report-btn');
  const benchmarkReportOutput = document.getElementById('benchmark-report-output');
  const benchmarkSection = document.getElementById('benchmark-section');
  const benchPointsEl = document.getElementById('bench-points');
  const benchFpsEl = document.getElementById('bench-fps');
  const benchFrametimeEl = document.getElementById('bench-frametime');
  const benchRendertimeEl = document.getElementById('bench-rendertime');
  const benchMemoryEl = document.getElementById('bench-memory');
  const benchLodEl = document.getElementById('bench-lod');
  const benchVisibleEl = document.getElementById('bench-visible');
  const benchTimingDetailsEl = document.getElementById('bench-timing-details');
  const benchMinFtEl = document.getElementById('bench-min-ft');
  const benchP95FtEl = document.getElementById('bench-p95-ft');
  const benchMaxFtEl = document.getElementById('bench-max-ft');
  const benchGenInfoEl = document.getElementById('bench-gen-info');
  const benchGenTimeEl = document.getElementById('bench-gen-time');

  // The renderer controls themselves belong to `ui/modules/render-controls`,
  // which `initUI` builds before a saved session is restored. The benchmark
  // report only observes them, so it reads them and never publishes them.
  const hpShaderQuality = document.getElementById('hp-shader-quality');
  const hpFrustumCulling = document.getElementById('hp-frustum-culling');
  const hpLodEnabled = document.getElementById('hp-lod-enabled');

  // FPS monitoring and synthetic generation form the small live runtime.
  // The configuration-matrix harness publishes independently, while the
  // report and bottleneck analyzer remain a third, explicitly requested
  // developer-support graph.
  let perfTracker = null;
  // Off-thread synthetic generation and its point-count rule are captured
  // from their focused modules so the panel keeps a small lazy boundary.
  let generateSyntheticDataOffThread = null;
  let assertSyntheticCount = null;
  let benchmarkHarnessModule = null;
  let benchmarkHarnessModuleLoadTask = null;
  let benchmarkModuleLoaded = false;
  let benchmarkModuleLoadTask = null;
  let benchmarkSupportModule = null;
  let benchmarkSupportModuleLoadTask = null;

  function ensureBenchmarkHarnessModule() {
    if (benchmarkHarnessModule !== null) {
      return Promise.resolve(benchmarkHarnessModule);
    }
    if (benchmarkHarnessModuleLoadTask !== null) {
      return benchmarkHarnessModuleLoadTask;
    }

    const loadTask = loadAppCode(() => import('./index.js')).then(
      harnessModule => {
        if (isApplicationRetired()) return null;
        // The configuration-matrix harness is the only thing that can sweep
        // LOD, culling and view count with per-frame upload counters. The
        // page is served under `script-src 'self'` with a single hashed
        // inline block, so an inline bootstrap is blocked and a console
        // `import()` of a relative path has no base to resolve against.
        // Publishing the loaded module namespace next to _cellucidViewer /
        // _cellucidState is what makes `createBenchmarkHarness({ viewer,
        // canvas })` reachable. Nothing in the module runs on import; the
        // harness instruments the GL context only when it is explicitly
        // created.
        window._cellucidBenchmarkHarness = harnessModule;
        benchmarkHarnessModule = harnessModule;
        return harnessModule;
      },
      error => {
        // A load the page's leaving cut off (`loadAppCode`) is no failure.
        if (!isCancellation(error)) console.error('[Main] Failed to load benchmark harness:', error);
        return null;
      }
    );
    benchmarkHarnessModuleLoadTask = loadTask;
    void loadTask.then(harnessModule => {
      if (
        harnessModule === null &&
        benchmarkHarnessModuleLoadTask === loadTask
      ) {
        benchmarkHarnessModuleLoadTask = null;
      }
    });
    return loadTask;
  }

  // Load only the live panel runtime from user activation. In particular,
  // panel readiness must await neither the full measurement harness nor
  // `dev/benchmark.js`: those graphs own matrix runners, report generation,
  // analyzers and GPU instrumentation that live statistics and synthetic
  // generation do not use. Parsing them on a native Firefox main thread that
  // is already rendering smoke can indefinitely delay an otherwise healthy
  // panel. The full harness is requested only after the small live runtime is
  // ready, then publishes through its own independent readiness boundary.
  function ensureBenchmarkModule() {
    if (isApplicationRetired()) return Promise.resolve(false);
    if (benchmarkModuleLoaded) {
      // A failed optional harness fetch resets its own task. A later panel
      // activation must retry it without invalidating the healthy live UI.
      void ensureBenchmarkHarnessModule();
      return Promise.resolve(true);
    }
    if (benchmarkModuleLoadTask !== null) return benchmarkModuleLoadTask;

    const loadTask = (async () => {
      try {
        const [generationModule, generationContract, trackerModule] = await loadAppCode(() => Promise.all([
          import('./generation.js'),
          import('./generation-contract.js'),
          import('./performance-tracker.js')
        ]));
        if (isApplicationRetired()) return false;
        generateSyntheticDataOffThread =
          generationModule.generateSyntheticDataOffThread;
        assertSyntheticCount = generationContract.assertSyntheticCount;
        perfTracker = new trackerModule.PerformanceTracker();
        benchmarkModuleLoaded = true;
        // This optional developer entry point remains reachable from the
        // panel, but it cannot hold live production controls hostage.
        void ensureBenchmarkHarnessModule();
        debug.log('[Main] Live benchmark runtime lazy-loaded');
        return true;
      } catch (err) {
        if (!isCancellation(err)) console.error('[Main] Failed to load live benchmark runtime:', err);
        return false;
      }
    })();
    benchmarkModuleLoadTask = loadTask;
    // A transient fetch, parse, or construction failure cannot permanently
    // turn every later panel activation into the same cached `false` result.
    // Successful loads retain the settled task and the published namespace.
    void loadTask.then(loaded => {
      if (!loaded && benchmarkModuleLoadTask === loadTask) {
        benchmarkModuleLoadTask = null;
      }
    });
    return loadTask;
  }

  function ensureBenchmarkSupportModule() {
    if (benchmarkSupportModule !== null) {
      return Promise.resolve(benchmarkSupportModule);
    }
    if (benchmarkSupportModuleLoadTask !== null) {
      return benchmarkSupportModuleLoadTask;
    }

    const loadTask = loadAppCode(() => import('../../../../dev/benchmark.js')).then(
      module => {
        if (isApplicationRetired()) return null;
        benchmarkSupportModule = module;
        return module;
      },
      error => {
        if (!isCancellation(error)) {
          console.error(
            '[Main] Failed to load benchmark report and analyzer support:',
            error
          );
        }
        return null;
      }
    );
    benchmarkSupportModuleLoadTask = loadTask;
    void loadTask.then(module => {
      if (
        module === null &&
        benchmarkSupportModuleLoadTask === loadTask
      ) {
        benchmarkSupportModuleLoadTask = null;
      }
    });
    return loadTask;
  }

  let benchmarkActive = false;
  // The synthetic run and the stage it published: the panel and the report
  // describe the run only while that stage is the one shown, so a dataset
  // opened after it, or None, is described as itself.
  let syntheticDatasetInfo = null;
  let syntheticDatasetStage = null;
  let latestPerfSample = null;
  let latestRendererStats = null;
  let perfLoopHandle = null;
  let perfVisibilityListenerActive = false;

  const synchronizePerfTrackerVisibility = () => {
    if (!benchmarkActive || !perfTracker) return;
    if (document.hidden) {
      perfTracker.pause();
    } else {
      perfTracker.resume();
    }
  };

  const rendererConfigSnapshot = () => ({
    shaderQuality: hpShaderQuality?.value || 'full',
    lodEnabled: hpLodEnabled ? hpLodEnabled.checked : true,
    frustumCulling: hpFrustumCulling ? hpFrustumCulling.checked : false,
    renderMode: renderModeSelect ? renderModeSelect.value : null
  });

  const buildDatasetSnapshot = () => {
    if (syntheticDatasetInfo !== null && syntheticDatasetStage === getActiveStage()) {
      return {
        mode: 'synthetic',
        ...syntheticDatasetInfo,
        visiblePoints: syntheticDatasetInfo.visiblePoints ?? syntheticDatasetInfo.pointCount,
        filters: [],
        activeFieldKey: null,
        activeFieldKind: null
      };
    }
    const filtered = state.getFilteredCount ? state.getFilteredCount() : null;
    const activeField = state.getActiveField ? state.getActiveField() : null;
    const filters = state.getActiveFiltersStructured ? state.getActiveFiltersStructured() : [];
    return {
      mode: 'real',
      pointCount: state.pointCount || 0,
      visiblePoints: filtered?.shown ?? state.pointCount,
      activeFieldKey: activeField?.key || null,
      activeFieldKind: activeField?.kind || null,
      filters
    };
  };

  const formatMs = (val) => {
    if (val == null) return null;
    return typeof val === 'number' ? val.toFixed(2) : String(val);
  };

  const ensureBenchmarkStatsVisible = () => {
    if (benchmarkStatsEl) {
      benchmarkStatsEl.hidden = false;
    }
  };

  const renderBenchmarkStats = (stats, hpStats, datasetSnapshot) => {
    const pointCount = datasetSnapshot?.pointCount ?? 0;
    const visiblePoints = datasetSnapshot?.visiblePoints ?? pointCount;
    const generationMs = datasetSnapshot?.generationMs ?? null;

    if (benchPointsEl) benchPointsEl.textContent = formatNumber(visiblePoints ?? pointCount ?? 0);
    if (benchVisibleEl) benchVisibleEl.textContent = formatNumber(visiblePoints ?? pointCount ?? 0);

    if (benchMemoryEl) {
      benchMemoryEl.textContent =
        formatBenchmarkGpuMemory(hpStats, pointCount);
    }

    if (benchGenInfoEl && benchGenTimeEl) {
      if (generationMs != null) {
        benchGenTimeEl.textContent = formatDuration(generationMs);
        benchGenInfoEl.hidden = false;
      } else {
        benchGenInfoEl.hidden = true;
      }
    }

    if (stats && stats.samples > 1) {
      const displayFps = stats?.fps ?? hpStats?.fps ?? 0;
      const displayFrameTime = formatMs(stats?.avgFrameTime ?? hpStats?.lastFrameTime);
      const renderFrameTime = formatMs(hpStats?.lastFrameTime);

      if (benchFpsEl) {
        benchFpsEl.textContent = displayFps ?? '-';
      }
      if (benchFrametimeEl) {
        benchFrametimeEl.textContent = displayFrameTime != null ? `${displayFrameTime} ms` : '-';
      }
      if (benchRendertimeEl) {
        // Main-thread time spent issuing the last frame, not GPU time. Under
        // the page's coarse timer it often reads 0.00, which says nothing.
        const cpuShown = renderFrameTime != null && renderFrameTime !== '0.00';
        benchRendertimeEl.textContent = cpuShown ? `CPU ${renderFrameTime} ms` : '';
        benchRendertimeEl.hidden = !cpuShown;
      }

      if (stats.samples >= 30 && benchTimingDetailsEl) {
        benchTimingDetailsEl.hidden = false;
        // Format timing values with 2 decimal places
        const formatTiming = (val) => typeof val === 'number' ? val.toFixed(2) : val;
        if (benchMinFtEl) benchMinFtEl.textContent = formatTiming(stats.minFrameTime) + ' ms';
        if (benchP95FtEl) benchP95FtEl.textContent = formatTiming(stats.p95FrameTime) + ' ms';
        if (benchMaxFtEl) benchMaxFtEl.textContent = formatTiming(stats.maxFrameTime) + ' ms';
      } else if (benchTimingDetailsEl) {
        benchTimingDetailsEl.hidden = true;
      }
    } else {
      if (benchFpsEl) benchFpsEl.textContent = '-';
      if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
      if (benchRendertimeEl) benchRendertimeEl.hidden = true;
      if (benchTimingDetailsEl) benchTimingDetailsEl.hidden = true;
    }

    if (hpStats) {
      if (benchLodEl) benchLodEl.textContent = hpStats.lodLevel === -1 ? 'Full' : `Level ${hpStats.lodLevel}`;
      if (benchVisibleEl) benchVisibleEl.textContent = formatNumber(hpStats.visiblePoints ?? visiblePoints ?? 0);
    } else {
      if (benchLodEl) benchLodEl.textContent = '-';
    }
  };

  const startPerfMonitoring = ({ resetTracker = false } = {}) => {
    if (isApplicationRetired()) return;
    // perfTracker is lazy-loaded; if not available yet, skip monitoring
    if (!perfTracker) {
      console.warn('[Main] Performance tracker not loaded yet');
      return;
    }

    ensureBenchmarkStatsVisible();

    if (resetTracker || !benchmarkActive) {
      perfTracker.start();
    }
    benchmarkActive = true;
    if (!perfVisibilityListenerActive) {
      document.addEventListener(
        'visibilitychange',
        synchronizePerfTrackerVisibility
      );
      perfVisibilityListenerActive = true;
    }
    synchronizePerfTrackerVisibility();

    const tick = () => {
      if (!benchmarkActive) {
        perfLoopHandle = null;
        return;
      }

      const stats = perfTracker.recordFrame();
      const activeViewId = state.getActiveViewId();
      const hpStats = viewer.hasRendererStats(activeViewId)
        ? viewer.getRendererStats(activeViewId)
        : null;
      if (stats) latestPerfSample = stats;
      if (hpStats) latestRendererStats = hpStats;

      const datasetSnapshot = buildDatasetSnapshot();
      renderBenchmarkStats(stats, hpStats, datasetSnapshot);

      perfLoopHandle = requestAnimationFrame(tick);
    };

    if (!perfLoopHandle) {
      perfLoopHandle = requestAnimationFrame(tick);
    }
  };

  const stopPerfMonitoring = () => {
    benchmarkActive = false;
    if (perfVisibilityListenerActive) {
      document.removeEventListener(
        'visibilitychange',
        synchronizePerfTrackerVisibility
      );
      perfVisibilityListenerActive = false;
    }
    if (perfTracker) {
      perfTracker.stop();
    }
    if (perfLoopHandle) {
      cancelAnimationFrame(perfLoopHandle);
      perfLoopHandle = null;
    }
  };

  const activateBenchmarkingPanel = ({ resetTracker = false } = {}) => {
    renderBenchmarkStats(
      null,
      null,
      buildDatasetSnapshot()
    );
    startPerfMonitoring({ resetTracker });
  };

  if (benchmarkSection) {
    const benchmarkSummary = benchmarkSection.querySelector(
      ':scope > summary'
    );
    if (!(benchmarkSummary instanceof HTMLElement)) {
      throw new TypeError(
        'Performance benchmark disclosure requires its direct summary.'
      );
    }
    const reportBenchmarkPanelFailure = error => {
      const exactError = error instanceof Error
        ? error
        : new Error(String(error));
      console.error(
        '[Main] Performance benchmark panel could not be changed:',
        exactError
      );
      try {
        notifications.error(
          `${PLACES.benchmark.name} panel was not changed: ` +
          `${sayFailure(exactError)}`,
          { ...failureDetails(exactError),
            category: 'rendering',
            title: 'Renderer setting unavailable'
          }
        );
      } catch (notificationError) {
        // Panel state is already coherent. Notification delivery is
        // observational and must not escape the synchronous DOM event.
        console.error(
          '[Main] Benchmark panel failure notification was not delivered:',
          notificationError
        );
      }
    };
    const publishBenchmarkPanelState = () => {
      if (isApplicationRetired()) return;
      if (benchmarkSection.open) {
        // The summary activation and the native toggle notification can both
        // settle the same opening. Only the first owns tracker reset/start.
        if (!benchmarkActive) {
          activateBenchmarkingPanel({ resetTracker: true });
        }
      } else if (benchmarkActive) {
        stopPerfMonitoring();
      }
    };
    const synchronizeBenchmarkPanelWithSection = async () => {
      if (benchmarkSection.open) {
        // Lazy-load benchmark module when section is first opened
        const moduleLoaded = await ensureBenchmarkModule();
        if (!moduleLoaded || isApplicationRetired()) return;
      }
      publishBenchmarkPanelState();
    };
    const ownBenchmarkPanelSynchronization = () => {
      synchronizeBenchmarkPanelWithSection().catch(
        reportBenchmarkPanelFailure
      );
    };
    const ownBenchmarkSummaryActivation = () => {
      // `toggle` is a queued notification. A stressed native Firefox GPU
      // service can continue to render and service automation while delaying
      // that notification indefinitely. The summary's click is the actual
      // user activation, so initiate the live module request in this task.
      // It starts the independent harness request only after live readiness;
      // once the live graph settles, the browser's default action has already
      // published the exact `open` state and this owner can reconcile it.
      ensureBenchmarkModule().then(moduleLoaded => {
        if (!moduleLoaded || isApplicationRetired()) return;
        publishBenchmarkPanelState();
      }).catch(reportBenchmarkPanelFailure);
    };
    benchmarkSummary.addEventListener(
      'click',
      ownBenchmarkSummaryActivation,
      { signal: applicationSignal }
    );
    benchmarkSection.addEventListener(
      'toggle',
      ownBenchmarkPanelSynchronization,
      { signal: applicationSignal }
    );
    // A `<details>` opens itself: the browser toggles it on a summary click
    // with no script involved, so a click made while the bootstrap above was
    // still running has already happened when this listener is attached.
    // Left unreconciled, that click would open an empty panel, the next
    // click would close it, and only the third would load anything. Reading
    // the state the listener was attached to is what makes the first click
    // count.
    ownBenchmarkPanelSynchronization();
  }

  /**
   * Tell the user their synthetic data load was overtaken.
   *
   * A superseded exit says so: a click that lands while a dataset change is
   * still settling would otherwise look like a dead button, with nothing
   * rendered, nothing logged, and the run's own notification already
   * dismissed.
   *
   * @returns {false} Always, so a superseded exit reads as one statement.
   */
  function reportSupersededBenchmark() {
    notifications.warning(
      'Synthetic data load was superseded by a newer dataset change. ' +
      'Nothing was replaced — run it again once the current load settles.',
      { category: 'benchmark', title: 'Benchmark superseded' }
    );
    return false;
  }

  // A run is a dataset change like any other: it supersedes the load in
  // flight when the user starts it, and a later choice supersedes it.
  async function runBenchmark(pointCount, pattern) {
    const syntheticTransaction = datasetReloadCoordinator.begin();
    try {
      try {
        await confirmDatasetReplacement(syntheticTransaction, {});
      } catch (error) {
        if (isCancellation(error)) return false;
        throw error;
      }
      return await runSyntheticBenchmark(
        syntheticTransaction,
        pointCount,
        pattern
      );
    } finally {
      syntheticTransaction.finish();
    }
  }

  async function runSyntheticBenchmark(
    syntheticTransaction,
    pointCount,
    pattern
  ) {
    // Ensure benchmark module is loaded before running
    const moduleLoaded = await ensureBenchmarkModule();
    if (!syntheticTransaction.isCurrent()) return reportSupersededBenchmark();
    syntheticTransaction.assertCurrent();
    if (
      !moduleLoaded ||
      !generateSyntheticDataOffThread ||
      !assertSyntheticCount
    ) {
      console.error('[Main] Cannot run benchmark: synthetic generation is not available');
      notifications.error('Benchmark module failed to load', { category: 'benchmark' });
      return false;
    }

    // The control's declared range is only advertised until something
    // enforces it. Check before the run is announced, so an out-of-range
    // request is refused by name rather than surfacing as a failed
    // multi-gigabyte allocation.
    try {
      assertSyntheticCount(pointCount);
    } catch (error) {
      notifications.error(
        error instanceof Error ? error.message : String(error),
        { category: 'benchmark', title: 'Point count out of range' }
      );
      return false;
    }

    debug.log(`Running benchmark: ${formatNumber(pointCount)} ${countNoun(pointCount, 'point')} (${pattern})`);

    // Show notification for benchmark data generation
    const benchNotifId = notifications.startDataGeneration(pattern, pointCount);
    let candidateDimensionManager = null;
    const dismissSupersededBenchmark = ({ retireCandidate = false } = {}) => {
      try {
        if (
          retireCandidate &&
          candidateDimensionManager !== null &&
          candidateDimensionManager !== getDimensionManager()
        ) {
          runtimeRetirementOwner.retire(candidateDimensionManager);
        }
      } finally {
        notifications.dismiss(benchNotifId);
      }
      return reportSupersededBenchmark();
    };

    ensureBenchmarkStatsVisible();
    if (benchFpsEl) benchFpsEl.textContent = '-';
    if (benchFrametimeEl) benchFrametimeEl.textContent = '-';
    if (benchRendertimeEl) benchRendertimeEl.hidden = true;
    if (benchTimingDetailsEl) benchTimingDetailsEl.hidden = true;
    if (benchGenInfoEl) benchGenInfoEl.hidden = true;

    // Generate off the main thread. Every pattern costs six to twenty-five
    // transcendental calls per point in one uninterruptible loop, so running
    // it here would freeze the tab for the whole of it, in proportion to the
    // point count, with no frame drawn, no progress reported and no way to
    // cancel (measured: 35_decisions_interface.md). The worker builds the
    // same arrays from the same seed and transfers them back, so the main
    // thread's exposure stops scaling with the count, and the reload
    // transaction's signal terminates the worker when a newer dataset change
    // overtakes this run.
    let data;
    const genStart = performance.now();
    try {
      if (pattern === 'glb') {
        notifications.updateBenchmark(benchNotifId, 10, 'Loading the 3D model…');
      }
      data = await generateSyntheticDataOffThread({
        pattern,
        count: pointCount,
        signal: syntheticTransaction.signal
      });
    } catch (err) {
      if (!syntheticTransaction.isCurrent()) {
        return dismissSupersededBenchmark();
      }
      console.error('Failed to generate data:', err);
      notifications.fail(
        benchNotifId,
        `Benchmark failed: ${pattern === 'glb' ? 'the model file could not be read: ' : ''}${sayFailure(err)}`,
        failureDetails(err)
      );
      return false;
    }
    if (!syntheticTransaction.isCurrent()) {
      return dismissSupersededBenchmark();
    }
    syntheticTransaction.assertCurrent();
    const genTime = Math.round(performance.now() - genStart);
    try {
      if (
        !Number.isSafeInteger(pointCount) ||
        pointCount < 1 ||
        ![1, 2, 3].includes(data.dimensionLevel) ||
        !(data.positions instanceof Float32Array) ||
        data.positions.length !== pointCount * data.dimensionLevel ||
        !(data.colors instanceof Uint8Array) ||
        data.colors.length !== pointCount * 4
      ) {
        throw new TypeError(
          'Synthetic benchmark data must contain exact dataset-length ' +
          'Float32 positions (dimensionLevel values per point) and ' +
          'Uint8 RGBA arrays.'
        );
      }
      candidateDimensionManager = createInMemoryDimensionManager({
        positions: data.positions,
        dimension: data.dimensionLevel,
        representations: syntheticRepresentations(
          data.positions,
          data.dimensionLevel,
          benchmarkRepresentationsSelect?.value ?? 'one'
        )
      });
    } catch (error) {
      console.error('Failed to stage benchmark data:', error);
      notifications.fail(benchNotifId, `Benchmark failed: ${sayFailure(error)}`, failureDetails(error));
      return false;
    }

    const syntheticStage = Object.freeze({
      colors: data.colors,
      dimensionLevel: data.dimensionLevel,
      dimensionManager: candidateDimensionManager,
      positions: data.positions,
      runtimeKind: 'synthetic'
    });
    const previousRuntimeStage = getActiveStage();
    const previousPublication = getActivePublication();
    let syntheticPublication;
    try {
      await cancelPublishedDatasetStateAndWait();
      if (!syntheticTransaction.isCurrent()) {
        return dismissSupersededBenchmark({
          retireCandidate: true
        });
      }
      syntheticTransaction.assertCurrent();
    } catch (error) {
      if (!syntheticTransaction.isCurrent()) {
        return dismissSupersededBenchmark({
          retireCandidate: true
        });
      }
      try {
        runtimeRetirementOwner.retire(candidateDimensionManager);
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          'Published state cancellation and benchmark retirement failed.'
        );
      }
      console.error(
        'Failed to cancel the current dataset state:',
        error
      );
      notifications.fail(benchNotifId, `Benchmark failed: ${sayFailure(error)}`, failureDetails(error));
      return false;
    }
    try {
      syntheticPublication =
        commitSyntheticRuntimeStage(syntheticStage);
    } catch (error) {
      const publicationErrors = [error];
      try {
        restorePreviousRuntime(previousRuntimeStage, previousPublication);
      } catch (restorationError) {
        publicationErrors.push(restorationError);
      }
      try {
        runtimeRetirementOwner.retire(candidateDimensionManager);
      } catch (retirementError) {
        publicationErrors.push(retirementError);
      }
      const exactError = publicationErrors.length === 1
        ? error
        : new AggregateError(
            publicationErrors,
            'Synthetic benchmark publication, restoration, or retirement failed.'
          );
      console.error('Failed to publish benchmark data:', exactError);
      notifications.fail(benchNotifId, `Benchmark failed: ${sayFailure(exactError)}`, failureDetails(exactError));
      return false;
    }

    // The exact DataState generation is now live. Publish the matching app
    // runtime and retire every previous dataset-count owner synchronously.
    const synchronizationOutcome = await settlePublishedDatasetUi({
      synchronize: async () => {
        assertCurrentDatasetPublication(syntheticPublication);
        try {
          await ui?.settleFieldInteractions?.();
        } finally {
          assertCurrentDatasetPublication(syntheticPublication);
        }
        connectivityRuntimeOwner.synchronizeDatasetPublication();
        // A synthetic scene has no data mapping; the panel says so.
        ui?.refreshDataMapping?.();
        if (getComparisonModule() !== null) {
          try {
            await getComparisonModule().resetForDatasetReload({
              reason: 'synthetic-benchmark-publication'
            });
          } finally {
            assertCurrentDatasetPublication(syntheticPublication);
          }
        }
      },
      finalize: () => {
        retireReplacedDimensionManager(syntheticPublication);
      },
      reportFailure: error => {
        if (syntheticPublication.isCurrent() !== true) return;
        console.error(
          '[Main] Synthetic benchmark was published, but cleanup failed:',
          error
        );
        notifications.error(
          `Benchmark data is visible, but prior resources could not be ` +
          `fully released: ${sayFailure(error)}`,
          { ...failureDetails(error),
            category: 'benchmark',
            duration: 0,
            title: 'Benchmark cleanup incomplete'
          }
        );
      }
    });
    if (
      synchronizationOutcome.status === 'superseded' ||
      syntheticPublication.isCurrent() !== true
    ) {
      return dismissSupersededBenchmark();
    }
    assertCurrentDatasetPublication(syntheticPublication);

    // Ensure point rendering mode only after the complete replacement has
    // succeeded, so a rejected benchmark preserves the previous runtime.
    if (renderModeSelect && renderModeSelect.value !== 'points') {
      const applied = ui.applyRenderMode('points');
      if (applied !== true || renderModeSelect.value !== 'points') {
        throw new Error(
          'Synthetic benchmark publication could not settle exact Points mode.'
        );
      }
    }

    notifications.completeDataGeneration(benchNotifId, genTime);

    const syntheticDimLevel = data.dimensionLevel;

    syntheticDatasetStage = syntheticStage;
    syntheticDatasetInfo = {
      pointCount,
      pattern,
      generationMs: genTime,
      visiblePoints: pointCount,
      dimensionLevel: syntheticDimLevel
    };

    const gpuMemEstimateMB =
      estimateBenchmarkGpuMemoryMB(pointCount);

    // Refresh stat panel immediately and start perf tracking loop
    activateBenchmarkingPanel({ resetTracker: true });

    debug.log(
      `Benchmark loaded: ${formatNumber(pointCount)} ${countNoun(pointCount, 'point')}, ` +
      `~${gpuMemEstimateMB.toFixed(1)}MB estimated GPU memory ` +
      `(gen: ${genTime}ms)`
    );
    return true;
  }

  // The situation report and the bottleneck analysis both measure drawn
  // cells, and None leaves none to draw: no frame would ever publish the
  // renderer statistics they read.
  const NO_CELLS_TO_MEASURE =
    'Open a dataset or load synthetic data first.';

  async function generateSituationReport() {
    if (viewer.getPointCount() === 0) {
      notifications.info(NO_CELLS_TO_MEASURE, { category: 'benchmark' });
      return;
    }
    const [runtimeLoaded, supportModule] = await Promise.all([
      ensureBenchmarkModule(),
      ensureBenchmarkSupportModule()
    ]);
    if (
      !runtimeLoaded ||
      typeof supportModule?.BenchmarkReporter !== 'function'
    ) {
      console.warn(
        '[Main] Benchmark report support is unavailable; report not generated'
      );
      notifications.error('Benchmark module not available', { category: 'benchmark' });
      return;
    }

    // Create benchmarkReporter lazily on first use
    if (!benchmarkReporter) {
      benchmarkReporter = new supportModule.BenchmarkReporter({
        viewer,
        state,
        canvas
      });
    }

    // Show notification for report generation
    const reportNotifId = notifications.startReport();

    const datasetSnapshot = buildDatasetSnapshot();
    const activeViewId = state.getActiveViewId();
    if (!viewer.hasRendererStats(activeViewId)) {
      notifications.failCalculation(
        reportNotifId,
        'Renderer statistics are not ready; wait for the first rendered frame'
      );
      return;
    }
    const rendererStats = viewer.getRendererStats(activeViewId);
    if (rendererStats) latestRendererStats = rendererStats;
    const report = benchmarkReporter.buildReport({
      dataset: datasetSnapshot,
      rendererConfig: rendererConfigSnapshot(),
      rendererStats: latestRendererStats,
      perfStats: latestPerfSample,
      filteredCount: datasetSnapshot.mode === 'real' && state.getFilteredCount ? state.getFilteredCount() : null,
      filters: datasetSnapshot.mode === 'real' ? datasetSnapshot.filters : [],
      activeField: datasetSnapshot.mode === 'real' && state.getActiveField ? state.getActiveField() : null
    });

    const yamlOutput = report.yaml();
    if (benchmarkReportOutput) {
      benchmarkReportOutput.value = yamlOutput;
      benchmarkReportOutput.hidden = false;
    }

    // The report's card says it was copied; a refusal says why (the text
    // stays in the field below to select by hand).
    const copiedToClipboard = await copyText(yamlOutput, {
      what: 'the situation report',
      success: null,
      failure: 'Select it in the field below.',
      category: 'benchmark',
      notifications,
    });

    // Complete notification
    notifications.completeReport(reportNotifId, copiedToClipboard);
  }

  /**
   * Read the requested point count from the control.
   *
   * The field is an exact integer count, so it is parsed as one (`parseInt`
   * would read a typed `1e9` as one point and accept a trailing suffix) and
   * `runBenchmark` refuses anything the declared range excludes.
   *
   * @returns {number} The requested count, or NaN when the field is unusable.
   */
  function readBenchmarkPointCount() {
    const raw = (benchmarkCountInput?.value ?? '').trim();
    // A cleared field means the control's own default, which is declared in
    // the markup beside its min and max rather than restated here.
    return Number(raw === '' ? benchmarkCountInput?.defaultValue : raw);
  }

  /**
   * Start a run from a control and own its outcome.
   *
   * `runBenchmark` can reject — publication failures throw — and a dropped
   * promise turns that into an unhandled rejection the user never sees. It
   * reports every `false` outcome itself, so only the rejection needs a home.
   *
   * @param {number} count - Requested point count.
   * @param {string} pattern - Requested synthetic pattern.
   */
  function startBenchmarkRun(count, pattern) {
    runBenchmark(count, pattern).catch(error => {
      console.error('[Main] Synthetic benchmark failed:', error);
      notifications.error(
        `Synthetic data load failed: ${sayFailure(error)}`,
        { ...failureDetails(error), category: 'benchmark', title: 'Benchmark failed' }
      );
    });
  }

  // Wire up run button
  if (benchmarkRunBtn) {
    benchmarkRunBtn.addEventListener('click', () => {
      const pattern = benchmarkPatternSelect?.value || 'clusters';
      startBenchmarkRun(readBenchmarkPointCount(), pattern);
    }, { signal: applicationSignal });
  }

  if (benchmarkReportBtn) {
    benchmarkReportBtn.addEventListener('click', () => {
      generateSituationReport().catch(error => {
        console.error('[Main] Situation report failed:', error);
        notifications.error(
          `Situation report failed: ${sayFailure(error)}`,
          { ...failureDetails(error), category: 'benchmark', title: 'Report failed' }
        );
      });
    }, { signal: applicationSignal });
  }

  // Wire up preset buttons
  benchPresets.forEach(btn => {
    btn.addEventListener('click', () => {
      const count = Number(btn.dataset.count);
      if (benchmarkCountInput) benchmarkCountInput.value = count;
      const pattern = benchmarkPatternSelect?.value || 'clusters';
      startBenchmarkRun(count, pattern);
    }, { signal: applicationSignal });
  });

  // ========================================
  // BOTTLENECK ANALYSIS (Single Button)
  // ========================================
  const bottleneckAnalyzeBtn = document.getElementById('bottleneck-analyze-btn');
  const bottleneckProgress = document.getElementById('bottleneck-progress');
  const bottleneckResults = document.getElementById('bottleneck-results');

  if (bottleneckAnalyzeBtn) {
    bottleneckAnalyzeBtn.addEventListener('click', async () => {
      if (viewer.getPointCount() === 0) {
        notifications.info(NO_CELLS_TO_MEASURE, { category: 'benchmark' });
        return;
      }
      const hpRenderer = viewer.getHPRenderer();

      const [runtimeLoaded, supportModule] = await Promise.all([
        ensureBenchmarkModule(),
        ensureBenchmarkSupportModule()
      ]);
      if (
        !runtimeLoaded ||
        typeof supportModule?.BottleneckAnalyzer !== 'function'
      ) {
        notifications.error(
          'Benchmark analyzer is not available',
          { category: 'benchmark' }
        );
        return;
      }
      const BottleneckAnalyzer = supportModule.BottleneckAnalyzer;

      // The viewer canvas's own context (asked again, the same one): its GPU
      // timer must time the frames the renderer draws, and the page's first
      // canvas need not be the viewer's.
      const gl = canvas.getContext('webgl2');
      if (!gl) {
        notifications.error('Analyze performance needs the viewer\'s WebGL2 context, which is not available.', { category: 'benchmark' });
        return;
      }
      // The button's label as the page wrote it, put back when the run ends.
      const analyzeLabel = bottleneckAnalyzeBtn.textContent;

      // Show progress
      bottleneckAnalyzeBtn.disabled = true;
      bottleneckAnalyzeBtn.textContent = 'Analyzing…';
      if (bottleneckProgress) bottleneckProgress.hidden = false;
      if (bottleneckResults) bottleneckResults.hidden = true;

      try {
        const analyzer = new BottleneckAnalyzer(gl, hpRenderer, viewer, {
          pointSizeMax: pointSpriteCap(gl),
        });

        const results = await analyzer.runAnalysis({
          warmupFrames: 30,
          testFrames: 100
        });

        // Hide progress, show results
        if (bottleneckProgress) bottleneckProgress.hidden = true;
        if (bottleneckResults) bottleneckResults.hidden = false;

        const s = results.summary;
        const b = results.bottleneckType;
        const recs = results.recommendations;
        const fps = s.performance.fps;

        // Build verdict
        const verdictBox = document.getElementById('bn-verdict-box');
        const verdictTitle = document.getElementById('bn-verdict-title');
        const verdictDetail = document.getElementById('bn-verdict-detail');

        let verdictText, detailText, status;

        if (fps >= supportModule.SMOOTH_FPS) {
          status = 'good';
          verdictText = 'Performance is good';
          detailText = 'Running smoothly at ' + fps.toFixed(0) + ' FPS. No issues detected.';
        } else if (fps >= 30) {
          status = 'warning';
          verdictText = 'Performance could be better';
          detailText = b.primary.type + ' is the main bottleneck. ' + (b.primary.evidence || '');
        } else {
          status = 'danger';
          verdictText = 'Serious performance problem';
          detailText = b.primary.type + ' is severely limiting performance. ' + (b.primary.evidence || '');
        }

        // The status drives both the panel tint and which decorative glyph
        // CSS reveals; no icon character is written from script.
        if (verdictBox) {
          verdictBox.dataset.status = status;
        }
        if (verdictTitle) {
          verdictTitle.textContent = verdictText;
        }
        if (verdictDetail) {
          verdictDetail.textContent = detailText;
        }

        // FPS display
        const bnFps = document.getElementById('bn-fps');
        if (bnFps) {
          bnFps.textContent = fps.toFixed(0);
          bnFps.dataset.status = status;
        }

        // Build problem list
        const problemList = document.getElementById('bn-problem-list');
        if (problemList) {
          /**
           * @param {string} text
           * @param {{ status?: 'good' | 'warning' | 'danger' }} [options]
           * @returns {HTMLDivElement}
           */
          const createListItem = (text, options = {}) => {
            const el = document.createElement('div');
            el.className = 'bn-list-item';
            if (options.status) el.dataset.status = options.status;
            el.textContent = text;
            return el;
          };

          /** @type {HTMLDivElement[]} */
          const items = [];

          // Add main bottleneck
          if (fps < supportModule.SMOOTH_FPS) {
            const el = document.createElement('div');
            el.className = 'bn-list-item';
            el.dataset.status = status;
            el.append('• ');
            const strong = document.createElement('strong');
            strong.textContent = b.primary.type;
            el.append(strong);
            el.append(`: ${b.primary.evidence || 'Main limiting factor'}`);
            items.push(el);
          }

          // Add contributing factors
          for (const c of b.contributing) {
            items.push(createListItem(`• ${c.type}: ${c.evidence}`, { status: 'warning' }));
          }

          // Add jank/stuttering issues
          if (s.frameStability && s.frameStability.hasJank) {
            const severity = s.frameStability.jankSeverity;
            const stutterStatus = severity === 'mild' ? 'warning' : 'danger';
            // Severity is stated in words, not color or an icon character.
            items.push(createListItem(`• Frame stuttering (${severity}): ${s.frameStability.diagnosis} (${s.frameStability.jankPercent} janky frames)`, { status: stutterStatus }));
          }

          // Add CPU/JS health issues
          if (s.cpuHealth && s.cpuHealth.issues && s.cpuHealth.issues.length > 0) {
            for (const issue of s.cpuHealth.issues.slice(0, 2)) {
              items.push(createListItem(`• ${issue}`, { status: 'warning' }));
            }
          }

          if (items.length === 0) {
            items.push(createListItem('No significant problems found', { status: 'good' }));
          }

          problemList.innerHTML = '';
          for (const item of items) problemList.appendChild(item);
        }

        // Build fix list
        const fixList = document.getElementById('bn-fix-list');
        if (fixList && recs.recommendations.length > 0) {
          fixList.innerHTML = '';
          for (const rec of recs.recommendations.slice(0, 3)) {
            const item = document.createElement('div');
            item.className = 'bn-list-item';
            const title = document.createElement('div');
            title.className = 'bn-fix-title';
            title.textContent = rec.title;
            const action = document.createElement('div');
            action.className = 'bn-fix-action';
            action.textContent = rec.actions?.[0] || '';
            item.append(title, action);
            fixList.appendChild(item);
          }
        } else if (fixList) {
          fixList.innerHTML = '';
          const ok = document.createElement('div');
          ok.className = 'bn-list-item';
          ok.dataset.status = 'good';
          ok.textContent = 'No changes needed - performance is good!';
          fixList.appendChild(ok);
        }

        // Populate detailed stats
        const bnVisiblePoints = document.getElementById('bn-visible-points');
        const bnGpuMemory = document.getElementById('bn-gpu-memory');
        const bnLodLevel = document.getElementById('bn-lod-level');
        const bnDrawCalls = document.getElementById('bn-draw-calls');
        const bnFrametime = document.getElementById('bn-frametime');
        const bnP95 = document.getElementById('bn-p95');
        const bnLodOverhead = document.getElementById('bn-lod-overhead');
        const bnFrustumOverhead = document.getElementById('bn-frustum-overhead');
        const bnPointSizeResponse = document.getElementById('bn-point-size-response');

        if (bnVisiblePoints) bnVisiblePoints.textContent = formatNumber(s.rendering.visiblePoints);
        if (bnGpuMemory) {
          bnGpuMemory.textContent =
            `${s.rendering.gpuMemoryMB}MB` +
            (s.rendering.gpuMemoryEstimated
              ? ' (estimate)'
              : '');
        }
        if (bnLodLevel) bnLodLevel.textContent = Math.round(s.rendering.lodLevel);
        if (bnDrawCalls) bnDrawCalls.textContent = Math.round(s.rendering.drawCalls);
        if (bnFrametime) bnFrametime.textContent = s.performance.avgFrameTimeMs.toFixed(1) + 'ms';
        if (bnP95) bnP95.textContent = s.performance.p95FrameTimeMs.toFixed(1) + 'ms';
        if (bnLodOverhead) bnLodOverhead.textContent = s.overhead.lodMs + 'ms';
        if (bnFrustumOverhead) bnFrustumOverhead.textContent = s.overhead.frustumCullingMs + 'ms';
        if (bnPointSizeResponse) bnPointSizeResponse.textContent = s.bottleneck.pointSizeResponse;

        // Frame stability and CPU health stats
        const bnFrameStability = document.getElementById('bn-frame-stability');
        const bnJankPercent = document.getElementById('bn-jank-percent');
        const bnCpuHealth = document.getElementById('bn-cpu-health');

        if (s.frameStability) {
          if (bnFrameStability) {
            const stability = s.frameStability.hasJank ? s.frameStability.jankSeverity : 'stable';
            const stabilityStatus = stability === 'stable' ? 'good' : stability === 'mild' ? 'warning' : 'danger';
            bnFrameStability.textContent = stability;
            bnFrameStability.dataset.status = stabilityStatus;
          }
          if (bnJankPercent) bnJankPercent.textContent = s.frameStability.jankPercent;
        }

        if (s.cpuHealth && bnCpuHealth) {
          const health = s.cpuHealth.health || 'unknown';
          const healthStatus = health === 'good' ? 'good' : health === 'fair' ? 'warning' : 'danger';
          bnCpuHealth.textContent = health;
          bnCpuHealth.dataset.status = healthStatus;
        }

        // Log to console too
        debug.log('[Bottleneck Analysis]', results);

      } catch (err) {
        console.error('[Bottleneck] Analysis failed:', err);
        if (bottleneckProgress) bottleneckProgress.hidden = true;
        notifications.error(`${joinFailure(`Analyze performance did not finish`, sayFailure(err))}`, {
          category: 'benchmark', ...failureDetails(err)
        });
      } finally {
        bottleneckAnalyzeBtn.disabled = false;
        bottleneckAnalyzeBtn.textContent = analyzeLabel;
      }
    }, { signal: applicationSignal });
  }

  return Object.freeze({ stopPerfMonitoring });
}
