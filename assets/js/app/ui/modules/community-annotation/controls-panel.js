/**
 * @fileoverview The community annotation sidebar panel.
 *
 * Rebuilds the whole section on every `render()` while the section is open
 * (a closed section only records that it is stale, and renders when it is
 * opened): the offline and sign-in
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

import { annotationDatasetIdOf } from '../../../community-annotations/runtime-context.js';
import {
  getAnnotationRepoForDataset,
} from '../../../community-annotations/repo-store.js';
import {
  isAnnotationRepoConnected,
  isSimulateRepoConnectedEnabled,
} from '../../../community-annotations/access-store.js';
import {
  createStatusIcon,
  createStatusRow,
  downloadJsonAsFile,
  el,
  toCleanString,
} from './dom.js';
import { createDomId } from '../../components/dom-id.js';
import {
  createButton,
  createDisclosure,
  createGroup,
  createIconButton,
  createSliderField,
  createStatusLine,
} from '../../components/controls.js';
import { confirmAsync } from './modal-shell.js';
import { assertExactGitHubLogin } from './identity-assertions.js';
import {
  clampInt,
  formatPctSigned11,
  sliderValueToThreshold,
  thresholdToSliderValue,
} from './consensus-math.js';
import { copyTextToClipboard } from './browser-integration.js';
import { createVisibilityGatedRender } from '../../core/visibility-gate.js';

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
    lifecycleSignal,
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
    !(annotatableSettingsDirty instanceof Set) ||
    !(lifecycleSignal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'The community annotation panel requires its container, its lifecycle signal, the visualization state, the information popover controller, and the annotatable settings draft'
    );
  }

  let selectedFieldKey = null;
  // Derived consensus column (manual, optional).
  let consensusColumnThreshold = 0.5;
  let consensusColumnMinAnnotators = 1;
  let consensusColumnKey = 'community_cell_type';
  let consensusSourceFieldKey = null;
  // Community annotation collapsibles: closed by default; only one may be open at a time.
  /** @type {'consensus-column'|'manage'|'exports-cache'|null} */
  let openAccordionKey = null;

  let identityEditButton = null;

  let infoPopoverSequence = 0;

  function createInfoTooltip(label, tip) {
    const btn = el(
      'button',
      { className: 'info-btn' },
      [el('span', { 'aria-hidden': 'true', text: 'i' })]
    );
    const tooltip = el('div', { className: 'info-tooltip' });
    infoPopoverSequence += 1;
    infoPopovers.configurePair(btn, tooltip, {
      id: `community-annotation-info-${infoPopoverSequence}`,
      label,
      tip
    });

    return { btn, tooltip };
  }

  /**
   * A sub-section of the panel: a heading with its info popover trigger, and
   * the controls it names, grouped under it (`role="group"` labelled by the
   * heading).
   *
   * @param {string} title
   * @param {{btn: HTMLElement, tooltip: HTMLElement}} info
   * @returns {HTMLElement}
   */
  function createInfoGroup(title, info) {
    const group = createGroup({ title, info: info.btn });
    group.root.appendChild(info.tooltip);
    return group.root;
  }

  // The panel is rebuilt on every session change and every active field
  // change, and its section is closed by default: while it cannot be seen a
  // render only marks the panel stale, and showing it renders once.
  const gatedRender = createVisibilityGatedRender(container, renderNow);
  lifecycleSignal.addEventListener('abort', () => gatedRender.destroy(), { once: true });

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
    gatedRender.request();
  }

  function renderNow() {
    if (controller.isContextDestroyed()) return;
    identityEditButton = null;
    infoPopovers.closeWithin(container);
    container.innerHTML = '';
    infoPopoverSequence = 0;

    const datasetId = annotationDatasetIdOf(dataSourceManager) || null;
    const cacheUsername = getCacheUserKey();
    const repo = getAnnotationRepoForDataset(datasetId, cacheUsername);
    const repoConnectedForGating = isAnnotationRepoConnected(datasetId, cacheUsername);
    const online =
      typeof navigator !== 'undefined'
        ? navigator.onLine !== false
        : true;
    if (!repoConnectedForGating) {
      const introInfo = createInfoTooltip('About community annotation', 'community-intro');
      const introBlock = createInfoGroup('Repository', introInfo);
      introBlock.appendChild(el('p', { className: 'status-line', text: 'Not connected.' }));

      const actions = el('div', { className: 'community-annotation-suggestion-actions' });
      // A repository is connected per dataset, so None has nothing to
      // connect it to.
      if (datasetId === null) {
        introBlock.appendChild(el('p', {
          className: 'status-line',
          role: 'status',
          text: 'Load a dataset to connect a repository.',
        }));
      } else if (!online) {
        introBlock.appendChild(el('p', {
          className: 'status-line',
          role: 'status',
          'data-tone': 'warning',
          text: 'Offline: GitHub actions are disabled.',
        }));
      }
      const connectBtn = el('button', {
        type: 'button',
        className: 'btn',
        text: 'Connect repo',
        disabled: datasetId === null || controller.isSyncBusy() || !online,
        'data-community-annotation-action': 'github-connection',
      });
      connectBtn.addEventListener('click', () => {
        startBackgroundTask(
          () => connectRepoFlow({ reason: null }),
          { label: 'Unable to open GitHub annotation connection' },
        );
      });
      actions.appendChild(connectBtn);
      introBlock.appendChild(actions);
      container.appendChild(introBlock);
      return;
    }

    // GitHub sync. The panel opens on it: a separate "Community voting"
    // heading above it held nothing but its info button.
    const isAuthed = githubAuth.isAuthenticated();
    const authedUser = githubAuth.getUser();
    const login =
      authedUser === null
        ? ''
        : assertExactGitHubLogin(authedUser.login, 'Authenticated GitHub login');
    const syncInfo = createInfoTooltip('About community voting and GitHub sync', 'community-sync');
    const syncBlock = createInfoGroup('GitHub sync', syncInfo);

    const storedRepoName = repo ? String(repo).split('@')[0] : '';
    const connectedName = isAuthed ? storedRepoName : '';

    const copyShareLinkBtn = (() => {
      if (!repo) return null;
      const btn = createIconButton({
        label: 'Copy share link (includes @branch)',
        icon: createStatusIcon('copy').outerHTML,
      });
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

    const statusList = el('div', { className: 'control-box community-annotation-status-list community-annotation-status-panel' });
    statusList.appendChild(createStatusRow({
      icon: 'dataset',
      tone: datasetId ? 'ok' : 'warn',
      key: 'Dataset',
      value: datasetId ? ` ${datasetId}` : ' —',
    }).row);
    statusList.appendChild(createStatusRow({
      icon: 'github',
      tone: isAuthed ? 'ok' : 'warn',
      key: 'GitHub',
      value: isAuthed ? (login ? ` @${login}` : ' signed in') : ' not connected',
    }).row);
    statusList.appendChild(createStatusRow({
      icon: 'repo',
      tone: connectedName ? 'ok' : 'warn',
      key: 'Repo',
      value: connectedName ? ` ${connectedName}` : (storedRepoName && !isAuthed ? ` ${storedRepoName} (sign in)` : ' not connected'),
      actions: copyShareLinkBtn ? [copyShareLinkBtn] : []
    }).row);

    syncBlock.appendChild(statusList);

    if (!online) {
      syncBlock.appendChild(createStatusLine({
        tone: 'warning',
        text: 'Offline: GitHub actions are disabled.',
      }).root);
    }

    const currentSyncError = controller.getSyncError();
    if (currentSyncError) {
      syncBlock.appendChild(createStatusLine({
        tone: 'danger',
        text: currentSyncError,
      }).root);
    }

    const syncActions = el('div', { className: 'community-annotation-sync-actions' });
    const openBtnText = !isAuthed ? 'Connect GitHub…' : (!repo ? 'Choose repo…' : 'GitHub sync…');
    const openSyncBtn = el('button', {
      type: 'button',
      className: 'btn',
      text: openBtnText,
      'data-community-annotation-action': 'github-connection',
    });
    openSyncBtn.disabled = controller.isSyncBusy() || !online;
    openSyncBtn.addEventListener('click', () => {
      observeBackgroundTask(
        openGitHubConnectionFlow({
          reason: null,
          datasetId,
          cacheUser: cacheUsername,
          login,
          currentRepo: repo,
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

    // Community annotation collapsibles: closed by default, at most one open.
    const disclosures = new Map();
    const createPeerDisclosure = (key, title, tip) => {
      const disclosure = createDisclosure({
        title,
        tip,
        expanded: openAccordionKey === key,
        onToggle: (expanded) => {
          openAccordionKey = expanded ? key : null;
          for (const [peerKey, peer] of disclosures) {
            if (peerKey !== key) peer.setExpanded(openAccordionKey === peerKey);
          }
        },
      });
      disclosures.set(key, disclosure);
      return disclosure;
    };

    container.appendChild(syncBlock);

    const catFieldsForConsensus = (state.getFields?.() || []).filter((f) => f?.kind === 'category' && f?._isDeleted !== true);
    const allKeysForConsensus = catFieldsForConsensus.map((f) => f.key).filter(Boolean);
    const annotatableKeysForConsensus = session.getAnnotatedFields().filter((k) => allKeysForConsensus.includes(k));
    if (!consensusSourceFieldKey || !annotatableKeysForConsensus.includes(consensusSourceFieldKey)) {
      consensusSourceFieldKey = annotatableKeysForConsensus[0] || null;
    }

    const consensusDisclosure = createPeerDisclosure(
      'consensus-column',
      'Consensus column',
      'community-consensus-column'
    );
    const content = consensusDisclosure.content;

    // Source annotatable column selector
    const srcWrap = el('div', { className: 'control-block' });
    const srcSelectId = createDomId('community-annotation-consensus-source');
    srcWrap.appendChild(el('label', { for: srcSelectId, text: 'Annotatable column' }));
    const srcSelect = el('select', {
      id: srcSelectId,
      className: 'obs-select'
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
    const consensusKeyWrap = el('div', { className: 'control-block' });
    const consensusKeyInputId = createDomId(
      'community-annotation-consensus-key'
    );
    consensusKeyWrap.appendChild(el('label', {
      for: consensusKeyInputId,
      text: 'New column key'
    }));
    const consensusKeyInput = el('input', {
      id: consensusKeyInputId,
      type: 'text',
      className: 'obs-select',
      placeholder: 'community_cell_type'
    });
    consensusKeyInput.value = consensusColumnKey;
    consensusKeyInput.addEventListener('change', () => {
      consensusColumnKey = String(consensusKeyInput.value || '').trim();
    });
    consensusKeyWrap.appendChild(consensusKeyInput);
    content.appendChild(consensusKeyWrap);

    // Consensus threshold + min annotators
    const consensusSettings = el('div', { className: 'community-annotation-settings' });
    const threshold = createSliderField({
      label: 'Consensus threshold',
      min: -100,
      max: 100,
      step: 1,
      value: Number(thresholdToSliderValue(consensusColumnThreshold)),
      format: (value) => formatPctSigned11(sliderValueToThreshold(value)),
      onInput: (value) => {
        consensusColumnThreshold = sliderValueToThreshold(value);
      },
    });
    consensusSettings.appendChild(threshold.root);

    const minWrap = el('div', { className: 'control-block' });
    const minInputId = createDomId('community-annotation-consensus-min');
    minWrap.appendChild(el('label', {
      for: minInputId,
      text: 'Min annotators'
    }));
    const minInput = el('input', {
      id: minInputId,
      type: 'number',
      className: 'obs-select',
      value: String(consensusColumnMinAnnotators),
      min: '0',
      max: '50',
      step: '1'
    });
    minInput.addEventListener('change', () => {
      consensusColumnMinAnnotators = clampInt(Number(minInput.value), 0, 50);
      minInput.value = String(consensusColumnMinAnnotators);
    });
    minWrap.appendChild(minInput);
    consensusSettings.appendChild(minWrap);
    content.appendChild(consensusSettings);

    const applyActions = el('div', { className: 'community-annotation-consensus-actions' });
    const applyBtn = createButton({
      label: 'Build derived column',
      variant: 'primary',
      onClick: () => {
        startBackgroundTask(
          () => applyConsensusColumn(readConsensusColumnSettings),
          { label: 'Unable to build the community consensus column' },
        );
      },
    });
    applyBtn.disabled = controller.isSyncBusy() || !consensusSourceFieldKey;
    applyActions.appendChild(applyBtn);
    content.appendChild(applyActions);

    // Profile (asked once per GitHub username; editable)
    const profile = session.getProfile();
    const identityInfo = createInfoTooltip('About annotation profiles', 'community-profile');
    const identityBlock = createInfoGroup('Profile', identityInfo);

    const authedLogin = getGitHubLogin();
    // Allow editing when signed in OR when dev override is enabled
    const canEdit = Boolean(githubAuth.isAuthenticated?.() && authedLogin) || isSimulateRepoConnectedEnabled();
    const profileBox = el('div', { className: 'control-box community-annotation-profile-box' });
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
    const editBtn = createButton({
      label: 'Edit',
      className: 'community-annotation-profile-edit',
    });
    identityEditButton = editBtn;
    const clearBtn = createButton({ label: 'Clear' });
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

    const manageDisclosure = createPeerDisclosure(
      'manage',
      'Annotated columns',
      'community-annotated-columns'
    );
    const manageContent = manageDisclosure.content;

    if (role !== 'author') {
      const msg = role === 'unknown'
        ? 'Role: checking repo permissions…'
        : `Role: ${role}. Only authors can change this.`;
      manageContent.appendChild(el('p', { className: 'status-line', text: msg }));
    }

    // Field selector dropdown
    const fieldSelectWrap = el('div', { className: 'control-block' });
    const fieldSelectId = createDomId(
      'community-annotation-categorical-obs'
    );
    fieldSelectWrap.appendChild(el('label', {
      for: fieldSelectId,
      text: 'Categorical obs'
    }));
    const fieldSelect = el('select', {
      id: fieldSelectId,
      className: 'obs-select'
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

    const manageActions = el('div', { className: 'community-annotation-consensus-actions', role: 'group', 'aria-label': 'Manage annotation actions' });

    const lockedReason = !hasSelection
      ? 'Select a categorical obs field first.'
      : (repoConnectedForGating && !access.isAuthor() ? 'Author (maintain/admin) required.' : '');
    const addBtn = createButton({ label: 'Add', title: lockedReason || 'Mark this column as annotatable' });
    addBtn.disabled = !canManageAnnotatable;
    const removeBtn = createButton({ label: 'Remove', title: lockedReason || 'Remove this column from annotation' });
    removeBtn.disabled = !canManageAnnotatable;
    const isAnnotatable = hasSelection && annotated.includes(selectedFieldKey);
    const isClosed = isAnnotatable ? Boolean(session.isFieldClosed(selectedFieldKey)) : false;
    const closeBtn = isAnnotatable
      ? createButton({
        label: isClosed ? 'Reopen' : 'Close',
        title: isClosed ? 'Reopen this annotatable column for community voting.' : 'Close this annotatable column (voting disabled for annotators).',
      })
      : null;
    if (closeBtn !== null) closeBtn.disabled = repoConnectedForGating && !access.isAuthor();

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
      const info = createInfoTooltip('About consensus settings', 'community-consensus-settings');

      const block = createInfoGroup('Consensus settings', info);
      block.classList.add('community-annotation-annotatable-settings');

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

      const annotatableThreshold = createSliderField({
        label: 'Threshold',
        min: -100,
        max: 100,
        step: 1,
        value: Number(thresholdToSliderValue(draft.threshold)),
        format: (value) => formatPctSigned11(sliderValueToThreshold(value)),
        onCommit: (value) => {
          if (!canEditSettings) return;
          annotatableSettingsDraft[selectedFieldKey] = {
            ...annotatableSettingsDraft[selectedFieldKey],
            threshold: sliderValueToThreshold(value),
          };
          annotatableSettingsDirty.add(selectedFieldKey);
          render();
        },
      });
      annotatableThreshold.input.disabled = !canEditSettings;
      block.appendChild(annotatableThreshold.root);

      const annotatableMinWrap = el('div', { className: 'control-block' });
      const minInputId = createDomId(
        'community-annotation-annotatable-min'
      );
      annotatableMinWrap.appendChild(el('label', {
        for: minInputId,
        text: 'Min annotators'
      }));
      const minInput = el('input', {
        id: minInputId,
        type: 'number',
        className: 'obs-select',
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
      annotatableMinWrap.appendChild(minInput);
      block.appendChild(annotatableMinWrap);

      const actions = el('div', { className: 'community-annotation-consensus-actions', role: 'group', 'aria-label': 'Consensus settings actions' });
      const settingsDirty = annotatableSettingsDirty.has(selectedFieldKey);
      const apply = createButton({ label: 'Apply', variant: 'primary' });
      apply.disabled = !canEditSettings || !settingsDirty;
      const reset = createButton({ label: 'Reset' });
      reset.disabled = !canEditSettings || !settingsDirty;
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

    // ─────────────────────────────────────────────────────────────────────────
    // CONSENSUS SNAPSHOT + LOCAL CACHE (one collapsible)
    // ─────────────────────────────────────────────────────────────────────────
    const exportsDisclosure = createPeerDisclosure(
      'exports-cache',
      'Snapshot and cache',
      'community-snapshot'
    );
    const exportsContent = exportsDisclosure.content;

    // Consensus snapshot. Its (i) is the disclosure's, above; the file name
    // is on the button's title.
    const consensusDownloadBlock = el('div', { className: 'control-block' });
    const consensusDownloadActions = el('div', { className: 'community-annotation-cache-actions', role: 'group', 'aria-label': 'Consensus snapshot actions' });
    const downloadBtn = createButton({
      label: 'Download',
      title: 'Download cellucid-consensus.json',
      onClick: () => {
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
      },
    });
    downloadBtn.disabled = controller.isSyncBusy();
    consensusDownloadActions.appendChild(downloadBtn);
    consensusDownloadBlock.appendChild(consensusDownloadActions);
    exportsContent.appendChild(consensusDownloadBlock);

    // Local cache
    const cacheInfo = createInfoTooltip('About local annotation data', 'community-cache');
    const cacheBlock = createInfoGroup('Local cache', cacheInfo);

    const cacheActions = el('div', { className: 'community-annotation-cache-actions', role: 'group', 'aria-label': 'Local cache actions' });
    const clearSessionBtn = createButton({ label: 'Clear session' });
    clearSessionBtn.disabled = controller.isSyncBusy();
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

    const cacheDatasetId = annotationDatasetIdOf(dataSourceManager) || null;
    const cacheUser = getCacheUserKey();
    const cacheUserId = getCacheUserId();
    const repoRef = getAnnotationRepoForDataset(cacheDatasetId, cacheUser) || null;
    const clearFilesBtn = createButton({ label: 'Clear downloads' });
    clearFilesBtn.disabled = controller.isSyncBusy() || !(cacheDatasetId && repoRef && cacheUserId);
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

    // Collapsibles: always at the bottom of the section, in one list.
    const collapsibles = el('div', { className: 'control-block disclosure-list community-annotation-disclosures' }, [
      manageDisclosure.root,
      consensusDisclosure.root,
      exportsDisclosure.root,
    ]);
    container.appendChild(collapsibles);
    // Popup handles per-category voting/suggestions; keep the sidebar compact.
  }

  return { render };
}
