/**
 * @fileoverview The agent presence: what every agent acting in this tab goes
 * through, whichever way it came in (Cellucid's chat bar, or Claude or
 * ChatGPT through the connector). It hangs on the action dispatcher, so a
 * new way in gets it without code here.
 *
 * - **The person's permissions** (the dispatcher's confirmer,
 *   `setConfirmer`; `permissions.js`): every change an agent asks for is
 *   allowed, refused or asked about by the person's settings per kind of
 *   action (any undoable change, heavy work judged from the action's
 *   estimate, and what the history cannot take back: writing a file,
 *   deleting what was saved, a large download, publishing). Asking shows a
 *   compact card: who asks, what (the action; its parameters under Details),
 *   why (each kind asked about, with the estimate of the work), and the
 *   agent waits. **Deny** refuses it with one sentence the agent reads (the
 *   dispatcher's "The person declined, so this was not done: …"); **Allow** once, in this chat
 *   (or for this connection) until the page closes, or always (the kind is
 *   set to Allow). An agent that gives up (its call stopped), the person's
 *   Stop, another dataset shown and a closed tab refuse it too, each with
 *   its own sentence. The settings (a mode, or each kind) are one line in
 *   the chat settings and a dialog (`openPermissions`).
 * - **What agents send** (`../data-scope.js`): the first time an agent acts
 *   on a dataset (the chat or a connector, any dispatch of `origin:
 *   'agent'`), a compact notice says once what agents read is sent to their
 *   provider, with the switch "Agents see names and summaries only" for that
 *   dataset in it; the switch is also in the permission settings, for the
 *   dataset shown. Nothing waits on the notice: free reading is the default.
 * - **The activity line** (`activity.js`): which agent is acting now and
 *   what it runs, with **Stop** (stops what that turn runs: the dispatcher's
 *   `stop` for its actions, and the attached surface's own stop, the chat
 *   bar's model call), then, once it made steps, **Undo turn** (the
 *   turn's steps taken back: `history-link.js` `undoAgentTurn`).
 *
 * @module app/agent/presence
 */

import { actorLabel, createAgentActivity, outsideText, turnKey } from './activity.js';
import { outsideActOf } from '../../actions/catalog.js';
import { SUMMARIES_ONLY_LABEL, SUMMARIES_ONLY_CAVEAT, agentDataStore, dataScopeNow, subscribeDataScope } from '../data-scope.js';
import { undoAgentTurn } from '../history-link.js';
import {
  KIND_LABELS, PERMISSION_CHOICES, PERMISSION_KINDS, PERMISSION_MODES, createPermissionStore, decide, deniedSentence,
  estimateText, grantKey, modeOf, permissionFor, permissionsLine, permissionsSummary,
} from './permissions.js';
import { wireAppDialog } from '../../ui/components/app-dialog.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { plainSentence } from '../../actions/targets/names.js';
import { getCurrentHistory, subscribeCurrentHistory } from '../../history/current.js';
import { inSentence, parameterFacts } from '../../history/exports/step-text.js';
import { renderFactList, bindDisclosure } from '../../ui/components/controls.js';
import { createDomId } from '../../ui/components/dom-id.js';
import { abortReason, cancelled, onAbort } from '../../../utils/abort.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { whileWaitingOnPerson } from '../../../utils/person-wait.js';

/** Why the person is asked, by the definition's `confirm`: what the history cannot do about it. */
export const CONFIRM_REASONS = Object.freeze({
  'writes-file': 'It writes a file to this computer, which the history cannot take back.',
  'deletes-saved': 'It deletes something saved in this browser, which the history cannot bring back.',
  'large-download': 'It downloads a lot of data, which takes time and may cost on a metered connection.',
  publishes: 'It publishes for others to see, which the history cannot take back.',
  'pauses-recording': 'It pauses the history: changes made meanwhile become one step, so no change can be undone on its own.',
});

/** Why a kind of action is asked about, in the card (`detail`: what the action says makes it cost). */
function askedBecause(kind, estimate, detail) {
  if (kind === 'heavy') return `It is heavy work: ${estimateText(estimate) ?? 'it takes long on this device.'}`;
  if (kind === 'change') return 'Your settings ask before every change.';
  // A handler's sentence marks the names in it for an agent; the person reads them plain.
  return detail === null || detail === undefined ? CONFIRM_REASONS[kind] : plainSentence(detail);
}

/**
 * What a confirm card says: who asks, what exactly (the action, and what
 * its step or act will say, `describe(params)`, with its names as the
 * person reads them), why (each kind asked about, with the estimate of the
 * work or the action's own sentence on what it costs, `detail`), and the
 * parameters. The question an agent's own app asks (`questionFor`) is the
 * same words.
 * @param {{definition: object, params: object, meta: {origin?: string, agent?: string, host?: string}, estimate?: object|null, detail?: string|null, asking?: string[]}} request
 */
export function confirmTextOf({ definition, params, meta, estimate = null, detail = null, asking = [definition.confirm ?? 'change'] }) {
  let exactly = null;
  try {
    exactly = definition.describe(params, null);
  } catch (error) {
    console.error(`[agent presence] describing ${definition.type} failed`, error);
  }
  const what = `${actorLabel(meta)} asks to ${inSentence(definition.title)}`;
  return {
    who: meta.agent ?? actorLabel(meta),
    what: exactly ? `${what}: “${exactly}”.` : `${what}.`,
    why: asking.map(kind => askedBecause(kind, estimate, detail)).join(' '),
    facts: parameterFacts(params, definition.params),
  };
}

/**
 * One sentence for an activity line; ⏸ first while the history's recording
 * is paused (History v2 §3.15.1: the agent's changes make no step meanwhile).
 * @param {object} line
 * @param {{paused?: boolean}} [options]
 */
export function activityTextOf(line, { paused = false } = {}) {
  const steps = line.steps > 0 ? ` · ${formatCountOf(line.steps, 'step')}` : '';
  // What it did outside the state stays done whatever is undone: said as such.
  const outside = outsideText(line.outside);
  const acts = outside === null ? '' : ` · ${outside}, not undoable`;
  const mark = paused ? '⏸ ' : '';
  switch (line.state) {
    case 'acting': return `${mark}${line.label} is working${steps}${acts}${line.doing ? ` · ${line.doing}` : ''}`;
    case 'stopped': return `${mark}${line.label} stopped${steps}${acts}`;
    case 'undone': return `${mark}${line.label}'s turn is undone${acts}`;
    default: return `${mark}${line.label}${steps}${acts}${line.lastLabel ? ` · ${line.lastLabel}` : ''}`;
  }
}

/**
 * @param {{
 *   root: HTMLElement,
 *   dialog: {dialog: HTMLDialogElement, body: HTMLElement},
 *   actions: {subscribe: Function, setConfirmer: Function, stop: Function, catalog: object},
 *   permissions?: ReturnType<typeof createPermissionStore>,
 *   history?: {current: () => object|null, subscribe: (listener: () => void) => () => void},
 *   dataStore?: ReturnType<typeof agentDataStore>,
 *   notify?: (sentence: string) => void,
 *   win?: Window,
 * }} options - `root`: the presence's place in the agent dock; `dialog`: the permission settings'
 *   dialog and the body drawn into it; `dataStore`: what agents are sent of each dataset
 *   (`../data-scope.js`); `notify`: tell the person one sentence
 */
export function initAgentPresence({
  root, dialog, actions,
  permissions = createPermissionStore(),
  history = { current: getCurrentHistory, subscribe: subscribeCurrentHistory },
  dataStore = agentDataStore(),
  notify = () => {},
  win = globalThis.window,
}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('The agent presence needs its place in the page.');
  if (!(dialog?.dialog instanceof HTMLDialogElement) || !(dialog.body instanceof HTMLElement)) {
    throw new TypeError('The agent presence needs the permission settings dialog.');
  }
  const doc = root.ownerDocument;
  /** Kinds allowed for one chat or connection until the page closes (`grantKey`). */
  const grants = new Set();
  /** Who hears that what a connection's tool list says may have changed (the settings, or a grant). */
  const permissionListeners = new Set();
  function permissionsChanged() {
    for (const listener of [...permissionListeners]) {
      try { listener(); } catch (error) { console.error('[agents] a permissions listener failed', error); }
    }
  }
  const activity = createAgentActivity({
    titleOf: type => (actions.catalog.has(type) ? actions.catalog.get(type).title : type),
    outsideOf: (type, params, outcome) => (actions.catalog.has(type) ? outsideActOf(actions.catalog.get(type), params, outcome) : null),
  });
  const controller = new AbortController();
  const { signal } = controller;
  /** Cards waiting for the person, oldest first. */
  const pending = [];
  /** key → line elements */
  const lineElements = new Map();
  const noticeBox = doc.createElement('div');
  noticeBox.className = 'agent-notices';
  const cardsBox = doc.createElement('div');
  cardsBox.className = 'agent-confirms';
  const linesBox = doc.createElement('div');
  linesBox.className = 'agent-activities';
  const announcer = doc.createElement('p');
  announcer.className = 'sr-only';
  announcer.setAttribute('role', 'status');
  root.replaceChildren(noticeBox, cardsBox, linesBox, announcer);
  let shownHistory = history.current();
  let destroyed = false;
  let lastStates = new Map();

  function render() {
    if (destroyed) return;
    const lines = activity.lines();
    const seen = new Set();
    lines.forEach((line, index) => {
      seen.add(line.key);
      let parts = lineElements.get(line.key);
      if (parts === undefined) {
        parts = lineElement(line);
        lineElements.set(line.key, parts);
      }
      updateLine(parts, line);
      // Moved only when out of place: a line keeps the focus of its buttons.
      if (linesBox.children[index] !== parts.root) linesBox.insertBefore(parts.root, linesBox.children[index] ?? null);
    });
    for (const [key, parts] of lineElements) {
      if (!seen.has(key)) {
        parts.root.remove();
        parts.release();
        lineElements.delete(key);
      }
    }
    announce(lines);
    root.hidden = lines.length === 0 && pending.length === 0 && notice === null;
  }

  /** Say a change of state once (the line itself is not a live region). */
  function announce(lines) {
    const states = new Map(lines.map(line => [line.key, line.state]));
    for (const line of lines) {
      if (lastStates.get(line.key) === line.state) continue;
      announcer.textContent = `${activityTextOf({ ...line, doing: null })}.`;
    }
    lastStates = states;
  }

  /** One line's elements; its listeners go with it (`lines` removed from the page are let go). */
  function lineElement(line) {
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    const element = doc.createElement('div');
    element.className = 'agent-activity';
    element.dataset.agentTurn = line.turn ?? '';
    element.dataset.agent = line.agent;
    element.dataset.connection = line.connection ?? '';
    const dot = doc.createElement('span');
    dot.className = 'agent-activity-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = doc.createElement('span');
    text.className = 'agent-activity-text';
    const stop = doc.createElement('button');
    stop.type = 'button';
    stop.className = 'btn btn-compact agent-activity-stop';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => stopTurn(line.key), { signal });
    const undo = doc.createElement('button');
    undo.type = 'button';
    undo.className = 'btn btn-compact agent-activity-undo';
    undo.textContent = 'Undo turn';
    undo.addEventListener('click', () => void undoTurn(line.key), { signal });
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'icon-btn agent-activity-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.title = 'Dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      activity.dismiss(line.key);
      render();
    }, { signal });
    element.append(dot, text, stop, undo, dismiss);
    return { root: element, text, stop, undo, dismiss, line, release: () => owner.abort() };
  }

  /** Whether the history shown records no steps now (its recording paused). */
  const recordingPaused = () => (history.current()?.active?.paused ?? null) !== null;

  function updateLine(parts, line) {
    parts.line = line;
    parts.root.dataset.state = line.state;
    const paused = recordingPaused();
    const text = activityTextOf(line, { paused });
    if (parts.text.textContent !== text) {
      parts.text.textContent = text;
      parts.text.title = paused ? `${text} (recording is paused: changes make no step)` : text;
    }
    parts.stop.hidden = line.state !== 'acting';
    parts.stop.setAttribute('aria-label', `Stop ${line.label}`);
    parts.undo.hidden = !(line.steps > 0 && line.state !== 'undone' && line.state !== 'acting');
    parts.undo.setAttribute('aria-label', `Undo ${line.label}'s turn of ${formatCountOf(line.steps, 'step')}`);
    parts.dismiss.hidden = line.state === 'acting';
  }

  function lineOf(key) {
    return activity.lines().find(line => line.key === key) ?? null;
  }

  /** Stop what the turn `key` runs: its surface's own work and its actions in flight. */
  function stopTurn(key) {
    const line = lineOf(key);
    if (line === null) return;
    const stopSurface = activity.markStopped(key);
    const reason = cancelled('user', `The person stopped ${line.label}.`);
    try { stopSurface?.(); } catch (error) { console.error('[agent presence] stopping the turn failed', error); }
    actions.stop({ origin: 'agent', agent: line.agent, ...(line.turn === null ? {} : { turn: line.turn }) }, reason);
    for (const card of [...pending]) {
      // The questions of this turn (this agent through this connection), and of no other.
      if (turnKey(card.meta.agent, line.turn === null ? null : card.meta.turn, card.meta.connection ?? null) === line.key) refuse(card, reason);
    }
    render();
  }

  async function undoTurn(key) {
    const line = lineOf(key);
    const current = history.current();
    if (line === null || line.turn === null || current === null) return;
    try {
      // Others acted after it began: the person chooses only its steps or everything since (`history-link.js`).
      const result = await undoAgentTurn(current, line.turn);
      if (result.undone) activity.markUndone(key);
      else if (!result.found) notify(`Nothing of ${line.label}'s turn is in the history shown.`);
    } catch (error) {
      notify(`Undoing ${line.label}'s turn failed: ${error?.message ?? String(error)}`);
    }
    render();
  }

  // ------------------------------------------------------------- Confirm

  function settle(card) {
    const at = pending.indexOf(card);
    if (at !== -1) pending.splice(at, 1);
    // The focus was on the card: it goes to the next question, else back where it was before the card took it.
    const hadFocus = card.element.contains(doc.activeElement);
    card.removeAbort();
    card.release();
    card.releaseLine();
    card.element.remove();
    render();
    if (!hadFocus) return;
    if (pending.length > 0) pending[0].element.focus();
    else if (card.returnFocus?.isConnected) card.returnFocus.focus({ preventScroll: true });
  }

  /**
   * Whether the person is typing in a field outside the agents' own place
   * (a card does not take the focus from them there; it is announced).
   */
  function typingElsewhere() {
    const active = doc.activeElement;
    if (!(active instanceof HTMLElement) || root.closest('.agent-dock')?.contains(active)) return false;
    return active.isContentEditable || active instanceof HTMLTextAreaElement
      || (active instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(active.type));
  }

  function refuse(card, error) {
    if (!pending.includes(card)) return;
    settle(card);
    card.reject(error);
  }

  /** A card's elements; its listeners go when it is settled (`card.release`). */
  function cardElement(card) {
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    card.release = () => owner.abort();
    const text = confirmTextOf(card);
    const element = doc.createElement('div');
    element.className = 'agent-confirm';
    element.setAttribute('role', 'group');
    // Focusable itself: a keyboard user is brought to the question, and Tab reaches its answers.
    element.tabIndex = -1;
    const titleId = createDomId('agent-confirm-title');
    element.setAttribute('aria-labelledby', titleId);
    element.dataset.agent = text.who;
    element.dataset.connection = card.meta.connection?.kind ?? '';
    element.dataset.action = card.definition.type;
    element.dataset.asking = card.asking.join(' ');
    const title = doc.createElement('p');
    title.className = 'agent-confirm-title';
    title.id = titleId;
    title.setAttribute('role', 'alert');
    title.textContent = text.what;
    const why = doc.createElement('p');
    why.className = 'agent-confirm-why';
    why.textContent = text.why;
    element.append(title, why);
    if (text.facts.length > 0) {
      const details = doc.createElement('div');
      details.className = 'disclosure disclosure-inline details-disclosure';
      const header = doc.createElement('button');
      header.type = 'button';
      header.className = 'disclosure-header';
      header.innerHTML = '<span class="disclosure-title">Details</span><span class="disclosure-chevron" aria-hidden="true"></span>';
      const content = doc.createElement('div');
      content.className = 'disclosure-content';
      content.id = createDomId('agent-confirm-details');
      const list = doc.createElement('dl');
      list.className = 'fact-list';
      renderFactList(list, text.facts);
      content.appendChild(list);
      details.append(header, content);
      bindDisclosure({ header, content, expanded: false, signal });
      element.appendChild(details);
    }
    const buttons = doc.createElement('div');
    buttons.className = 'agent-confirm-actions';
    const button = (label, className, title, answer) => {
      const node = doc.createElement('button');
      node.type = 'button';
      node.className = `btn btn-compact ${className}`;
      node.textContent = label;
      node.title = title;
      node.setAttribute('aria-label', title);
      node.addEventListener('click', () => answer(), { signal });
      return node;
    };
    const kinds = card.asking.map(kind => KIND_LABELS[kind].toLowerCase()).join(' and ');
    const where = card.surface === 'chat' ? 'in this chat' : card.surface === 'notebook' ? 'for this notebook' : 'for this connection';
    const allowLabel = doc.createElement('span');
    allowLabel.className = 'agent-confirm-allow-label';
    allowLabel.textContent = 'Allow';
    buttons.append(
      button('Deny', 'agent-confirm-deny', `Deny: ${actorLabel(card.meta)} is told you declined`, () => answerCard(card, 'deny')),
      allowLabel,
      button('Once', 'btn-primary agent-confirm-allow', 'Allow this once', () => answerCard(card, 'once')),
      button(card.surface === 'chat' ? 'This chat' : card.surface === 'notebook' ? 'This notebook' : 'This connection', 'agent-confirm-allow-here', `Allow ${kinds} ${where} until this page closes`, () => answerCard(card, 'here')),
      button('Always', 'agent-confirm-allow-always', `Always allow ${kinds} (Permissions in the chat settings)`, () => answerCard(card, 'always')),
    );
    element.appendChild(buttons);
    return element;
  }

  /** The person's answer to a card: Deny, or Allow once, here (this chat or connection), or always. */
  function answerCard(card, answer) {
    if (!pending.includes(card)) return;
    settle(card);
    if (answer === 'deny') {
      card.resolve(false);
      return;
    }
    if (answer === 'here') {
      for (const kind of card.asking) grants.add(grantKey(card.meta, kind));
      permissionsChanged();
    }
    if (answer === 'always') permissions.set({ kinds: Object.fromEntries(card.asking.map(kind => [kind, 'allow'])) });
    card.resolve(true);
  }

  /** The card asking about the agent call whose signal is `signal` (`meta.signal`), or null. */
  function cardOf(signal) {
    return signal ? pending.find(card => card.meta.signal === signal) ?? null : null;
  }

  /**
   * The dispatcher's confirmer: the person's settings decide (`permissions.js`);
   * what they ask about waits for the person. Resolves whether it may run;
   * a refusal by the settings is thrown with its sentence.
   */
  async function confirm({ definition, params, meta, signal = meta.signal, estimate = null, confirm: kind = null, detail = null, stage = 'start', asking = () => {} }) {
    if (destroyed) throw new ActionRefused('Cellucid cannot ask the person now; try again.', { code: 'closed', type: definition.type });
    let ruling = decide({ meta, estimate, confirm: kind, stage }, permissions.get(), grants);
    // Recording is paused (History v2 §3.15.1): an agent's change makes no step, so it cannot be undone
    // on its own; the person is asked whatever the settings allow.
    if (stage === 'start' && ['state', 'view', 'layout'].includes(definition.effect) && history.current()?.active?.paused) {
      if (ruling.decision === 'allow') ruling = { ...ruling, decision: 'ask', asking: ruling.kinds };
      detail = `Recording is paused: ${actorLabel(meta)}'s change can't be undone on its own.`;
    }
    if (ruling.decision === 'allow') return true;
    if (ruling.decision === 'deny') {
      throw new ActionRefused(deniedSentence(definition, ruling.denied), { code: 'not-permitted', type: definition.type });
    }
    // The person is asked: a wait on them (`utils/person-wait.js`), so an opening that asked does not count it as a stall.
    return whileWaitingOnPerson(new Promise((resolve, reject) => {
      const card = {
        definition, params, meta, estimate, detail, asking: ruling.asking, resolve, reject, removeAbort: () => {}, release: () => {}, element: null, returnFocus: null,
        // The line of an agent's turn acts while it waits, so Stop is there (the action has not
        // started yet); a notebook waits in its own cell, and is answered here.
        releaseLine: meta.origin === 'agent' ? activity.waitOnPerson(meta, definition.type) : () => {},
        // The chat bar's own calls come through its chat; a notebook is its own; any other through a connector connection.
        surface: meta.origin === 'host' ? 'notebook' : meta.connection?.kind === 'chat' ? 'chat' : 'connection',
      };
      card.element = cardElement(card);
      // Waiting first, so whoever hears the person is asked can read the card's question (`questionFor`).
      pending.push(card);
      // Whoever waits on the call hears the person is asked (the chat says so, the relay tells the agent).
      asking();
      cardsBox.appendChild(card.element);
      render();
      // A keyboard user is brought to the question (the first one, while it waits); the focus comes back after.
      if (pending.length === 1 && !typingElsewhere()) {
        card.returnFocus = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
        card.element.focus({ preventScroll: true });
      }
      // The agent gave up waiting (its call stopped) or the person stopped it: the question goes.
      card.removeAbort = onAbort(signal, () => refuse(card, abortReason(signal)));
    }));
  }

  function refuseAll(sentence, code) {
    for (const card of [...pending]) refuse(card, new ActionRefused(sentence, { code, type: card.definition.type }));
  }

  // -------------------------------------------------------- What is sent

  /** The notice shown: `{datasetId, element, release}`, or null. */
  let notice = null;

  function closeNotice() {
    if (notice === null) return;
    const hadFocus = notice.element.contains(doc.activeElement);
    notice.release();
    notice.element.remove();
    notice = null;
    root.hidden = activity.lines().length === 0 && pending.length === 0;
    // The focus was in it (Got it): it goes to the next thing of the presence rather than the page's start.
    if (hadFocus) (pending[0]?.element ?? [...root.querySelectorAll('button')].find(button => button.offsetParent !== null))?.focus({ preventScroll: true });
  }

  /**
   * A switch for the dataset `id` of names and summaries only (the notice's,
   * the settings'). Used in the settings, it answers the notice too.
   */
  function summariesSwitch(id, signal, { className = '', answersNotice = true } = {}) {
    const label = doc.createElement('label');
    label.className = `checkbox-inline ${className}`.trim();
    const box = doc.createElement('input');
    box.type = 'checkbox';
    box.className = 'agent-summaries-only';
    box.dataset.focusKey = 'summaries';
    box.checked = dataStore.get(id).summariesOnly;
    box.addEventListener('change', () => {
      dataStore.setSummariesOnly(id, box.checked);
      if (answersNotice) dataStore.markNoticed(id);
    }, { signal });
    label.append(box, doc.createTextNode(` ${SUMMARIES_ONLY_LABEL}`));
    return { label, box };
  }

  /**
   * Say once per dataset what agents read is sent to their provider: the
   * first time an agent acts on it (not answered yet in this browser).
   */
  function showNotice(scope) {
    const id = scope.dataset?.id ?? null;
    if (scope.dataset === null || dataStore.get(id).noticed || notice?.datasetId === id) return;
    closeNotice();
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, controller.signal]);
    const element = doc.createElement('div');
    element.className = 'agent-notice';
    element.setAttribute('role', 'group');
    const titleId = createDomId('agent-notice-title');
    element.setAttribute('aria-labelledby', titleId);
    const title = doc.createElement('p');
    title.className = 'agent-notice-title';
    title.id = titleId;
    title.textContent = 'What agents read here goes to their AI provider';
    const text = doc.createElement('p');
    text.className = 'agent-notice-text';
    text.textContent = 'That is names, counts and summaries, and, when an agent asks, values of cells and pictures of the plot. '
      + 'The dataset\'s files stay in this browser. Names and summaries only keeps values, extremes and pictures out; it is not anonymisation '
      + '(Permissions… changes it later).';
    const actionsRow = doc.createElement('div');
    actionsRow.className = 'agent-notice-actions';
    const { label } = summariesSwitch(id, signal, { className: 'agent-notice-switch', answersNotice: false });
    const done = doc.createElement('button');
    done.type = 'button';
    done.className = 'btn btn-compact btn-primary agent-notice-done';
    done.textContent = 'Got it';
    done.addEventListener('click', () => {
      dataStore.markNoticed(id);
      closeNotice();
    }, { signal });
    actionsRow.append(label, done);
    element.append(title, text, actionsRow);
    notice = { datasetId: id, element, release: () => owner.abort() };
    noticeBox.appendChild(element);
    root.hidden = false;
    announcer.textContent = `${title.textContent}. ${text.textContent}`;
  }

  // ----------------------------------------------------------- Settings

  const settingsDialog = wireAppDialog(dialog.dialog);

  /**
   * The settings dialog's body: the mode, each kind, what was allowed for a
   * chat or connection, the dataset's switch. Drawn again on every change;
   * the control that had the focus has it again (`data-focus-key`).
   */
  function drawPermissions() {
    if (destroyed) return;
    const focusKey = dialog.body.contains(doc.activeElement) ? doc.activeElement.dataset?.focusKey ?? null : null;
    const settings = permissions.get();
    const mode = modeOf(settings);
    const modes = doc.createElement('div');
    modes.className = 'agent-permission-modes';
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', 'Mode');
    for (const [id, preset] of Object.entries(PERMISSION_MODES)) {
      const label = doc.createElement('label');
      label.className = 'checkbox-inline';
      const radio = doc.createElement('input');
      radio.type = 'radio';
      radio.name = 'agent-permission-mode';
      radio.value = id;
      radio.dataset.focusKey = `mode:${id}`;
      radio.checked = mode === id;
      radio.addEventListener('change', () => permissions.set({ mode: id }), { signal });
      label.append(radio, doc.createTextNode(` ${preset.label}`));
      modes.appendChild(label);
    }
    const kinds = doc.createElement('dl');
    kinds.className = 'agent-permission-kinds';
    for (const kind of PERMISSION_KINDS) {
      const term = doc.createElement('dt');
      const id = createDomId(`agent-permission-${kind}`);
      const label = doc.createElement('label');
      label.htmlFor = id;
      label.textContent = KIND_LABELS[kind];
      term.appendChild(label);
      const value = doc.createElement('dd');
      const select = doc.createElement('select');
      select.className = 'obs-select';
      select.id = id;
      select.dataset.kind = kind;
      select.dataset.focusKey = `kind:${kind}`;
      for (const choice of PERMISSION_CHOICES) select.appendChild(new Option(choice[0].toUpperCase() + choice.slice(1), choice));
      select.value = settings.kinds[kind];
      select.addEventListener('change', () => permissions.set({ kinds: { [kind]: select.value } }), { signal });
      value.appendChild(select);
      kinds.append(term, value);
    }
    const status = doc.createElement('p');
    status.className = 'status-line';
    status.dataset.tone = 'muted';
    status.textContent = mode === 'custom'
      ? 'Custom settings. Reads need no permission; kept in this browser.'
      : 'Reads need no permission. Kept in this browser.';
    const granted = doc.createElement('div');
    granted.className = 'agent-permission-grants';
    const grantedText = doc.createElement('span');
    grantedText.textContent = grants.size === 0
      ? 'Nothing allowed for one chat or connection.'
      : `${formatCountOf(grants.size, 'kind')} allowed for a chat or connection until this page closes.`;
    const forget = doc.createElement('button');
    forget.type = 'button';
    forget.className = 'btn btn-compact';
    forget.textContent = 'Forget';
    forget.dataset.focusKey = 'forget';
    forget.disabled = grants.size === 0;
    forget.addEventListener('click', () => {
      grants.clear();
      drawPermissions();
      permissionsChanged();
    }, { signal });
    granted.append(grantedText, forget);
    dialog.body.replaceChildren(modes, kinds, granted, datasetBlock(), status);
    if (focusKey !== null) {
      const again = [...dialog.body.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey && !element.disabled);
      (again ?? dialog.body.querySelector('[data-focus-key="mode:ask"]'))?.focus({ preventScroll: true });
    }
  }

  /** The dataset shown: its switch of names and summaries only (kept for it in this browser). */
  function datasetBlock() {
    const block = doc.createElement('div');
    block.className = 'agent-permission-data';
    const scope = dataScopeNow({ store: dataStore, history: history.current });
    if (scope.dataset === null) {
      const none = doc.createElement('p');
      none.className = 'field-help';
      none.textContent = `${SUMMARIES_ONLY_LABEL}: a setting of each dataset, offered once one is open.`;
      block.appendChild(none);
      return block;
    }
    const id = scope.dataset.id;
    const { label } = summariesSwitch(id, signal);
    const help = doc.createElement('p');
    help.className = 'field-help';
    const name = scope.dataset.name ?? 'this dataset';
    help.textContent = `${SUMMARIES_ONLY_CAVEAT} For ${name}, `
      + (dataStore.pageOnly(id) ? 'kept for this page (the dataset has no name to keep it by).' : 'kept for it in this browser.');
    block.append(label, help);
    return block;
  }

  function openPermissions(opener = null) {
    drawPermissions();
    settingsDialog.open(opener);
  }

  /** The permission lines placed in the page (the chat settings, the Agents panel): summary → its Change… button. */
  const permissionLines = new Map();
  function drawPermissionLines() {
    const text = permissionsLine(permissions.get());
    const title = `Agent permissions: ${permissionsSummary(permissions.get())}`;
    for (const summary of permissionLines.keys()) {
      if (summary.textContent !== text) summary.textContent = text;
      summary.title = title;
    }
  }

  const unsubscribePermissions = permissions.subscribe(() => {
    permissionsChanged();
    drawPermissionLines();
    if (dialog.dialog.open) drawPermissions();
  });

  actions.setConfirmer(confirm);
  const unsubscribeDispatch = actions.subscribe(event => {
    // An agent acting on a dataset for the first time in this browser: what is sent, said once.
    if (event.kind === 'start' && event.meta?.origin === 'agent') showNotice(dataScopeNow({ store: dataStore, history: history.current }));
    if (activity.onDispatch(event)) render();
  });
  // The switch changed (here, in the notice, in another place) or another dataset is shown.
  const unsubscribeData = subscribeDataScope(() => {
    const shown = dataScopeNow({ store: dataStore, history: history.current }).dataset;
    if (notice !== null && (shown === null || shown.id !== notice.datasetId || dataStore.get(notice.datasetId).noticed)) closeNotice();
    else if (notice !== null) {
      const box = notice.element.querySelector('.agent-summaries-only');
      if (box !== null) box.checked = dataStore.get(notice.datasetId).summariesOnly;
    }
    if (dialog.dialog.open) drawPermissions();
  }, { store: dataStore, subscribeHistory: history.subscribe });
  /**
   * A saved state loaded over the history shown (a session file, a saved
   * state, the autosave): the questions asked about the state it replaced
   * are moot, as when another dataset is shown.
   */
  let unwatchShown = () => {};
  function watchShown() {
    unwatchShown();
    unwatchShown = shownHistory?.subscribe?.(event => {
      // Pausing or resuming, or another tracker in use: the lines say ⏸ while paused.
      if (event.kind === 'recording' || event.kind === 'tracker') render();
      if (event.kind !== 'loaded') return;
      refuseAll('A saved state was loaded before the person answered; nothing was done.', 'state-loaded');
      activity.clearFinished();
      render();
    }) ?? (() => {});
  }
  watchShown();
  const unsubscribeHistory = history.subscribe(() => {
    const next = history.current();
    if (next === shownHistory) return;
    shownHistory = next;
    watchShown();
    refuseAll('Another dataset was shown before the person answered; nothing was done.', 'dataset-changed');
    activity.clearFinished();
    render();
  });
  win?.addEventListener?.('pagehide', () => {
    refuseAll('The Cellucid tab was closed before the person answered; nothing was done.', 'closed');
  }, { signal });
  render();

  return Object.freeze({
    /** The dispatcher's confirmer (installed with `setConfirmer`): resolves whether the person allowed it. */
    confirm,
    /**
     * Take a turn of an agent's own surface (the chat bar) as acting until
     * the returned function is called (`activity.js` `attach`).
     */
    attach(attachment) {
      const detach = activity.attach(attachment);
      render();
      return () => {
        detach();
        render();
      };
    },
    /** The permission settings (`permissions.js`): `get`, `set`, `subscribe`. */
    permissions,
    /**
     * What the settings make of a kind of action for one connection, with
     * what the person allowed for it on this page (`permissions.js`
     * `permissionFor`): what its tool list says.
     * @param {{kind: string, connection: {id: string, kind: string}}} question
     */
    permissionFor: question => permissionFor(question, permissions.get(), grants),
    /** Open the permission settings. */
    openPermissions,
    /**
     * Show the settings as one line where the page places it (the chat
     * settings, the Agents panel): the mode in words, and Change… opening
     * the settings. Returns the unbind.
     * @param {{summary: HTMLElement, change: HTMLButtonElement}} line
     */
    bindPermissionsLine({ summary, change }) {
      if (!(summary instanceof HTMLElement) || !(change instanceof HTMLButtonElement)) {
        throw new TypeError('A permissions line needs its summary and its Change… button.');
      }
      const lineController = new AbortController();
      change.addEventListener('click', () => openPermissions(change), { signal: lineController.signal });
      permissionLines.set(summary, change);
      drawPermissionLines();
      return () => {
        lineController.abort();
        permissionLines.delete(summary);
      };
    },
    /**
     * Say what agents send of the dataset shown, when not said yet (the chat
     * bar, before its first message goes out; an agent acting says it too).
     */
    showNotice: () => showNotice(dataScopeNow({ store: dataStore, history: history.current })),
    /** Forget what was allowed for a chat or connection (the settings dialog). */
    forgetGrants() {
      grants.clear();
      drawPermissions();
      permissionsChanged();
    },
    /**
     * Hear when what a connection's tool list says may have changed: the
     * settings changed, or something was allowed for (or forgotten of) a
     * chat or connection. Returns the unsubscribe.
     * @param {() => void} listener
     */
    onPermissionsChanged(listener) {
      permissionListeners.add(listener);
      return () => permissionListeners.delete(listener);
    },
    /**
     * The question the person is asked about the agent call whose signal is
     * `signal`, in the card's words (who asks, what, why), or null when
     * none waits: what an agent's own app asks with too (`cellucid mcp`'s
     * elicitation).
     * @param {AbortSignal} signal
     */
    questionFor(signal) {
      const card = cardOf(signal);
      if (card === null) return null;
      const text = confirmTextOf(card);
      return `${text.what} ${text.why}`.trim();
    },
    /**
     * Answer, from the agent's own app, the card asking about the call whose
     * signal is `signal`: Allow once (`allowed`) or Deny. The person answered
     * there (an MCP elicitation the app showed them, never the model); the
     * card goes as if they clicked it. Returns whether a card was waiting.
     * @param {AbortSignal} signal
     * @param {boolean} allowed
     */
    answer(signal, allowed) {
      const card = cardOf(signal);
      if (card === null) return false;
      answerCard(card, allowed === true ? 'once' : 'deny');
      return true;
    },
    /** Draw again (a surface started or stopped showing its turns). */
    refresh: render,
    /** The questions waiting for the person (tests, the walk-through). */
    pendingCount: () => pending.length,
    destroy() {
      if (destroyed) return;
      refuseAll('Cellucid closed before the person answered; nothing was done.', 'closed');
      destroyed = true;
      actions.setConfirmer(null);
      unsubscribePermissions();
      permissionListeners.clear();
      settingsDialog.destroy();
      unsubscribeDispatch();
      unsubscribeData();
      unsubscribeHistory();
      unwatchShown();
      controller.abort();
      root.replaceChildren();
      root.hidden = true;
    },
  });
}
