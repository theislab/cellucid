/**
 * @fileoverview The community annotation sidebar panel.
 *
 * Rebuilds the whole section on every `render()`: the offline and sign-in
 * gating, the GitHub sync block, the profile block, the per-field annotation
 * settings, the derived consensus column, and the exports/cache accordion.
 *
 * Everything the panel owns is view state — which field is selected, which
 * accordion is open, the consensus column draft, the information-popover
 * sequence, and the identity button that modals return focus to. None of it
 * outlives a render except across renders of the same controls instance, and
 * nothing outside this module reads it, which is why it lives here rather than
 * in the controls closure. Sync status, context ownership, identity, and the
 * connection wizard all belong to the controls and arrive through `controller`.
 *
 * @module ui/modules/community-annotation/controls-panel
 */

import {
  getAnnotationRepoForDataset,
} from '../../../community-annotations/repo-store.js';
import {
  isAnnotationRepoConnected,
  isSimulateRepoConnectedEnabled,
} from '../../../community-annotations/access-store.js';
import { downloadJsonAsFile, el, toCleanString } from './dom.js';
import { createDomId } from '../../components/dom-id.js';
import { confirmAsync } from './modal-shell.js';
import { assertExactGitHubLogin } from './identity-assertions.js';
import {
  clampConsensusThreshold11,
  clampInt,
  formatPctSigned11,
  sliderValueToThreshold,
  thresholdToSliderValue,
} from './consensus-math.js';
import { copyTextToClipboard } from './browser-integration.js';

const CONSENSUS_SNAPSHOT_FILENAME = 'cellucid-consensus.json';

/**
 * Members the panel needs from the community annotation controls.
 */
const REQUIRED_CONTROLLER_MEMBERS = Object.freeze([
  'isContextDestroyed',
  'isSyncBusy',
  'getSyncError',
  'applyConsensusColumn',
  'connectRepoFlow',
  'editIdentityFlow',
  'ensureIdentityForUserKey',
  'getCacheContext',
  'getCacheUserId',
  'getCacheUserKey',
  'getGitHubLogin',
  'isContextOwnerCurrent',
  'observeBackgroundTask',
  'openGitHubConnectionFlow',
  'publishContextOwner',
  'startBackgroundTask',
]);

/**
 * Build the sidebar renderer for one community annotation controls instance.
 *
 * @param {object} controller
 * @returns {{render: () => void}}
 */
export function createControlsPanel(controller) {
  if (controller === null || typeof controller !== 'object') {
    throw new TypeError(
      'The community annotation panel requires the controls interface'
    );
  }
  for (const member of REQUIRED_CONTROLLER_MEMBERS) {
    if (typeof controller[member] !== 'function') {
      throw new TypeError(
        `The community annotation panel requires controller.${member}()`
      );
    }
  }
  const {
    container,
    state,
    dataSourceManager,
    infoPopovers,
    session,
    access,
    fileCache,
    notifications,
    githubAuth,
    annotatableSettingsDraft,
    annotatableSettingsDirty,
    applyConsensusColumn,
    connectRepoFlow,
    editIdentityFlow,
    ensureIdentityForUserKey,
    getCacheContext,
    getCacheUserId,
    getCacheUserKey,
    getGitHubLogin,
    isContextOwnerCurrent,
    observeBackgroundTask,
    openGitHubConnectionFlow,
    publishContextOwner,
    startBackgroundTask,
  } = controller;
  if (
    !(container instanceof HTMLElement) ||
    state === null ||
    typeof state !== 'object' ||
    infoPopovers === null ||
    typeof infoPopovers !== 'object' ||
    annotatableSettingsDraft === null ||
    typeof annotatableSettingsDraft !== 'object' ||
    !(annotatableSettingsDirty instanceof Set)
  ) {
    throw new TypeError(
      'The community annotation panel requires its container, the visualization state, the information popover controller, and the annotatable settings draft'
    );
  }

  let selectedFieldKey = null;
  // Derived consensus column (manual, optional).
  let consensusColumnThreshold = 0.5;
  let consensusColumnMinAnnotators = 1;
  let consensusColumnKey = 'community_cell_type';
  let consensusSourceFieldKey = null;
  // Community annotation internal accordions: closed by default; only one may be open at a time.
  /** @type {'consensus-column'|'manage'|'exports-cache'|null} */
  let openAccordionKey = null;

  let identityEditButton = null;

  let infoPopoverSequence = 0;

  function createInfoTooltip(label, steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new TypeError(
        'Community annotation information requires at least one exact step'
      );
    }
    const btn = el(
      'button',
      { className: 'info-btn' },
      [el('span', { 'aria-hidden': 'true', text: 'i' })]
    );
    const tooltip = el('div', { className: 'info-tooltip' });
    const content = el('div', { className: 'info-tooltip-content' });
    for (const step of steps) {
      if (
        typeof step !== 'string'
        || !step
        || step.trim() !== step
      ) {
        throw new TypeError(
          'Community annotation information steps must be exact strings'
        );
      }
      content.appendChild(el('div', { className: 'info-step', text: step }));
    }
    tooltip.appendChild(content);
    infoPopoverSequence += 1;
    infoPopovers.configurePair(btn, tooltip, {
      id: `community-annotation-info-${infoPopoverSequence}`,
      label
    });

    return { btn, tooltip };
  }

  /**
   * A section caption with its info popover trigger.
   *
   * Pass `controlId` whenever the caption names one form control, so clicking
   * the caption text focuses that control. Without it the caption is a heading
   * over a group of controls (or over no control at all), and the `<label>`
   * carries no association because there is nothing single to associate it
   * with. The element stays a `<label>` in that case because `#sidebar label`
   * in `assets/css/components/_sidebar.css` is what gives every caption in this
   * panel its type treatment.
   *
   * @param {string} text
   * @param {{btn: HTMLElement}} info
   * @param {{controlId?: string|null}} [options]
   */
  function createInfoLabel(text, info, { controlId = null } = {}) {
    if (
      controlId !== null &&
      (typeof controlId !== 'string' || controlId !== controlId.trim() || !controlId)
    ) {
      throw new TypeError(
        'Community annotation info label control id must be an exact id or null'
      );
    }
    return el('div', { className: 'd-flex items-center gap-1' }, [
      el('label', controlId === null ? { text } : { for: controlId, text }),
      info.btn
    ]);
  }

  function resolveIdentityModalFocus() {
    if (controller.isContextDestroyed()) return null;
    if (
      identityEditButton instanceof HTMLButtonElement &&
      identityEditButton.isConnected &&
      !identityEditButton.disabled
    ) {
      return identityEditButton;
    }
    const details = container.closest('details');
    if (!(details instanceof HTMLDetailsElement)) return null;
    const summary = [...details.children].find(
      child => child.tagName === 'SUMMARY'
    );
    return summary instanceof HTMLElement && summary.isConnected
      ? summary
      : null;
  }

  function readConsensusColumnSettings() {
    return {
      consensusSourceFieldKey,
      selectedFieldKey,
      consensusColumnKey,
      consensusColumnMinAnnotators,
      consensusColumnThreshold,
    };
  }

  function render() {
    if (controller.isContextDestroyed()) return;
    identityEditButton = null;
    infoPopovers.closeWithin(container);
    container.innerHTML = '';
    infoPopoverSequence = 0;

    const datasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUsername = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUsername);
    const repoConnectedForGating = isAnnotationRepoConnected(datasetId, cacheUsername);
    const online =
      typeof navigator !== 'undefined'
        ? navigator.onLine !== false
        : true;
    if (!repoConnectedForGating) {
      const introBlock = el('div', { className: 'control-block relative' });
      const introInfo = createInfoTooltip('About community annotation', [
        'Connect an annotation repo to enable community voting and GitHub sync.',
        'Voting UI is hidden elsewhere until a repo is connected.'
      ]);
      introBlock.appendChild(createInfoLabel('Community annotation', introInfo));
      introBlock.appendChild(introInfo.tooltip);
      introBlock.appendChild(el('div', { className: 'legend-help', text: 'No annotation repo connected.' }));

      const actions = el('div', { className: 'community-annotation-suggestion-actions' });
      if (!online) {
        introBlock.appendChild(el('div', {
          className: 'legend-help',
          text: 'Offline: GitHub actions are disabled.',
        }));
      }
      const connectBtn = el('button', {
        type: 'button',
        className: 'btn-small',
        text: 'Connect repo',
        disabled: controller.isSyncBusy() || !online,
      });
      connectBtn.addEventListener('click', () => {
        startBackgroundTask(
          () => connectRepoFlow({ reason: null, defaultPullNow: true }),
          { label: 'Unable to open GitHub annotation connection' },
        );
      });
      actions.appendChild(connectBtn);
      introBlock.appendChild(actions);
      container.appendChild(introBlock);
      return;
    }

    const introBlock = el('div', { className: 'control-block relative' });
    const introInfo = createInfoTooltip('About community voting', [
      'Offline-first: votes/suggestions are saved locally first.',
      'Annotatable columns are chosen by repo authors (maintain/admin) via the annotation repo config.',
      'Connecting an annotation repo is required to participate (voting UI is hidden otherwise).',
      'Pull/Publish to GitHub is optional after connecting.'
    ]);
    introBlock.appendChild(createInfoLabel('Community voting', introInfo));
    introBlock.appendChild(introInfo.tooltip);
    container.appendChild(introBlock);

    // GitHub sync
    const isAuthed = githubAuth.isAuthenticated();
    const authedUser = githubAuth.getUser();
    const login =
      authedUser === null
        ? ''
        : assertExactGitHubLogin(authedUser.login, 'Authenticated GitHub login');
    const syncBlock = el('div', { className: 'control-block relative' });
    const syncInfo = createInfoTooltip('About GitHub annotation sync', [
      'Open GitHub sync to sign in, install the app, pick a repo, and pull/publish.',
      'Your sign-in token is stored only in sessionStorage (clears on tab close).',
      'The GitHub App has no repo access by default; you choose which repos to enable.'
    ]);
    syncBlock.appendChild(createInfoLabel('GitHub sync', syncInfo));
    syncBlock.appendChild(syncInfo.tooltip);

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

    const datasetIcon = icon('M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3m-16 6c0 1.7 3.6 3 8 3s8-1.3 8-3');
    const githubIcon = icon('M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 9a8 8 0 0 1 16 0');
    const repoIcon = icon('M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM8 8h8M8 12h8M8 16h6');
    const copyIcon = icon('M8 8h12v12H8zM4 4h12v12H4z');

    const toneClass = (tone) => {
      if (tone === 'ok') return 'community-annotation-status-chip community-annotation-status-chip--ok';
      if (tone === 'danger') return 'community-annotation-status-chip community-annotation-status-chip--danger';
      return 'community-annotation-status-chip community-annotation-status-chip--warn';
    };

    const makeStatusRow = ({ iconEl, tone = 'warn', key = '', value = '', actions = [] } = {}) => {
      const keyEl = el('span', { className: 'community-annotation-status-key', text: key || '' });
      const valueEl = el('span', { className: 'community-annotation-status-val', text: value || '' });
      const textEl = el('div', { className: 'community-annotation-status-text' }, [keyEl, valueEl]);
      const chip = el('div', { className: toneClass(tone) }, [iconEl || null, textEl]);
      const rowChildren = [chip];
      if (Array.isArray(actions) && actions.length) {
        rowChildren.push(el('div', { className: 'community-annotation-status-actions' }, actions));
      }
      return el('div', { className: 'community-annotation-status-row' }, rowChildren);
    };

    const storedRepoName = repo ? String(repo).split('@')[0] : '';
    const connectedName = isAuthed ? storedRepoName : '';

    const copyShareLinkBtn = (() => {
      if (!repo) return null;
      const btn = el('button', {
        type: 'button',
        className: 'community-annotation-status-action',
        title: 'Copy share link (includes @branch)',
        'aria-label': 'Copy share link'
      }, [copyIcon]);
      btn.disabled = controller.isSyncBusy();
      btn.addEventListener('click', () => {
        startBackgroundTask(async () => {
          const url = new URL(window.location.href);
          url.searchParams.set('annotations', String(repo).trim());
          const ok = await copyTextToClipboard(url.toString());
          if (ok) notifications.success('Share link copied.', { category: 'annotation', duration: 2200 });
          else notifications.error('Unable to copy share link.', { category: 'annotation', duration: 3500 });
        }, { label: 'Unable to copy the annotation share link' });
      });
      return btn;
    })();

    const statusList = el('div', { className: 'community-annotation-status-list community-annotation-status-panel community-annotation-dashed-box community-annotation-dashed-box--prose' });
    statusList.appendChild(makeStatusRow({
      iconEl: datasetIcon,
      tone: datasetId ? 'ok' : 'warn',
      key: 'Dataset',
      value: datasetId ? ` ${datasetId}` : ' —',
      actions: []
    }));
    statusList.appendChild(makeStatusRow({
      iconEl: githubIcon,
      tone: isAuthed ? 'ok' : 'warn',
      key: 'GitHub',
      value: isAuthed ? (login ? ` @${login}` : ' signed in') : ' not connected',
      actions: []
    }));
    statusList.appendChild(makeStatusRow({
      iconEl: repoIcon,
      tone: connectedName ? 'ok' : 'warn',
      key: 'Repo',
      value: connectedName ? ` ${connectedName}` : (storedRepoName && !isAuthed ? ` ${storedRepoName} (sign in)` : ' not connected'),
      actions: copyShareLinkBtn ? [copyShareLinkBtn] : []
    }));

    syncBlock.appendChild(statusList);

    if (!online) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: 'Offline: GitHub actions are disabled.' }));
    }

    const currentSyncError = controller.getSyncError();
    if (currentSyncError) {
      syncBlock.appendChild(el('div', { className: 'legend-help', text: `⚠ ${currentSyncError}` }));
    }

    const syncActions = el('div', { className: 'community-annotation-sync-actions' });
    const openBtnText = !isAuthed ? 'Connect GitHub…' : (!repo ? 'Choose repo…' : 'GitHub sync…');
    const openSyncBtn = el('button', { type: 'button', className: 'btn-small', text: openBtnText });
    openSyncBtn.disabled = controller.isSyncBusy() || !online;
    openSyncBtn.addEventListener('click', () => {
      observeBackgroundTask(
        openGitHubConnectionFlow({
          mode: 'repo',
          focus: 'overview',
          reason: null,
          datasetId,
          cacheUser: cacheUsername,
          login,
          currentRepo: repo,
          defaultPullNow: true
        }),
        { label: 'Unable to open GitHub annotation sync' },
      );
    });
    syncActions.appendChild(openSyncBtn);
    syncBlock.appendChild(syncActions);

    // Keep the panel minimal unless a repo is connected (or dev-simulated).
    // This avoids showing lots of offline controls that depend on repo config/roles.
    if (!repoConnectedForGating) {
      container.appendChild(syncBlock);
      return;
    }

    // Community annotation internal accordions:
    // - closed by default
    // - only one open at a time
    const accordionPeers = [];
    const registerAccordionPeer = (key, itemEl, headerEl) => {
      if (!key || !itemEl || !headerEl) return;
      accordionPeers.push({ key, itemEl, headerEl });
    };
    const syncAccordionPeers = () => {
      for (const { key, itemEl, headerEl } of accordionPeers) {
        const isOpen = openAccordionKey === key;
        itemEl.classList.toggle('open', isOpen);
        headerEl.setAttribute('aria-expanded', String(isOpen));
      }
    };
    const toggleAccordionPeer = (key) => {
      openAccordionKey = (openAccordionKey === key) ? null : key;
      syncAccordionPeers();
    };

    container.appendChild(syncBlock);

    const consensusBlock = el('div', { className: 'control-block relative' });

    const catFieldsForConsensus = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeysForConsensus = catFieldsForConsensus.map((f) => f.key).filter(Boolean);
    const annotatableKeysForConsensus = session.getAnnotatedFields().filter((k) => allKeysForConsensus.includes(k));
    if (!consensusSourceFieldKey || !annotatableKeysForConsensus.includes(consensusSourceFieldKey)) {
      consensusSourceFieldKey = annotatableKeysForConsensus[0] || null;
    }

    const accordion = el('div', { className: 'analysis-accordion' });
    const consensusAccordionKey = 'consensus-column';
    const item = el('div', { className: `analysis-accordion-item${openAccordionKey === consensusAccordionKey ? ' open' : ''}` });
    const header = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === consensusAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'DERIVED CONSENSUS COLUMN' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Optional: build an obs column from current votes' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const content = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(consensusAccordionKey, item, header);
    const toggleOpen = () => toggleAccordionPeer(consensusAccordionKey);
    header.addEventListener('click', () => toggleOpen());
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleOpen();
      }
    });

    // Source annotatable column selector
    const srcWrap = el('div', { className: 'field-select relative' });
    const consensusInfo = createInfoTooltip('About derived consensus columns', [
      'This does not change the voting rules or publish anything to GitHub.',
      'It only creates/updates a local derived obs column in the dataset for visualization.',
      'Each cluster becomes: a consensus label, Disputed, or Pending.'
    ]);
    const srcSelectId = createDomId('community-annotation-consensus-source');
    srcWrap.appendChild(createInfoLabel(
      'Annotatable column:',
      consensusInfo,
      { controlId: srcSelectId }
    ));
    srcWrap.appendChild(consensusInfo.tooltip);
    const srcSelect = el('select', {
      id: srcSelectId,
      className: 'obs-select',
      'aria-label': 'Annotatable column'
    });
    if (!annotatableKeysForConsensus.length) {
      srcSelect.appendChild(el('option', { value: '', text: '(no annotatable columns)' }));
      srcSelect.disabled = true;
    } else {
      for (const k of annotatableKeysForConsensus) srcSelect.appendChild(el('option', { value: k, text: k }));
      srcSelect.value = consensusSourceFieldKey || annotatableKeysForConsensus[0];
      srcSelect.addEventListener('change', () => {
        consensusSourceFieldKey = toCleanString(srcSelect.value) || null;
      });
    }
    srcWrap.appendChild(srcSelect);
    content.appendChild(srcWrap);

    // Consensus column key
    const consensusKeyWrap = el('div', { className: 'field-select' });
    const consensusKeyInputId = createDomId(
      'community-annotation-consensus-key'
    );
    consensusKeyWrap.appendChild(el('label', {
      for: consensusKeyInputId,
      text: 'New column key:'
    }));
    const consensusKeyInput = el('input', {
      id: consensusKeyInputId,
      type: 'text',
      className: 'community-annotation-text-input community-annotation-input',
      'aria-label': 'New column key',
      placeholder: 'community_cell_type'
    });
    consensusKeyInput.value = consensusColumnKey;
    consensusKeyInput.addEventListener('change', () => {
      consensusColumnKey = String(consensusKeyInput.value || '').trim();
    });
    consensusKeyWrap.appendChild(consensusKeyInput);
    content.appendChild(consensusKeyWrap);

    // Consensus threshold + min annotators
    const consensusSettings = el('div', { className: 'control-block community-annotation-settings' });
    const thresholdInputId = createDomId(
      'community-annotation-consensus-threshold'
    );
    const thresholdLabel = el('label', {
      for: thresholdInputId,
      text: 'Consensus threshold:'
    });
    const thresholdInput = el('input', {
      id: thresholdInputId,
      type: 'range',
      'aria-label': 'Consensus threshold',
      min: '-100',
      max: '100',
      step: '1',
      value: thresholdToSliderValue(consensusColumnThreshold)
    });
    const thresholdDisplay = el('span', { className: 'slider-value', text: formatPctSigned11(consensusColumnThreshold) });
    thresholdInput.addEventListener('input', () => {
      consensusColumnThreshold = sliderValueToThreshold(thresholdInput.value);
      thresholdDisplay.textContent = formatPctSigned11(consensusColumnThreshold);
    });
    const thresholdRow = el('div', { className: 'slider-row' }, [thresholdInput, thresholdDisplay]);
    consensusSettings.appendChild(thresholdLabel);
    consensusSettings.appendChild(thresholdRow);

    const minInputId = createDomId('community-annotation-consensus-min');
    const minLabel = el('label', {
      for: minInputId,
      text: 'Min annotators:'
    });
    const minInput = el('input', {
      id: minInputId,
      type: 'number',
      className: 'obs-select',
      'aria-label': 'Min annotators',
      value: String(consensusColumnMinAnnotators),
      min: '0',
      max: '50',
      step: '1'
    });
    minInput.addEventListener('change', () => {
      consensusColumnMinAnnotators = clampInt(Number(minInput.value), 0, 50);
      minInput.value = String(consensusColumnMinAnnotators);
    });
    consensusSettings.appendChild(minLabel);
    consensusSettings.appendChild(minInput);
    content.appendChild(consensusSettings);

    const applyActions = el('div', { className: 'community-annotation-consensus-actions' });
    const applyBtn = el('button', { type: 'button', className: 'btn-small', text: 'Build derived column' });
    applyBtn.disabled = controller.isSyncBusy() || !consensusSourceFieldKey;
    applyBtn.addEventListener('click', () => {
      startBackgroundTask(
        () => applyConsensusColumn(readConsensusColumnSettings),
        { label: 'Unable to build the community consensus column' },
      );
    });
    applyActions.appendChild(applyBtn);
    content.appendChild(applyActions);

    item.appendChild(header);
    item.appendChild(content);
    accordion.appendChild(item);
    consensusBlock.appendChild(accordion);

    // Profile (asked once per GitHub username; editable)
    const profile = session.getProfile();
      const identityBlock = el('div', { className: 'control-block relative' });
      const identityInfo = createInfoTooltip('About annotation profiles', [
        'Profile fields are optional and saved locally (like votes) until you Publish.',
        'Publish writes them into your GitHub user file; Pull reloads them from GitHub.',
        'Your GitHub username comes from sign-in.'
      ]);
    identityBlock.appendChild(createInfoLabel('Profile (optional)', identityInfo));
    identityBlock.appendChild(identityInfo.tooltip);

    const authedLogin = getGitHubLogin();
    // Allow editing when signed in OR when dev override is enabled
    const canEdit = Boolean(githubAuth.isAuthenticated?.() && authedLogin) || isSimulateRepoConnectedEnabled();
    const profileBox = el('div', { className: 'community-annotation-dashed-box community-annotation-profile-box' });
    const addProfileRow = (key, value) => {
      profileBox.appendChild(el('div', { className: 'community-annotation-profile-row' }, [
        el('span', { className: 'community-annotation-profile-key', text: String(key || '') }),
        el('span', { className: 'community-annotation-profile-val', text: String(value || '') })
      ]));
    };
    addProfileRow('GitHub', githubAuth.isAuthenticated?.() ? 'connected' : 'not connected');
    addProfileRow('User', `@${authedLogin || 'local'}`);
    if (profile?.displayName) addProfileRow('Name', profile.displayName);
    if (profile?.title) addProfileRow('Title', profile.title);
    if (profile?.orcid) addProfileRow('ORCID', profile.orcid);
    if (profile?.linkedin) addProfileRow('LinkedIn', profile.linkedin);
    identityBlock.appendChild(profileBox);

    const identityActions = el('div', { className: 'community-annotation-identity-actions' });
    const editBtn = el('button', {
      type: 'button',
      className: 'btn-small community-annotation-profile-edit',
      text: 'Edit'
    });
    identityEditButton = editBtn;
    const clearBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear' });
    identityActions.appendChild(editBtn);
    identityActions.appendChild(clearBtn);
    identityBlock.appendChild(identityActions);

    editBtn.disabled = !canEdit || controller.isSyncBusy();
    clearBtn.disabled = !canEdit || controller.isSyncBusy();
    editBtn.title = editBtn.disabled ? 'Sign in first.' : 'Edit your attribution info (published in your GitHub user file).';
    clearBtn.title = clearBtn.disabled ? 'Sign in first.' : 'Clear your profile fields (Publish to update GitHub).';

      editBtn.addEventListener('click', (event) => {
        const returnFocusTo = event.currentTarget;
        if (!(returnFocusTo instanceof HTMLButtonElement)) {
          throw new TypeError(
            'Community annotation profile edit requires its button owner'
          );
        }
        startBackgroundTask(async () => {
          if (!canEdit) return;
          const loginOrLocal = authedLogin || 'local';
          await ensureIdentityForUserKey({ userKey: getCacheUserKey(), login: loginOrLocal, githubUserId: githubAuth.getUser?.()?.id ?? null, promptIfMissing: false });
            await editIdentityFlow({
            suggestedUsername: loginOrLocal,
            returnFocusTo,
            returnFocusResolver: resolveIdentityModalFocus
          });
        }, { label: 'Unable to edit the annotation profile' });
      });

      clearBtn.addEventListener('click', () => {
      startBackgroundTask(async () => {
          if (!canEdit) return;
        const owner = publishContextOwner(getCacheContext({}));
          const loginOrLocal = authedLogin || 'local';
          const ok = await confirmAsync({
            title: 'Clear profile?',
            message: `Clear your profile fields for @${loginOrLocal} in this session?\n\nPublish to update your GitHub user file.`,
            confirmText: 'Clear',
            signal: owner.signal,
          });
          if (!ok || !isContextOwnerCurrent(owner)) return;
          const currentProfile = session.getProfile();
          session.setProfile({
            ...currentProfile,
            login: loginOrLocal,
            displayName: '',
            title: '',
            orcid: '',
            linkedin: '',
          });
        render();
      }, { label: 'Unable to clear the annotation profile' });
      });

      container.appendChild(identityBlock);
      // Collapsibles are appended at the bottom of this section.

      // ─────────────────────────────────────────────────────────────────────────
      // MANAGE ANNOTATION - author-only when connected to a repo
      // ─────────────────────────────────────────────────────────────────────────
      const annotated = session.getAnnotatedFields();
    const catFields = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeys = catFields.map((f) => f.key).filter(Boolean);
    if (!selectedFieldKey || !allKeys.includes(selectedFieldKey)) {
      const active = state.getActiveField?.() || null;
      selectedFieldKey = active?.kind === 'category' && active?.key ? active.key : (allKeys[0] || null);
    }

    const hasSelection = Boolean(selectedFieldKey);
    const canManageAnnotatable = hasSelection && access.isAuthor();
    const role = access.getEffectiveRole?.() || access.getRole?.() || 'unknown';

    const manageBlock = el('div', { className: 'control-block relative' });

    const manageAccordionKey = 'manage';
    const manageAccordion = el('div', { className: 'analysis-accordion' });
    const manageItem = el('div', { className: `analysis-accordion-item${openAccordionKey === manageAccordionKey ? ' open' : ''}` });
    const manageHeaderBtn = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === manageAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'MANAGE ANNOTATION' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Add/remove columns from annotation (author)' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const manageContent = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(manageAccordionKey, manageItem, manageHeaderBtn);

    const toggleManageOpen = () => toggleAccordionPeer(manageAccordionKey);
    manageHeaderBtn.addEventListener('click', () => toggleManageOpen());
    manageHeaderBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleManageOpen();
      }
    });

      if (role !== 'author') {
        const msg = role === 'unknown'
          ? 'Role: unknown (checking repo permissions). If this cannot be resolved, the repo will be disconnected.'
          : `Role: ${role}. Only authors (maintain/admin) can change repo annotation settings.`;
        manageContent.appendChild(el('div', { className: 'legend-help', text: msg }));
      }

    manageContent.appendChild(el('div', {
      className: 'legend-help',
      text: 'Add or remove categorical columns from the annotation list. When connected to a repo, only authors can change this.'
    }));

      // Field selector dropdown
      const fieldSelectWrap = el('div', { className: 'field-select' });
      const fieldSelectId = createDomId(
        'community-annotation-categorical-obs'
      );
      fieldSelectWrap.appendChild(el('label', {
        for: fieldSelectId,
        text: 'Categorical obs:'
      }));
      const fieldSelect = el('select', {
        id: fieldSelectId,
        className: 'obs-select',
        'aria-label': 'Categorical obs'
      });
      fieldSelect.appendChild(el('option', { value: '', text: allKeys.length ? 'None' : '(no categorical obs fields)' }));
      for (const key of allKeys) {
        const enabled = annotated.includes(key);
        const closed = enabled ? Boolean(session.isFieldClosed(key)) : false;
        const prefix = enabled ? (closed ? '🗳️🏁 ' : '🗳️ ') : '';
        fieldSelect.appendChild(el('option', { value: key, text: prefix ? `${prefix}${key}` : key }));
      }
      if (selectedFieldKey) fieldSelect.value = selectedFieldKey;
      fieldSelect.addEventListener('change', () => {
        selectedFieldKey = fieldSelect.value || null;
        render();
      });
      fieldSelectWrap.appendChild(fieldSelect);
      manageContent.appendChild(fieldSelectWrap);

      const manageActions = el('div', { className: 'community-annotation-consensus-actions', 'aria-label': 'Manage annotation actions' });

      const lockedReason = !hasSelection
        ? 'Select a categorical obs field first.'
        : (repoConnectedForGating && !access.isAuthor() ? 'Author (maintain/admin) required.' : '');
      const addBtn = el('button', { type: 'button', className: 'btn-small', text: 'Add', title: lockedReason || 'Mark this column as annotatable', disabled: !canManageAnnotatable });
      const removeBtn = el('button', { type: 'button', className: 'btn-small', text: 'Remove', title: lockedReason || 'Remove this column from annotation', disabled: !canManageAnnotatable });
      const isAnnotatable = hasSelection && annotated.includes(selectedFieldKey);
      const isClosed = isAnnotatable ? Boolean(session.isFieldClosed(selectedFieldKey)) : false;
      const closeBtn = isAnnotatable
        ? el('button', {
          type: 'button',
          className: 'btn-small',
          text: isClosed ? 'Reopen' : 'Close',
          title: isClosed ? 'Reopen this annotatable column for community voting.' : 'Close this annotatable column (voting disabled for annotators).',
          disabled: repoConnectedForGating && !access.isAuthor()
        })
        : null;

      addBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        if (annotated.includes(selectedFieldKey)) {
          notifications.error(`"${selectedFieldKey}" is already in annotation list`, { category: 'annotation', duration: 2200 });
          return;
        }
        session.setFieldAnnotated(selectedFieldKey, true);
        notifications.success(`Added "${selectedFieldKey}" to annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      removeBtn.addEventListener('click', () => {
        if (!selectedFieldKey) return;
        if (repoConnectedForGating && !access.isAuthor()) return;
        if (!annotated.includes(selectedFieldKey)) {
          notifications.error(`"${selectedFieldKey}" is not in annotation list`, { category: 'annotation', duration: 2200 });
          return;
        }
        session.setFieldAnnotated(selectedFieldKey, false);
        notifications.success(`Removed "${selectedFieldKey}" from annotation`, { category: 'annotation', duration: 2200 });
        render();
      });

      manageActions.appendChild(addBtn);
      manageActions.appendChild(removeBtn);
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          if (!selectedFieldKey) return;
          if (repoConnectedForGating && !access.isAuthor()) return;
          const next = !Boolean(session.isFieldClosed(selectedFieldKey));
          session.setFieldClosed(selectedFieldKey, next);
          notifications.success(next ? `Closed "${selectedFieldKey}"` : `Reopened "${selectedFieldKey}"`, { category: 'annotation', duration: 2200 });
          render();
        });
        manageActions.appendChild(closeBtn);
      }
      manageContent.appendChild(manageActions);

      // Per-annotatable voting consensus settings (author-controlled, per field; only shown once the field is annotatable).
      if (isAnnotatable) {
        const info = createInfoTooltip('About consensus settings', [
          'These settings control the voting consensus for this annotatable column (per column).',
          'Changes are staged locally until you click Apply; Publish (as author) writes them to annotations/config.json.'
        ]);

        const block = el('div', { className: 'control-block community-annotation-settings relative' });
        block.appendChild(el('div', { className: 'd-flex items-center gap-1' }, [
          el('div', { className: 'legend-help', text: 'Annotatable consensus settings' }),
          info.btn
        ]));
        block.appendChild(info.tooltip);

        const canEditSettings = !repoConnectedForGating || access.isAuthor();
        const applied = session.getAnnotatableConsensusSettings(selectedFieldKey);
        if (!applied) {
          throw new Error(
            `Missing consensus settings for annotatable field ${JSON.stringify(selectedFieldKey)}`
          );
        }
        if (
          !annotatableSettingsDirty.has(selectedFieldKey) ||
          !Object.hasOwn(annotatableSettingsDraft, selectedFieldKey)
        ) {
          annotatableSettingsDraft[selectedFieldKey] = { ...applied };
        }
        const draft = annotatableSettingsDraft[selectedFieldKey];

        const thInputId = createDomId(
          'community-annotation-annotatable-threshold'
        );
        const thLabel = el('label', {
          for: thInputId,
          text: 'Threshold:'
        });
        const thInput = el('input', {
          id: thInputId,
          type: 'range',
          'aria-label': 'Annotatable consensus threshold',
          min: '-100',
          max: '100',
          step: '1',
          value: thresholdToSliderValue(draft.threshold),
          disabled: !canEditSettings
        });
        const thDisplay = el('span', { className: 'slider-value', text: formatPctSigned11(clampConsensusThreshold11(Number(draft.threshold))) });
        thInput.addEventListener('input', () => {
          const v = sliderValueToThreshold(thInput.value);
          thDisplay.textContent = formatPctSigned11(v);
        });
        thInput.addEventListener('change', () => {
          if (!canEditSettings) return;
          const v = sliderValueToThreshold(thInput.value);
          annotatableSettingsDraft[selectedFieldKey] = { ...annotatableSettingsDraft[selectedFieldKey], threshold: v };
          annotatableSettingsDirty.add(selectedFieldKey);
          render();
        });
        block.appendChild(thLabel);
        block.appendChild(el('div', { className: 'slider-row' }, [thInput, thDisplay]));

        const minInputId = createDomId(
          'community-annotation-annotatable-min'
        );
        const minLabel = el('label', {
          for: minInputId,
          text: 'Min annotators:'
        });
        const minInput = el('input', {
          id: minInputId,
          type: 'number',
          className: 'obs-select',
          'aria-label': 'Annotatable min annotators',
          value: String(draft.minAnnotators),
          min: '0',
          max: '50',
          step: '1',
          disabled: !canEditSettings
        });
        minInput.addEventListener('change', () => {
          if (!canEditSettings) return;
          const nextMin = clampInt(Number(minInput.value), 0, 50);
          minInput.value = String(nextMin);
          annotatableSettingsDraft[selectedFieldKey] = { ...annotatableSettingsDraft[selectedFieldKey], minAnnotators: nextMin };
          annotatableSettingsDirty.add(selectedFieldKey);
          render();
        });
        block.appendChild(minLabel);
        block.appendChild(minInput);

        const actions = el('div', { className: 'community-annotation-consensus-actions', 'aria-label': 'Annotatable consensus settings actions' });
        const apply = el('button', { type: 'button', className: 'btn-small', text: 'Apply', disabled: !canEditSettings || !annotatableSettingsDirty.has(selectedFieldKey) });
        const reset = el('button', { type: 'button', className: 'btn-small', text: 'Reset', disabled: !canEditSettings || !annotatableSettingsDirty.has(selectedFieldKey) });
        apply.addEventListener('click', () => {
          if (!canEditSettings) return;
          const next = Object.hasOwn(
            annotatableSettingsDraft,
            selectedFieldKey
          )
            ? annotatableSettingsDraft[selectedFieldKey]
            : applied;
          session.setAnnotatableConsensusSettings(selectedFieldKey, next);
          annotatableSettingsDirty.delete(selectedFieldKey);
          notifications.success('Consensus settings applied (local)', { category: 'annotation', duration: 1800 });
          render();
        });
        reset.addEventListener('click', () => {
          if (!canEditSettings) return;
          annotatableSettingsDraft[selectedFieldKey] = { ...applied };
          annotatableSettingsDirty.delete(selectedFieldKey);
          render();
        });
        actions.appendChild(apply);
        actions.appendChild(reset);
        block.appendChild(actions);

        manageContent.appendChild(block);
      }

    manageItem.appendChild(manageHeaderBtn);
    manageItem.appendChild(manageContent);
    manageAccordion.appendChild(manageItem);
    manageBlock.appendChild(manageAccordion);

    // ─────────────────────────────────────────────────────────────────────────
    // CONSENSUS SNAPSHOT + LOCAL CACHE (one collapsible)
    // ─────────────────────────────────────────────────────────────────────────
    const exportsCacheBlock = el('div', { className: 'control-block relative' });

    const exportsAccordionKey = 'exports-cache';
    const exportsAccordion = el('div', { className: 'analysis-accordion' });
    const exportsItem = el('div', { className: `analysis-accordion-item${openAccordionKey === exportsAccordionKey ? ' open' : ''}` });
    const exportsHeaderBtn = el('div', {
      className: 'analysis-accordion-header',
      role: 'button',
      tabIndex: '0',
      'aria-expanded': String(openAccordionKey === exportsAccordionKey)
    }, [
      el('span', { className: 'analysis-accordion-title', text: 'CONSENSUS SNAPSHOT + LOCAL CACHE' }),
      el('span', { className: 'analysis-accordion-desc', text: 'Download cellucid-consensus.json and manage local cache' }),
      el('span', { className: 'analysis-accordion-chevron', 'aria-hidden': 'true' })
    ]);
    const exportsContent = el('div', { className: 'analysis-accordion-content' });

    registerAccordionPeer(exportsAccordionKey, exportsItem, exportsHeaderBtn);
    const toggleExportsOpen = () => toggleAccordionPeer(exportsAccordionKey);
    exportsHeaderBtn.addEventListener('click', () => toggleExportsOpen());
    exportsHeaderBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleExportsOpen();
      }
    });

    // Consensus snapshot (cellucid-consensus.json)
    const consensusDownloadBlock = el('div', { className: 'control-block relative' });
    const consensusDownloadInfo = createInfoTooltip('About consensus snapshots', [
      'Downloads a cellucid-consensus.json snapshot of the current merged view.',
      'Tip: Pull first to refresh the locally cached raw files from GitHub.',
      'This is generated in your browser and is never written back to GitHub.'
    ]);
    consensusDownloadBlock.appendChild(createInfoLabel(
      'Consensus snapshot (cellucid-consensus.json)',
      consensusDownloadInfo
    ));
    consensusDownloadBlock.appendChild(consensusDownloadInfo.tooltip);
    const consensusDownloadActions = el('div', { className: 'community-annotation-cache-actions', 'aria-label': 'Consensus snapshot actions' });
    const downloadBtn = el('button', { type: 'button', className: 'btn-small', text: 'Download', disabled: controller.isSyncBusy() });
    downloadBtn.title = 'Download cellucid-consensus.json';
    downloadBtn.addEventListener('click', () => {
      try {
        const doc = session.buildConsensusDocument({ includeComments: false, includeMergedFrom: false });
        if (!doc) throw new Error('Consensus snapshot unavailable');
        downloadJsonAsFile(CONSENSUS_SNAPSHOT_FILENAME, doc);
        notifications.success(
          `Downloaded ${CONSENSUS_SNAPSHOT_FILENAME}`,
          { category: 'annotation', duration: 2200 }
        );
      } catch (err) {
        notifications.error(err?.message || 'Failed to build cellucid-consensus.json', { category: 'annotation', duration: 6000 });
      }
    });
    consensusDownloadActions.appendChild(downloadBtn);
    consensusDownloadBlock.appendChild(consensusDownloadActions);
    exportsContent.appendChild(consensusDownloadBlock);

    // Local cache
    const cacheBlock = el('div', { className: 'control-block relative' });
    const cacheInfo = createInfoTooltip('About local annotation data', [
      'Session state stores your local votes/suggestions/comments until you Publish.',
      'Downloaded files cache stores raw GitHub files (annotations/users/* and optional annotations/moderation/merges.json) to speed up Pull.',
      'Clearing caches never writes anything to GitHub.'
    ]);
    cacheBlock.appendChild(createInfoLabel('Local cache', cacheInfo));
    cacheBlock.appendChild(cacheInfo.tooltip);

    const cacheActions = el('div', { className: 'community-annotation-cache-actions', 'aria-label': 'Local cache actions' });
      const clearSessionBtn = el('button', { type: 'button', className: 'btn-small', text: 'Clear session', disabled: controller.isSyncBusy() });
      clearSessionBtn.addEventListener('click', () => {
        startBackgroundTask(async () => {
          const owner = publishContextOwner(getCacheContext({}));
          const ok = await confirmAsync({
            title: 'Clear local session?',
            message: 'This clears your local session state (votes, suggestions, comments, and annotatable-column selections) for the current dataset/repo/branch in this browser.',
            confirmText: 'Clear session',
            signal: owner.signal,
          });
          if (!ok || !isContextOwnerCurrent(owner)) return;
        session.clearLocalCache({ keepVotingMode: false });
        notifications.success('Local session cleared', { category: 'annotation', duration: 2200 });
        render();
      }, { label: 'Unable to clear the local annotation session' });
    });

    const cacheDatasetId = dataSourceManager?.getCurrentDatasetId?.() || null;
    const cacheUser = getCacheUserKey();
    const cacheUserId = getCacheUserId();
    const repoRef = getAnnotationRepoForDataset(cacheDatasetId, cacheUser) || null;
    const clearFilesBtn = el('button', {
      type: 'button',
      className: 'btn-small',
      text: 'Clear downloads',
      disabled: controller.isSyncBusy() || !(cacheDatasetId && repoRef && cacheUserId)
    });
      clearFilesBtn.addEventListener('click', () => {
        startBackgroundTask(async () => {
          if (!cacheDatasetId || !repoRef || !cacheUserId) return;
          const owner = publishContextOwner(getCacheContext({}));
          const ok = await confirmAsync({
          title: 'Clear downloaded files?',
          message:
            `This clears locally cached copies of raw files under annotations/users/ and annotations/moderation/.\n\n` +
            `Tip: Pull again to re-download what you need.`,
            confirmText: 'Clear downloads',
            signal: owner.signal,
          });
          if (!ok || !isContextOwnerCurrent(owner)) return;
          await fileCache.clearRepo({ datasetId: cacheDatasetId, repoRef, userId: cacheUserId });
          if (!isContextOwnerCurrent(owner)) return;
        notifications.success('Downloaded file cache cleared', { category: 'annotation', duration: 2200 });
        render();
      }, { label: 'Unable to clear downloaded annotation files' });
    });

    cacheActions.appendChild(clearSessionBtn);
    cacheActions.appendChild(clearFilesBtn);
    cacheBlock.appendChild(cacheActions);
    exportsContent.appendChild(cacheBlock);

    exportsItem.appendChild(exportsHeaderBtn);
    exportsItem.appendChild(exportsContent);
    exportsAccordion.appendChild(exportsItem);
    exportsCacheBlock.appendChild(exportsAccordion);

    // Collapsibles: always at the bottom of the section.
    container.appendChild(manageBlock);
    container.appendChild(consensusBlock);
    container.appendChild(exportsCacheBlock);
    syncAccordionPeers();

    // Popup handles per-category voting/suggestions; keep the sidebar compact.
  }

  return { render };
}
