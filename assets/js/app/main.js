/**
 * @fileoverview Application entry point: the start-up sequence, in order.
 *
 * It owns what runs once a page, in the order it runs: the link read
 * (`startup-url-intent.js`), the page shell, the viewer and the
 * application's teardown (`destroyApplication`), the state and the change
 * owner, every awaited start-up step (the GitHub sign-in, a host viewer's
 * channel, `?remote=`, the page's own server, the source registry, `?data=`,
 * `?dataset=`, the default sample), the session and its histories, the
 * interface (`initUI`), the analysis panel, the state domains, the shortcuts,
 * the render loop, and the startup dataset's load. Every `window` hook the
 * tests read is set here.
 *
 * What each part does is its module's, made here by a synchronous factory
 * that takes what exists and getters for what is made later: the dataset's
 * publication, its changes and its starting view (`dataset/`), a host
 * viewer's view and channel (`viewer-host/host-view.js`, `host-channel.js`),
 * the connectivity controls, the benchmark and the smoke rebuild
 * (`ui/modules/`). What is left here stays because it is the sequence
 * itself: an awaited stretch moved into an awaited function would add a
 * microtask turn at its end and change what runs before the interface is
 * built (the default sample's catalog is asked at the bootstrap's next
 * yield). That is also why this file is larger than the other modules of
 * `app/`.
 *
 * @module main
 */
import { createViewer } from '../rendering/viewer.js';
import { keepSessionThroughGraphicsReset } from './graphics-reset-session.js';
import { initSidebarLayout } from './ui/core/sidebar-layout.js';
import { initializeConnectivityControls } from './ui/modules/connectivity-controls.js';
import { createDataState } from './state/index.js';
import { createSmokeDensityRebuild } from './ui/modules/smoke-density.js';
import {
  createStableTerminalDestroy,
  initUI
} from './ui/core/ui-coordinator.js';
import { createSessionSerializer } from './session/index.js';
import { createViewCarry } from './session/view-carry.js';
import { providePersistenceActions } from './history/persistence-actions.js';
import { provideAnnDataCopyAction } from './history/anndata-copy-save.js';
import { createSpool } from './exports/cell-exports.js';
import { keptLocalFile } from './library/local-file-handles.js';
import { capturePageChrome, planPageChrome } from './state-serializer/ui-controls.js';
import { downloadBlob } from './utils/download.js';
import { datasetFactsOf } from './ui/modules/state/dataset-facts.js';
import { cellucidCitationReader } from './citation.js';
import { getActions, getStateDomains } from './actions/index.js';
import { createDatasetHistories } from './history/dataset-history.js';
import { createPublishedDatasetState } from './dataset/published-state.js';
import { createUnkeptWorkGuard } from './unkept-work-guard.js';
import { showConfirmDialog } from './ui/components/confirm-dialog.js';
import { recordDatasetOpened } from './library/my-datasets.js';
import { hasPendingConnectCode } from './agent/bridge/connect-code.js';
import {
  createLatestDatasetPublicationContinuationOwner,
  createLatestDatasetReloadCoordinator
} from './dataset-reload-outcome.js';
import { createDatasetPublication } from './dataset/publication.js';
import { createDatasetChanges } from './dataset/reload.js';
import { initDockableAccordions } from './dockable-accordions.js';
import { getDockableAccordions, setDockableAccordions } from './dockable-accordions-registry.js';
import { installStateDomains } from './state/domains/index.js';
import { installSettingsActions } from './ui/modules/settings-actions.js';
import { installLayoutActions } from './ui/modules/layout-actions.js';
import { installReadActions } from './reads/index.js';
import { describeOpenDataset } from './reads/dataset.js';
import { installAnalysisActions } from './analysis/actions.js';
import { getNotificationCenter } from './notification-center.js';
import { installMatrixShareNotices } from './matrix-share-notices.js';
import { showReadProgress } from './read-progress-notifications.js';
import { showOpeningProgress } from './opening-progress-view.js';
import { showSourceSignIn } from './source-sign-in-view.js';
import { initPageMemory } from './page-memory.js';
import { beginOpening } from '../data/opening-progress.js';
import { retireAnnDataReaderWorkers } from '../data/anndata-reader-client.js';
import {
  loadCoordinateRows,
  loadDatasetGeneration,
  loadConnectivitySummary,
  loadMappingCandidates
} from '../data/data-loaders.js';
import { MAPPING_CANDIDATES_ROUTE } from '../data/dataset-mapping.js';
import { initBenchmarkControls } from './ui/modules/benchmark/benchmark-controls.js';
import { describeOpeningFailure } from './ui/modules/dataset-connections.js';
import { canonicalServerAddress } from './ui/modules/address-routing.js';
import { parseSubsampleUrlParameters } from './subsample-url.js';
import { setNextCellSubsetRequest, setTabCellSubsetRequest, withdrawNextCellSubsetRequest } from '../data/cell-subset-policy.js';
import { getDataSourceManager } from '../data/data-source-manager.js';
import { getTransferLog } from '../data/transfer-log.js';
import { sweepAbandonedIndexes } from '../data/column-store-placement.js';
import { sweepAbandonedTranscodes } from '../data/anndata/transcode/space.js';
import { createLocalUserDirDataSource } from '../data/local-user-source.js';
import { createRemoteDataSource, validateRemoteServerUrl } from '../data/remote-source.js';
import {
  createViewerHostBridgeDataSource,
  getViewerHostConfig
} from '../data/viewer-host-source.js';
import { viewerHostWords } from '../data/viewer-protocol.js';
import { installViewerHostChannel, installViewerHostSessionBundles } from './viewer-host/host-channel.js';
import { installViewerHostView } from './viewer-host/host-view.js';
import { dispatchFromControl } from './actions/control-dispatch.js';
import { viewNameOf } from './actions/targets/views.js';
import { createOpenCellsResize } from './open-cells-resize.js';
import {
  DataSourceError,
  isExplainedFailure
} from '../data/data-source.js';
import { ThemeManager } from '../utils/theme-manager.js';
import { afterWelcome } from '../utils/startup-sequence.js';
import { webStorage, STORAGE_NOT_KEPT } from '../utils/web-storage.js';
import { debug } from '../utils/debug.js';
import { getGitHubAuthSession } from './community-annotations/github-auth.js';
import {
  hideWelcomeModal,
  initKeyboardShortcuts,
  initWelcomeModal,
  provideShortcut,
  isWelcomeModalVisible,
  showWelcomeModal
} from './ui/onboarding/index.js';
import { publishWebBuildVersion } from './ui/core/build-version.js';
import { retireDeferredControls } from './ui/core/deferred-control-readiness.js';
import { DATA_LOAD_METHODS } from './data-load-methods.js';
import { analytics } from './optional-analytics.js';
import {
  classifySameOriginHealthAdvertisement,
  resolveStartupUrlIntent,
  refusedLaunchLink,
  isRefusedLaunchLink,
  LAUNCH_LINK_PARAMETERS,
  selectConnectedDatasetId,
  selectIntentDatasetId
} from './startup-url-intent.js';
import {
  normalizeStartupError,
  publishStartupFailure,
  requireBrowserFeatures
} from './startup-failure.js';
import {
  STARTUP_STALL_CODE,
  createStartupPhaseOwner
} from './startup-phase.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { PLACES } from './ui/place-names.js';
import { createStatusLine } from './ui/components/controls.js';
import { loadAppCode } from './app-code.js';
import { cancel, isCancellation, onAbort, quietUnhandledCancellations } from '../utils/abort.js';
import { failureDetails, joinFailure, sayFailure } from '../utils/errors.js';
import { promiseWithResolvers } from '../utils/promise-resolvers.js';

// The whole static graph has loaded, linked and run (a graph that fails to
// is reported by ui/core/code-load-watch.js, from index.html's boot script).
document.documentElement.dataset.codeStarted = 'true';

debug.log('Starting…');


/** The page chrome sessions and saved states carry outside the history. */
const PAGE_CHROME = Object.freeze({ capture: () => capturePageChrome(), plan: chrome => planPageChrome(chrome) });

// Requested before anything else so it loads in parallel with startup. It is
// never awaited: calls made before it arrives are queued, so it never blocks
// or breaks startup.
void analytics.load();
// A closed or crashed tab's spilled gene-column index (OPFS) is removed now,
// not only when this tab first spills one of its own; so are the stores a
// closed tab read single-stream files into (R objects, MatrixMarket folders).
void sweepAbandonedIndexes();
void sweepAbandonedTranscodes();

(async function bootstrap() {
  let statsEl = null;
  let destroyApplication = null;
  // The opening of the startup dataset, shown from the first moment.
  let startupOpening = null;
  // Lets the samples' listing go (`holdListingUntil`, below) once startup's dataset settles, and on
  // every other way out of startup (a failure, the page torn down first): a listing held past
  // startup would hold the teardown that waits for it.
  let releaseSampleListing = () => {};
  // Every startup await on the network runs through this owner: it publishes
  // `data-startup-phase` and bounds request/response steps with a deadline.
  const startup = createStartupPhaseOwner({
    root: document.documentElement
  });

  try {
    // A browser older than the platform features Cellucid calls is told so
    // now, not in the middle of its first opening.
    requireBrowserFeatures();
    ThemeManager.init();
    publishWebBuildVersion();

    const urlParams = new URLSearchParams(window.location.search);
    // A link Cellucid cannot read (a parameter twice, empty, or two sources
    // at once) is the link's problem: Cellucid starts without it, and its
    // opening card says what is wrong with it (below, `failStartupData`).
    let refusedLink = null;
    let startupIntent;
    let viewerHostConfig = null;
    try {
      try {
        viewerHostConfig = getViewerHostConfig();
      } catch (error) {
        throw refusedLaunchLink(
          'This link is the address of a viewer that Python or R opened, but its viewer fields are ' +
          'missing or changed; open the address the program printed.',
          error
        );
      }
      startupIntent = resolveStartupUrlIntent(urlParams, viewerHostConfig);
    } catch (error) {
      if (!isRefusedLaunchLink(error)) throw error;
      refusedLink = error;
      viewerHostConfig = null;
      startupIntent = resolveStartupUrlIntent(new URLSearchParams(), null);
    }
    const {
      remoteUrlParam,
      dataLinkParam,
      sourceParam,
      requestedDataset,
      isAnndataMode,
      inViewerHost
    } = startupIntent;
    // A refused link shows its refusal, not the welcome.
    const shouldShowWelcome = startupIntent.shouldShowWelcome && refusedLink === null;

    const canvas = document.getElementById('glcanvas');
    const labelLayer = document.getElementById('label-layer');
    const viewTitleLayer = document.getElementById('view-title-layer');
    statsEl = document.getElementById('stats');
    const themeSelect = document.getElementById('theme-select');
    const sidebar = document.getElementById('sidebar');
    const renderModeSelect = document.getElementById('render-mode');

    setDockableAccordions(initDockableAccordions({ sidebar, actions: getActions() }));

    // The notification center is created before the first yield below, so
    // whatever fails or reports from here on has somewhere to be announced.
    // (This code starts at DOMContentLoaded: the page boot imports it then.)
    const notifications = getNotificationCenter();
    notifications.init();
    // A cancellation is never a failure: one that reaches no handler (a
    // choice superseded by a newer one) is not a page error (`utils/abort.js`).
    quietUnhandledCancellations(window);

    // A subsample the link names (`subsample-url.js`): the linked dataset
    // opens with exactly it, overriding fitting to the device; a share also
    // applies to datasets opened next in this tab. A malformed one is said
    // by name, and the dataset opens as if it named none. Startup's opening
    // that never reached its reader leaves it to no later opening (below).
    let linkedCells = null;
    // A refused link's subsample belongs to no dataset (`refusedLink`).
    if (refusedLink === null) try {
      const linked = parseSubsampleUrlParameters(urlParams);
      if (linked !== null) {
        linkedCells = setNextCellSubsetRequest(linked);
        if (linked.mode === 'all' || linked.percent !== undefined) {
          setTabCellSubsetRequest(linked.mode === 'all' ? linked : { ...linked, strict: false });
        }
      }
    } catch (error) {
      notifications.error(`The link's cell subsample was left out: ${sayFailure(error)}`, { category: 'data', ...failureDetails(error) });
    }

    // The renderer and benchmark controls are wired at the far end of this
    // bootstrap, past every await below. They are painted and offered long
    // before that, so they are taken out of service here and admitted at the
    // one point where their listeners exist.
    const admitDeferredControls = retireDeferredControls(document);

    if (themeSelect instanceof HTMLSelectElement) {
      themeSelect.value = ThemeManager.getTheme();
      themeSelect.addEventListener('change', () => {
        ThemeManager.setTheme(themeSelect.value);
      });
    }

    initWelcomeModal();
    // A page opened to approve an agent's connection (the relay's link) goes
    // straight to that question (`app/agent/connect/`), without the welcome.
    if (shouldShowWelcome && !hasPendingConnectCode()) {
      showWelcomeModal();
    }
    // A browser that keeps nothing for this site (site data blocked, some
    // private windows) runs Cellucid for this visit only: said once, after
    // the welcome, so nothing kept is promised (`utils/web-storage.js`). A
    // full store is not this: what could not be kept says so itself (the
    // history's "no room left").
    if (webStorage('localStorage') === null) {
      void afterWelcome().then(() => notifications.info(STORAGE_NOT_KEPT, {
        category: 'data',
        duration: 0,
        title: 'Nothing is kept'
      }));
    }
    // The analysis panel and windows are imported on demand: requested now,
    // they load while the dataset opens, and the first view never waits for
    // their code (the page bundle keeps them in chunks of their own).
    const analysisCode = loadAppCode(() => import('./analysis/comparison-module.js'));
    // Its failure is handled where the panel starts, further down.
    analysisCode.catch(() => {});
    // The startup work before the first network wait (module evaluation, the
    // WebGL programs, the interface) would be one long task. It yields to
    // the event loop between its stages, so the page paints and answers
    // input between them (measured: 35_decisions_interface.md).
    await yieldToMacrotask();

    let ui = null;
    let sidebarLayout = null;
    /**
     * Removers of what is provided or installed here and outlives its call
     * (actions, reads, analyses, notices, the graphics-reset dialog, the
     * host's history events, keys): the application's teardown runs them.
     */
    const actionOwners = [];
    let comparisonModule = null;
    /** Withdraws the state domains' owners (`app/state/domains/`), once installed. */
    let uninstallStateDomains = null;
    // The history of the dataset shown (`history/dataset-history.js`), made
    // once the session owner exists (below): opened when a dataset is
    // published, begun once its starting view is applied, retired before any
    // other runtime is published and when the page is torn down. What it
    // changed is kept in this browser as it is made.
    let datasetHistories = null;
    /** Unwires the page from the memory model (`app/page-memory.js`), once wired. */
    let stopPageMemory = null;
    // The owner of every dataset change (`createLatestDatasetReloadCoordinator`),
    // once it exists.
    let datasetReloadCoordinator = null;
    // The owner of the live dataset publication's continuations
    // (`createLatestDatasetPublicationContinuationOwner`), once it exists.
    let datasetPublicationOwner = null;
    let applicationRetired = false;
    let stopPerfMonitoring = () => {};
    // What the start-up adds to the page itself (listeners on the window, the
    // document and the sidebar's controls) and its timers end with this
    // signal, which the application's teardown aborts: the page outlives the
    // application.
    const applicationEnd = new AbortController();
    const applicationSignal = applicationEnd.signal;

    debug.log('[Main] Creating viewer...');
    // Antialiasing is not a construction argument. It is a live setting owned by
    // `render-controls.js`, which reads the stored preference, resolves it
    // against each dataset as that dataset is published — see
    // `ui/core/antialias-preference.js`.
    const viewer = createViewer({
      canvas,
      labelLayer,
      viewTitleLayer
    });
    debug.log('[Main] Viewer created successfully');
    await yieldToMacrotask();

    // Expose viewer globally for dev tools (benchmark, debugging)
    window._cellucidViewer = viewer;

    // Browser page closure is not guaranteed to run asynchronous cleanup, so
    // publish one terminal owner as soon as the viewer exists. It remains
    // valid while the later UI and analysis owners are adopted, and always
    // fences the render loop and releases WebGL synchronously before its
    // returned task waits for asynchronous child teardown.
    /** Whether the application is torn down because the page is left. */
    let pageLeaving = false;
    destroyApplication = createStableTerminalDestroy({
      closeAdmission: () => {
        applicationRetired = true;
        cancel(applicationEnd, 'closed', 'The application was torn down.');
        releaseSampleListing();
        window.removeEventListener(
          'pagehide',
          retireApplicationOnPageHide
        );
        window.removeEventListener('beforeunload', warnBeforeLeavingUnkeptWork);
      },
      getOperations: () => [
        // The dataset change in flight is stopped first, so the owners
        // below wait only for work that has been told to stop: a read that
        // never answers cannot hold the teardown.
        ...(datasetReloadCoordinator === null
          ? []
          : [() => datasetReloadCoordinator.retire()]),
        // So does the work of the dataset on screen (its first frame to
        // record, its reads): its publication ends with the page's.
        ...(datasetPublicationOwner === null
          ? []
          : [() => datasetPublicationOwner.retire()]),
        // Nor can a reader worker that never leaves: every one still leaving,
        // or ended from now on, is ended from outside. A page being left
        // ends its workers itself, so a leaving one keeps what it fetched
        // until then.
        ...(pageLeaving ? [] : [() => retireAnnDataReaderWorkers()]),
        () => stopPerfMonitoring(),
        // Every action under way ends before the owners of its state go: it
        // records nothing and puts nothing back into a withdrawn owner.
        () => getActions().retire(),
        // So does the history: a start still under way reads the owners, and
        // once retired it ends without a tracker (its autosave writes what is
        // waiting).
        ...(datasetHistories === null ? [] : [() => datasetHistories.destroy()]),
        ...(uninstallStateDomains === null ? [] : [() => uninstallStateDomains()]),
        ...(comparisonModule === null
          ? []
          : [() => comparisonModule.destroy()]),
        ...(ui === null ? [] : [() => ui.destroy()]),
        ...actionOwners.splice(0).map(remove => () => remove()),
        ...(sidebarLayout === null ? [] : [() => sidebarLayout.destroy()]),
        ...(stopPageMemory === null ? [] : [() => stopPageMemory()]),
        () => viewer.dispose()
      ],
      failureMessage: 'Application teardown was incomplete.'
    });
    function retireApplicationOnPageHide(event) {
      if (event.persisted === true) return;
      pageLeaving = true;
      void destroyApplication().catch(error => {
        console.error('[Main] Application teardown failed:', error);
      });
    }
    window._cellucidDispose = destroyApplication;
    window.addEventListener('pagehide', retireApplicationOnPageHide);

    // The sidebar toggle is painted with the first frame, and on a phone it is
    // the only way out of the full-screen menu, so it works from now on rather
    // than from the end of the first dataset load.
    sidebarLayout = initSidebarLayout({ documentOwner: document, viewer, actions: getActions() });
    // Settings and layout are actions from here: what a person changes is
    // recorded, and an agent, a notebook or a replay changes it the same way.
    actionOwners.push(
      installSettingsActions({ sidebar, actions: getActions() }),
      installLayoutActions({
        actions: getActions(),
        dockable: getDockableAccordions(),
        describeSidebar: sidebarLayout.describeSidebar,
        themeSelect,
      })
    );

    const state = createDataState({ viewer, labelLayer });
    // A matrix read after its map: its pass said, its genes read on arrival.
    actionOwners.push(installMatrixShareNotices(state));

    // The page's side of the memory model (`app/page-memory.js`): other
    // Cellucid pages of this origin, what a hidden or frozen page gives back,
    // and the notice when memory runs short.
    stopPageMemory = initPageMemory({ notifications });
    // How many times the page was hidden: an opening measured across one is
    // not measured (`data/opening-cost.js`).
    let pageHiddenCount = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pageHiddenCount += 1;
    }, { signal: applicationSignal });
    debug.log('[Main] State created successfully');

    // Expose state globally for dev tools
    window._cellucidState = state;

    // Long reads of an AnnData file say how much is left while they run.
    actionOwners.push(showReadProgress({ notifications }));
    // Every opening is shown from its first moment: over the empty viewer
    // while no dataset is shown, as a notification with Cancel otherwise.
    actionOwners.push(showOpeningProgress({ hasDataset: () => state.pointCount > 0, notifications }));
    // A Google Drive or OneDrive file waiting on a sign-in says so, with its button.
    actionOwners.push(showSourceSignIn({ notifications }));
    // The startup dataset is being opened from now on: the layers that
    // resolve and read it join this opening, which ends once its first view
    // is drawn (or startup chose none).
    startupOpening = beginOpening({
      title: dataLinkParam
        ?? (remoteUrlParam !== null ? `the datasets at ${remoteUrlParam}` : null)
        ?? (inViewerHost ? "the viewer host's dataset" : null)
        // A sample is named by its catalog once that answers (`nameStartupOpening`), never by its id.
        ?? (requestedDataset !== null && sourceParam !== null ? requestedDataset : null)
        ?? 'the sample dataset',
      step: 'Starting Cellucid'
    });
    // Data the address names (`?data=`, `?remote=`, `?dataset=`) that does
    // not open leaves Cellucid running without it: the startup opening fails
    // over the empty viewer with one plain sentence, the failure's message
    // under Details, Try again, and Open without this link, which drops those
    // parameters from the address. Only a failure of the app itself is the
    // startup failure screen.
    let startupDataFailed = false;
    // The address parameters that name a startup dataset of each source.
    const STARTUP_LAUNCH_PARAMETERS = Object.freeze({
      link: ['data', 'dataset'],
      remote: ['remote', 'dataset'],
      'local-demo': ['sampleCatalog', 'dataset']
    });
    function failStartupData(error, summary, launchParameters) {
      startupDataFailed = true;
      console.error('[Main] The data the address names did not open:', error);
      // What the address asked for comes first; onboarding would cover it.
      if (isWelcomeModalVisible()) hideWelcomeModal();
      analytics.trackStartupFailure({ phase: startup.phase, error });
      const withoutLink = launchParameters.some(name => urlParams.has(name));
      // The reason itself is said; a refusal trying again cannot change
      // (a file without an embedding, a folder without datasets.json) leads
      // with opening Cellucid without the link.
      const { summary: said, settled } = describeOpeningFailure(summary, error, { withoutLink });
      const tryAgain = { label: 'Try again', run: () => window.location.reload() };
      const actions = [tryAgain];
      if (withoutLink) {
        const openWithout = {
          label: 'Open without this link',
          run: () => {
            const address = new URL(window.location.href);
            for (const name of launchParameters) address.searchParams.delete(name);
            window.history.replaceState(window.history.state, '', address);
          }
        };
        if (settled) actions.unshift(openWithout);
        else actions.push(openWithout);
      }
      startupOpening.fail(error, { summary: said, actions });
    }
    if (refusedLink !== null) {
      failStartupData(refusedLink, 'Cellucid could not read this link.', LAUNCH_LINK_PARAMETERS);
    }

    // Construct the optional GitHub annotation session inside the startup
    // boundary so storage/configuration failures cannot leave a blank page.
    const githubAuthSession = getGitHubAuthSession();
    try {
      const signInResult = await startup.step(
        'sign-in',
        'the GitHub sign-in exchange',
        () => githubAuthSession.completeSignInFromRedirect()
      );
      if (signInResult !== null) {
        notifications.success(
          `Signed in with GitHub as @${signInResult.user.login}.`,
          {
            category: 'annotation',
            duration: 2800
          }
        );
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new TypeError(
          'GitHub redirect completion rejected with a non-Error value.'
        );
      }
      console.error('[GitHubAuth] Redirect completion failed:', error);
      notifications.error(`${joinFailure(`GitHub sign-in did not finish`, sayFailure(error))}`, {
        category: 'annotation',
        duration: 8000,
        ...failureDetails(error),
      });
    }

    // Initialize DataSourceManager
    const dataSourceManager = getDataSourceManager();
    // A page kept for going back (`pagehide` persisted) is not torn down:
    // what the history changed and is still waiting is written now.
    window.addEventListener('pagehide', () => { void datasetHistories?.flush(); });
    // Work on the dataset shown that this browser is not keeping (Autosave
    // off, no storage, no room) is asked about before any other dataset
    // replaces it and before the page is left (`app/unkept-work-guard.js`,
    // made once the history exists, below).
    /** @type {ReturnType<typeof createUnkeptWorkGuard>|null} */
    let unkeptWorkGuard = null;
    function warnBeforeLeavingUnkeptWork(event) {
      unkeptWorkGuard?.onBeforeUnload(event);
    }
    window.addEventListener('beforeunload', warnBeforeLeavingUnkeptWork);
    /**
     * Before the dataset shown is replaced or closed: the person (or, for an
     * agent's opening, its consent path) is asked when work on it is not
     * kept. Kept, the change ends as cancelled and the dataset shown stays.
     */
    async function confirmDatasetReplacement(transaction, change) {
      try {
        await unkeptWorkGuard?.confirmReplacement(change);
      } catch (error) {
        if (isCancellation(error)) transaction.cancel();
        throw error;
      }
      transaction.assertCurrent();
    }
    datasetReloadCoordinator = createLatestDatasetReloadCoordinator(
      () => {
        const source = dataSourceManager.activeSource;
        if (source === null) {
          return {
            source: null,
            baseUrl: null,
            datasetId: null,
            selectionIdentity: null
          };
        }
        const sourceType = dataSourceManager.getCurrentSourceType();
        return {
          source,
          baseUrl: dataSourceManager.getCurrentBaseUrl(),
          datasetId: dataSourceManager.getCurrentDatasetId(),
          selectionIdentity: sourceType === 'local-user'
            ? source.getAdoptionIdentity()
            : null
        };
      }
    );
    // The one dataset startup opens. The catalog phase below only resolves
    // it; it is loaded once the interface and every control exist, through
    // the same dataset-change transaction as every later choice, so a choice
    // the user makes while it is still loading replaces it instead of being
    // discarded behind it. When two startup intents resolve, the later one is
    // the selection, exactly as successive switches would have left it.
    let startupSelection = null;
    /**
     * Name startup's opening as its catalog names the dataset (`datasets.json`'s
     * `name`), as soon as the catalog has answered and before any file of it
     * is read: "Opening Developing human gonad (Garcia)", never the id
     * ("Opening garcia") while it opens. A catalog without names keeps the
     * title; the dataset's own name follows once read (`named`).
     */
    async function nameStartupOpening(source, datasetId) {
      if (typeof source?.listCatalogEntries !== 'function') return;
      try {
        const entry = (await source.listCatalogEntries()).find(each => each.id === datasetId);
        if (entry !== undefined && entry.name !== datasetId && !startupOpening.cancelled) startupOpening.rename(entry.name);
      } catch {
        // The catalog's failure is said where it is read (the picker, the opening).
      }
    }

    /**
     * @param {string} sourceType
     * @param {string} datasetId
     * @param {string} loadMethod
     * @param {ReadonlyArray<{id: string, name: string}>|null} [listed] - The
     *   source's listing it was chosen from: the opening is labeled with the
     *   name the dataset is listed under (the Dataset box's), not its id.
     */
    function selectStartupDataset(sourceType, datasetId, loadMethod, listed = null) {
      for (const [label, value] of [
        ['source type', sourceType],
        ['id', datasetId],
        ['load method', loadMethod]
      ]) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new TypeError(
            `Startup dataset ${label} must be a non-empty string.`
          );
        }
      }
      const name = listed?.find(dataset => dataset.id === datasetId)?.name ?? null;
      startupSelection = Object.freeze(
        typeof name === 'string' && name.length > 0
          ? { datasetId, loadMethod, name, sourceType }
          : { datasetId, loadMethod, sourceType }
      );
      debug.log(
        `[Main] Startup dataset selection: ${sourceType}/${datasetId}`
      );
    }
    analytics.init();
    const startPerfAnalytics = () => {
      analytics.startPerformance({ dataSourceManager });
    };
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(startPerfAnalytics, { timeout: 2000 });
      onAbort(applicationSignal, () => window.cancelIdleCallback(idle));
    } else {
      const timer = setTimeout(startPerfAnalytics, 1200);
      onAbort(applicationSignal, () => clearTimeout(timer));
    }

    // The page's keys and the Keyboard shortcuts panel, from one table
    // (`ui/onboarding/shortcut-table.js`); each module provides its keys'
    // commands once its controls exist.
    initKeyboardShortcuts();

    // Always register the user directory source through browser-independent file inputs.
    const userSource = createLocalUserDirDataSource();
    dataSourceManager.registerSource('local-user', userSource);

    // Register remote server source
    const remoteSource = createRemoteDataSource();
    dataSourceManager.registerSource('remote', remoteSource);

    // Check if a viewer host (Python, Jupyter or R) opened this page
    let viewerHostSource = null;
    // What the person makes, published to the host (app/viewer-host/results.js).
    let viewerHostResults = null;
    /** The open cells grown or cut in place (`open-cells-resize.js`), once the UI is up. */
    let openCellsResize = null;
    /**
     * The progressive opening growing now: its source and its publication's
     * signal. A page put in the back/forward cache ends its reader (the
     * growth step under way ends as a cancellation); back, growth resumes
     * from the cells open (`grow` skips the steps reached).
     */
    let resumableGrowth = null;
    window.addEventListener('pageshow', event => {
      if (event.persisted !== true || resumableGrowth === null || openCellsResize === null) return;
      const { shown, signal } = resumableGrowth;
      if (signal.aborted || shown !== shownAnnDataSource() || openCellsResize.growing) return;
      const target = shown.getCellSubset?.()?.growth?.target ?? null;
      if (target !== null && state.pointCount < target) void openCellsResize.grow(shown, signal);
    }, { signal: applicationSignal });
    /** The AnnData source of the dataset shown, or null. */
    const shownAnnDataSource = () => {
      const sourceType = dataSourceManager.getCurrentSourceType?.() ?? null;
      const datasetId = dataSourceManager.getCurrentDatasetId?.() ?? null;
      if (sourceType === null || datasetId === null) return null;
      return dataSourceManager.getSource(sourceType)?.getAnnDataSource?.(datasetId) ?? null;
    };
    if (inViewerHost) {
      debug.log('[Main] Detected a viewer host, initializing the viewer channel...');
      viewerHostSource = createViewerHostBridgeDataSource(viewerHostConfig);
      dataSourceManager.registerSource('jupyter', viewerHostSource);

      // A notebook widget's viewer waits for the widget to connect it: the
      // kernel answers between cells, so this wait has no deadline.
      startup.enter('health');
      await viewerHostSource.connectHost();
      const viewerHostInitialized = await startup.step(
        'health',
        "the viewer's host",
        signal => viewerHostSource.initialize({ signal })
      );
      if (viewerHostInitialized !== true) {
        throw new Error(
          'Viewer host context must initialize one authenticated Python server'
        );
      }
      debug.log('[Main] viewer channel initialized successfully');

      if (viewerHostConfig === null) {
        throw new Error(
          'Initialized viewer host mode requires its authenticated configuration'
        );
      }

      // The view of the host viewer: its end and its pointer hooks.
      installViewerHostView({
        viewerHostSource,
        viewer,
        canvas,
        notifications,
        destroyApplication,
        applicationSignal
      });

      const viewerHostDatasets = await startup.step(
        'catalog',
        "the viewer host's dataset",
        () => viewerHostSource.listDatasets()
      );
      const viewerHostDatasetId = selectIntentDatasetId(
        viewerHostDatasets,
        requestedDataset,
        `The viewer of ${viewerHostWords(viewerHostSource.getHostRuntime()).name}`
      );
      selectStartupDataset(
        'jupyter',
        viewerHostDatasetId,
        DATA_LOAD_METHODS.VIEWER_HOST_AUTO,
        viewerHostDatasets
      );
    }

    // An explicit remote URL: a server that cannot be reached, or that does
    // not hold the requested dataset, leaves Cellucid running without it.
    if (remoteUrlParam !== null) {
      debug.log(`[Main] Remote server URL from param: ${remoteUrlParam}`);
      // Spelled as the address bar spells a server: a trailing slash
      // or an upper-case scheme is the same server.
      const remoteServer = canonicalServerAddress(remoteUrlParam);
      try {
        try {
          validateRemoteServerUrl(remoteServer);
        } catch (error) {
          throw refusedLaunchLink(
            'This link\'s "remote" is not a server address: a server is one web address, such as ' +
            'http://localhost:8765 (what `cellucid serve` prints).',
            error
          );
        }
        await startup.step(
          'health',
          remoteServer,
          () => remoteSource.connect({ url: remoteServer })
        );
        if (remoteSource.isConnected() !== true) {
          throw new Error(
            'The requested remote source did not publish a connected state.'
          );
        }
        const remoteDatasets = await startup.step(
          'catalog',
          remoteServer,
          () => remoteSource.listDatasets()
        );
        const remoteDatasetId = selectIntentDatasetId(
          remoteDatasets,
          requestedDataset,
          'The server this link names'
        );
        selectStartupDataset(
          'remote',
          remoteDatasetId,
          DATA_LOAD_METHODS.REMOTE_URL_PARAM,
          remoteDatasets
        );
      } catch (error) {
        failStartupData(
          error,
          'Cellucid could not open the server this link points to.',
          ['remote', 'dataset']
        );
      }
    }

    // Auto-connect to a same-origin Cellucid server when the web app is being
    // served by the Python package itself (CLI/Python server mode).
    //
    // Without this, the app may auto-load the demo dataset and ignore the
    // server-hosted dataset, especially when a sample catalog is configured.
    if (
      !startupDataFailed &&
      !inViewerHost &&
      remoteUrlParam === null &&
      (sourceParam === null || sourceParam === 'remote')
    ) {
      // A link asking for the server this page comes from, on a page no
      // server serves: the link's refusal, said on its opening card.
      const notServed = refusedLaunchLink(
        'This link asks for the Cellucid server this page comes from ("source=remote" or "anndata=true"), ' +
        'but no Cellucid server serves this page; open the address `cellucid serve` printed.'
      );
      const protocol = window.location.protocol;
      if (protocol !== 'http:' && protocol !== 'https:') {
        if (sourceParam === 'remote' || isAnndataMode) {
          failStartupData(notServed, 'Cellucid could not read this link.', LAUNCH_LINK_PARAMETERS);
        }
      } else {
        const selfBase = new URL('.', window.location.href)
          .toString()
          .replace(/\/$/, '');
        const healthUrl = `${selfBase}/_cellucid/health`;
        const healthResponse = await startup.step(
          'health',
          healthUrl,
          signal => fetch(healthUrl, { cache: 'no-store', signal })
        );
        if (
          healthResponse.status === 404 &&
          sourceParam === null &&
          !isAnndataMode
        ) {
          debug.log(
            '[Main] Current origin does not advertise a Cellucid server.'
          );
        } else if (healthResponse.status === 404) {
          // The link asks for this page's server, and no server answers.
          failStartupData(notServed, 'Cellucid could not read this link.', LAUNCH_LINK_PARAMETERS);
        } else {
          if (!healthResponse.ok) {
            throw new Error(
              `Same-origin Cellucid health request failed with HTTP ` +
              `${healthResponse.status}.`
            );
          }
          const healthAdvertisement = await startup.step(
            'health',
            healthUrl,
            () => healthResponse.json()
          );
          const healthKind = classifySameOriginHealthAdvertisement(
            healthAdvertisement
          );
          if (healthKind === 'static') {
            if (sourceParam === 'remote' || isAnndataMode) {
              failStartupData(notServed, 'Cellucid could not read this link.', LAUNCH_LINK_PARAMETERS);
            }
            debug.log(
              '[Main] Current origin advertises the static Cellucid viewer.'
            );
          } else {
            debug.log(
              `[Main] Cellucid server endpoint detected at ${selfBase}; ` +
              'validating the complete remote contract.'
            );
            await startup.step(
              'health',
              selfBase,
              () => remoteSource.connect({ url: selfBase })
            );
            if (remoteSource.isConnected() !== true) {
              throw new Error(
                'Same-origin Cellucid source did not publish a connected state.'
              );
            }
            const datasets = await startup.step(
              'catalog',
              selfBase,
              () => remoteSource.listDatasets()
            );
            const remoteDatasetId = selectConnectedDatasetId(
              datasets,
              requestedDataset,
              'This Cellucid server'
            );
            if (remoteDatasetId === null) {
              notifications.info(
                `Connected to ${datasets.length} server datasets. Choose one ` +
                `from Sample datasets.`,
                {
                  category: 'connectivity',
                  duration: 0,
                  title: 'Choose a dataset'
                }
              );
            } else {
              selectStartupDataset(
                'remote',
                remoteDatasetId,
                DATA_LOAD_METHODS.SERVER_AUTO,
                datasets
              );
            }
          }
        }
      }
    }

    // Register current sources before resolving the exact startup selection.
    await startup.step(
      'catalog',
      'the dataset source registry',
      () => dataSourceManager.initialize({
        // Viewer host mode owns one authenticated dataset source, so it
        // does not register the unrelated sample catalog.
        registerDemoCatalog: !inViewerHost
      })
    );

    const useDefaultDemo =
      !startupDataFailed
      && !inViewerHost
      && remoteUrlParam === null
      && dataLinkParam === null
      && requestedDataset === null
      && (sourceParam === null || sourceParam === 'local-demo')
      && startupSelection === null;
    // The default sample's catalog is asked when startup awaits it, once the
    // interface is live, just before startup loads it: the question below
    // waits for the bootstrap's next yield, and on the default path nothing
    // yields before that await. The data controls never wait for a list of
    // samples the person may not want (a file of their own, a link or a
    // dropped folder open from the first moment), and a choice they make
    // while the catalog answers is the one that opens.
    let defaultSample = null;
    // The samples' files are read for the picker's names and counts only
    // once startup's dataset has settled (`holdListingUntil`): the listing,
    // asked for as the interface is built, would otherwise read them against
    // that dataset's first view.
    const sampleSource = dataSourceManager.getSource('local-demo');
    if (typeof sampleSource?.holdListingUntil === 'function') {
      const listing = promiseWithResolvers();
      releaseSampleListing = listing.resolve;
      sampleSource.holdListingUntil(listing.promise);
    }
    if (useDefaultDemo) {
      const localDemoSource = dataSourceManager.getSource('local-demo');
      if (
        localDemoSource === null
        || typeof localDemoSource.isAvailable !== 'function'
        || typeof localDemoSource.getDefaultDatasetId !== 'function'
      ) {
        throw new TypeError(
          'Default sample startup requires the registered catalog default owner.'
        );
      }
      const answer = Promise.resolve().then(() => localDemoSource.isAvailable());
      // Awaited below; a failure is handled there.
      answer.catch(() => {});
      defaultSample = {
        catalog: localDemoSource.catalogUrl ?? 'the sample catalog',
        answer,
        defaultDatasetId: () => localDemoSource.getDefaultDatasetId()
      };
    }

    // A data link in the query (?data=): GitHub, CELLxGENE, GEO, any web
    // address. Must be after initialize(), which registers the link source.
    let linkConnection = null;
    if (dataLinkParam !== null) {
      debug.log(`[Main] Data link from param: ${dataLinkParam}`);
      const linkSource = dataSourceManager.getSource('link');
      if (linkSource === null) {
        throw new Error(
          'Data link startup requires the registered link source.'
        );
      }
      // Opening a linked file reads as much of it as the first view needs,
      // which grows with the file: the step stalls only when no byte arrives
      // for a whole deadline, as the Transfers log records them; while it
      // waits on the person (a sign-in, Google's file picker), the clock
      // stands still (`startup-phase.js`).
      try {
        linkConnection = await startup.step(
          'catalog',
          dataLinkParam,
          () => linkSource.connect(dataLinkParam),
          {
            progress: onProgress => getTransferLog().subscribe(onProgress),
            doing: 'opening the data link'
          }
        );
      } catch (error) {
        // Canceled while it opened: Cellucid starts without a dataset, as it
        // does when the link did not open.
        if (!startupOpening.cancelled) {
          failStartupData(
            error,
            'Cellucid could not read the data this link points to.',
            ['data', 'dataset']
          );
        }
      }
    }
    if (linkConnection !== null) {
      if (
        typeof linkConnection !== 'object' ||
        Array.isArray(linkConnection) ||
        !Object.hasOwn(linkConnection, 'datasets')
      ) {
        throw new TypeError(
          'Link source connection must publish its dataset inventory.'
        );
      }
      // Without `dataset=`, a link opens on the dataset its catalog names as
      // its default, as the sample catalog does.
      try {
        const linkDatasetId = selectIntentDatasetId(
          linkConnection.datasets,
          requestedDataset ?? linkConnection.defaultDatasetId,
          'The data this link points to'
        );
        selectStartupDataset(
          'link',
          linkDatasetId,
          DATA_LOAD_METHODS.DATA_URL_PARAM,
          linkConnection.datasets
        );
      } catch (error) {
        failStartupData(
          error,
          'This link does not hold the dataset it names.',
          ['data', 'dataset']
        );
      }

      const dataLinkInput = document.getElementById('data-address');
      if (!(dataLinkInput instanceof HTMLInputElement)) {
        throw new Error(
          'Data link startup requires the address bar.'
        );
      }
      // The link as it is read, access key included: the address bar and
      // this field are the two places it is kept.
      dataLinkInput.value = dataSourceManager.getSource('link').getAddressLocator();
    }

    // Check URL parameters for dataset selection
    // Only process if we haven't already connected via remote/jupyter/a link
    const requestedSource = sourceParam === null
      ? 'local-demo'
      : sourceParam;
    const currentSourceType = startupSelection?.sourceType ?? null;
    // A link names its own dataset (`dataset=` picks one of its catalog's),
    // also when its opening was cancelled.
    const skipUrlDataset = currentSourceType === 'remote' || currentSourceType === 'jupyter' || dataLinkParam !== null;

    if (requestedDataset !== null && !skipUrlDataset && !startupDataFailed) {
      const targetSource = dataSourceManager.getSource(requestedSource);
      if (targetSource === null) {
        throw new Error(
          `Requested source '${requestedSource}' is not registered.`
        );
      }
      if (typeof targetSource.hasDataset !== 'function') {
        throw new TypeError(
          `Requested source '${requestedSource}' must implement hasDataset().`
        );
      }
      const requestedCatalog = `the ${requestedSource} dataset catalog`;
      try {
        const requestedExists = await startup.step(
          'catalog',
          requestedCatalog,
          () => targetSource.hasDataset(requestedDataset)
        );
        if (!requestedExists) {
          throw refusedLaunchLink(
            `This link names the dataset "${requestedDataset}", which ${requestedSource === 'remote' ? 'this Cellucid server does not hold' : 'is not one of the sample datasets'}.`
          );
        }
        await nameStartupOpening(targetSource, requestedDataset);
        selectStartupDataset(
          requestedSource,
          requestedDataset,
          DATA_LOAD_METHODS.DATASET_URL_PARAM
        );
      } catch (error) {
        failStartupData(
          error,
          'The dataset this link names could not be found.',
          // A link's own sample catalog that cannot be used goes with it.
          error?.details?.parameter === 'sampleCatalog' ? STARTUP_LAUNCH_PARAMETERS['local-demo'] : ['dataset']
        );
      }
    }

    // What the publication reads of the parts made after it.
    const getUi = () => ui;
    const getDatasetHistories = () => datasetHistories;
    const getViewerHostResults = () => viewerHostResults;
    const getComparisonModule = () => comparisonModule;

    // The runtime shown and its publication (`dataset/publication.js`). Its
    // continuation owner exists first, so a teardown while it is made retires it.
    datasetPublicationOwner = createLatestDatasetPublicationContinuationOwner();
    const datasetPublication = createDatasetPublication({
      state,
      viewer,
      notifications,
      statsEl,
      datasetPublicationOwner,
      viewerHostSource,
      shownAnnDataSource,
      initializeConnectivityControls: graph => initializeConnectivityControls({
        viewer,
        state,
        notifications,
        dataSourceManager,
        userSource,
        applicationSignal,
        onEdgesShown: edges => ui.showLoadedConnectivityEdges(edges),
        ...graph
      }),
      getUi,
      getDatasetHistories,
      getViewerHostResults,
      getComparisonModule
    });
    const {
      runtimeRetirementOwner,
      connectivityRuntimeOwner,
      publicationHasCells,
      retireReplacedDimensionManager,
      retireInProgressHighlightSelection,
      completePublishedMapping,
      commitSyntheticRuntimeStage,
      restorePreviousRuntime,
      assertCurrentDatasetPublication,
      retireKeptViews,
      getDatasetBaseUrl,
      getDimensionManager,
      getActiveStage,
      getActivePublication,
      getPublicationGeneration,
      adoptStage
    } = datasetPublication;

    // What a dataset change reads of the parts made after it, and the growth
    // it starts, for the page shown again (`pageshow`, above).
    const getOpenCellsResize = () => openCellsResize;
    const getPageHiddenCount = () => pageHiddenCount;
    const onGrowthStarted = growth => {
      resumableGrowth = growth;
    };

    // One-time helper to rebuild density from current visibility + grid
    const rebuildSmokeDensity = createSmokeDensityRebuild({ state, viewer });

    // Smoke volume is built lazily when switching to smoke mode
    // (no initial build to save startup time)

    // Session files hold the history of the dataset shown (format 4).
    const sessionSerializer = createSessionSerializer({
      state,
      dataSourceManager,
      getHistory: () => datasetHistories?.current() ?? null,
      dispatcher: getActions(),
      // A loaded session plays its camera path when it was saved with Autoplay on.
      onLoaded: () => { ui?.cinematicCamera?.startAutoplay(); },
      // The page chrome sessions carry outside the history: the selection tool.
      chrome: PAGE_CHROME,
    });
    datasetHistories = createDatasetHistories({
      dispatcher: getActions(),
      domains: getStateDomains(),
      notifications,
      header: () => sessionSerializer.captureSessionHeader(),
      loadSavedHistory: (open, options) => sessionSerializer.loadSavedHistory(open, options),
      // A saved state opens its dataset first, as a session file does (the session controls).
      openSavedState: (id, options) => ui.openSavedState(id, options),
      chrome: PAGE_CHROME,
    });
    unkeptWorkGuard = createUnkeptWorkGuard({
      unkept: () => datasetHistories?.unkept() ?? null,
      ask: ({ title, message }) => new Promise(resolve => {
        showConfirmDialog({
          title,
          message,
          confirmText: 'Open anyway',
          alternativeText: 'Save…',
          onConfirm: () => resolve('open'),
          onAlternative: () => resolve('save'),
          onCancel: () => resolve('cancel'),
        });
      }),
      // The history's Save file dialog (State › Session).
      save: () => document.getElementById('history-share-btn')?.click(),
    });
    // The history written down or read out (methods, pseudocode, saved states, Share, Save in this browser).
    actionOwners.push(providePersistenceActions({
      dispatcher: getActions(),
      histories: datasetHistories,
      serializer: sessionSerializer,
      datasetFacts: datasetFactsOf({ state, dataSourceManager }),
      citation: cellucidCitationReader(),
      download: (blob, filename) => downloadBlob(blob, filename),
    }));
    // "Save AnnData with this state…": a new .zarr.zip of the dataset with the state shown applied.
    actionOwners.push(provideAnnDataCopyAction({
      dispatcher: getActions(),
      histories: datasetHistories,
      serializer: sessionSerializer,
      state,
      adapter: () => shownAnnDataSource()?.getAdapter?.() ?? null,
      datasetFacts: datasetFactsOf({ state, dataSourceManager }),
      // The dataset's own file, when it was opened from this computer: a copy never goes over it.
      sourceHandle: async () => {
        const datasetId = dataSourceManager.getCurrentDatasetId?.() ?? null;
        const kept = datasetId === null ? null : await keptLocalFile(datasetId);
        return kept?.kind === 'file' ? kept.handle : null;
      },
      createSpool,
      download: (blob, filename) => downloadBlob(blob, filename),
      notifications,
    }));
    // What a re-read of the open dataset with other cells keeps (Cells to open).
    const viewCarry = createViewCarry({ domains: getStateDomains() });
    // A graphics reset keeps everything in the page; the session is
    // captured at the loss in case the context does not come back.
    actionOwners.push(keepSessionThroughGraphicsReset({ viewer, sessionSerializer, notifications }));
    // The catalog's starting view of each dataset published (`published-state.js`).
    const {
      cancelPublishedDatasetStateAndWait,
      restoreAdvertisedDatasetState
    } = createPublishedDatasetState({
      dataSourceManager,
      sessionSerializer,
      notifications,
      getUi: () => ui,
      getPublicationRevision: getPublicationGeneration
    });

    // -----------------------------------------------------------------------
    // Session capture for the host ("no download"): the bundle goes to the
    // host on the viewer channel.
    // -----------------------------------------------------------------------
    if (viewerHostSource) {
      installViewerHostSessionBundles({ viewerHostSource, sessionSerializer });
    }

    // Every change of the dataset shown (`dataset/reload.js`), made here: the
    // histories exist, and the interface below takes two of them.
    const { reloadActiveDatasetShown, clearActiveDatasetInPlace } = createDatasetChanges({
      state,
      viewer,
      notifications,
      dataSourceManager,
      startup,
      startupOpening,
      datasetHistories,
      confirmDatasetReplacement,
      shownAnnDataSource,
      cancelPublishedDatasetStateAndWait,
      restoreAdvertisedDatasetState,
      getUi,
      getComparisonModule,
      getOpenCellsResize,
      getPageHiddenCount,
      onGrowthStarted,
      datasetPublication
    });

    startup.enter('ui');
    ui = initUI({
      state,
      viewer,
      smoke: {
        rebuildSmokeDensity
      },
      clearActiveDataset: clearActiveDatasetInPlace,
      reloadActiveDataset: reloadActiveDatasetShown,
      resizeOpenCells: options => {
        if (openCellsResize === null) throw new Error('The open cells cannot be resized before the app has started.');
        return openCellsResize.resize(options);
      },
      datasetChanges: datasetReloadCoordinator,
      sessionSerializer,
      datasetHistories,
      viewCarry,
      dataSourceManager,
      viewerHostSource
    });
    window._cellucidUi = ui;
    window._cellucidHistories = datasetHistories;
    // What an agent, a notebook or a test reads of the open dataset.
    actionOwners.push(installReadActions({
      actions: getActions(),
      state,
      viewer,
      dataSourceManager,
      documentRef: document,
      getFigureExport: () => ui?.figureExport ?? null
    }));
    // The data controls are live from here: a dataset the person chooses
    // from now on decides what startup opens (`defaultSample`).
    const controlsLiveAt = datasetReloadCoordinator.actionSequence;
    // The open cells grown or cut in place: Apply of a larger or smaller
    // share of the same method and seed, and a progressive opening's steps
    // (`open-cells-resize.js`).
    openCellsResize = createOpenCellsResize({
      state,
      viewer,
      notify: (text, { level = 'info', action = null, details = '' } = {}) => notifications[level](text, {
        category: 'data',
        ...(action === null ? {} : { action }),
        ...(details === '' ? {} : { details }),
      }),
      onProgress: progress => ui.showOpenCellsGrowth?.(progress),
      runtime: {
        // The cells added: rows of an embedding's positions, in the frame
        // shown (`loadCoordinateRows`), and the dataset's generation again.
        readPositionRows: ({ path, dimension, rows, signal }) => loadCoordinateRows('embedding', `${getDatasetBaseUrl()}${path}`, { dimension, rows, signal }),
        loadGeneration: ({ expectedIdentityId, signal }) => loadDatasetGeneration(getDatasetBaseUrl(), { expectedIdentityId, signal }),
        stage: () => getActiveStage(),
        adoptStage,
        retireKeptViews,
        retireSelections: retireInProgressHighlightSelection,
        keptViews: { capture: () => viewCarry.captureKeptViews(), restore: record => viewCarry.restore(record) },
        connectivity: {
          getConnectivityGraph: connectivityRuntimeOwner.getConnectivityGraph,
          replaceConnectivityGraph: connectivityRuntimeOwner.replaceConnectivityGraph,
          retireGraphKeepingChoices: connectivityRuntimeOwner.retireGraphKeepingChoices,
          loadSummary: (url, signal) => loadConnectivitySummary(url, { signal })
        },
        // Analyses' cached cell lists and gene columns are of the earlier
        // cells; their windows stay, their results marked stale.
        invalidateAnalysisData: () => comparisonModule?.dataLayer?.resetForDatasetReload?.(),
        loadMappingCandidates: signal => loadMappingCandidates(`${getDatasetBaseUrl()}${MAPPING_CANDIDATES_ROUTE}`, { signal }),
        completeMappingCandidates: () => completePublishedMapping(getActiveStage()),
        adoptMetadata: metadata => dataSourceManager.adoptResizedMetadata(metadata),
        afterResize: async () => {
          ui.refreshOpenCells(dataSourceManager.getCurrentMetadata());
          // My datasets keeps the cells it is open with now.
          void recordDatasetOpened(dataSourceManager, { counted: false });
          if (viewerHostResults !== null) await viewerHostResults.resync();
        }
      }
    });
    // The runtime publications made before the interface existed reached no
    // UI: it is told the current state now.
    ui.publishCellPresence(publicationHasCells(getActivePublication()));

    if (viewerHostSource !== null) {
      const viewerHostChannel = installViewerHostChannel({
        viewerHostSource,
        state,
        dataSourceManager,
        sessionSerializer,
        datasetHistories,
        agentPresence: ui.agents?.presence ?? null
      });
      viewerHostResults = viewerHostChannel.results;
      actionOwners.push(viewerHostChannel.stop);
    }

    // The analysis panel and windows start once their code has arrived
    // (`analysisCode`), without holding the rest of startup: the viewer and
    // the sidebar are usable at once, and the panel says its tools are
    // loading until then. The `analysis` and `layout` state domains read them
    // as they are now (`analysisShown`, null until the code has arrived and
    // when it could not load) and never wait for them to capture, so the
    // history starts and records while the code loads; a restore that shows
    // analyses waits for `analysisRefs`. The history, a session file and a
    // re-read of the open cells (`session/view-carry.js`) carry them once
    // they exist.
    const pageAnalysisSection = document.getElementById('page-analysis-section');
    const analysisStatus = createStatusLine({ text: 'Loading the analysis tools…' });
    pageAnalysisSection?.querySelector('.accordion-content')?.append(analysisStatus.root);
    let analysisShown = null;
    const analysisRefs = analysisCode.then(({ createComparisonModule }) => {
      if (applicationRetired || pageAnalysisSection === null) return null;
      comparisonModule = createComparisonModule({
        state,
        container: pageAnalysisSection,
        colorByGene: ui.colorByGene
      });
      // Store reference for potential external access
      window._comparisonModule = comparisonModule;
      // The analyses as actions; their results name the dataset they are of.
      actionOwners.push(installAnalysisActions({
        actions: getActions(),
        comparisonModule,
        dockable: getDockableAccordions(),
        section: pageAnalysisSection,
        describeOpenDataset: () => describeOpenDataset(dataSourceManager)
      }));
      const analysisWindowManager = comparisonModule.getAnalysisWindowManager();
      analysisStatus.root.remove();
      analysisShown = { comparisonModule, analysisWindowManager };
      return analysisShown;
    }).catch(error => {
      // A load the page's leaving cut off (`loadAppCode`) is no failure.
      if (isCancellation(error)) return null;
      console.error('[Main] The analysis tools could not load:', error);
      analysisStatus.set('The analysis tools could not load. Reload the page to try again.', 'danger');
      notifications.error(
        `The analysis tools could not load, so the ${PLACES.analysis.name} panel cannot be used. Reload the page to try again.`,
        { category: 'analysis', title: 'Analysis unavailable' }
      );
      return null;
    });

    // Every state domain's owner (`app/state/domains/`): what the history,
    // the session file and the state fingerprint read and put back.
    uninstallStateDomains = installStateDomains({
      state,
      viewer,
      sidebar,
      refreshUi: ui.refreshUiAfterStateLoad,
      cinematicCamera: ui.cinematicCamera,
      figureExport: ui.figureExport,
      analysis: () => analysisShown,
      analysisArrived: () => analysisRefs,
      getDockable: getDockableAccordions,
      openCells: ui.openCells,
      sidebarLayout,
    });

    const isApplicationRetired = () => applicationRetired;

    // ========================================
    // PERFORMANCE BENCHMARK CONTROLS
    // ========================================
    const benchmark = initBenchmarkControls({
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
    });
    stopPerfMonitoring = benchmark.stopPerfMonitoring;

    // Every renderer and benchmark listener above now exists, so the controls
    // they act on can be offered. Nothing between here and the retirement at
    // the top of this bootstrap may read those controls as accepted state.
    admitDeferredControls();

    // The keys of the controls that exist now (`shortcut-table.js`). H: as
    // the sidebar's toggle (its action).
    actionOwners.push(provideShortcut('sidebar.toggle', () => {
      document.getElementById('sidebar-toggle')?.click();
    }));

    // 1, 2 and 3: the dimension's default in the selected view, then each of
    // its other enabled representations in turn.
    actionOwners.push(provideShortcut('representation.cycle', (dim) => {
      void ui?.cycleRepresentation?.(dim);
    }));

    // X and O, P, G: actions, as the Clear button and the navigation select.
    actionOwners.push(provideShortcut('highlights.clear', () => {
      const page = state.getActivePage();
      if (page === null || page.highlightedGroups.length === 0) return;
      void dispatchFromControl(
        'highlight.page.clear',
        { page: page.name },
        { failure: 'Clearing the highlight page failed', category: 'highlight' }
      );
    }));

    actionOwners.push(provideShortcut('navigation.set', (mode) => {
      void dispatchFromControl(
        'camera.navigation.set',
        { view: viewNameOf(viewer, viewer.getFocusedViewId()), mode },
        { failure: 'Changing the navigation mode failed', category: 'render' }
      );
    }));

    viewer.start();

    // Every control and the render loop now exist, so the startup selection
    // loads as one ordinary dataset change: its progress is the data
    // controls' own, and any dataset choice the user makes while it loads —
    // a sample, None, a file, a connection, the benchmark — supersedes it.
    // A dataset that does not open leaves Cellucid running without it (its
    // opening says why); any other failure no newer choice superseded ends
    // startup.
    let startupOutcome = 'none';
    // The default sample, once its catalog has answered, unless the person
    // chose a dataset meanwhile. An unreachable catalog only leaves startup
    // without a default (the sample picker says why); a stalled one is a
    // startup failure that names where it stopped.
    if (defaultSample !== null && !startupOpening.cancelled) {
      let available = false;
      try {
        available = await startup.step('catalog', defaultSample.catalog, () => defaultSample.answer);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new TypeError(
            'Default sample catalog availability rejected with a non-Error value.'
          );
        }
        if (error.code === STARTUP_STALL_CODE) throw error;
        debug.log(
          `[Main] Default sample catalog is unavailable: ${error.message}`
        );
      }
      if (available && datasetReloadCoordinator.actionSequence === controlsLiveAt) {
        const defaultDatasetId = await startup.step(
          'catalog',
          defaultSample.catalog,
          () => defaultSample.defaultDatasetId()
        );
        if (datasetReloadCoordinator.actionSequence === controlsLiveAt) {
          await nameStartupOpening(dataSourceManager.getSource('local-demo'), defaultDatasetId);
          selectStartupDataset(
            'local-demo',
            defaultDatasetId,
            DATA_LOAD_METHODS.DEFAULT_DEMO
          );
        }
      }
    }
    // Canceled while startup resolved it: Cellucid starts without it.
    if (startupSelection !== null && !startupOpening.cancelled) {
      try {
        startupOutcome = await ui.loadStartupDataset(startupSelection);
      } catch (error) {
        // Data that did not open, or stopped arriving before its first view;
        // a stall after it (the published default view) is still terminal.
        const dataFailed = error instanceof DataSourceError
          || isExplainedFailure(error)
          || (error?.code === STARTUP_STALL_CODE
            && (error.phase === 'dataset' || error.phase === 'positions'));
        if (!dataFailed) throw error;
        startupOutcome = 'failed';
        const launchParameters =
          STARTUP_LAUNCH_PARAMETERS[startupSelection.sourceType] ?? [];
        failStartupData(
          error,
          launchParameters.some(name => urlParams.has(name))
            ? 'Cellucid could not read the dataset this link opens.'
            : 'Cellucid could not read the dataset it was opening.',
          launchParameters
        );
      }
      // A viewer host: it is told the viewer is ready only once its own
      // dataset is on screen. A dataset the user chose instead in this
      // viewer is not the one the host's cell positions describe: its
      // results name no host dataset (app/viewer-host/results.js), and the
      // commands that name cells are refused while it is open.
      if (viewerHostSource !== null && startupOutcome === 'ready') {
        await startup.step(
          'ui',
          "the viewer's host",
          () => viewerHostSource.notifyReady({
            dimensions: state.getDimensionLevel()
          })
        );
        // Everything the person had made (a restored session's highlights
        // and fields) reaches the host, replacing what it kept before; and
        // again whenever the channel opens again after a drop.
        if (viewerHostResults !== null) {
          const resync = () => viewerHostResults.resync().catch(error => {
            console.error('[Main] Sending the results snapshot to the host failed:', error);
          });
          viewerHostSource.onChannelReopen(() => { void resync(); });
          void resync();
        }
      }
    }
    if (linkedCells !== null) withdrawNextCellSubsetRequest(linkedCells);
    releaseSampleListing();
    startup.enter('ready');
    // Opened, or startup showed none: a failure was said where it happened.
    if (startupOutcome === 'ready') startupOpening.end();
    else startupOpening.dismiss();
    analytics.trackAppReady({
      viewer,
      hasDataset: startupOutcome === 'ready'
    });
  } catch (thrown) {
    const startupError = normalizeStartupError(thrown);
    startup.retire(startupError);
    releaseSampleListing();
    startupOpening?.fail(startupError);
    console.error('[Main] Terminal startup failure:', startupError);
    if (destroyApplication !== null) {
      void destroyApplication().catch(error => {
        console.error('[Main] Terminal startup teardown failed:', error);
      });
    }
    publishStartupFailure({
      documentOwner: document,
      error: startupError,
      statsElement: statsEl
    });
    analytics.trackStartupFailure({
      phase: startup.phase,
      error: startupError
    });
  }
})();
