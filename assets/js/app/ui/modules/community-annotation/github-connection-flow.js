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
import { el } from './dom.js';
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
const GITHUB_REPOSITORY_PAGE_SIZE = 100;

/**
 * Members the wizard needs from the community annotation controls. Every one
 * is a live handle into the controls instance that opened the wizard, so the
 * wizard and the panel behind it always agree about sync status, the connected
 * repository, and which modal is on screen.
 */
const REQUIRED_CONTROLLER_MEMBERS = Object.freeze([
  'isSyncBusy',
  'getSyncError',
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
    mode = 'repo',
    focus = 'overview',
    reason = null,
    datasetId = null,
    cacheUser = null,
    login = null,
    currentRepo = null,
    defaultPullNow = true
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

      const modalRef = showOwnedCommunityModal({
        title: 'GitHub sync',
        buildContent: (content) => {
          const modalAbort = new AbortController();
          // Allow outer scope to stop listeners when modal closes.
          content.__cellucidCleanup = () => modalAbort.abort();

          const did =
            datasetId !== null
              ? datasetId
              : (dataSourceManager?.getCurrentDatasetId?.() ?? null);
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

          const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
          const icon = (d, { viewBox = '0 0 24 24' } = {}) => {
            const svg = svgEl('svg');
            svg.setAttribute('viewBox', viewBox);
            svg.setAttribute('aria-hidden', 'true');
            svg.classList.add('community-annotation-status-icon');
            const path = svgEl('path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', 'currentColor');
            path.setAttribute('stroke-width', '1.8');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
            return svg;
          };

          const statusList = el('div', { className: 'community-annotation-status-list' });
          const makeStatusRow = ({ iconEl, tone = 'warn', key = '', value = '', actions = [] } = {}) => {
            const keyEl = el('span', { className: 'community-annotation-status-key', text: key || '' });
            const valueEl = el('span', { className: 'community-annotation-status-val', text: value || '' });
            const textEl = el('div', { className: 'community-annotation-status-text' }, [keyEl, valueEl]);
            const chip = el('div', { className: `community-annotation-status-chip community-annotation-status-chip--${tone}` }, [
              iconEl || null,
              textEl
            ]);
            const actionsWrap = el('div', { className: 'community-annotation-status-actions' }, actions);
            const row = el('div', { className: 'community-annotation-status-row' }, [chip, actionsWrap]);
            return { row, chip, actionsWrap, keyEl, valueEl };
          };

          const datasetIcon = icon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3');
          const githubIcon = icon('M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 9a8 8 0 0 1 16 0');
          const repoIcon = icon('M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8M8 12h8M8 16h6');
          const gearIcon = icon('M12 15.5a3.5 3.5 0 1 0-3.5-3.5 3.5 3.5 0 0 0 3.5 3.5zm7-3.5a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8.4 8.4 0 0 0-1.7-1l-.3-2.6H9.5L9.2 6.1a8.4 8.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8.4 8.4 0 0 0 1.7 1l.3 2.6h5l.3-2.6a8.4 8.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5a7.8 7.8 0 0 0 .1-1z');
          const disconnectIcon = icon('M10 17l5-5-5-5M15 12H3M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3');

          const githubSettingsBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'GitHub settings', 'aria-label': 'GitHub settings' }, [gearIcon]);
          const disconnectGitHubBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'Disconnect GitHub', 'aria-label': 'Disconnect GitHub' }, [disconnectIcon.cloneNode(true)]);
          const disconnectRepoBtn = el('button', { type: 'button', className: 'community-annotation-status-action', title: 'Disconnect repository', 'aria-label': 'Disconnect repository' }, [disconnectIcon.cloneNode(true)]);

          const datasetRow = makeStatusRow({ iconEl: datasetIcon, tone: 'warn', key: 'Dataset', value: '' });
          const githubRow = makeStatusRow({ iconEl: githubIcon, tone: 'warn', key: 'GitHub', value: '', actions: [githubSettingsBtn, disconnectGitHubBtn] });
          const repoRow = makeStatusRow({ iconEl: repoIcon, tone: 'warn', key: 'Repo', value: '', actions: [disconnectRepoBtn] });

          statusList.appendChild(datasetRow.row);
          statusList.appendChild(githubRow.row);
          statusList.appendChild(repoRow.row);
          content.appendChild(statusList);

          const step1Desc = [
            'This redirects you to GitHub to sign you in. ',
            el('strong', { text: 'Cellucid does not get access to your repositories by default.' }),
            ' You decide later whether to install the GitHub App and which repositories to enable.'
          ];

          const stepDefs = [
            {
              title: 'Sign in with GitHub',
              descParts: step1Desc
            },
            {
              title: 'Install the GitHub App',
              descParts: [
                'Install the GitHub App on your account/org and select which repositories it can access. ',
                'Use “Add repo” to open GitHub, then come back and click “Reload”.'
              ]
            },
            {
              title: 'Select an annotation repository',
              descParts: [
                'Pick a repository where the app is installed. ',
                'This connection is saved locally per dataset (',
                el('code', { text: String(did || 'default') }),
                ') and per GitHub account. ',
                'Cellucid will validate the repo, connect it to this dataset, and pull the latest annotations.'
              ]
            },
            {
              title: 'Sync (pull / publish)',
              descParts: [
                'Use Pull to fetch updates from GitHub. ',
                'Cellucid selects one publication route from the repository permissions before publishing: a direct write for writers, or a fork Pull Request for contributors. A failed route is reported and is never replaced by another route. ',
                'Optional: enable Auto pull to periodically refresh from GitHub.'
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

          const stepIntro = el('div', { className: 'community-annotation-step-intro' });
          const stepIntroTitle = el('div', { className: 'community-annotation-step-intro-title', text: '' });
          const stepIntroDesc = el('div', { className: 'community-annotation-step-intro-desc' });
          stepIntro.appendChild(stepIntroTitle);
          stepIntro.appendChild(stepIntroDesc);
          content.appendChild(stepIntro);

          const step1Panel = el('div', { className: 'community-annotation-step-panel' });
          const step1Help = el('div', { className: 'legend-help', text: '' });
          step1Panel.appendChild(step1Help);
          const step1Actions = el('div', { className: 'community-annotation-step1-actions' });
          const step1SignInBtn = el('button', { type: 'button', className: 'btn-small', text: 'Continue with GitHub' });
          step1Actions.appendChild(step1SignInBtn);
          step1Panel.appendChild(step1Actions);
          content.appendChild(step1Panel);

          const createRepoPager = (label) => {
            const previous = el('button', {
              type: 'button',
              className: 'btn-small',
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
              className: 'btn-small',
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
          const step2Help = el('div', { className: 'legend-help', text: '' });
          step2Panel.appendChild(step2Help);
          const step2Actions = el('div', { className: 'community-annotation-suggestion-actions' });
          const addRepoBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add repo' });
          const reloadReposBtn = el('button', { type: 'button', className: 'btn-small community-annotation-reload-btn', text: 'Reload' });
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
          const step3Help = el('div', { className: 'legend-help', text: 'Select an annotation repository to connect.' });
          step3Panel.appendChild(step3Help);

          const filterRow = el('div', { className: 'legend-help', text: '' });
          const filterInput = el('input', {
            type: 'text',
            className: 'community-annotation-text-input',
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
            className: 'legend-help',
            'aria-live': 'polite',
            'aria-atomic': 'true',
            text: '',
          });
          step3Panel.appendChild(step3Selection);
          content.appendChild(step3Panel);

          const syncBlock = el('div', { className: 'community-annotation-step-panel' });
          syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Sync' }));
          const syncTopRow = el('div', { className: 'community-annotation-sync-toprow' });
          const syncActions = el('div', { className: 'community-annotation-suggestion-actions' });
          const pullBtn = el('button', { type: 'button', className: 'btn-small', text: 'Pull latest' });
          const publishBtn = el('button', { type: 'button', className: 'btn-small', text: 'Publish' });
          syncActions.appendChild(pullBtn);
          syncActions.appendChild(publishBtn);
          syncTopRow.appendChild(syncActions);

          const autoPullRow = el('div', { className: 'community-annotation-auto-pull-row' });
          const autoPullToggle = el('label', { className: 'community-annotation-auto-pull-toggle' });
          const autoPullCheckbox = el('input', { type: 'checkbox' });
          autoPullToggle.appendChild(autoPullCheckbox);
          autoPullToggle.appendChild(el('span', { text: 'Auto pull' }));
            const autoPullSelect = el('select', {
              className: 'community-annotation-auto-pull-select',
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
            className: 'community-annotation-wizard-status',
            role: 'status',
            'aria-live': 'polite',
            text: String(reason || '')
          });
          content.appendChild(status);

          const wizardNav = el('div', { className: 'community-annotation-wizard-nav' });
          const prevBtn = el('button', { type: 'button', className: 'btn-small community-annotation-wizard-prev', text: 'Back' });
          const stepCount = el('div', { className: 'community-annotation-wizard-stepcount', text: '' });
          const nextBtn = el('button', { type: 'button', className: 'btn-small community-annotation-wizard-next', text: 'Next' });
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

            if (visibleRepos.length === 0) {
              const emptyMessage =
                isReloadingRepos && !repoListLoaded
                  ? 'Loading repositories…'
                  : (
                    selectable && q
                      ? 'No repositories match this filter.'
                      : 'No repositories found.'
                  );
              fragment.appendChild(el('div', {
                className: 'legend-help',
                text: emptyMessage,
              }));
            } else {
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
            pager.pageStatus.textContent =
              source.length === 0
                ? 'No repositories to display.'
                : (
                  `Showing ${pageStart + 1}–${pageEnd} of ` +
                  `${source.length} repositories. ` +
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

            const toneToClass = (tone) => {
              const t = String(tone || '').trim();
              if (t === 'ok') return 'community-annotation-status-chip--ok';
              if (t === 'danger') return 'community-annotation-status-chip--danger';
              return 'community-annotation-status-chip--warn';
            };

            datasetRow.chip.className = `community-annotation-status-chip ${toneToClass(did ? 'ok' : 'warn')}`;
            datasetRow.valueEl.textContent = did ? ` ${did}` : ' —';

            githubRow.chip.className = `community-annotation-status-chip ${toneToClass(authed ? 'ok' : 'warn')}`;
            githubRow.valueEl.textContent = authed ? (who ? ` @${who}` : ' signed in') : ' not connected';
            githubSettingsBtn.disabled = !authed;
            disconnectGitHubBtn.disabled = !authed;

            const repoTone = connectedName ? 'ok' : (storedRepoName ? 'warn' : 'warn');
            repoRow.chip.className = `community-annotation-status-chip ${toneToClass(repoTone)}`;
            repoRow.valueEl.textContent =
              connectedName ? ` ${connectedName}` : (storedRepoName && !authed ? ` ${storedRepoName} (sign in)` : ' not connected');
            disconnectRepoBtn.disabled = !(authed && connectedName);

            const showFilter = repoListLoaded && allRepos.length > 20;
            filterRow.style.display = authed && uiStep === 3 && showFilter ? '' : 'none';

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

            step1Panel.style.display = uiStep === 1 ? '' : 'none';
            step2Panel.style.display = authed && uiStep === 2 ? '' : 'none';
            step3Panel.style.display = authed && uiStep === 3 ? '' : 'none';
            syncBlock.style.display = authed && uiStep === 4 ? '' : 'none';

            if (uiStep === 1) {
              step1Help.textContent = authed
                ? 'You’re already signed in. Click Next to continue.'
                : 'Click “Continue with GitHub” to sign in. You will be redirected to GitHub and then returned here.';
              step1Actions.style.display = authed ? 'none' : '';
              step1SignInBtn.disabled = busy;
              step1SignInBtn.textContent = isSigningIn ? 'Redirecting…' : 'Continue with GitHub';
            } else {
              step1Actions.style.display = 'none';
            }

            if (authed && uiStep === 2) {
              const n = allRepos.length;
              step2Help.textContent =
                isReloadingRepos && !repoListLoaded
                  ? 'Loading repositories…'
                  : (
                    n
                      ? `${n} repos available. Click Next to choose one, or Add repo to enable more.`
                      : 'No repos available yet. Click Add repo, choose repos in GitHub, then come back (or click Reload).'
                  );
            }

            if (authed && uiStep === 3) {
              if (isReloadingRepos) {
                step3Help.textContent = 'Loading repositories…';
              } else if (repoListLoaded && allRepos.length === 0) {
                step3Help.textContent = 'No repositories available yet. Go back to step 2 to add repos, then reload.';
              } else {
                step3Help.textContent = 'Select an annotation repository to connect.';
              }
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
              step3Selection.style.display =
                selectionParts.length > 0 ? '' : 'none';
            }

            // Step intro content.
            const def = stepDefs[Math.max(0, Math.min(stepDefs.length - 1, uiStep - 1))] || null;
            stepIntroTitle.textContent = def?.title || '';
            stepIntroDesc.innerHTML = '';
            const parts = Array.isArray(def?.descParts) ? def.descParts : [];
            for (const part of parts) {
              if (part == null) continue;
              stepIntroDesc.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
            }

            // Wizard nav.
            stepCount.textContent = `Step ${uiStep} of ${stepDefs.length}`;
            prevBtn.disabled = busy || uiStep <= 1;

            let nextText = 'Next';
            let nextEnabled = !busy;
            if (uiStep === 1) {
              nextText = 'Next';
              nextEnabled = nextEnabled && authed;
            } else if (uiStep === 2) {
              nextText = 'Next';
              nextEnabled = nextEnabled && (Boolean(connectedName) || (repoListLoaded && allRepos.length > 0));
            } else if (uiStep === 3) {
              const selected = String(selectedRepoFullName || '').trim();
              const wantsSwitch = Boolean(connectedName && selected && selected !== connectedName);
              const needsConnect = Boolean(!connectedName);
              if (wantsSwitch || needsConnect) {
                nextText = isConnectingRepo ? (wantsSwitch ? 'Switching…' : 'Connecting…') : (wantsSwitch ? 'Switch repo' : 'Connect');
                nextEnabled = nextEnabled && Boolean(selected) && (!connectedName || selected !== connectedName);
              } else {
                nextText = 'Next';
              }
            } else if (uiStep === 4) {
              nextText = 'Done';
            }

            nextBtn.textContent = nextText;
            nextBtn.disabled = !nextEnabled;
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
            isReloadingRepos = true;
            updateUi();
            status.textContent = uiStep === 3 ? 'Loading repositories…' : '';
            try {
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
              status.textContent = allRepos.length ? '' : 'No repositories available yet. Install the app and select repos, then reload.';
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

            status.textContent = 'Connecting…';
            isConnectingRepo = true;
            updateUi();
            try {
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
              if (result?.ok) {
                selectedRepoFullName = '';
                status.textContent = 'Connected and up to date.';
                uiStep = 4;
              } else if (result?.cancelled) {
                status.textContent = 'Cancelled.';
              } else {
                status.textContent = controller.getSyncError() ? `⚠ ${controller.getSyncError()}` : 'Failed to connect.';
              }
            } finally {
              isConnectingRepo = false;
              if (isModalOwnerCurrent()) updateUi();
            }
          };

          const signIn = async () => {
            if (isSigningIn) return;
            isSigningIn = true;
            status.textContent = 'Redirecting to GitHub sign-in…';
            updateUi();
            try {
              await githubAuth.signIn?.({
                signal: modalAbort.signal,
              });
              if (isModalOwnerCurrent()) {
                isSigningIn = false;
                status.textContent =
                  'GitHub sign-in navigation was requested.';
                updateUi();
              }
            } catch (err) {
              if (modalAbort.signal.aborted) return;
              isSigningIn = false;
              status.textContent = String(err?.message || 'Sign-in failed');
              updateUi();
            }
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

          pullBtn.addEventListener('click', () => {
            startBackgroundTask(async () => {
              pullBtn.disabled = true;
              status.textContent = 'Pulling latest annotations…';
              try {
                const promise = pullFromGitHub({
                  signal: modalAbort.signal,
                });
                updateUi();
                await promise;
                if (!isModalOwnerCurrent()) return;
                status.textContent = controller.getSyncError() ? `⚠ ${controller.getSyncError()}` : 'Pulled latest annotations.';
              } finally {
                if (isModalOwnerCurrent()) {
                  pullBtn.disabled = false;
                  updateUi();
                }
              }
            }, { label: 'GitHub annotation pull action failed' });
          });
          publishBtn.addEventListener('click', () => {
            startBackgroundTask(async () => {
              publishBtn.disabled = true;
              status.textContent = 'Publishing…';
              try {
                const promise = pushToGitHub({
                  signal: modalAbort.signal,
                });
                updateUi();
                await promise;
                if (!isModalOwnerCurrent()) return;
                status.textContent = controller.getSyncError() ? `⚠ ${controller.getSyncError()}` : 'Publish complete.';
              } finally {
                if (isModalOwnerCurrent()) {
                  publishBtn.disabled = false;
                  updateUi();
                }
              }
            }, { label: 'GitHub annotation publish action failed' });
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
      const cleanup = () => {
        modalRef?.content?.__cellucidCleanup?.();
      };
      const observer = new MutationObserver(() => {
        if (resolved) {
          observer.disconnect();
          cleanup();
          return;
        }
        if (!document.body.contains(overlay)) {
          observer.disconnect();
          cleanup();
          controller.releaseActiveConnectionClose(setupClose);
          resolveOnce(mode === 'auth' ? Boolean(githubAuth.isAuthenticated?.()) : null);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function connectRepoFlow({ reason = null, defaultPullNow = true } = {}) {
    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const login = getGitHubLogin();
    const cacheUser = getCacheUserKey();
    const currentRepo = getAnnotationRepoForDataset(datasetId, cacheUser);
    return openGitHubConnectionFlow({
      mode: 'repo',
      focus: 'repo',
      reason,
      datasetId,
      cacheUser,
      login,
      currentRepo,
      defaultPullNow
    });
  }

  return { openGitHubConnectionFlow, connectRepoFlow };
}
