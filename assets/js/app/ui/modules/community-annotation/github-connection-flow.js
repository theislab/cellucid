/**
 * @fileoverview The GitHub connection wizard.
 *
 * One modal covers signing in to the Cellucid GitHub App, discovering the
 * repositories an installation can reach, connecting one to the current
 * dataset, and editing that connection's automatic-pull preference. It is the
 * only place in the community annotation UI that renders repository discovery,
 * and it is opened from exactly two places: the controls panel and
 * `connectRepoFlow`.
 *
 * The wizard drives the controls rather than owning them: sync status, context
 * ownership, identity, pull, and publish all belong to the controls module and
 * arrive through the `controller` interface. Nothing here mutates controls
 * state directly, so the wizard can be opened, replaced, and torn down without
 * the controls losing track of what it owns.
 *
 * @module ui/modules/community-annotation/github-connection-flow
 */

import { annotationDatasetIdOf } from '../../../community-annotations/runtime-context.js';
import { toCacheScopeKey } from '../../../community-annotations/cache-scope.js';
import { toGitHubUserKey } from '../../../community-annotations/github-auth.js';
import { getAnnotationRepoForDataset } from '../../../community-annotations/repo-store.js';
import { parseOwnerRepo } from '../../../community-annotations/github-sync.js';
import {
  AUTO_PULL_INTERVALS_MS,
  DEFAULT_AUTO_PULL_INTERVAL_MS,
  assertAutoPullIntervalMs,
  autoPullIntervalFromSelectValue,
} from '../../../community-annotations/auto-pull-preferences.js';
import {
  readAutoPullPreferences,
  writeAutoPullPreferences,
} from './auto-pull-storage.js';
import {
  createStatusIcon,
  createStatusRow,
  el,
  setStatusTone,
} from './dom.js';
import { createIconButton } from '../../components/controls.js';
import { formatCount, formatCountOf } from '../../../../utils/format-units.js';
import { removeOwningCommunityModal } from './modal-shell.js';
import {
  assertExactAnnotationUserKey,
  assertExactGitHubLogin,
} from './identity-assertions.js';
import {
  describeCannotPublishMessage,
  getPublishCapability,
  isTokenAuthFailure,
  isWorkerOriginSecurityError,
} from './github-error-classification.js';
import {
  describeGitHubAuthReachabilityError,
  openExternal,
} from './browser-integration.js';

const GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS = 10_000;
const SYNC_SKIPPED_MESSAGE =
  'Another GitHub sync is still running. Wait for it to finish, then try again.';

/**
 * Status text for one Pull or Publish outcome returned by the controls.
 *
 * Only a `done` outcome produces the success text; a transaction that never
 * ran (`skipped`) or ended without completing says so explicitly.
 *
 * @param {{status: string, error?: string}} outcome
 * @param {string} doneText
 * @returns {string}
 */
export function describeSyncOutcome(outcome, doneText) {
  if (typeof doneText !== 'string' || !doneText) {
    throw new TypeError('Sync outcome success text must be a non-empty string');
  }
  if (outcome === null || typeof outcome !== 'object') {
    throw new TypeError('GitHub sync must return an explicit outcome');
  }
  switch (outcome.status) {
    case 'done':
      return doneText;
    case 'skipped':
      return SYNC_SKIPPED_MESSAGE;
    case 'cancelled':
      return 'Cancelled.';
    case 'failed':
      if (typeof outcome.error !== 'string' || !outcome.error) {
        throw new TypeError('A failed GitHub sync outcome must carry its error message');
      }
      return `⚠ ${outcome.error}`;
    default:
      throw new TypeError(
        `Unknown GitHub sync outcome status: ${String(outcome.status)}`
      );
  }
}
const GITHUB_REPOSITORY_PAGE_SIZE = 100;

/**
 * Members the wizard needs from the community annotation controls. Every one
 * is a live handle into the controls instance that opened the wizard, so the
 * wizard and the panel behind it always agree about sync status, the connected
 * repository, and which modal is on screen.
 */
const REQUIRED_CONTROLLER_MEMBERS = Object.freeze([
  'isSyncBusy',
  'subscribeSyncBusy',
  'resolveConnectionTrigger',
  'getLastRepoInfo',
  'setLastRepoInfo',
  'getLastAutoPullPreferenceError',
  'setActiveConnectionClose',
  'releaseActiveConnectionClose',
  'disconnectAnnotationRepo',
  'disconnectGitHubAndAnnotationRepo',
  'ensureIdentityForUserKey',
  'getCacheContext',
  'getCacheUserId',
  'getCacheUserKey',
  'getGitHubLogin',
  'isContextOwnerCurrent',
  'publishContextOwner',
  'pullFromGitHub',
  'pushToGitHub',
  'refreshAutoPullScheduler',
  'showOwnedCommunityModal',
  'startBackgroundTask',
]);

/**
 * Build the connection wizard openers for one community annotation controls
 * instance.
 *
 * @param {object} controller
 * @returns {{openGitHubConnectionFlow: Function, connectRepoFlow: Function}}
 */
export function createGitHubConnectionFlow(controller) {
  if (controller === null || typeof controller !== 'object') {
    throw new TypeError(
      'The GitHub connection wizard requires the community annotation controls interface'
    );
  }
  for (const member of REQUIRED_CONTROLLER_MEMBERS) {
    if (typeof controller[member] !== 'function') {
      throw new TypeError(
        `The GitHub connection wizard requires controller.${member}()`
      );
    }
  }
  const {
    access,
    githubAuth,
    dataSourceManager,
    disconnectAnnotationRepo,
    disconnectGitHubAndAnnotationRepo,
    ensureIdentityForUserKey,
    getCacheContext,
    getCacheUserId,
    getCacheUserKey,
    getGitHubLogin,
    isContextOwnerCurrent,
    publishContextOwner,
    pullFromGitHub,
    pushToGitHub,
    refreshAutoPullScheduler,
    showOwnedCommunityModal,
    startBackgroundTask,
  } = controller;
  if (
    access === null ||
    typeof access !== 'object' ||
    githubAuth === null ||
    typeof githubAuth !== 'object' ||
    dataSourceManager === null ||
    typeof dataSourceManager !== 'object'
  ) {
    throw new TypeError(
      'The GitHub connection wizard requires the access store, the GitHub auth session, and the data source manager'
    );
  }

  async function openGitHubConnectionFlow({
    reason = null,
    datasetId = null,
    cacheUser = null,
    login = null,
    currentRepo = null,
  } = {}) {
    const appInstallUrl = 'https://github.com/apps/cellucid-community-annotations/installations/new';
    const settingsUrl = 'https://github.com/settings/installations';
    const openingOwner = publishContextOwner(
      getCacheContext({ datasetId: datasetId ?? undefined })
    );

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };

      // Replaced once the dialog is up; a close during construction leaves
      // nothing to settle here (the missing overlay below settles it).
      let settleClosed = () => {};
      const modalRef = showOwnedCommunityModal({
        title: 'GitHub sync',
        onClosed: () => settleClosed(),
        // The panel re-renders while the wizard is open, so the opening
        // button is usually detached by the time the wizard closes.
        returnFocusResolver: () => controller.resolveConnectionTrigger(),
        buildContent: (content) => {
          const modalAbort = new AbortController();
          // Allow outer scope to stop listeners when modal closes.
          content.__cellucidCleanup = () => modalAbort.abort();

          const did =
            datasetId !== null
              ? datasetId
              : (annotationDatasetIdOf(dataSourceManager) ?? null);
          const initialUserKey =
            cacheUser !== null ? cacheUser : getCacheUserKey();
          assertExactAnnotationUserKey(
            initialUserKey,
            'GitHub sync initial user'
          );
          const getEffectiveUserKey = () => {
            const key = toGitHubUserKey(githubAuth.getUser?.());
            return key === null ? initialUserKey : key;
          };
          const initialRepoRef = currentRepo;
          const isModalOwnerCurrent = () =>
            !modalAbort.signal.aborted &&
            isContextOwnerCurrent(openingOwner);

          let connectedRepoRef = initialRepoRef;
          let repoListLoaded = false;
          let installationsLoaded = false;
          let isReloadingRepos = false;
          /** @type {{full_name:string, private?:boolean, searchKey:string}[]} */
          let allRepos = [];
          /** @type {{id:number, account:{login:string}}[]} */
          let installations = [];
          /** @type {string} */
          let selectedRepoFullName = '';
          let repoPageStep2 = 0;
          let repoPageStep3 = 0;
          let repoFocusRequestFullName = null;
          let repoRenderSnapshot = null;

          const statusList = el('div', { className: 'community-annotation-status-list' });
          const statusAction = (label, icon) => createIconButton({
            label,
            icon: createStatusIcon(icon).outerHTML,
          });
          const githubSettingsBtn = statusAction('GitHub settings', 'gear');
          const disconnectGitHubBtn = statusAction('Disconnect GitHub', 'disconnect');
          const disconnectRepoBtn = statusAction('Disconnect repository', 'disconnect');

          const datasetRow = createStatusRow({ icon: 'dataset', key: 'Dataset' });
          const githubRow = createStatusRow({ icon: 'github', key: 'GitHub', actions: [githubSettingsBtn, disconnectGitHubBtn] });
          const repoRow = createStatusRow({ icon: 'repo', key: 'Repo', actions: [disconnectRepoBtn] });

          statusList.appendChild(datasetRow.row);
          statusList.appendChild(githubRow.row);
          statusList.appendChild(repoRow.row);
          content.appendChild(statusList);

          // One short line per step; the panel's (i) tip ('community-sync')
          // carries the detail. The access statement stays visible: it is
          // what the user agrees to before leaving for GitHub.
          const stepDefs = [
            {
              title: 'Sign in',
              descParts: [
                el('strong', { text: 'Cellucid gets no repository access' }),
                ' until you install its GitHub App on repositories you choose.'
              ]
            },
            {
              title: 'Install app',
              descParts: [
                'Add repo opens GitHub to choose repositories; then Reload.'
              ]
            },
            {
              title: 'Choose repository',
              descParts: [
                'Remembered for this dataset (',
                el('code', { text: String(did || 'default') }),
                ') and account.'
              ]
            },
            {
              title: 'Sync',
              descParts: [
                'Pull fetches the latest votes; Publish writes them for everyone.'
              ]
            }
          ];

          const stepEls = stepDefs.map((s, i) => {
            const n = i + 1;
            const node = el('div', { className: 'community-annotation-step', role: 'listitem', 'data-step': String(n) }, [
              el('div', { className: 'community-annotation-step-num', text: String(n) }),
              el('div', { className: 'community-annotation-step-title', text: s.title })
            ]);
            return node;
          });

          const stepper = el('div', { className: 'community-annotation-stepper', role: 'list' }, stepEls);
          content.appendChild(stepper);

          // The stepper above names the step; the intro says only what it does.
          const stepIntro = el('div', { className: 'community-annotation-step-intro' });
          const stepIntroDesc = el('div', { className: 'community-annotation-step-intro-desc' });
          stepIntro.appendChild(stepIntroDesc);
          content.appendChild(stepIntro);

          const step1Panel = el('div', { className: 'community-annotation-step-panel' });
          const step1Help = el('div', { className: 'status-line', text: '' });
          step1Panel.appendChild(step1Help);
          const step1Actions = el('div', { className: 'community-annotation-step1-actions' });
          const step1SignInBtn = el('button', { type: 'button', className: 'btn', text: 'Continue with GitHub' });
          step1Actions.appendChild(step1SignInBtn);
          step1Panel.appendChild(step1Actions);
          content.appendChild(step1Panel);

          const createRepoPager = (label) => {
            const previous = el('button', {
              type: 'button',
              className: 'btn',
              text: 'Previous',
              'aria-label': `Previous ${label} page`,
            });
            const pageStatus = el('div', {
              className: 'community-annotation-repo-page-status',
              'aria-live': 'polite',
              'aria-atomic': 'true',
              tabIndex: '-1',
              text: '',
            });
            const next = el('button', {
              type: 'button',
              className: 'btn',
              text: 'Next',
              'aria-label': `Next ${label} page`,
            });
            const root = el('div', {
              className: 'community-annotation-repo-pagination',
              role: 'group',
              'aria-label': `${label} pagination`,
              hidden: true,
            }, [previous, pageStatus, next]);
            return { next, pageStatus, previous, root };
          };

          // Step 2: add/refresh repos (no selection).
          const step2Panel = el('div', { className: 'community-annotation-step-panel' });
          const step2Help = el('div', { className: 'status-line', text: '' });
          step2Panel.appendChild(step2Help);
          const step2Actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const addRepoBtn = el('button', { type: 'button', className: 'btn community-annotation-repo-action', text: 'Add repo' });
          const reloadReposBtn = el('button', { type: 'button', className: 'btn community-annotation-repo-action', text: 'Reload' });
          step2Actions.appendChild(addRepoBtn);
          step2Actions.appendChild(reloadReposBtn);
          step2Panel.appendChild(step2Actions);
          const repoGridStep2 = el('div', {
            className: 'community-annotation-repo-grid',
            'aria-label': 'Available annotation repositories',
          });
          const repoPagerStep2 = createRepoPager('available repositories');
          step2Panel.appendChild(repoGridStep2);
          step2Panel.appendChild(repoPagerStep2.root);
          content.appendChild(step2Panel);

          // Step 3: pick repo (selection + connect).
          const step3Panel = el('div', { className: 'community-annotation-step-panel' });
          const step3Help = el('div', { className: 'status-line', text: '' });
          step3Panel.appendChild(step3Help);

          const filterRow = el('div', { className: 'control-block', hidden: true });
          const filterInput = el('input', {
            type: 'text',
            className: 'obs-select',
            'aria-label': 'Filter repositories',
            autocomplete: 'off',
            maxlength: '256',
            placeholder: 'Filter repositories…',
            value: ''
          });
          filterRow.appendChild(filterInput);
          step3Panel.appendChild(filterRow);

          const repoGridStep3 = el('div', {
            className: 'community-annotation-repo-grid',
            'aria-label': 'Selectable annotation repositories',
          });
          const repoPagerStep3 = createRepoPager('selectable repositories');
          step3Panel.appendChild(repoGridStep3);
          step3Panel.appendChild(repoPagerStep3.root);

          const step3Selection = el('div', {
            className: 'status-line',
            'aria-live': 'polite',
            'aria-atomic': 'true',
            text: '',
          });
          step3Panel.appendChild(step3Selection);
          content.appendChild(step3Panel);

          const syncBlock = el('div', { className: 'community-annotation-step-panel' });
          const syncTopRow = el('div', { className: 'community-annotation-sync-toprow' });
          const syncActions = el('div', { className: 'community-annotation-suggestion-actions' });
          const pullBtn = el('button', { type: 'button', className: 'btn', text: 'Pull latest' });
          const publishBtn = el('button', { type: 'button', className: 'btn', text: 'Publish' });
          syncActions.appendChild(pullBtn);
          syncActions.appendChild(publishBtn);
          syncTopRow.appendChild(syncActions);

          const autoPullRow = el('div', { className: 'community-annotation-auto-pull-row' });
          const autoPullToggle = el('label', { className: 'checkbox-inline community-annotation-auto-pull-toggle' });
          const autoPullCheckbox = el('input', { type: 'checkbox' });
          autoPullToggle.appendChild(autoPullCheckbox);
          autoPullToggle.appendChild(document.createTextNode('Auto pull'));
            const autoPullSelect = el('select', {
              className: 'obs-select community-annotation-auto-pull-select',
              'aria-label': 'Auto pull interval'
            });
            const autoPullOptions = [
              { ms: AUTO_PULL_INTERVALS_MS[0], label: 'Every 10 minutes' },
              { ms: AUTO_PULL_INTERVALS_MS[1], label: 'Every 15 minutes' },
              { ms: AUTO_PULL_INTERVALS_MS[2], label: 'Every 60 minutes' }
            ];
            for (const opt of autoPullOptions) {
              autoPullSelect.appendChild(el('option', { value: String(opt.ms), text: opt.label }));
            }
          autoPullRow.appendChild(autoPullToggle);
          autoPullRow.appendChild(autoPullSelect);
          syncTopRow.appendChild(autoPullRow);
          syncBlock.appendChild(syncTopRow);
          content.appendChild(syncBlock);

          const status = el('div', {
            className: 'status-line community-annotation-wizard-status',
            role: 'status',
            'aria-live': 'polite',
            text: String(reason || '')
          });
          content.appendChild(status);

          const wizardNav = el('div', { className: 'community-annotation-wizard-nav' });
          const prevBtn = el('button', { type: 'button', className: 'btn community-annotation-wizard-prev', text: 'Back' });
          const stepCount = el('div', { className: 'community-annotation-wizard-stepcount', text: '' });
          const nextBtn = el('button', { type: 'button', className: 'btn community-annotation-wizard-next', text: 'Next' });
          wizardNav.appendChild(prevBtn);
          wizardNav.appendChild(stepCount);
          wizardNav.appendChild(nextBtn);
          content.appendChild(wizardNav);

            let isSigningIn = false;
            let isConnectingRepo = false;
            let autoPullEnabled = false;
            let autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
          /** @type {string} */
          let autoPullScopeKey = '';

            const computeAutoPullScopeKey = () => {
              if (!did || !githubAuth.isAuthenticated()) return null;
              const effectiveUserKey = getEffectiveUserKey();
              const userId = getCacheUserId();
              if (
                !Number.isSafeInteger(userId) ||
                userId < 1 ||
                effectiveUserKey !== `ghid_${userId}`
              ) {
                throw new Error(
                  'Auto-pull requires the exact current authenticated GitHub identity'
                );
              }
              const repoRef = getAnnotationRepoForDataset(did, effectiveUserKey);
              if (repoRef === null) return null;
              const key = toCacheScopeKey({ datasetId: did, repoRef, userId });
              if (key === null) {
                throw new Error(
                  'Auto-pull requires a repository with an exact resolved branch'
                );
              }
              return key;
            };

            const syncAutoPullFromStorage = ({ force = false } = {}) => {
              const nextKey = computeAutoPullScopeKey();
              if (!nextKey) {
                autoPullScopeKey = '';
                autoPullEnabled = false;
                autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
                return;
              }
              if (!force && nextKey === autoPullScopeKey) return;
              autoPullScopeKey = nextKey;
              const prefs = readAutoPullPreferences();
              const entry = prefs[autoPullScopeKey];
              if (entry === undefined) {
                autoPullEnabled = false;
                autoPullIntervalMs = DEFAULT_AUTO_PULL_INTERVAL_MS;
                return;
              }
              autoPullEnabled = entry.enabled;
              autoPullIntervalMs = assertAutoPullIntervalMs(entry.intervalMs);
            };

          const ensureAutoPullTimer = () => {
            const active = refreshAutoPullScheduler();
            const autoPullPreferenceError =
              controller.getLastAutoPullPreferenceError();
            if (autoPullPreferenceError !== null) {
              throw new Error(autoPullPreferenceError);
            }
            if (autoPullEnabled && active !== true) {
              throw new Error(
                'Unable to start automatic annotation pulls for the exact current scope'
              );
            }
            return active;
          };

            const commitAutoPullPreference = ({
              enabled,
              intervalMs,
            }) => {
              if (typeof enabled !== 'boolean') {
                throw new TypeError(
                  'Auto-pull enabled preference must be a boolean'
                );
              }
              const exactIntervalMs =
                assertAutoPullIntervalMs(intervalMs);
              const key = computeAutoPullScopeKey();
              if (key === null || key !== autoPullScopeKey) {
                throw new Error(
                  'Auto-pull preferences require the current exact cache scope'
                );
              }
              const previousPrefs = readAutoPullPreferences();
              const previousEntry = previousPrefs[key];
              const previousEnabled = previousEntry?.enabled === true;
              const previousIntervalMs =
                previousEntry === undefined
                  ? DEFAULT_AUTO_PULL_INTERVAL_MS
                  : assertAutoPullIntervalMs(previousEntry.intervalMs);
              const nextPrefs = {
                ...previousPrefs,
                [key]: {
                  enabled,
                  intervalMs: exactIntervalMs,
                },
              };
              writeAutoPullPreferences(nextPrefs);
              autoPullEnabled = enabled;
              autoPullIntervalMs = exactIntervalMs;

              try {
                ensureAutoPullTimer();
              } catch (primaryError) {
                const rollbackErrors = [primaryError];
                let durableStateRolledBack = false;
                try {
                  writeAutoPullPreferences(previousPrefs);
                  durableStateRolledBack = true;
                } catch (rollbackStorageError) {
                  rollbackErrors.push(rollbackStorageError);
                }

                if (durableStateRolledBack) {
                  autoPullEnabled = previousEnabled;
                  autoPullIntervalMs = previousIntervalMs;
                }
                try {
                  ensureAutoPullTimer();
                } catch (rollbackTimerError) {
                  rollbackErrors.push(rollbackTimerError);
                }

                if (rollbackErrors.length === 1) throw primaryError;
                throw new AggregateError(
                  rollbackErrors,
                  durableStateRolledBack
                    ? 'Unable to save auto-pull preference; restoring its live schedule also failed'
                    : 'Unable to save auto-pull preference and its durable rollback failed'
                );
              }
            };

          const toRepoFullName = (repoRef) => {
            if (repoRef === null) return null;
            const parsed = parseOwnerRepo(repoRef);
            if (parsed === null) {
              throw new Error(
                'Connected annotation repository must use the exact owner/repo[@branch] representation'
              );
            }
            return parsed.ownerRepo;
          };

          const isStepLocked = (step, { authed, connectedName }) => {
            if (step === 1) return false;
            if (!authed) return true;
            if (step === 4) return !connectedName;
            return false; // steps 2 & 3 unlocked once authed
          };

          const computeRecommendedStep = ({ authed, connectedName }) => {
            if (!authed) return 1;
            if (connectedName) return 4;
            return 2;
          };

          /** @type {number|null} */
          let uiStep = null;
          /** @type {number|null} */
          let lastUiStep = null;
          let canGoNext = false;
          let clearStatusOnStepChange = false;

          const setActiveStep = (n) => {
            const active = Math.max(1, Math.min(4, Number(n) || 1));
            for (let i = 0; i < stepEls.length; i++) {
              const elStep = stepEls[i];
              const isActive = i === active - 1;
              elStep.classList.toggle('community-annotation-step--active', isActive);
              if (isActive) elStep.setAttribute('aria-current', 'step');
              else elStep.removeAttribute('aria-current');
            }
          };

          const setStepStates = ({ authed, connectedName, activeStep }) => {
            const current = Math.max(1, Math.min(4, Number(activeStep) || 1));
            const done = (step) => {
              if (step >= current) return false;
              if (step === 1) return authed;
              if (step === 2) return authed;
              if (step === 3) return authed && Boolean(connectedName);
              return false;
            };
            for (let i = 0; i < stepEls.length; i++) {
              const step = i + 1;
              const elStep = stepEls[i];
              const isLocked = isStepLocked(step, { authed, connectedName });
              const isDone = done(step);
              elStep.classList.toggle('community-annotation-step--locked', isLocked);
              elStep.classList.toggle('community-annotation-step--done', isDone);
              elStep.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
              const num = elStep.querySelector?.('.community-annotation-step-num') || null;
              if (num) {
                const isActive = elStep.classList.contains('community-annotation-step--active');
                num.textContent = isDone && !isActive ? '✓' : String(step);
              }
            }
          };

          const resetRepoViewState = () => {
            repoPageStep2 = 0;
            repoPageStep3 = 0;
            repoFocusRequestFullName = null;
            repoRenderSnapshot = null;
          };

          const clearRepoView = (grid, pager) => {
            if (grid.childNodes.length > 0) grid.replaceChildren();
            pager.root.hidden = true;
            pager.pageStatus.textContent = '';
            pager.previous.disabled = true;
            pager.previous.hidden = true;
            pager.next.disabled = true;
            pager.next.hidden = true;
          };

          const disconnectGitHubSession = ({ message, notify = 'error' } = {}) => {
            const msg = String(message || 'GitHub disconnected.').trim() || 'GitHub disconnected.';
            disconnectGitHubAndAnnotationRepo({
              datasetId: did,
              message: msg,
              notify,
            });
            connectedRepoRef = null;
            controller.setLastRepoInfo(null);
            access.clearRole?.();
            repoListLoaded = false;
            installationsLoaded = false;
            installations = [];
            allRepos = [];
            selectedRepoFullName = '';
            resetRepoViewState();
            status.textContent = msg;
            uiStep = 1;
            updateUi();
          };

          const renderRepoCards = () => {
            const activeStep =
              uiStep === 2
                ? 2
                : (uiStep === 3 ? 3 : null);
            if (activeStep === null) {
              clearRepoView(repoGridStep2, repoPagerStep2);
              clearRepoView(repoGridStep3, repoPagerStep3);
              repoRenderSnapshot = null;
              return;
            }

            const selectable = activeStep === 3;
            const grid = selectable ? repoGridStep3 : repoGridStep2;
            const pager = selectable ? repoPagerStep3 : repoPagerStep2;
            if (selectable) {
              clearRepoView(repoGridStep2, repoPagerStep2);
            } else {
              clearRepoView(repoGridStep3, repoPagerStep3);
            }

            const base = Array.isArray(allRepos) ? allRepos : [];
            const q = String(filterInput.value || '').trim().toLowerCase();
            const source =
              selectable && q
                ? base.filter((repo) => repo.searchKey.includes(q))
                : base;
            const pageCount = Math.max(
              1,
              Math.ceil(source.length / GITHUB_REPOSITORY_PAGE_SIZE)
            );
            const requestedPage =
              selectable ? repoPageStep3 : repoPageStep2;
            const page = Math.max(
              0,
              Math.min(pageCount - 1, requestedPage)
            );
            if (selectable) repoPageStep3 = page;
            else repoPageStep2 = page;

            const connected = toRepoFullName(connectedRepoRef);
            if (
              repoRenderSnapshot !== null &&
              repoRenderSnapshot.step === activeStep &&
              repoRenderSnapshot.repos === base &&
              repoRenderSnapshot.query === q &&
              repoRenderSnapshot.page === page &&
              repoRenderSnapshot.connected === connected &&
              repoRenderSnapshot.selected === selectedRepoFullName &&
              repoRenderSnapshot.loading === isReloadingRepos &&
              repoRenderSnapshot.loaded === repoListLoaded
            ) {
              return;
            }

            const focusedRepoFullName =
              repoFocusRequestFullName ??
              (
                grid.contains(document.activeElement)
                  ? document.activeElement?.getAttribute?.(
                      'data-repo-full-name'
                    ) ?? null
                  : null
              );
            const fragment = document.createDocumentFragment();
            const pageStart = page * GITHUB_REPOSITORY_PAGE_SIZE;
            const pageEnd = Math.min(
              source.length,
              pageStart + GITHUB_REPOSITORY_PAGE_SIZE
            );
            const visibleRepos = source.slice(pageStart, pageEnd);

            // An empty page says why once, in the pager's live status line
            // below the grid (the step help already says "Loading…" while
            // the list loads).
            const emptyMessage =
              isReloadingRepos && !repoListLoaded
                ? ''
                : (
                  selectable && q
                    ? 'No repositories match this filter.'
                    : 'No repositories found.'
                );
            if (visibleRepos.length > 0) {
              for (const repo of visibleRepos) {
                const full = repo.full_name;
                const isConnected = Boolean(connected && full === connected);
                const isSelected = Boolean(
                  selectable &&
                  selectedRepoFullName &&
                  full === selectedRepoFullName
                );
                const cls = [
                  'community-annotation-repo-card',
                  selectable
                    ? ''
                    : 'community-annotation-repo-card--static',
                  isSelected
                    ? 'community-annotation-repo-card--selected'
                    : '',
                  isConnected
                    ? 'community-annotation-repo-card--connected'
                    : ''
                ].filter(Boolean).join(' ');
                const card = el(selectable ? 'button' : 'div', {
                  ...(selectable
                    ? {
                        type: 'button',
                        'aria-pressed': isSelected ? 'true' : 'false',
                      }
                    : {}),
                  className: cls,
                  'data-repo-full-name': full,
                });
                const title = el('span', {
                  className: 'community-annotation-repo-title',
                  text: full,
                });
                const meta = el('span', {
                  className: 'community-annotation-repo-meta',
                });
                meta.appendChild(el('span', {
                  className: 'community-annotation-repo-meta-main',
                  text: repo.private ? 'Private' : 'Public',
                }));
                const pills = el('span', {
                  className: 'community-annotation-repo-meta-pills',
                });
                if (isSelected) {
                  pills.appendChild(el('span', {
                    className: 'community-annotation-repo-meta-pill',
                    text: 'Selected',
                  }));
                }
                if (isConnected) {
                  pills.appendChild(el('span', {
                    className: 'community-annotation-repo-meta-pill',
                    text: 'Connected',
                  }));
                }
                if (pills.childNodes.length > 0) meta.appendChild(pills);
                card.appendChild(title);
                card.appendChild(meta);

                if (selectable) {
                  card.addEventListener('click', () => {
                    repoFocusRequestFullName = full;
                    selectedRepoFullName =
                      selectedRepoFullName === full ? '' : full;
                    updateUi();
                  });
                }
                fragment.appendChild(card);
              }
            }

            grid.replaceChildren(fragment);
            pager.root.hidden = false;
            const hasMultiplePages = pageCount > 1;
            pager.previous.hidden = !hasMultiplePages;
            pager.next.hidden = !hasMultiplePages;
            pager.previous.disabled = page === 0;
            pager.next.disabled = page >= pageCount - 1;
            pager.pageStatus.dataset.empty = String(source.length === 0);
            pager.pageStatus.textContent =
              source.length === 0
                ? emptyMessage
                : (
                  `Showing ${formatCount(pageStart + 1)}–${formatCount(pageEnd)} of ` +
                  `${formatCountOf(source.length, 'repository', 'repositories')}. ` +
                  `Page ${page + 1} of ${pageCount}.`
                );
            repoRenderSnapshot = {
              connected,
              loaded: repoListLoaded,
              loading: isReloadingRepos,
              page,
              query: q,
              repos: base,
              selected: selectedRepoFullName,
              step: activeStep,
            };

            if (focusedRepoFullName !== null) {
              const replacement = Array.from(
                grid.querySelectorAll('[data-repo-full-name]')
              ).find(
                (candidate) =>
                  candidate.getAttribute('data-repo-full-name') ===
                  focusedRepoFullName
              ) ?? null;
              if (replacement instanceof HTMLElement) {
                replacement.focus();
              } else {
                pager.pageStatus.focus();
              }
              if (repoFocusRequestFullName === focusedRepoFullName) {
                repoFocusRequestFullName = null;
              }
            }
          };

          const changeRepoPage = (step, delta, sourceButton) => {
            if (step === 2) {
              repoPageStep2 = Math.max(0, repoPageStep2 + delta);
            } else {
              repoPageStep3 = Math.max(0, repoPageStep3 + delta);
            }
            renderRepoCards();
            const pager = step === 2 ? repoPagerStep2 : repoPagerStep3;
            if (sourceButton.disabled) {
              const alternateControl =
                sourceButton === pager.next
                  ? pager.previous
                  : pager.next;
              if (
                !alternateControl.disabled &&
                !alternateControl.hidden
              ) {
                alternateControl.focus();
              } else {
                pager.pageStatus.focus();
              }
            }
          };
          repoPagerStep2.previous.addEventListener('click', () => {
            changeRepoPage(2, -1, repoPagerStep2.previous);
          });
          repoPagerStep2.next.addEventListener('click', () => {
            changeRepoPage(2, 1, repoPagerStep2.next);
          });
          repoPagerStep3.previous.addEventListener('click', () => {
            changeRepoPage(3, -1, repoPagerStep3.previous);
          });
          repoPagerStep3.next.addEventListener('click', () => {
            changeRepoPage(3, 1, repoPagerStep3.next);
          });

          const updateUi = () => {
            const authed = Boolean(githubAuth.isAuthenticated?.());
            const user = githubAuth.getUser?.() || null;
            const who = String(user?.login || '').trim();
            const effectiveUserKey = getEffectiveUserKey();
            const storedRepoRef = did
              ? getAnnotationRepoForDataset(did, effectiveUserKey)
              : null;
            const repoRef =
              storedRepoRef !== null ? storedRepoRef : connectedRepoRef;
            connectedRepoRef = repoRef;
            const storedRepoName = toRepoFullName(repoRef);
            const connectedName = authed ? storedRepoName : '';
            const busy = Boolean(isSigningIn || isConnectingRepo || isReloadingRepos || controller.isSyncBusy());
            syncAutoPullFromStorage();

            if (selectedRepoFullName) {
              const stillExists = (Array.isArray(allRepos) ? allRepos : []).some((r) => String(r?.full_name || '').trim() === selectedRepoFullName);
              if (!stillExists) selectedRepoFullName = '';
            }

            const recommended = computeRecommendedStep({ authed, connectedName });
            if (uiStep == null) uiStep = recommended;
            uiStep = Math.max(1, Math.min(4, uiStep));
            if (isStepLocked(uiStep, { authed, connectedName })) uiStep = recommended;
            setActiveStep(uiStep);
            setStepStates({ authed, connectedName, activeStep: uiStep });

            if (clearStatusOnStepChange && uiStep !== lastUiStep && !busy) {
              status.textContent = '';
              clearStatusOnStepChange = false;
            }

            if (uiStep !== lastUiStep) {
              lastUiStep = uiStep;
              if (authed && uiStep === 2 && !isReloadingRepos) {
                // Step 2 auto-refreshes repository list.
                loadRepoList();
              }
              if (authed && uiStep === 3 && !repoListLoaded && !isReloadingRepos) {
                // Step 3 triggers a refresh only if step 2 was skipped.
                loadRepoList();
              }
            }

            setStatusTone(datasetRow.chip, did ? 'ok' : 'warn');
            datasetRow.valueEl.textContent = did ? ` ${did}` : ' —';

            setStatusTone(githubRow.chip, authed ? 'ok' : 'warn');
            githubRow.valueEl.textContent = authed ? (who ? ` @${who}` : ' signed in') : ' not connected';
            githubSettingsBtn.disabled = !authed;
            disconnectGitHubBtn.disabled = !authed;

            setStatusTone(repoRow.chip, connectedName ? 'ok' : 'warn');
            repoRow.valueEl.textContent =
              connectedName ? ` ${connectedName}` : (storedRepoName && !authed ? ` ${storedRepoName} (sign in)` : ' not connected');
            disconnectRepoBtn.disabled = !(authed && connectedName);

            const showFilter = repoListLoaded && allRepos.length > 20;
            filterRow.hidden = !(authed && uiStep === 3 && showFilter);

            addRepoBtn.disabled = !authed;
            reloadReposBtn.disabled = !authed || isReloadingRepos;
            reloadReposBtn.setAttribute('data-loading', isReloadingRepos ? 'true' : 'false');
            reloadReposBtn.textContent = isReloadingRepos ? 'Reloading…' : 'Reload';

              const canSync = Boolean(authed && connectedName && !controller.isSyncBusy());
              const currentRepoInfo = controller.getLastRepoInfo();
              const publishCapability =
                currentRepoInfo === null
                  ? null
                  : getPublishCapability(currentRepoInfo);
              pullBtn.disabled = !canSync;
              publishBtn.disabled =
                !canSync ||
                publishCapability === null ||
                !publishCapability.canPublish;
              publishBtn.title =
                !canSync
                  ? 'Connect a repository and wait for active sync to finish.'
                  : (
                    publishCapability === null
                      ? 'Checking GitHub publication permissions…'
                      : (
                        publishCapability.canPublish
                          ? 'Publish local annotation changes to GitHub.'
                          : describeCannotPublishMessage(connectedName)
                      )
                  );
            autoPullCheckbox.checked = autoPullEnabled;
            autoPullCheckbox.disabled = busy || !canSync;
            autoPullSelect.value = `${assertAutoPullIntervalMs(autoPullIntervalMs)}`;
            autoPullSelect.disabled = busy || !canSync || !autoPullEnabled;

            step1Panel.hidden = uiStep !== 1;
            step2Panel.hidden = !(authed && uiStep === 2);
            step3Panel.hidden = !(authed && uiStep === 3);
            syncBlock.hidden = !(authed && uiStep === 4);

            if (uiStep === 1) {
              step1Help.textContent = authed ? 'Signed in. Press Next.' : '';
              step1Help.hidden = !authed;
              step1Actions.hidden = authed;
              step1SignInBtn.disabled = busy;
              step1SignInBtn.textContent = isSigningIn ? 'Redirecting…' : 'Continue with GitHub';
            } else {
              step1Actions.hidden = true;
            }

            if (authed && uiStep === 2) {
              const n = allRepos.length;
              step2Help.textContent =
                isReloadingRepos && !repoListLoaded
                  ? 'Loading repositories…'
                  : (
                    n
                      ? `${formatCount(n)} repos available.`
                      : 'No repos yet: Add repo, then Reload.'
                  );
            }

            if (authed && uiStep === 3) {
              if (isReloadingRepos) {
                step3Help.textContent = 'Loading repositories…';
              } else if (repoListLoaded && allRepos.length === 0) {
                step3Help.textContent = 'No repos yet: go back a step to add one.';
              } else {
                step3Help.textContent = '';
              }
              step3Help.hidden = step3Help.textContent === '';
            }

            if (authed && uiStep === 3) {
              const selectionParts = [];
              if (selectedRepoFullName) {
                selectionParts.push(`Selected: ${selectedRepoFullName}`);
              }
              if (connectedName) {
                selectionParts.push(`Connected: ${connectedName}`);
              }
              step3Selection.textContent = selectionParts.join(' · ');
              step3Selection.hidden = selectionParts.length === 0;
            }

            // Step intro content.
            const def = stepDefs[Math.max(0, Math.min(stepDefs.length - 1, uiStep - 1))] || null;
            stepIntroDesc.innerHTML = '';
            const parts = Array.isArray(def?.descParts) ? def.descParts : [];
            for (const part of parts) {
              if (part == null) continue;
              stepIntroDesc.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
            }

            // Wizard nav.
            stepCount.textContent = `Step ${uiStep} of ${stepDefs.length}`;
            prevBtn.disabled = busy || uiStep <= 1;

            // A disabled Next says why in its title, so the step's blocker is
            // never a silent grey button.
            let nextText = 'Next';
            let nextBlocker = busy ? 'Wait for the current GitHub request to finish.' : '';
            if (uiStep === 1) {
              nextText = 'Next';
              if (!nextBlocker && !authed) nextBlocker = 'Sign in with GitHub first.';
            } else if (uiStep === 2) {
              nextText = 'Next';
              if (!nextBlocker && !(Boolean(connectedName) || (repoListLoaded && allRepos.length > 0))) {
                nextBlocker = 'Enable at least one repo with Add repo, then Reload.';
              }
            } else if (uiStep === 3) {
              const selected = String(selectedRepoFullName || '').trim();
              const wantsSwitch = Boolean(connectedName && selected && selected !== connectedName);
              const needsConnect = Boolean(!connectedName);
              if (wantsSwitch || needsConnect) {
                nextText = isConnectingRepo ? (wantsSwitch ? 'Switching…' : 'Connecting…') : (wantsSwitch ? 'Switch repo' : 'Connect');
                if (!nextBlocker && !selected) nextBlocker = 'Select a repository first.';
              } else {
                nextText = 'Next';
              }
            } else if (uiStep === 4) {
              nextText = 'Done';
            }
            const nextEnabled = nextBlocker === '';

            nextBtn.textContent = nextText;
            nextBtn.disabled = !nextEnabled;
            if (nextEnabled) nextBtn.removeAttribute('title');
            else nextBtn.title = nextBlocker;
            canGoNext = Boolean(nextEnabled);

            ensureAutoPullTimer();
            renderRepoCards();
          };

          const loadRepoList = async () => {
            if (!isModalOwnerCurrent() || isReloadingRepos) return;
            if (!githubAuth.isAuthenticated()) {
              repoListLoaded = false;
              installationsLoaded = false;
              installations = [];
              allRepos = [];
              selectedRepoFullName = '';
              resetRepoViewState();
              updateUi();
              return;
            }
            try {
              isReloadingRepos = true;
              updateUi();
              status.textContent = '';
              const instData = await githubAuth.listInstallations({
                signal: modalAbort.signal,
              });
              if (!isModalOwnerCurrent()) return;
              installations = instData.installations;
              installationsLoaded = true;
              if (!installations.length) {
                repoListLoaded = true;
                allRepos = [];
                resetRepoViewState();
                status.textContent = 'No installations found. Install the app, choose repos, then reload.';
                return;
              }

              const repos = [];
              const seenRepoIds = new Set();
              const seenRepoNames = new Set();
              for (const inst of installations) {
                if (!isModalOwnerCurrent()) return;
                const repoData = await githubAuth.listInstallationRepos(
                  inst.id,
                  { signal: modalAbort.signal },
                );
                if (!isModalOwnerCurrent()) return;
                for (const repo of repoData.repositories) {
                  const nameKey = repo.full_name.toLowerCase();
                  if (
                    seenRepoIds.has(repo.id) ||
                    seenRepoNames.has(nameKey)
                  ) {
                    throw new Error(
                      `GitHub returned duplicate repository ${repo.full_name}`
                    );
                  }
                  if (
                    repos.length >=
                    GITHUB_REPOSITORY_DISCOVERY_MAX_ITEMS
                  ) {
                    throw new Error(
                      'GitHub repository discovery exceeds 10000 repositories'
                    );
                  }
                  seenRepoIds.add(repo.id);
                  seenRepoNames.add(nameKey);
                  repos.push({
                    id: repo.id,
                    full_name: repo.full_name,
                    private: repo.private,
                    searchKey: nameKey,
                  });
                }
              }

              if (!isModalOwnerCurrent()) return;
              allRepos = repos.sort((a, b) => {
                if (a.full_name < b.full_name) return -1;
                if (a.full_name > b.full_name) return 1;
                return 0;
              });
              resetRepoViewState();
              repoListLoaded = true;
              // The step help states an empty list; the status line is for
              // what went wrong.
              status.textContent = '';
            } catch (err) {
              if (!isModalOwnerCurrent()) return;
              repoListLoaded = false;
              installationsLoaded = false;
              installations = [];
              allRepos = [];
              selectedRepoFullName = '';
              resetRepoViewState();
              if (isWorkerOriginSecurityError(err)) {
                disconnectGitHubSession({ message: err?.message || 'Invalid GitHub worker origin.', notify: 'error' });
                return;
              }
              if (isTokenAuthFailure(err)) {
                disconnectGitHubSession({ message: 'GitHub session expired or was revoked. Please connect again.', notify: 'error' });
                return;
              }
              status.textContent = describeGitHubAuthReachabilityError(err);
            } finally {
              isReloadingRepos = false;
              if (isModalOwnerCurrent()) updateUi();
            }
          };

          const connectSelectedRepo = async () => {
            if (!isModalOwnerCurrent()) return;
            if (!githubAuth.isAuthenticated?.()) {
              status.textContent = 'Sign in first.';
              updateUi();
              return;
            }
            if (!did) {
              status.textContent = 'Missing dataset context.';
              updateUi();
              return;
            }
            const selected = String(selectedRepoFullName || '').trim();
            const parts = selected.split('/');
            if (!selected || parts.length !== 2) {
              status.textContent = 'Select a valid repository.';
              updateUi();
              return;
            }

            try {
              isConnectingRepo = true;
              status.textContent = 'Connecting…';
              updateUi();
              const authedUserKey = toGitHubUserKey(githubAuth.getUser?.()) || null;
              const authedLogin = login || getGitHubLogin() || '';
              if (authedUserKey) {
                await ensureIdentityForUserKey({
                  userKey: authedUserKey,
                  login: authedLogin,
                  githubUserId: githubAuth.getUser?.()?.id ?? null,
                  promptIfMissing: false
                });
              }
              if (!isModalOwnerCurrent()) return;

              status.textContent = 'Pulling latest annotations…';
              const result = await pullFromGitHub({
                repoOverride: selected,
                confirmDatasetMismatch: true,
                signal: modalAbort.signal,
              });
              if (!isModalOwnerCurrent()) return;
              status.textContent = describeSyncOutcome(
                result,
                'Connected and up to date.'
              );
              if (result.status === 'done') {
                selectedRepoFullName = '';
                uiStep = 4;
              }
            } finally {
              isConnectingRepo = false;
              if (isModalOwnerCurrent()) updateUi();
            }
          };

          const signIn = async () => {
            if (isSigningIn) return;
            let signInError = null;
            try {
              isSigningIn = true;
              status.textContent = 'Redirecting to GitHub sign-in…';
              updateUi();
              await githubAuth.signIn?.({
                signal: modalAbort.signal,
              });
            } catch (err) {
              signInError = err;
            } finally {
              isSigningIn = false;
            }
            if (!isModalOwnerCurrent()) return;
            status.textContent =
              signInError === null
                ? 'GitHub sign-in navigation was requested.'
                : String(signInError?.message || 'Sign-in failed');
            updateUi();
          };

          const closeModal = () => removeOwningCommunityModal(content);

          prevBtn.addEventListener('click', () => {
            const step = Number(uiStep) || 1;
            if (step === 3 || step === 4) selectedRepoFullName = '';
            clearStatusOnStepChange = true;
            uiStep = Math.max(1, (Number(uiStep) || 1) - 1);
            updateUi();
          });

          nextBtn.addEventListener('click', () => {
            startBackgroundTask(async () => {
              const step = Number(uiStep) || 1;
              const authed = Boolean(githubAuth.isAuthenticated?.());
              const storedRepoRef = did
                ? getAnnotationRepoForDataset(did, getEffectiveUserKey())
                : null;
              const repoRef =
                storedRepoRef !== null ? storedRepoRef : connectedRepoRef;
              const connectedName = toRepoFullName(repoRef);

              if (step === 1) {
                if (!authed) return;
                clearStatusOnStepChange = true;
                uiStep = 2;
                updateUi();
                return;
              }

              if (step === 2) {
                selectedRepoFullName = '';
                clearStatusOnStepChange = true;
                uiStep = 3;
                updateUi();
                return;
              }

              if (step === 3) {
                const selected = String(selectedRepoFullName || '').trim();
                if (connectedName && (!selected || selected === connectedName)) {
                  selectedRepoFullName = '';
                  clearStatusOnStepChange = true;
                  uiStep = 4;
                  updateUi();
                  return;
                }
                await connectSelectedRepo();
                return;
              }

              closeModal();
            }, { label: 'GitHub annotation setup step failed' });
          });

          step1SignInBtn.addEventListener('click', () => {
            startBackgroundTask(
              () => signIn(),
              { label: 'GitHub annotation sign-in failed' },
            );
          });

          addRepoBtn.addEventListener('click', () => {
            if (!installationsLoaded) {
              if (!openExternal(appInstallUrl)) {
                status.textContent = 'Unable to open the GitHub App installation page.';
              }
              return;
            }
            const whoLogin = assertExactGitHubLogin(
              githubAuth.getUser?.()?.login,
              'Authenticated GitHub login'
            ).toLowerCase();
            const preferred =
              installations.find(
                (inst) =>
                  inst.account.login.toLowerCase() ===
                  whoLogin
              ) ?? null;
            const selectedUrl =
              preferred === null ? appInstallUrl : settingsUrl;
            if (!openExternal(selectedUrl)) {
              status.textContent = 'Unable to open the GitHub App repository settings.';
            }
          });
          reloadReposBtn.addEventListener('click', () => {
            startBackgroundTask(
              () => loadRepoList(),
              { label: 'Unable to reload GitHub annotation repositories' },
            );
          });
          filterInput.addEventListener('input', () => {
            repoPageStep3 = 0;
            renderRepoCards();
          });

          const showAutoPullPreferenceFailure = (primaryError) => {
            const errors = [primaryError];
            try {
              syncAutoPullFromStorage({ force: true });
            } catch (recoveryError) {
              errors.push(recoveryError);
            }
            autoPullCheckbox.checked = autoPullEnabled;
            autoPullSelect.value =
              `${assertAutoPullIntervalMs(autoPullIntervalMs)}`;
            autoPullSelect.disabled =
              autoPullCheckbox.disabled || !autoPullEnabled;
            const error =
              errors.length === 1
                ? primaryError
                : new AggregateError(
                    errors,
                    'Unable to save and restore the auto-pull preference'
                  );
            status.textContent =
              typeof error?.message === 'string' && error.message
                ? error.message
                : 'Unable to save auto-pull preferences';
          };

          autoPullCheckbox.addEventListener('change', () => {
            const requestedEnabled = autoPullCheckbox.checked;
            try {
              syncAutoPullFromStorage({ force: true });
              commitAutoPullPreference({
                enabled: requestedEnabled,
                intervalMs: autoPullIntervalMs,
              });
              status.textContent = '';
              updateUi();
            } catch (error) {
              showAutoPullPreferenceFailure(error);
            }
          });

          autoPullSelect.addEventListener('change', () => {
            try {
              const requestedIntervalMs =
                autoPullIntervalFromSelectValue(autoPullSelect.value);
              syncAutoPullFromStorage({ force: true });
              commitAutoPullPreference({
                enabled: autoPullEnabled,
                intervalMs: requestedIntervalMs,
              });
              status.textContent = '';
              updateUi();
            } catch (error) {
              showAutoPullPreferenceFailure(error);
            }
          });

          // Pull and Publish report the outcome the controls returned. The
          // buttons themselves follow `syncBusy` through the subscription
          // below, including transactions this dialog did not start.
          const runSyncAction = async (pendingText, run, doneText) => {
            status.textContent = pendingText;
            let outcome;
            try {
              outcome = await run({ signal: modalAbort.signal });
            } catch (error) {
              if (isModalOwnerCurrent()) {
                status.textContent =
                  `⚠ ${String(error?.message || 'GitHub sync failed')}`;
              }
              throw error;
            }
            if (!isModalOwnerCurrent()) return;
            status.textContent = describeSyncOutcome(outcome, doneText);
          };
          pullBtn.addEventListener('click', () => {
            startBackgroundTask(
              () => runSyncAction(
                'Pulling latest annotations…',
                pullFromGitHub,
                'Pulled latest annotations.'
              ),
              { label: 'GitHub annotation pull action failed' },
            );
          });
          publishBtn.addEventListener('click', () => {
            startBackgroundTask(
              () => runSyncAction(
                'Publishing…',
                pushToGitHub,
                'Publish complete.'
              ),
              { label: 'GitHub annotation publish action failed' },
            );
          });

          githubSettingsBtn.addEventListener('click', () => {
            if (!openExternal(settingsUrl)) {
              status.textContent = 'Unable to open GitHub App settings.';
            }
          });
          disconnectRepoBtn.addEventListener('click', () => {
            const authedUserKey = toGitHubUserKey(githubAuth.getUser?.());
            if (!did || !authedUserKey) return;
            const repoRef = getAnnotationRepoForDataset(did, authedUserKey);
            const connectedName = toRepoFullName(repoRef);
            if (!connectedName) return;
            disconnectAnnotationRepo({
              datasetId: did,
              userKey: authedUserKey,
              message: 'Disconnected annotation repository.',
              notify: 'success'
            });
            connectedRepoRef = null;
            selectedRepoFullName = '';
            controller.setLastRepoInfo(null);
            access.clearRole?.();
            status.textContent = 'Repository disconnected.';
            uiStep = 2;
            updateUi();
          });
          disconnectGitHubBtn.addEventListener('click', () => {
            disconnectGitHubSession({ message: 'GitHub disconnected.', notify: 'success' });
          });

          // Initial state.
          updateUi();
          const unsubscribeSyncBusy = controller.subscribeSyncBusy(() => {
            if (isModalOwnerCurrent()) updateUi();
          });
          modalAbort.signal.addEventListener('abort', unsubscribeSyncBusy, {
            once: true,
          });

          // Convenience: after returning from GitHub (Add repo), refresh list automatically.
          window.addEventListener('focus', () => {
            if (!githubAuth.isAuthenticated?.()) return;
            if (uiStep !== 2) return;
            if (isReloadingRepos) return;
            startBackgroundTask(
              () => loadRepoList(),
              { label: 'Unable to refresh GitHub annotation repositories' },
            );
          }, { signal: modalAbort.signal });
        }
      });

      const setupClose = modalRef?.close ?? null;
      if (setupClose !== null) {
        if (typeof setupClose !== 'function') {
          throw new TypeError(
            'GitHub connection modal must expose an exact close function'
          );
        }
        controller.setActiveConnectionClose(setupClose);
      }
      const overlay = modalRef?.overlay || null;
      if (!overlay) {
        controller.releaseActiveConnectionClose(setupClose);
        resolveOnce(null);
        return;
      }
      settleClosed = () => {
        modalRef.content.__cellucidCleanup?.();
        controller.releaseActiveConnectionClose(setupClose);
        resolveOnce(null);
      };
    });
  }

  async function connectRepoFlow({ reason = null } = {}) {
    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    const login = getGitHubLogin();
    const cacheUser = getCacheUserKey();
    const currentRepo = getAnnotationRepoForDataset(datasetId, cacheUser);
    return openGitHubConnectionFlow({
      reason,
      datasetId,
      cacheUser,
      login,
      currentRepo,
    });
  }

  return { openGitHubConnectionFlow, connectRepoFlow };
}
