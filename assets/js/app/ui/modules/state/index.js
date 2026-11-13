/**
 * @fileoverview The State panel: the session's Share and
 * Load, and the history of the dataset shown as a branch graph.
 *
 * - **Header:** `History (i)  🔍 ↶ ↷ ⚙ ⋯`: search, undo and redo (and the
 *   keys), History settings (what is recorded), and the menu (tour, compare,
 *   branch map, Recently deleted, the exports, an AnnData copy with the
 *   state shown, replay, another tracker, the state at a time, clear
 *   keeping the state).
 * - **Status line:** `[● Recording] Main ▾ · 14 steps · ⚠ 2 stale`: the
 *   recording switch, the branch picker, what is shown, the stale results
 *   (a click shows them), and "Next change starts …" with Cancel.
 * - **The graph** (`graph.js`), its rows' details and menus, and the
 *   questions each operation asks (`shared.js` `askHistory`).
 *
 * Every operation is a history action dispatched as the person's
 * (`history-source.js`): the panel calls no history mutator. One operation
 * runs at a time from here (`run`): while it runs the panel is busy, and a
 * failure is told once. While recording is paused, going back (undo, redo, a
 * jump, a branch or tracker switch) first asks whether to keep what changed
 * as one step.
 *
 * The panel draws the page's current history (`app/history/current.js`) and
 * redraws when it tells of a change, at most once a frame and only while the
 * panel can be seen.
 *
 * @module ui/modules/state
 */

import { createGraph } from './graph.js';
import { detailsFor } from './step-details.js';
import { createBranchPicker } from './branch-picker.js';
import { createBranchMap } from './branch-map-dialog.js';
import { createSearch, filterChoices, stepMatcher } from './search.js';
import { createShareDialog } from './share-dialog.js';
import { createRecentlyDeleted } from './recently-deleted.js';
import { createWorkflowBanner } from './workflow-banner.js';
import { createReplayReport } from './replay-report-dialog.js';
import { createMemoryDialog, historyOverBudget, memoryWords } from './memory-dialog.js';
import { memoryAllowanceBytes, onMemoryChange, workingSetBytes } from '../../../../data/memory-budget.js';
import { createDiffDialog } from './diff-dialog.js';
import { createSavedStatesDialog } from './saved-states-dialog.js';
import { createTour } from './tour.js';
import { createHistorySharing } from './share.js';
import { bindHistoryKeys } from './keyboard.js';
import { openMenu } from '../../components/menu.js';
import { statusWords } from './model.js';
import { askHistory, commandKey, reportHistoryFailure, toastEdit, undoKeys } from './shared.js';
import {
  canUndo, createHistoryActions, extendableGroup, groupRange, redoTarget, revertProblem, spanOf, squashProblem, stepSpan,
  trackerView,
} from './history-source.js';
import { initOpenDataMenu } from '../open-data-menu.js';
import { createInfoTip } from '../../components/controls.js';
import { createVisibilityGatedRender } from '../../core/visibility-gate.js';
import { getCurrentHistory, getSavedHistories, subscribeCurrentHistory } from '../../../history/current.js';
import {
  HISTORY_SETTINGS, historySettings, offDomainsOf, onHistorySettingsChange, setHistorySetting,
} from '../../../history/history-settings.js';
import { HISTORY_SENTENCES, idNumber, nameProblem } from '../../../history/model.js';
import { plainSentence } from '../../../actions/targets/names.js';

/** A sentence of the history's for the person (`plainSentence`), or null. */
const plainOrNull = text => (text === null ? null : plainSentence(text));
import { domainName } from '../../../actions/domains.js';
import { summarizeReplay } from '../../../history/replay.js';
import { getNotificationCenter } from '../../../notification-center.js';
import { formatCountOf, formatDuration } from '../../../../utils/format-units.js';
import { viewNameInValue } from '../../../actions/targets/views.js';
import { cancelled, isCancellation } from '../../../../utils/abort.js';
import { registerStepRevealer, revealTurn, subscribeTurns, undoAgentTurn } from '../../../agent/history-link.js';
import { ActionRefused } from '../../../actions/dispatcher.js';
import { downloadBlob } from '../../../utils/download.js';
import { HISTORY_WAITS_FOR_DATASET, openADatasetTo } from '../../no-dataset.js';
import { copyText } from '../../../utils/clipboard.js';
import { lowerFirst } from '../../../../utils/text-case.js';

const REQUIRED = [
  'section', 'shareButton', 'loadButton', 'searchButton', 'undoButton', 'redoButton', 'settingsButton', 'menuButton',
  'menu', 'settings', 'search', 'searchInput', 'filterButton', 'recording', 'branchButton', 'status', 'staleButton',
  'memoryButton', 'memoryDialog', 'pendingCancel', 'branches', 'banner', 'graph', 'where', 'diffDialog', 'diffFrom', 'diffTo', 'diffStatus', 'diffList',
  'savedDialog', 'savedList', 'savedEmpty', 'savedStatus', 'savedName', 'savedContent', 'savedSaveAs', 'savedReplayFile', 'savedOpenFile',
  'shareDialog', 'deletedDialog', 'deletedStatus', 'deletedList', 'deletedEmpty', 'mapDialog', 'replayDialog',
  'reportDialog', 'reportPictures', 'reportSteps', 'reportOpen',
];

/**
 * The rows of History settings, in order: each a setting of
 * `HISTORY_SETTINGS` (its label and kind from there) with its info tip, or
 * the rule between what is recorded and the rest. A setting this browser's
 * history does not have is not drawn.
 */
const SETTING_ROWS = Object.freeze([
  { key: 'recordCamera', tip: 'history-record-camera' },
  { key: 'recordLayout', tip: 'history-record-layout' },
  { rule: true },
  { key: 'recordNewDatasets' },
  { key: 'askWhilePaused' },
  { key: 'autosave', tip: 'history-autosave' },
  { key: 'personName' },
]);

/**
 * @param {object} options
 * @param {Record<string, HTMLElement>} options.dom - `dom-cache.js` `state`
 * @param {(type: string, params: object, meta?: object) => Promise<{outcome: unknown, step: object|null}>} options.dispatch -
 *   the page's dispatcher (`getActions().dispatch`)
 * @param {() => object} options.datasetFacts - `dataset-facts.js`
 * @param {((history: object, branchA: string, branchB: string) => Promise<string[]>)|null} options.compareBranches
 *   `compare.js`, or null where views cannot be kept
 * @param {{getCameraState: () => object, setCameraState: (state: object) => void}|null} options.camera
 * @param {(() => Promise<{png: string}>)|null} options.pictures - the selected view as a PNG (`view.picture`)
 * @param {{pick: () => Promise<File|null>, replay: (file: File, options: {signal: AbortSignal,
 *   onStep: Function}) => Promise<{tracker: string, report: object[]}>}|null} [options.replaySessionFile]
 * @param {{can: (trackerId: string) => boolean, replay: (trackerId: string, mapping: object, options: {signal: AbortSignal,
 *   onStep: Function}) => Promise<{tracker: string, report: object[]}>}|null} [options.replayAgain] - a replayed
 *   tracker's steps replayed again from their source with other names (`dataset-history.js` `replayAgain`)
 * @param {((type: string, handler: Function) => () => void)|null} [options.provide] - the page's
 *   `getActions().provide`: the panel provides the tour and the report as actions
 *   (`history.tour.start`, `history.tour.stop`, `history.report`)
 * @param {(blob: Blob, filename: string) => void} [options.download] - the app's one download path
 */
export function initStateSection({
  dom, dispatch, datasetFacts, compareBranches = null, camera = null, pictures = null, replaySessionFile = null, replayAgain = null,
  provide = null, download = (blob, filename) => downloadBlob(blob, filename),
}) {
  for (const key of REQUIRED) {
    if (!(dom?.[key] instanceof HTMLElement)) throw new TypeError(`The State panel requires its ${key}.`);
  }
  const ownerDocument = dom.section.ownerDocument;
  const keys = undoKeys();
  const controller = new AbortController();
  const { signal } = controller;
  const actions = createHistoryActions(dispatch);
  const ask = askHistory;
  const notify = (text, tone = 'info') => getNotificationCenter()[tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'info'](text, { category: 'session' });
  let history = null;
  let view = null;
  let unsubscribeHistory = () => {};
  let busy = 0;
  let destroyed = false;
  let replaying = null;
  let query = {};

  const now = () => Date.now();
  const catalog = () => history?.catalog ?? null;
  const effectOf = type => (type !== null && catalog()?.has?.(type) ? catalog().get(type).effect : null);
  const isResult = step => step.touches?.includes('analysis') === true;

  /** Run one history operation: the panel is busy meanwhile; a failure is told once. */
  async function run(task, what) {
    busy++;
    renderBusy();
    try {
      return await task();
    } catch (error) {
      reportHistoryFailure(what, error);
      return undefined;
    } finally {
      busy--;
      if (!destroyed) render();
    }
  }

  /** A history action as the person's, as one operation of the panel. */
  const act = (type, params = {}, what = catalog()?.has?.(type) ? catalog().get(type).title : type) => run(() => actions.act(type, params), what);

  // ------------------------------------------------------------------ settings

  /** The domains the detail switches leave out (the history's own `offDomains`, `history-settings.js`). */
  function offDomains() {
    return new Set(offDomainsOf(historySettings()));
  }

  function layoutOptions() {
    const stale = view?.stale() ?? new Map();
    return {
      // What the history, its turns or History settings last told: an open row's details are
      // built again only when it moved (`graph.js` `render`), never for a redraw of the panel alone.
      version: historyVersion,
      filter: stepMatcher(query, { effectOf, stale }),
      offDomains: offDomains(),
      effectOf,
    };
  }

  /** Build the settings' rows once from `HISTORY_SETTINGS`. */
  function buildSettings() {
    const doc = ownerDocument;
    const rows = SETTING_ROWS.filter(row => row.rule || Object.hasOwn(HISTORY_SETTINGS, row.key));
    const nodes = [];
    rows.forEach((row, index) => {
      if (row.rule) {
        if (index > 0 && index < rows.length - 1 && !rows[index - 1].rule) {
          const rule = doc.createElement('div');
          rule.className = 'history-settings-rule';
          rule.setAttribute('role', 'separator');
          nodes.push(rule);
        }
        return;
      }
      const setting = HISTORY_SETTINGS[row.key];
      const line = doc.createElement('div');
      line.className = 'history-setting-row';
      line.dataset.historySettingRow = row.key;
      if (setting.kind === 'name') {
        line.classList.add('history-setting-name');
        const input = doc.createElement('input');
        input.type = 'text';
        input.id = `history-setting-${row.key}`;
        input.className = 'obs-select';
        input.autocomplete = 'name';
        input.spellcheck = false;
        input.placeholder = 'Not recorded';
        input.dataset.historySetting = row.key;
        const label = doc.createElement('label');
        label.htmlFor = input.id;
        label.textContent = setting.label;
        line.append(label, input);
        nodes.push(line);
        return;
      }
      const control = doc.createElement('button');
      control.type = 'button';
      control.className = 'switch';
      control.setAttribute('role', 'switch');
      control.setAttribute('aria-checked', 'false');
      control.dataset.historySetting = row.key;
      const track = doc.createElement('span');
      track.className = 'switch-track';
      track.setAttribute('aria-hidden', 'true');
      const text = doc.createElement('span');
      text.className = 'switch-label';
      text.textContent = setting.label;
      control.append(track, text);
      line.append(control);
      nodes.push(line);
      if (row.tip !== undefined) {
        const info = createInfoTip({ tip: row.tip, label: `About ${lowerFirst(setting.label)}` });
        line.classList.add('checkbox-info-row');
        line.append(info.button);
        nodes.push(info.popover);
      }
    });
    dom.settings.append(...nodes);
  }
  buildSettings();

  function renderSettings() {
    const settings = historySettings();
    for (const row of dom.settings.querySelectorAll('[data-history-setting-row]')) {
      const key = row.dataset.historySettingRow;
      const control = row.querySelector('[data-history-setting]');
      if (control.getAttribute('role') === 'switch') control.setAttribute('aria-checked', String(settings[key] === true));
      else if (ownerDocument.activeElement !== control) control.value = settings[key] ?? '';
    }
  }

  dom.settingsButton.addEventListener('click', () => {
    const open = dom.settings.hidden;
    dom.settings.hidden = !open;
    dom.settingsButton.setAttribute('aria-expanded', String(open));
    if (open) {
      renderSettings();
      dom.settings.querySelector('[data-history-setting]:not([hidden])')?.focus();
    }
  }, { signal });
  dom.settings.addEventListener('click', event => {
    const control = event.target instanceof Element ? event.target.closest('button[data-history-setting]') : null;
    if (control === null) return;
    const key = control.dataset.historySetting;
    setHistorySetting(key, control.getAttribute('aria-checked') !== 'true');
    // Safari does not focus a clicked button: the box keeps the focus, so Escape still closes it.
    control.focus({ preventScroll: true });
  }, { signal });
  dom.settings.addEventListener('change', event => {
    const control = event.target instanceof HTMLInputElement && event.target.dataset.historySetting ? event.target : null;
    if (control !== null) setHistorySetting(control.dataset.historySetting, control.value.trim() || null);
  }, { signal });
  dom.settings.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dom.settings.hidden = true;
      dom.settingsButton.setAttribute('aria-expanded', 'false');
      dom.settingsButton.focus();
    }
  }, { signal });
  /** Open History settings (⚙ and the History (i) tip's link). */
  function openSettings() {
    if (!dom.settings.hidden) {
      dom.settings.querySelector('[data-history-setting]:not([hidden])')?.focus();
      return;
    }
    dom.settingsButton.click();
  }

  // The History (i) tip links to History settings, first under its
  // title (`data-info-tip-live`), so a person who never looks at ⚙ finds it.
  const historyTip = ownerDocument.getElementById('history-info-tooltip');
  if (historyTip !== null) {
    const line = ownerDocument.createElement('p');
    line.className = 'info-tip-text history-tip-settings';
    line.dataset.infoTipLive = '';
    const link = ownerDocument.createElement('button');
    link.type = 'button';
    link.className = 'history-tip-settings-link';
    link.textContent = 'History settings…';
    line.append('What is recorded and the autosave: ', link);
    const header = historyTip.querySelector('.info-tip-header');
    if (header === null) historyTip.append(line); else header.after(line);
    link.addEventListener('click', () => {
      historyTip.querySelector('[data-info-tip-close]')?.click();
      openSettings();
    }, { signal });
  }

  const unsubscribeSettings = onHistorySettingsChange(() => {
    renderSettings();
    changed();
  });

  // ------------------------------------------------------------------ while paused

  /**
   * Before the history moves while recording is paused with changes: keep
   * them as one step first, discard them, or stay. The answer is
   * the core's for the next move (`setPausedChoice`), for the rest of the
   * paused period with "Don't ask again". Resolves whether to go on.
   */
  async function goingBack() {
    if (view === null || view.recording) return true;
    const changes = view.pausedChanges();
    if (changes === null || changes.remembered !== null) return true;
    if (historySettings().askWhilePaused === false) return true;
    const answer = await ask({
      title: 'Keep your changes first?',
      lines: [
        changes.domains.length === 0 ? 'You changed things while recording was paused.'
          : `You changed ${changes.domains.map(domainName).join(', ')} while recording was paused.`,
        'Keep and go makes them one step, then moves.',
        'Discard and go drops them.',
      ],
      option: { label: 'Don’t ask again while paused' },
      answers: [
        { value: 'discard', label: 'Discard and go', tone: 'danger' },
        { value: 'keep', label: 'Keep and go', tone: 'primary' },
      ],
    });
    if (answer === null) return false;
    history.setPausedChoice(answer.answer, { remember: answer.option });
    return true;
  }

  /** The tour shows step after step: the paused card asks once, before the first. */
  async function playTour(options = {}) {
    if (history === null || tour.playing) return;
    if (!await goingBack()) return;
    await tour.play(options);
  }

  async function move(type, params, what) {
    if (history === null || tour.playing) return;
    if (!await goingBack()) return;
    await act(type, params, what);
  }

  // ------------------------------------------------------------------ operations

  function stepLabel(id) {
    const step = view?.step(id);
    return step === undefined ? id : `step ${idNumber(id)} (“${step.label}”)`;
  }

  /** A name asked for, checked as the history checks it (unique by key, not an id's form). */
  function askName({ title, kind, value = '', taken = [], lines = [], answer = 'Save' }) {
    const keyOf = text => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
    return ask({
      title,
      lines: lines.length > 0 ? lines : [''],
      input: {
        label: 'Name',
        value,
        validate: text => plainOrNull(nameProblem(kind, text)) ?? (taken.some(other => keyOf(other) === keyOf(text) && keyOf(other) !== keyOf(value))
          ? plainSentence(HISTORY_SENTENCES.nameTaken({ kind, name: text.trim() })) : null),
      },
      answers: [{ value: 'save', label: answer, tone: 'primary' }],
    });
  }

  /** Toast an edit with Undo (its Recently deleted entry). */
  function toasted(outcome, text) {
    if (outcome === undefined) return;
    const entry = outcome?.journal ?? null;
    const tracker = view?.id ?? null;
    toastEdit(text, entry === null ? null : () => void act('history.journal.undo', { entry, tracker }, 'Undo'));
  }

  const ops = {
    show(row) {
      switch (row.kind) {
        case 'fork': return ops.switchBranch(row.branch.id);
        case 'step': if (row.step.id !== view?.headId) return move('history.jump', { step: row.step.id }, 'Showing the step'); return undefined;
        case 'turn': case 'group': case 'run': {
          const last = row.stepIds[row.stepIds.length - 1];
          if (last !== view?.headId) return move('history.jump', { step: last }, 'Showing the step');
          return undefined;
        }
        default: return undefined;
      }
    },
    switchBranch(branchId) {
      return move('history.branch.switch', { branch: branchId }, 'Switching branch');
    },
    async branchHere(stepId) {
      if (stepId === null || view === null) return;
      if (stepId !== view.headId && !await goingBack()) return;
      await act('history.branch.create', { step: stepId }, 'Branch here');
    },
    compare(stepId) {
      if (view === null) return;
      const from = stepId === view.headId ? view.step(stepId)?.parent ?? stepId : stepId;
      diff.open(from, view.headId, ownerDocument.activeElement);
    },
    whatChanged(step) {
      if (step.parent !== null) diff.open(step.parent, step.id, ownerDocument.activeElement);
    },
    runAgain(step) {
      void run(() => dispatch(step.type, step.params ?? {}, { origin: 'user' }), `Running “${step.label}” again`);
    },
    /** Whether a step's view can be shown (a viewer to set cameras on). */
    canShowView: () => camera !== null,
    /**
     * Put each view's camera where `step` kept it (`camera.set` per view, a
     * camera step while camera moves are recorded, none while they are not);
     * the history does not move. A step whose views were others says so.
     */
    showView(step) {
      if (history?.active == null || view === null) return undefined;
      return run(async () => {
        const kept = history.valueAt(step.id, 'camera').views;
        const views = history.shownValue('views');
        if (kept.length !== views.views.length) {
          notify(`This step had ${formatCountOf(kept.length, 'view')}; ${formatCountOf(views.views.length, 'view is', 'views are')} open now, so its view cannot be shown. Show the step instead.`, 'warning');
          return;
        }
        const now = history.shownValue('camera').views;
        for (let index = 0; index < kept.length; index++) {
          // The hidden live view has no name to set its camera by; it is not shown either.
          if (views.liveHidden && index === 0) continue;
          // A view already where the step kept it is left alone: nothing is dispatched for it.
          if (JSON.stringify(now[index]) === JSON.stringify(kept[index])) continue;
          await dispatch('camera.set', { view: viewNameInValue(index, views.liveHidden), camera: kept[index] }, { origin: 'user' });
        }
      }, 'Showing the step’s view');
    },
    async copyCode(step) {
      await copyText(step.code ?? '', { what: 'the code', category: 'session' });
    },
    openChat(turnId) { revealTurn(turnId); },
    /** A turn of the chat bar keeps its conversation (a connector's has none here: no ↗). */
    canOpenChat: turnId => (view?.turn(turnId)?.conversation ?? null) !== null,
    toggleRow(row) { graph.toggle(row.key); },
    stepMenu(row, anchor) { openRowMenu(row, anchor, graph.selection()); },
    branchMenu(branchId, anchor) { openBranchMenu(branchId, anchor); },
    trackerMenu(anchor) { openTrackerMenu(anchor); },
    openMap(opener) { picker.close(); map.open(opener); },
    async renameBranch(branchId) {
      const branch = view?.branch(branchId);
      if (branch === undefined) return;
      const answer = await askName({ title: `Rename “${branch.name}”`, kind: 'branch', value: branch.name, taken: view.branches().map(b => b.name) });
      if (answer === null) return;
      toasted(await act('history.branch.rename', { branch: branchId, name: answer.value }), `Renamed to “${answer.value.trim()}”`);
    },
    async renameGroup(groupId) {
      const group = view?.group(groupId);
      if (group === undefined) return;
      const answer = await askName({ title: `Rename “${group.name}”`, kind: 'group', value: group.name, taken: view.groups().map(g => g.name) });
      if (answer === null) return;
      toasted(await act('history.group.rename', { group: groupId, name: answer.value }), `Renamed to “${answer.value.trim()}”`);
    },
    async bookmark(stepId) {
      const step = view?.step(stepId);
      if (step === undefined) return;
      const taken = view.steps().map(each => each.bookmark).filter(Boolean);
      const answer = await ask({
        title: step.bookmark ? `Bookmark “${step.bookmark}”` : `Bookmark ${stepLabel(stepId)}`,
        lines: ['A name to find this step by (a jump, Compare, the report’s pictures). Empty removes it.'],
        input: {
          label: 'Bookmark',
          value: step.bookmark ?? '',
          validate: text => (text.trim() === '' ? null : plainOrNull(nameProblem('bookmark', text))
            ?? (taken.some(name => name.toLowerCase() === text.trim().toLowerCase() && name !== step.bookmark)
              ? plainSentence(HISTORY_SENTENCES.bookmarkTaken({ name: text.trim(), step: view.steps().find(each => each.bookmark?.toLowerCase() === text.trim().toLowerCase()).id })) : null)),
        },
        answers: [{ value: 'save', label: 'Save', tone: 'primary' }],
      });
      if (answer === null) return;
      const name = answer.value.trim() === '' ? null : answer.value;
      toasted(await act('history.bookmark.set', { step: stepId, name }), name === null ? 'Removed the bookmark' : `Bookmarked “${name.trim()}”`);
    },
    async revert(stepId) {
      toasted(await act('history.step.revert', { step: stepId }), `Reverted ${stepLabel(stepId)}`);
    },
    async branchWithout(stepId) {
      // It shows the new branch: a move, so the paused card asks first.
      await move('history.branch.without', { step: stepId }, 'Branch without this step');
    },
    async deleteStep(stepId) {
      const step = view?.step(stepId);
      if (step === undefined || step.parent === null) return;
      const plan = await run(() => history.deletePlan(stepId), 'Deleting the step');
      if (plan === undefined || view === null) return;
      const starts = view.branchesFrom(stepId);
      const seconds = plan.ms >= 1000 ? ` (about ${formatDuration(plan.ms)})` : '';
      const answer = await ask({
        title: `Delete ${stepLabel(stepId)}?`,
        lines: [
          'It goes to Recently deleted, where it can be restored.',
          plan.reapply.length === 0 ? 'No later step changed or read what it changed: nothing is applied again.'
            : `${formatCountOf(plan.reapply.length, 'later step')} that changed or read what it changed ${plan.reapply.length === 1 ? 'is' : 'are'} applied again without it${seconds}; one that no longer applies stays, flagged.`,
          ...(starts.length > 0 ? [`${formatCountOf(starts.length, 'branch', 'branches')} start from it and will start from the step before.`] : []),
          ...(stepId === view.headId ? [`You will see ${stepLabel(step.parent)}.`] : []),
        ],
        answers: [{ value: 'delete', label: 'Delete step', tone: 'danger' }],
      });
      if (answer === null) return;
      if (stepId === view?.headId && !await goingBack()) return;
      const outcome = await act('history.step.delete', { step: stepId });
      if (outcome === undefined) return;
      const flagged = outcome?.flagged ?? [];
      toasted(outcome, flagged.length === 0 ? `Deleted “${step.label}”` : `Deleted “${step.label}”; ${formatCountOf(flagged.length, 'step')} no longer ${flagged.length === 1 ? 'applies' : 'apply'}`);
      if (flagged.length > 0) graph.reveal(flagged[0].step, { details: true });
    },
    async deleteBranch(branchId) {
      const branch = view?.branch(branchId);
      if (branch === undefined) return;
      const problem = branchId === view.mainBranch ? plainSentence(HISTORY_SENTENCES.mainBranch())
        : branch.locked ? plainSentence(HISTORY_SENTENCES.locked({ name: branch.name })) : null;
      if (problem !== null) {
        notify(problem, 'warning');
        return;
      }
      const plans = await run(() => [history.branchDeletePlan(branchId), history.branchDeletePlan(branchId, { withSubBranches: true })], 'Deleting the branch');
      if (!Array.isArray(plans) || view === null) return;
      const subBranches = plans[1].branches.length - plans[0].branches.length;
      const linesOf = withSub => {
        const p = plans[withSub ? 1 : 0];
        const one = p.steps === 1;
        const out = [`Its ${spanOf(view, p.steps, p.first, p.last)}, ${one ? 'goes' : 'go'} to Recently deleted, where you can restore ${one ? 'it' : 'them'}.`];
        if (p.results > 0) out.push(`${formatCountOf(p.results, 'result')} computed on it go with it.`);
        if (p.absorbed_by !== null) out.push(`“${p.absorbed_by.name}” starts from it: the steps they share stay and become part of it.`);
        if (withSub && p.branches.length > 1) out.push(p.branches.length === 2 ? 'The branch that starts from it goes too.' : `The ${formatCountOf(p.branches.length - 1, 'branch', 'branches')} that start from it go too.`);
        if (p.kept_views > 0) out.push(`${formatCountOf(p.kept_views, 'kept view')} made from it keep their picture and can no longer be replayed.`);
        if (p.replays > 0) out.push(`${formatCountOf(p.replays, 'tracker')} replayed from it will say that their source was deleted.`);
        if (p.head !== view.headId) out.push(`You are on this branch: you will see ${stepLabel(p.head)}.`);
        return out;
      };
      const answer = await ask({
        title: `Delete branch “${branch.name}”?`,
        lines: linesOf,
        option: subBranches === 0 ? null
          : { label: `Also delete ${subBranches === 1 ? 'the branch that starts' : `the ${formatCountOf(subBranches, 'branch', 'branches')} that start`} from it (${formatCountOf(plans[1].steps - plans[0].steps, 'step')})` },
        answers: [{ value: 'delete', label: 'Delete branch', tone: 'danger' }],
      });
      if (answer === null) return;
      if (plans[answer.option ? 1 : 0].head !== view.headId && !await goingBack()) return;
      toasted(await act('history.branch.delete', { branch: branchId, ...(answer.option ? { with_sub_branches: true } : {}) }), `Deleted branch “${branch.name}”`);
    },
    async deleteBranches(branchIds) {
      if (view === null || branchIds.length === 0) return false;
      if (branchIds.length === 1) {
        await ops.deleteBranch(branchIds[0]);
        return true;
      }
      const plans = await run(() => branchIds.map(id => ({ name: view.branch(id)?.name ?? id, plan: history.branchDeletePlan(id) })), 'Deleting the branches');
      if (!Array.isArray(plans)) return false;
      const steps = plans.reduce((sum, each) => sum + each.plan.steps, 0);
      const moves = plans.some(each => each.plan.head !== view.headId);
      const answer = await ask({
        title: `Delete ${formatCountOf(branchIds.length, 'branch', 'branches')}?`,
        lines: [
          `${steps === 1 ? 'Their 1 own step goes' : `Their ${formatCountOf(steps, 'own step')} go`} to Recently deleted, where you can restore ${steps === 1 ? 'it' : 'them'}.`,
          ...(moves ? ['You are on one of them: you will see where it starts.'] : []),
          ...plans.map(each => `“${each.name}”: ${formatCountOf(each.plan.steps, 'step')}`),
        ],
        answers: [{ value: 'delete', label: 'Delete branches', tone: 'danger' }],
      });
      if (answer === null) return false;
      if (moves && !await goingBack()) return false;
      // One edit for the person: the toast's Undo restores every branch
      // deleted, the last first (each is its own Recently deleted entry).
      const entries = [];
      for (const id of branchIds) {
        // A delete may take others with it.
        if (view?.branch(id) === undefined) continue;
        const outcome = await act('history.branch.delete', { branch: id });
        if (outcome === undefined) break;
        if (typeof outcome?.journal === 'string') entries.push(outcome.journal);
      }
      if (entries.length === 0) return false;
      const tracker = history?.active?.id ?? null;
      toastEdit(`Deleted ${formatCountOf(entries.length, 'branch', 'branches')}`, () => void (async () => {
        for (const entry of [...entries].reverse()) if (await act('history.journal.undo', { entry, tracker }, 'Undo') === undefined) return;
      })());
      return true;
    },
    async archiveBranch(branchId, archived, { quiet = false } = {}) {
      const name = view?.branch(branchId)?.name ?? branchId;
      const outcome = await act('history.branch.archive', { branch: branchId, archived });
      if (!quiet) toasted(outcome, `${archived ? 'Archived' : 'Unarchived'} “${name}”`);
    },
    async setMain(branchId) {
      toasted(await act('history.branch.set-main', { branch: branchId }), `“${view?.branch(branchId)?.name}” is main`);
    },
    async lock(branchId, locked) {
      toasted(await act('history.branch.lock', { branch: branchId, locked }), `${locked ? 'Locked' : 'Unlocked'} “${view?.branch(branchId)?.name}”`);
    },
    async compareBranch(branchId) {
      if (compareBranches === null || view === null) return;
      const shown = view.activeBranch;
      if (branchId === shown) return;
      const views = await run(() => compareBranches(history, shown, branchId), 'Comparing the branches');
      if (Array.isArray(views)) notify(`Kept ${formatCountOf(views.length, 'view')}: ${view?.branch(shown)?.name} and ${view?.branch(branchId)?.name}, side by side.`, 'success');
    },
    async group(from, to) {
      if (view === null) return;
      const range = groupRange(view, from, to);
      if (range.problem !== null) {
        notify(range.problem, 'warning');
        return;
      }
      const answer = await askName({
        title: `Group ${formatCountOf(range.steps.length, 'step')}`,
        kind: 'group',
        taken: view.groups().map(g => g.name),
        lines: [
          `${stepSpan(range.steps)}, become one node you can expand. Nothing is changed or merged.`,
          ...(range.widened === null ? [] : [range.widened]),
        ],
        answer: 'Group',
      });
      if (answer === null) return;
      toasted(await act('history.group.create', { from: range.from, to: range.to, name: answer.value }), `Grouped ${formatCountOf(range.steps.length, 'step')} as “${answer.value.trim()}”`);
    },
    async extendGroup(groupId, to) {
      const found = view === null ? null : extendableGroup(view, to);
      if (found === null || found.group.id !== groupId) return;
      toasted(await act('history.group.extend', { group: groupId, to }), `Added ${formatCountOf(found.steps, 'step')} to “${found.group.name}”`);
    },
    async ungroup(groupId) {
      const name = view?.group(groupId)?.name ?? groupId;
      toasted(await act('history.group.remove', { group: groupId }), `Ungrouped “${name}”`);
    },
    async squash(from, to) {
      if (view === null) return;
      const problem = squashProblem(view, from, to);
      if (problem !== null) {
        notify(problem, 'warning');
        return;
      }
      const steps = [];
      for (let at = view.step(to); at !== undefined; at = view.step(at.parent)) {
        steps.unshift(at);
        if (at.id === from) break;
      }
      const noted = steps.filter(step => (step.notes?.length ?? 0) > 0).length;
      const answer = await ask({
        title: `Merge ${formatCountOf(steps.length, 'step')} into one?`,
        lines: [
          `${stepSpan(steps)}, become one step from the state before the first to the state after the last.`,
          'The steps in between go to Recently deleted, where you can restore them. Group keeps them instead.',
          'Replayed on another dataset, the merged step brings its values only.',
          ...(noted > 0 ? [`Notes of ${formatCountOf(noted, 'step')} move to the merged step.`] : []),
        ],
        answers: [{ value: 'group', label: 'Group instead' }, { value: 'squash', label: 'Merge into one step', tone: 'danger' }],
      });
      if (answer === null) return;
      if (answer.answer === 'group') {
        await ops.group(from, to);
        return;
      }
      toasted(await act('history.squash', { from, to }), `Merged ${formatCountOf(steps.length, 'step')} into one`);
    },
    /**
     * Undo an agent's turn as the chat's Undo turn does (`history-link.js`
     * `undoAgentTurn`: one question when others acted after it began, only
     * its steps or everything since), told in a notification, and the first
     * step that no longer applies opened.
     */
    async undoTurn(turnId) {
      if (history?.active == null) return;
      if (!await goingBack()) return;
      await undoAgentTurn(history, turnId, {
        run: task => run(task, 'Undoing the turn'),
        tell: (note, result) => {
          notify(note.text, note.tone);
          if (result.report.length > 0) graph.reveal(result.report[0].step, { details: true });
        },
      });
    },
    async startTracker() {
      const answer = await ask({
        title: 'Start another tracker',
        lines: ['A new, independent tree of steps on this dataset. The one in use keeps its steps.'],
        answers: [{ value: 'shown', label: 'From what is shown' }, { value: 'opened', label: 'From the dataset as opened', tone: 'primary' }],
      });
      if (answer === null || !await goingBack()) return;
      await act('history.tracker.start', { start: answer.answer }, 'Starting a tracker');
    },
    async useTracker(trackerId) {
      await move('history.tracker.use', { tracker: trackerId }, 'Switching tracker');
    },
    async renameTracker() {
      if (view === null) return;
      const answer = await askName({ title: `Rename “${view.name}”`, kind: 'tracker', value: view.name, taken: (history.trackers?.() ?? []).map(t => t.name) });
      if (answer === null) return;
      toasted(await act('history.tracker.rename', { tracker: view.id, name: answer.value }), `Renamed to “${answer.value.trim()}”`);
    },
    async removeTracker() {
      if (view === null) return;
      const answer = await ask({
        title: `Remove the tracker “${view.name}”?`,
        lines: [`Its ${formatCountOf(view.stepCount, 'step')} and ${formatCountOf(view.branches().length, 'branch', 'branches')} go to Recently deleted, where you can restore them; the tracker used before it is shown.`],
        answers: [{ value: 'remove', label: 'Remove tracker', tone: 'danger' }],
      });
      if (answer === null || !await goingBack()) return;
      toasted(await act('history.tracker.remove', { tracker: view.id }), `Removed the tracker “${view.name}”`);
    },
    async clear() {
      const answer = await ask({
        title: 'Clear the history, keep the state?',
        lines: [
          'A new branch “Fresh start” holds what is shown as one step, from the dataset as opened.',
          'Every branch stays (archive them when you like); this is undone from Recently deleted.',
        ],
        answers: [{ value: 'clear', label: 'Clear history', tone: 'danger' }],
      });
      if (answer === null) return;
      toasted(await act('history.clear', { keep_state: true }), 'Cleared the history; the state is kept');
    },
    async showAt() {
      const answer = await ask({
        title: 'Show the state at…',
        lines: ['The last step on the branch shown at or before this time.'],
        input: {
          label: 'Time (e.g. 10:30, or 2026-11-04 10:30)',
          value: '',
          validate: text => (Number.isNaN(timeOf(text)) ? 'Write a time as 10:30, or a date and time.' : null),
        },
        answers: [{ value: 'show', label: 'Show', tone: 'primary' }],
      });
      if (answer === null) return;
      await move('history.jump', { at: timeOf(answer.value) }, 'Showing the state at a time');
    },
  };

  /** "10:30" today, or a date and time, in milliseconds. */
  function timeOf(text) {
    const clock = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
    if (clock !== null) {
      const at = new Date();
      at.setHours(Number(clock[1]), Number(clock[2]), 59, 999);
      return at.getTime();
    }
    return Date.parse(text.replace(' ', 'T'));
  }

  // ------------------------------------------------------------------ menus

  function openRowMenu(row, anchor, selection, at = null) {
    if (view === null) return;
    const items = [];
    const range = selection.problem === null && selection.steps.length > 1 ? selection : null;
    if (row.kind === 'step') {
      const step = row.step;
      const root = step.parent === null;
      const revert = root ? 'The opening has nothing to revert.' : revertProblem(view, step.id, domainName);
      items.push(
        { label: step.id === view.headId ? 'Shown' : 'Show', disabled: step.id === view.headId, run: () => ops.show(row) },
        { label: 'Branch here', hint: commandKey('B', { shift: true }), run: () => ops.branchHere(step.id) },
        { label: step.bookmark ? 'Rename bookmark…' : 'Bookmark…', run: () => ops.bookmark(step.id) },
        { label: 'Compare…', run: () => ops.compare(step.id) },
        { separator: true },
        { label: 'Revert', disabled: revert !== null, title: revert ?? 'Add a step that puts back what it changed', run: () => ops.revert(step.id) },
        { label: 'Branch without this step', disabled: root, run: () => ops.branchWithout(step.id) },
        { label: 'Copy code', disabled: !step.code, run: () => ops.copyCode(step) },
      );
    } else if (row.kind === 'fork') {
      openBranchMenu(row.branch.id, anchor, at);
      return;
    } else if (row.kind === 'group') {
      items.push(
        { label: 'Show last step', run: () => ops.show(row) },
        { label: 'Rename group…', run: () => ops.renameGroup(row.group.id) },
        { label: 'Ungroup', run: () => ops.ungroup(row.group.id) },
      );
    } else if (row.kind === 'turn') {
      items.push(
        { label: 'Undo turn', disabled: row.position === 'undone' || row.position === null, run: () => ops.undoTurn(row.turnId) },
        { label: 'Show in the chat', disabled: !ops.canOpenChat(row.turnId), run: () => ops.openChat(row.turnId) },
      );
    } else if (row.kind === 'run') {
      items.push({ label: row.expanded ? 'Fold' : 'Expand', run: () => ops.toggleRow(row) });
    }
    if (row.kind !== 'fork' && row.kind !== 'paused') {
      const from = range?.steps[0] ?? row.stepIds[0];
      const to = range?.steps[range.steps.length - 1] ?? row.stepIds[row.stepIds.length - 1];
      const count = range?.steps.length ?? row.stepIds.length;
      items.push(
        { separator: true },
        { label: count > 1 ? `Group ${formatCountOf(count, 'step')}…` : 'Group…', hint: commandKey('G'), disabled: view.step(from)?.parent === null, run: () => ops.group(from, to) },
        { label: count > 1 ? `Merge ${formatCountOf(count, 'step')} into one…` : 'Merge into one step…', disabled: count < 2, title: count < 2 ? 'Shift+click a second row to choose several steps' : '', run: () => ops.squash(from, to) },
      );
      const extend = row.kind === 'group' ? null : extendableGroup(view, to);
      if (extend !== null) {
        items.push({
          label: `Add to group “${extend.group.name}”`,
          title: `The group grows to this step, taking in ${formatCountOf(extend.steps, 'step')}`,
          run: () => ops.extendGroup(extend.group.id, to),
        });
      }
    }
    if (row.kind === 'step' && row.step.parent !== null) {
      items.push({ separator: true }, { label: 'Delete…', danger: true, run: () => ops.deleteStep(row.step.id) });
    }
    openMenu({ anchor, at, items, label: 'Step actions', returnFocus: anchor instanceof HTMLElement ? anchor : null });
  }

  function openBranchMenu(branchId, anchor, at = null) {
    const branch = view?.branch(branchId);
    if (branch === undefined) return;
    const main = branch.id === view.mainBranch;
    const shown = branch.id === view.activeBranch;
    const steps = view.branchStepCount(branchId);
    openMenu({
      anchor,
      at,
      label: `Branch “${branch.name}”`,
      items: [
        { label: shown ? 'Shown' : 'Show', disabled: shown && view.headId === branch.tip, run: () => ops.switchBranch(branchId) },
        { label: 'Rename…', hint: 'F2', disabled: branch.locked, title: branch.locked ? 'Unlock it first' : '', run: () => ops.renameBranch(branchId) },
        { label: 'Compare with the shown branch', disabled: shown || compareBranches === null, run: () => ops.compareBranch(branchId) },
        { separator: true },
        { label: 'Make main', disabled: main, title: main ? 'It is main' : '', run: () => ops.setMain(branchId) },
        { label: branch.locked ? 'Unlock' : 'Lock', run: () => ops.lock(branchId, !branch.locked) },
        { label: branch.archived ? 'Unarchive' : 'Archive', disabled: main, title: main ? 'Main is not archived' : '', run: () => ops.archiveBranch(branchId, !branch.archived) },
        { separator: true },
        { label: 'Copy pseudocode', run: () => void sharing.copyPseudocode(branchId) },
        { label: 'Apply its steps here', disabled: shown, title: 'Its own steps again, by name, on the step shown, as a new branch', run: () => void move('history.branch.apply', { branch: branchId }, 'Applying the steps here') },
        { label: 'Verify', title: 'Replay it and compare every part of the state', run: () => void verify(branchId) },
        { separator: true },
        {
          label: 'Delete…', danger: true, disabled: main || branch.locked || steps === 0,
          title: main ? plainSentence(HISTORY_SENTENCES.mainBranch()) : branch.locked ? plainSentence(HISTORY_SENTENCES.locked({ name: branch.name })) : '',
          run: () => ops.deleteBranch(branchId),
        },
      ],
    });
  }

  async function verify(branchId) {
    const outcome = await act('history.verify', { branch: branchId }, 'Verifying the branch');
    if (outcome === undefined) return;
    if (outcome.reproduced) notify(`“${view?.branch(branchId)?.name}” reproduced exactly (${formatCountOf(outcome.steps, 'step')}).`, 'success');
    else notify(`Not reproduced: ${outcome.domains.map(each => `${domainName(each.domain)} differs from ${each.first_step === null ? 'the start' : stepLabel(each.first_step)}`).join('; ')}.`, 'warning');
  }

  function openTrackerMenu(anchor) {
    const trackers = (history?.trackers?.() ?? []).filter(each => (each.removed ?? null) === null);
    openMenu({
      anchor,
      label: 'Trackers',
      items: [
        ...trackers.map(tracker => ({
          label: tracker.name, checked: tracker.id === view?.id,
          run: () => { if (tracker.id !== view?.id) void ops.useTracker(tracker.id); },
        })),
        { separator: true },
        { label: 'Start another tracker…', run: () => ops.startTracker() },
        { label: 'Rename tracker…', run: () => ops.renameTracker() },
        // The only tracker cannot be removed (the history refuses it): start another first.
        { label: 'Remove tracker…', danger: true, disabled: trackers.length < 2, title: trackers.length < 2 ? 'The only tracker: start another first' : undefined, run: () => ops.removeTracker() },
      ],
    });
  }

  // ------------------------------------------------------------------ parts

  const graph = createGraph({
    container: dom.graph,
    where: dom.where,
    handlers: {
      show: row => void ops.show(row),
      details: (row, close) => detailsFor(row, {
        doc: ownerDocument, view, act: (type, params) => act(type, params), catalog: catalog(), domainName, now, ops: { ...ops, close },
      }),
      menu: (row, anchor, selection, at) => openRowMenu(row, anchor, selection, at),
      rename: row => {
        if (row.kind === 'fork') void ops.renameBranch(row.branch.id);
        else if (row.kind === 'group') void ops.renameGroup(row.group.id);
        else if (row.kind === 'step' && row.step.bookmark) void ops.bookmark(row.step.id);
        else if (row.kind === 'step' && row.step.branch !== undefined) void ops.renameBranch(row.step.branch);
      },
      remove: row => {
        if (row.kind === 'step') void ops.deleteStep(row.step.id);
        else if (row.kind === 'fork') void ops.deleteBranch(row.branch.id);
      },
      group: selection => {
        if (selection.problem !== null) notify(selection.problem, 'warning');
        else void ops.group(selection.steps[0], selection.steps[selection.steps.length - 1]);
      },
      branchHere: row => void ops.branchHere(row.stepIds?.[row.stepIds.length - 1] ?? null),
      canOpenChat: turnId => ops.canOpenChat(turnId),
      openChat: turnId => ops.openChat(turnId),
      search: () => search.open(),
    },
    now,
  });
  ops.toggleRow = row => graph.toggle(row.key);

  const picker = createBranchPicker({ box: dom.branches, button: dom.branchButton, ops, now });
  const map = createBranchMap({
    dialog: dom.mapDialog,
    view: () => view,
    ops,
    graphHandlers: {
      show: row => void ops.show(row),
      details: (row, close) => detailsFor(row, { doc: ownerDocument, view, act: (type, params) => act(type, params), catalog: catalog(), domainName, now, ops: { ...ops, close } }),
      menu: (row, anchor, selection, at) => openRowMenu(row, anchor, selection, at),
      rename: row => { if (row.kind === 'fork') void ops.renameBranch(row.branch.id); },
      remove: row => { if (row.kind === 'fork') void ops.deleteBranch(row.branch.id); },
      group: selection => { if (selection.problem === null) void ops.group(selection.steps[0], selection.steps[selection.steps.length - 1]); },
      branchHere: row => void ops.branchHere(row.stepIds?.[row.stepIds.length - 1] ?? null),
      canOpenChat: turnId => ops.canOpenChat(turnId),
      openChat: turnId => ops.openChat(turnId),
      search: () => {},
    },
    layoutOptions: () => ({ ...layoutOptions(), filter: null }),
    now,
  });
  const search = createSearch({
    box: dom.search,
    toggle: dom.searchButton,
    input: dom.searchInput,
    filterButton: dom.filterButton,
    onChange: next => {
      query = next;
      render();
    },
    onClose: () => graph.focus(),
    choices: () => filterChoices(view?.steps() ?? [], domainName, now()),
  });
  const share = createShareDialog({
    dialog: dom.shareDialog,
    act: (type, params) => act(type, params, 'Sharing the history'),
    history: () => history,
    viewOf: current => trackerView(current),
    isResult,
    notify,
  });
  const deleted = createRecentlyDeleted({ dom, act, history: () => history, ask, notify, now });
  const replayReport = createReplayReport({
    dialog: dom.replayDialog,
    reveal: stepId => graph.reveal(stepId, { details: true }),
    // The names this dataset has, read as an agent reads them ("Use instead ▾").
    read: async (type, params) => {
      if (catalog()?.get?.(type)?.effect !== 'read') throw new RangeError(`The replay report only reads, not "${type}"`);
      return (await dispatch(type, params, { origin: 'user' })).outcome;
    },
    again: replayAgain === null ? null : {
      can: trackerId => replayAgain.can(trackerId),
      // Again from where the replay started (its first step), not on top of what it applied.
      replay: async (tracker, mapping) => {
        if (history?.active?.id === tracker.id && history.active.headId !== tracker.rootId) {
          await move('history.jump', { step: tracker.rootId }, 'Showing where the replay started');
          if (history?.active?.headId !== tracker.rootId) return;
        }
        await replayHistory(
          options => replayAgain.replay(tracker.id, mapping, options),
          `“${tracker.start?.from?.branch?.name ?? tracker.name}” with other names`,
        );
      },
    },
  });
  const memoryDialog = createMemoryDialog({
    dialog: dom.memoryDialog,
    shown: () => (history?.active == null ? null : { history, view }),
    domainName,
    reveal: stepId => graph.reveal(stepId, { details: true }),
    openDeleted: opener => deleted.open(opener),
  });
  const banner = createWorkflowBanner({
    box: dom.banner,
    ops: {
      tour: () => void playTour(),
      methods: () => void sharing.copyMethods(),
      report: opener => { if (view !== null) replayReport.open(view.tracker, opener); },
    },
  });
  const diff = createDiffDialog({
    dialog: dom.diffDialog, from: dom.diffFrom, to: dom.diffTo, status: dom.diffStatus, list: dom.diffList,
    view: () => view,
    read: (a, b) => actions.act('history.diff', { a: { step: a }, b: { step: b } }),
  });
  const saved = createSavedStatesDialog({
    dialog: dom.savedDialog,
    list: dom.savedList,
    empty: dom.savedEmpty,
    status: dom.savedStatus,
    nameInput: dom.savedName,
    contentSelect: dom.savedContent,
    saveAsButton: dom.savedSaveAs,
    save: (name, content) => actions.act('history.save', { name, content }),
    remove: id => actions.act('history.saved.delete', { saved: id }),
    replayFileButton: dom.savedReplayFile,
    openFileButton: dom.savedOpenFile,
    onReplayFile: replaySessionFile === null ? null : () => replayFile(),
    store: getSavedHistories,
    hasHistory: () => history?.active != null,
    onReplay: entry => void replayHistory(
      options => getSavedHistories().replay(entry.id, options),
      entry.name === null ? `the autosave of ${entry.dataset?.name ?? 'a dataset'}` : entry.name,
    ),
  });
  const tour = createTour({
    ownerDocument,
    view: () => view,
    jump: stepId => actions.act('history.jump', { step: stepId }),
    camera,
    onChange: () => render(),
    recordedCamera: stepId => {
      if (!offDomains().has('camera') || history?.active == null || view?.step(stepId) === undefined) return null;
      const focus = history.shownValue('views').focus;
      return history.valueAt(stepId, 'camera').views[focus] ?? null;
    },
    // Anyone else changing the history while the tour plays ends it where they are.
    subscribe: listener => (history === null ? () => {} : history.subscribe(listener)),
  });
  const sharing = createHistorySharing({
    ownerDocument,
    history: () => history,
    view: () => view,
    read: (type, params) => actions.act(type, params),
    jump: (stepId, how) => actions.act('history.jump', { step: stepId }, how),
    datasetFacts,
    pictures,
    reportDom: {
      dialog: dom.reportDialog,
      picturesToggle: dom.reportPictures,
      steps: dom.reportSteps,
      openButton: dom.reportOpen,
    },
    run,
  });

  // ------------------------------------------------------- the tour and the report as actions

  function refuseWithoutHistory(type) {
    if (history?.active == null || view === null) {
      throw new ActionRefused(HISTORY_WAITS_FOR_DATASET, { code: 'unavailable', type });
    }
  }

  /**
   * `history.tour.start`: the Tour button's tour, answered once it plays
   * (the paused card may ask the person first, as it does for the button).
   */
  function startTourAction() {
    const type = 'history.tour.start';
    refuseWithoutHistory(type);
    if (tour.playing) throw new ActionRefused('The guided tour is playing already; history_tour_stop stops it.', { code: 'busy', type });
    if (view.headId === view.rootId) {
      throw new ActionRefused('The step shown is the opening, so the tour has no step to show; jump to a later step first.', { code: 'unavailable', type });
    }
    return new Promise((resolve, reject) => {
      let started = false;
      playTour({
        onStart: ({ tracker, branch, steps, returnsTo }) => {
          started = true;
          resolve({ tracker, branch, steps, returns_to: returnsTo });
        },
      }).then(() => {
        if (!started) {
          reject(new ActionRefused('The tour did not start: the person chose to stay where the paused history is.', { code: 'declined', type }));
        }
      }, reject);
    });
  }

  /**
   * `history.report`: Print report's document, written as a file the person
   * receives (asked first of an agent, before any picture is drawn) or given
   * as text. A window opens only from the person's click, so an agent never
   * gets one.
   */
  async function reportAction({ as, pictures: choice, file }, confirm, signal) {
    const type = 'history.report';
    refuseWithoutHistory(type);
    if (as === 'text' && choice !== 'none') {
      throw new ActionRefused('A report as text has no pictures: ask for pictures "none", or for the report as a file.', { code: 'bad-value', type });
    }
    const name = file ?? `${datasetFacts().name ?? 'Cellucid'} history report.html`;
    if (as === 'file') await confirm(`It writes the history report ${name} to this computer${choice === 'none' ? '' : ', showing each step chosen for a picture in turn'}.`);
    const report = await sharing.report({ pictures: choice, signal });
    const covers = { tracker: report.tracker, branch: report.branch, to: report.to, steps: report.steps, pictures: report.pictures };
    if (as === 'text') {
      return { as, ...covers, file: null, bytes: new TextEncoder().encode(report.html).length, html: report.html };
    }
    const blob = new Blob([report.html], { type: 'text/html' });
    download(blob, name);
    return { as, ...covers, file: name, bytes: blob.size, html: null };
  }

  const unprovide = provide === null ? [] : [
    provide('history.tour.start', () => startTourAction()),
    provide('history.tour.stop', async () => {
      const stopped = await tour.stop();
      return { stopped, head: getCurrentHistory()?.active?.headId ?? null };
    }),
    provide('history.report', (params, { confirm, signal }) => reportAction(params, confirm, signal)),
  ];

  /**
   * Replay a saved history on the dataset shown, in a new tracker; its
   * progress is a notification whose Cancel stops it, and its report opens
   * when a step did not match.
   */
  async function replayHistory(start, what) {
    if (history?.active == null || replaying !== null) return;
    const replay = new AbortController();
    replaying = replay;
    const center = getNotificationCenter();
    const progress = center.progress(`Replaying ${what} on this dataset…`, 0, {
      category: 'session',
      onCancel: () => replay.abort(cancelled('user', 'The replay was stopped.')),
    });
    const shownProgress = () => center.hasNotification(progress);
    let result;
    try {
      result = await run(async () => {
        try {
          return await start({
            signal: replay.signal,
            onStep: (_entry, index, total) => {
              if (shownProgress()) center.updateProgress(progress, Math.round((100 * (index + 1)) / Math.max(1, total)));
            },
          });
        } catch (error) {
          if (replay.signal.aborted && isCancellation(error)) return null;
          throw error;
        }
      }, `Replaying ${what}`);
    } finally {
      replaying = null;
    }
    if (shownProgress()) center.dismiss(progress);
    if (result === undefined || result === null) return;
    // The replay in one sentence (the history's own words), and its report when a step did not match.
    const summary = summarizeReplay(result.report);
    notify(summary.text, summary.tone);
    if (summary.unmatched === 0) return;
    if (view !== null) replayReport.open(view.tracker);
  }

  function replayFile() {
    if (replaySessionFile === null || history?.active == null || replaying !== null) return;
    const picking = replaySessionFile.pick();
    void (async () => {
      let file;
      try {
        file = await picking;
      } catch (error) {
        reportHistoryFailure('Choosing a session file', error);
        return;
      }
      if (file === null) return;
      await replayHistory(options => replaySessionFile.replay(file, options), file.name);
    })();
  }

  // ------------------------------------------------------------------ header and status

  /**
   * Undo and redo pressed (keys or buttons) whose moves have not ended yet.
   * Whether there is anything to undo or redo is the history's own answer
   * (`canUndo`, `canRedo`), never the panel's view, which is drawn a frame
   * after a move ends: a redo pressed right after an undo would find nothing
   * to redo in it and be dropped. While a move is still on its way the
   * history cannot answer for after it either, so the press is sent as it
   * is: the history runs moves one after another in the order asked
   * (`history.js` `exclusive`), and one with nothing to do answers
   * `moved: false`.
   */
  let movesPending = 0;

  function perform(command) {
    if (history === null || tour.playing || view === null || history.active == null) return false;
    const undo = command === 'undo';
    if (movesPending === 0 && !(undo ? history.canUndo() : history.canRedo())) return false;
    const before = history.active.headId;
    // An undo's step, named while it is still the one shown (none known while an earlier move is on its way).
    const label = undo && movesPending === 0 ? history.active.steps.get(before)?.label ?? null : null;
    movesPending += 1;
    void move(undo ? 'history.undo' : 'history.redo', {}, undo ? 'Undo' : 'Redo').then(() => {
      // Said once, politely, for a screen reader: the status line only counts.
      const now = history?.active?.headId ?? null;
      if (now === null || now === before) return;
      const name = undo ? label : history.active.steps.get(now)?.label ?? null;
      dom.announce.textContent = name === null ? `${undo ? 'Undid' : 'Redid'} a step` : `${undo ? 'Undid' : 'Redid'} “${name}”`;
    }).finally(() => { movesPending -= 1; });
    return true;
  }

  dom.undoButton.addEventListener('click', () => perform('undo'), { signal });
  dom.redoButton.addEventListener('click', () => perform('redo'), { signal });
  const keyBinding = bindHistoryKeys({ ownerDocument, perform });

  dom.recording.addEventListener('click', () => {
    if (view === null) return;
    void act(view.recording ? 'history.recording.pause' : 'history.recording.resume', {}, view.recording ? 'Pausing the recording' : 'Resuming the recording');
  }, { signal });
  dom.staleButton.addEventListener('click', () => search.showFlagged(), { signal });
  dom.memoryButton.addEventListener('click', () => memoryDialog.open(dom.memoryButton), { signal });
  dom.pendingCancel.addEventListener('click', () => void act('history.branch.cancel', {}, 'Canceling the new branch'), { signal });
  dom.shareButton.addEventListener('click', () => share.open(dom.shareButton), { signal });
  dom.loadButton.addEventListener('click', () => saved.open(dom.loadButton), { signal });

  const menuItems = [...dom.menu.querySelectorAll('[data-history-command]')];
  initOpenDataMenu({
    button: dom.menuButton,
    menu: dom.menu,
    items: menuItems,
    signal,
    onChoose: item => {
      if (history?.active == null) return;
      switch (item.dataset.historyCommand) {
        case 'tour': void playTour(); break;
        case 'diff': {
          const head = view.step(view.headId);
          diff.open(head.parent ?? view.headId, view.headId, dom.menuButton);
          break;
        }
        case 'map': map.open(dom.menuButton); break;
        case 'deleted': deleted.open(dom.menuButton); break;
        case 'pseudocode': void sharing.copyPseudocode(null); break;
        case 'methods': void sharing.copyMethods(); break;
        case 'report': sharing.printReport(dom.menuButton); break;
        // Its progress, outcome and refusals are told by the action itself (`history/anndata-copy-save.js`).
        case 'anndata': void actions.act('history.anndata.save').catch(() => {}); break;
        case 'replay': saved.open(dom.menuButton); break;
        case 'tracker': void ops.startTracker(); break;
        case 'at-time': void ops.showAt(); break;
        case 'clear': void ops.clear(); break;
        default:
      }
    },
  });

  function renderBusy() {
    const isBusy = busy > 0;
    dom.graph.setAttribute('aria-busy', String(isBusy));
    dom.section.dataset.historyBusy = String(isBusy);
    if (isBusy) {
      dom.undoButton.disabled = true;
      dom.redoButton.disabled = true;
    }
  }

  function renderHeader() {
    const idle = busy === 0 && !tour.playing && view !== null;
    const undoable = idle && canUndo(view);
    const redo = idle ? redoTarget(view) : null;
    dom.undoButton.disabled = !undoable;
    dom.redoButton.disabled = redo === null;
    const undoLabel = undoable ? `Undo “${view.step(view.headId).label}” (${keys.undo})` : `Undo (${keys.undo})`;
    const redoLabel = redo !== null ? `Redo “${view.step(redo).label}” (${keys.redo})` : `Redo (${keys.redo})`;
    dom.undoButton.setAttribute('aria-label', undoLabel);
    dom.undoButton.title = undoLabel;
    dom.redoButton.setAttribute('aria-label', redoLabel);
    dom.redoButton.title = redoLabel;
    dom.menuButton.disabled = view === null || tour.playing;
    dom.searchButton.disabled = view === null;
    dom.shareButton.disabled = view === null;
    dom.shareButton.title = view === null ? openADatasetTo('share a session') : 'Write a session file: the history, the current state only, or the steps only';
    const jumpParams = catalog()?.has?.('history.jump') ? catalog().get('history.jump').params?.properties ?? {} : {};
    for (const item of menuItems) {
      const command = item.dataset.historyCommand;
      const empty = view === null || view.stepCount === 0;
      item.hidden = (command === 'replay' && replaySessionFile === null && getSavedHistories() === null)
        || (command === 'at-time' && !Object.hasOwn(jumpParams, 'at'));
      item.disabled = view === null
        || (['tour', 'diff', 'pseudocode', 'methods', 'report', 'clear', 'at-time'].includes(command) && empty)
        || (command === 'replay' && replaying !== null);
    }
  }

  /**
   * "⚠ 1.2 GB" on the status line while the history passes what the memory
   * budget leaves for it, and once per time it does, one sentence naming
   * the largest parts (`memory-dialog.js`).
   */
  let overBudgetSaid = false;
  function renderMemory() {
    const historyBytes = history?.active == null ? 0 : history.pool.byteLength();
    const over = historyOverBudget({ historyBytes, workingSetBytes: workingSetBytes(), allowanceBytes: memoryAllowanceBytes() });
    dom.memoryButton.hidden = !over;
    if (!over) {
      overBudgetSaid = false;
      return;
    }
    // The parts are walked only for the sentence, once per time it passes.
    const words = memoryWords(overBudgetSaid ? { total: historyBytes, parts: [] } : history.memoryParts(), {
      domainName, shownTracker: history.active.id, trackerName: id => history.allTrackers().find(tracker => tracker.id === id)?.name ?? null,
    });
    dom.memoryButton.textContent = words.chip;
    dom.memoryButton.setAttribute('aria-label', `${words.chip.slice(2)} of memory, more than this device has room for: see where it goes`);
    dom.memoryButton.title = 'The history holds more than this device has room for now: see where it goes';
    if (!overBudgetSaid) {
      overBudgetSaid = true;
      notify(words.sentence, 'warning');
    }
  }

  function renderStatus(layout) {
    dom.recording.disabled = view === null || busy > 0;
    if (view === null) {
      dom.recording.hidden = true;
      dom.status.textContent = HISTORY_WAITS_FOR_DATASET;
      dom.status.dataset.tone = 'muted';
      dom.staleButton.hidden = true;
      dom.pendingCancel.hidden = true;
      return;
    }
    dom.recording.hidden = false;
    dom.recording.setAttribute('aria-checked', String(view.recording));
    dom.recording.dataset.state = view.recording ? 'recording' : 'paused';
    dom.recording.querySelector('.history-recording-text').textContent = view.recording ? 'Recording' : 'Paused';
    dom.recording.title = view.recording ? 'Pause: changes still apply, but are not steps until you resume' : 'Paused: changes still apply but are not steps. Resume: what changed meanwhile becomes one step';
    const pending = view.pending;
    dom.pendingCancel.hidden = pending === null || pending === undefined;
    if (pending) {
      dom.status.textContent = plainSentence(HISTORY_SENTENCES.pending({ name: pending.name, step: pending.from }));
      dom.status.dataset.tone = 'info';
      dom.staleButton.hidden = true;
      return;
    }
    const words = statusWords({
      steps: layout.steps, undone: layout.undone, matches: layout.matches, stale: view.stale().size,
      recording: view.recording, pausedAt: view.pausedAt, now: now(),
    });
    dom.status.textContent = layout.steps === 0 && view.recording && layout.matches === null
      ? `Every change you make appears here. Undo with ${keys.undo}.` : words.text;
    dom.status.dataset.tone = view.recording ? 'muted' : 'warning';
    dom.staleButton.hidden = words.stale === null;
    if (words.stale !== null) {
      dom.staleButton.textContent = words.stale;
      dom.staleButton.setAttribute('aria-label', `${words.stale}: show them`);
    }
  }

  /** Bumped whenever the history, its turns or History settings change (`layoutOptions`' `version`). */
  let historyVersion = 0;
  /** Something the rows or their details show changed: draw again. */
  function changed() {
    historyVersion += 1;
    // What the panel acts on is the history now. Drawing waits for the next frame and for the panel
    // being in sight; a tour stopped before that frame must see where the history is, not where
    // it was drawn (otherwise it would find itself still at the step to return
    // to, and stay at the opening).
    view = trackerView(history);
    render();
  }

  /** Draw the panel: at most once a frame, and only while it can be seen. */
  let frame = null;
  const gate = createVisibilityGatedRender(dom.graph, () => renderNow());
  function render() {
    if (destroyed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (destroyed) return;
      // Said whether or not the panel is in sight (its chip waits for it).
      renderMemory();
      gate.request();
    });
  }

  function renderNow() {
    if (destroyed) return;
    view = trackerView(history);
    let layout = { steps: 0, undone: 0, matches: null };
    try {
      layout = graph.render(view, layoutOptions());
      picker.render(view, history?.trackers?.() ?? []);
      banner.render(view);
    } catch (error) {
      reportHistoryFailure('Drawing the history', error);
    }
    // The tour moves the history; the graph waits until it ends.
    dom.graph.inert = tour.playing;
    renderStatus(layout);
    renderHeader();
    renderBusy();
    diff.refresh();
    map.refresh();
    deleted.refresh();
    memoryDialog.refresh();
  }

  function attach() {
    const next = getCurrentHistory();
    if (next !== history) {
      unsubscribeHistory();
      if (tour.playing) void tour.stop();
      diff.close();
      map.close();
      history = next;
      unsubscribeHistory = history === null ? () => {} : history.subscribe(() => changed());
      historyVersion += 1;
      view = trackerView(history);
    }
    saved.refresh();
    renderBusy();
    render();
  }
  const unsubscribeCurrent = subscribeCurrentHistory(attach);
  // What the device has room for moves too (another tab, a refused allocation, the open cells):
  // only the memory line follows it; the graph does not draw again for it.
  const unsubscribeMemory = onMemoryChange(() => {
    if (destroyed) return;
    renderMemory();
    memoryDialog.refresh();
  });
  attach();
  renderSettings();
  // A message of the chat shows its steps here: the panel opens on them.
  const unsubscribeTurns = subscribeTurns(() => changed());
  const unregisterStepRevealer = registerStepRevealer(async stepId => {
    const shown = history;
    if (shown?.active == null) return;
    if (!dom.section.open) {
      // Opening the panel is a layout step: the step is shown once that one is recorded.
      const toggled = new Promise(resolve => dom.section.addEventListener('toggle', resolve, { once: true }));
      dom.section.open = true;
      await toggled;
      await shown.idle();
      if (destroyed || history !== shown) return;
    }
    renderNow();
    const turn = view?.step(stepId)?.by?.turn ?? null;
    if (turn !== null && graph.revealTurn(turn)) return;
    graph.reveal(stepId);
  });

  return {
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of unprovide) remove();
      replaying?.abort(cancelled('user', 'The page section was closed.'));
      if (frame !== null) cancelAnimationFrame(frame);
      gate.destroy();
      unsubscribeCurrent();
      unsubscribeMemory();
      unsubscribeSettings();
      unregisterStepRevealer();
      unsubscribeTurns();
      unsubscribeHistory();
      controller.abort();
      keyBinding.destroy();
      tour.destroy();
      graph.destroy();
      picker.destroy();
      map.destroy();
      search.destroy();
      share.destroy();
      deleted.destroy();
      replayReport.destroy();
      memoryDialog.destroy();
      diff.destroy();
      saved.destroy();
      sharing.destroy();
    },
  };
}
