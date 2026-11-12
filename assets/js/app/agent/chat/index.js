/**
 * @fileoverview The chat bar: talk to an agent (Claude, or OpenAI's models
 * behind ChatGPT) with your own API key, inside the Cellucid tab, about the
 * dataset shown; the agent reads it and acts in it through the same tools
 * and the same history as everything else.
 *
 * - **One system.** The tools are the catalog's MCP tools
 *   (`bridge/mcp-tools.js`), a call is run as every agent call is
 *   (`bridge/tool-call.js`), the instructions are `instructionsFor('chat')`.
 *   Each message the person sends is one turn (`turn-<id>`): every step the
 *   agent takes in answer carries it, the agent's name and the chat as its
 *   connection (`meta.connection`, kind `chat`, the conversation's id), so
 *   the State panel groups and labels them, Undo turn takes the turn back
 *   (`history-link.js` `undoAgentTurn`), and a permission granted "in this
 *   chat" holds for it.
 * - **Presence and permissions.** A turn is attached to the agent presence
 *   (`presence/`): while the chat is open it shows its own turns (Stop in
 *   the composer, Undo turn under each turn); collapsed, the activity line
 *   does. What the person's permissions ask about shows its card there, and
 *   the chat says it waits (the dispatcher's `asking` and `answered`). The
 *   model is told the permissions (and the person's own instructions) with
 *   the message after they change, so it plans by them; the system prompt
 *   and the tools stay the same all chat long (a model's reasoning is bound
 *   to the exact tools it was given, so no tool says a permission, unlike a
 *   connector's list, `mcp-tools.js`).
 * - **Kept with the history** (`history.setChat`, after every message), so
 *   the autosave and a session file carry the chat beside its steps. The
 *   chat bar belongs to the tab; a history belongs to a dataset: showing
 *   another dataset or tracker shows its latest chat (or a new one),
 *   restoring a session the session's. A turn running then stops and is
 *   kept where it began, unless its own agent opened that dataset
 *   (`dataset.open`): then it goes on there, and the conversation is kept
 *   with both histories (the one it left, up to there). Messages and steps link both ways
 *   (`history-link.js`): a reply's step shows in the history (Show), a turn
 *   in the history opens its message (Chat), and its badge names the model.
 * - **Providers, models, effort, keys** (`providers/`, `keys.js`): the
 *   person picks the provider, a model from the provider's own list, the
 *   effort the model takes (none: the model's default); a key is kept for
 *   this tab unless Remember is ticked.
 * - **Attach the selection** (`selection.js`): while cells are highlighted
 *   that the conversation does not know yet (not attached to an earlier
 *   message, not highlighted when its last turn ended), a chip above the
 *   message field ("Selection: 1,234 cells ×") attaches a reference to them
 *   (the page, its groups, the counts) to the next message; × leaves it out
 *   until the selection changes.
 * - **Clickable choices** (`ask.js`): a question the model asks with
 *   choices shows them as buttons above the message field; a click sends
 *   the choice as the person's message.
 * - **What is sent** (`../data-scope.js`): the model is told the dataset's
 *   switch with the person's message when it changes; the tool call refuses
 *   and leaves out what the switch keeps out.
 * - **For the person:** suggestions made from the dataset shown, Edit (a
 *   message back in the field), Try again, Copy an answer, Export the chat
 *   (Markdown), each turn's tokens and what left this browser (Sent), a
 *   token budget per chat (none unless set), their own instructions for
 *   agents, and `/` to open the chat from anywhere on the page.
 *
 * @module app/agent/chat
 */

import {
  appendMessage, closeInterrupted, conversationFrom, createConversation, latestConversation, sentOf, transcriptOf,
  unreadConversationNotice, usageOf,
} from './conversation.js';
import { runAgentTurn } from './agent-loop.js';
import { setControlAvailability } from '../../ui/core/control-availability.js';
import { createKeyStore } from './keys.js';
import { effortKey, readChatPreferences, writeChatPreferences } from './preferences.js';
import { createTranscriptView, sentText, tokensText, workingTextOf } from './transcript-view.js';
import { conversationMarkdown, turnNoteOf } from './export.js';
import { readSuggestionFacts, suggestionsFor } from './suggestions.js';
import { ASK_TOOL, pendingQuestion } from './ask.js';
import { createSelectionSource, sameSelection, selectionLabel, selectionTitle } from './selection.js';
import { dataScopeNow } from '../data-scope.js';
import { chatFoldsForFilm } from '../dock.js';
import { providersForPage } from '../providers/index.js';
import { EFFORT_LABELS } from '../providers/contract.js';
import { instructionsFor } from '../instructions.js';
import { mcpToolsOf, toolIndexOf } from '../bridge/mcp-tools.js';
import { settingsTold } from '../settings-told.js';
import { historySettings, offDomainsOf } from '../../history/history-settings.js';
import {
  historySeen, historySinceSentence, noteTurn, registerTurnLink, revealStep, turnSteps, turnsChanged, undoAgentTurn,
} from '../history-link.js';
import { catalogDocument } from '../../actions/catalog.js';
import { getCurrentHistory, subscribeCurrentHistory } from '../../history/current.js';
import { createOpaqueId } from '../../../utils/opaque-id.js';
import { downloadBlob, fileTimestamp } from '../../utils/download.js';
import { sayFailure } from '../../../utils/errors.js';
import { getNotificationCenter } from '../../notification-center.js';
import { pageVersion } from '../../utils/page-version.js';
import { ICONS, createIconButton } from '../../ui/components/controls.js';
import { cancel } from '../../../utils/abort.js';
import { formatCount } from '../../../utils/format-units.js';
import { provideShortcut } from '../../ui/onboarding/keyboard-shortcuts.js';
import { noteSeenAddressesIn } from '../../ui/modules/seen-addresses.js';
import { copyText } from '../../utils/clipboard.js';
import { realmHosts } from '../../../formats/io/hosts.js';

const REQUIRED = [
  'dock', 'toggle', 'toggleLabel', 'panel', 'status', 'newButton', 'exportButton', 'settingsButton', 'collapseButton',
  'settings', 'provider', 'keyRow', 'keyLabel', 'key', 'remember', 'forget', 'keyLink', 'model', 'effortRow', 'effort', 'cacheRow', 'cache',
  'permissionsSummary', 'permissionsChange', 'instructions', 'budget', 'settingsStatus', 'usage',
  'log', 'form', 'tray', 'input', 'send', 'stop',
];

/** The effort choice that leaves the model's own default. */
const MODEL_DEFAULT = '';

/**
 * @param {{
 *   dom: Record<string, HTMLElement>,
 *   actions: {dispatch: Function, catalog: object, subscribe: Function},
 *   presence: {attach: Function, refresh: Function, permissions: object, bindPermissionsLine: Function},
 *   providers?: ReadonlyArray<object>,
 *   keys?: ReturnType<typeof createKeyStore>,
 *   history?: {current: () => object|null, subscribe: (listener: () => void) => () => void},
 *   selection?: ReturnType<typeof createSelectionSource>,
 *   dataScope?: {now: () => {summariesOnly: boolean}},
 *   opensAsSide?: () => boolean,
 *   win?: Window,
 * }} options - `selection`: the person's highlighted cells (`selection.js`); `dataScope`: what
 *   agents may be sent of the dataset shown (`../data-scope.js`); `opensAsSide`: whether the
 *   open chat is the dock's side panel on this window (`../dock.js`), else the bar over the plot
 */
export function initAgentChat({
  dom, actions, presence,
  providers = providersForPage(),
  keys = createKeyStore(),
  history = { current: getCurrentHistory, subscribe: subscribeCurrentHistory },
  selection = createSelectionSource(null),
  dataScope = { now: () => dataScopeNow() },
  opensAsSide = () => true,
  win = globalThis.window,
}) {
  for (const name of REQUIRED) {
    if (!(dom?.[name] instanceof HTMLElement)) throw new TypeError(`The chat bar requires its ${name}.`);
  }
  const doc = dom.panel.ownerDocument;
  const controller = new AbortController();
  const { signal } = controller;
  const catalogDoc = catalogDocument(actions.catalog);
  const toolIndex = toolIndexOf(actions.catalog);
  // The same tools all chat long: a model's reasoning is bound to the exact
  // tools it was given (Anthropic refuses reasoning sent back with other
  // tools), and the prompt cache holds only while they stay. So no tool says
  // the person's permissions; the model is told them with the message after
  // they change (`contextFor`).
  // The chat's own question with choices (`ask.js`) after the catalog's tools.
  const tools = Object.freeze([...mcpToolsOf(catalogDoc), ASK_TOOL]);
  const system = instructionsFor('chat');
  const preferences = readChatPreferences();

  let providerId = providers.some(provider => provider.id === preferences.provider) ? preferences.provider : providers[0].id;
  const chosenModels = { ...preferences.models };
  const chosenEfforts = { ...preferences.efforts };
  let personInstructions = preferences.instructions;
  let budget = preferences.budget;
  let cacheLength = preferences.cache;
  /** providerId → {key, list, error, loading} */
  const modelLists = new Map();
  let conversation = createConversation();
  let bound = null;
  let lastUsage = null;
  /** The turn running: {turn, controller, status, streaming, detach, asking}. */
  let running = null;
  let open = preferences.open;
  /** A camera path plays (`setFilmPlaying`), and whether the person opened the chat during it. */
  let filmPlaying = false;
  let keptForFilm = false;
  /** The chat had the focus when it folded for the film: its message field gets it back. */
  let refocusAfterFilm = false;
  let settingsOpen = false;
  let watched = null;
  let unwatch = () => {};
  let destroyed = false;
  let countdown = null;
  let suggestions = suggestionsFor();
  let suggestionsKey = null;
  /** The selection the person left out (×), until it changes. */
  let leftOut = null;
  /**
   * The selection each conversation already knows: the one attached to its
   * last message, or the one highlighted when its last turn ended (what its
   * agent highlighted among it). The chip offers, and a message carries, only
   * another: an unchanged selection was sent again with every message, and an
   * agent's own highlight came back to it as "the person attached their
   * selection".
   */
  const knownSelections = new WeakMap();
  /** The turns of a conversation (its person's messages'): its agent's own steps are of these. */
  const ownTurnsOf = chat => new Set(chat.messages.filter(message => message.role === 'user').map(message => message.turn));
  /** The tracker the conversation's turns act in, when it is the one shown. */
  function boundTree() {
    return bound !== null && bound.history === history.current() && bound.history.active?.id === bound.trackerId ? bound.history.active : null;
  }

  const view = createTranscriptView({
    log: dom.log,
    onUndoTurn: turn => void undoTurn(turn),
    onSuggestion: text => {
      dom.input.value = text;
      void send();
    },
    onRevealStep: stepId => revealStep(stepId),
    onEdit: text => {
      dom.input.value = text;
      resizeInput();
      dom.input.focus({ preventScroll: true });
    },
    onRetry: turn => {
      // Only a turn of this page's own (a received one offers no Try again: `offersRetry`).
      if (conversation.received.includes(turn)) return;
      const asked = conversation.messages.find(message => message.role === 'user' && message.turn === turn);
      if (asked === undefined || running !== null) return;
      dom.input.value = asked.text;
      void send();
    },
    onCopy: (text, button) => void copyText(text, { what: 'the answer', button, category: 'agent' }),
  });

  // ----------------------------------------------------- Above the field

  /** What sits above the message field: the question's choices, the selection's chip. */
  const tray = createTray();

  function createTray() {
    const choices = doc.createElement('div');
    choices.className = 'agent-chat-choices';
    choices.setAttribute('role', 'group');
    choices.hidden = true;
    const chip = doc.createElement('span');
    chip.className = 'agent-chat-chip';
    chip.hidden = true;
    const chipText = doc.createElement('span');
    chipText.className = 'agent-chat-chip-text';
    // Named with the selection it leaves out once one is attached (`renderTray`).
    const remove = createIconButton({ label: 'Leave out the selection', icon: ICONS.close, className: 'agent-chat-chip-remove' });
    remove.addEventListener('click', () => {
      leftOut = selection.current();
      renderTray();
      dom.input.focus({ preventScroll: true });
    }, { signal });
    chip.append(chipText, remove);
    const said = doc.createElement('p');
    said.className = 'sr-only';
    said.setAttribute('role', 'status');
    dom.tray.replaceChildren(choices, chip, said);
    return { choices, chip, chipText, remove, said, shownQuestion: null, choicesShown: new AbortController() };
  }

  /** The selection attached to the next message, or null (none, or left out). */
  function attachedSelection() {
    const now = selection.current();
    if (now === null || sameSelection(now, leftOut)) return null;
    return sameSelection(now, knownSelections.get(conversation) ?? null) ? null : now;
  }

  function renderTray() {
    if (destroyed) return;
    const attached = attachedSelection();
    tray.chip.hidden = attached === null;
    if (attached !== null) {
      const words = selectionLabel(attached);
      if (tray.chipText.textContent !== words) tray.chipText.textContent = words;
      const title = `Attached to your message: ${selectionTitle(attached)}`;
      tray.chip.title = title;
      tray.remove.setAttribute('aria-label', `Leave out the selection (${selectionTitle(attached)})`);
      tray.remove.title = 'Leave out the selection';
    }
    const question = running === null ? pendingQuestion(conversation) : null;
    const key = question === null ? null : `${conversation.id}:${question.id}`;
    if (key !== tray.shownQuestion) {
      tray.shownQuestion = key;
      // The buttons' listeners go with them.
      tray.choicesShown.abort();
      tray.choicesShown = new AbortController();
      const owner = AbortSignal.any([signal, tray.choicesShown.signal]);
      tray.choices.replaceChildren(...(question?.choices ?? []).map(choice => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-compact agent-chat-choice';
        button.textContent = choice;
        button.title = `Answer: ${choice}`;
        button.addEventListener('click', () => {
          // The choice is the answer; what the person was typing stays in the field, which takes the focus.
          dom.input.focus({ preventScroll: true });
          void send(choice);
        }, { signal: owner });
        return button;
      }));
      tray.choices.hidden = question === null;
      if (question !== null) {
        tray.choices.setAttribute('aria-label', question.question);
        tray.said.textContent = `Choices: ${question.choices.join(', ')}. They are above the message field; you can also type an answer.`;
      }
    }
    dom.tray.hidden = tray.chip.hidden && tray.choices.hidden;
  }

  function provider() {
    return providers.find(candidate => candidate.id === providerId) ?? providers[0];
  }

  function keyOf(chosen = provider()) {
    return chosen.needsKey ? keys.get(chosen.id)?.key ?? null : null;
  }

  function ready(chosen = provider()) {
    return !chosen.needsKey || keyOf(chosen) !== null;
  }

  // --------------------------------------------------------------- Models

  function modelEntry(chosen = provider()) {
    const key = keyOf(chosen);
    let entry = modelLists.get(chosen.id);
    if (entry === undefined || entry.key !== key) {
      entry = { key, list: null, error: null, loading: null };
      modelLists.set(chosen.id, entry);
    }
    return entry;
  }

  function loadModels(chosen = provider()) {
    const entry = modelEntry(chosen);
    if (!ready(chosen) || entry.list !== null || entry.loading !== null) return entry.loading ?? Promise.resolve();
    entry.loading = chosen.models({ key: entry.key, signal })
      .then(list => { entry.list = list; entry.error = null; })
      .catch(error => { if (!signal.aborted) entry.error = error; })
      .finally(() => {
        entry.loading = null;
        renderSettings();
        renderHeader();
      });
    renderSettings();
    return entry.loading;
  }

  /** The model to call: the person's choice, else the provider's default, else the newest listed. */
  function chosenModel(chosen = provider()) {
    const list = modelEntry(chosen).list;
    const wanted = chosenModels[chosen.id] ?? chosen.defaultModel;
    if (list === null || list.length === 0) {
      return { id: wanted, label: wanted, contextTokens: null, outputTokens: null, images: null, efforts: null };
    }
    return list.find(model => model.id === wanted) ?? list.find(model => model.id === chosen.defaultModel) ?? list[0];
  }

  /** The effort to send for the model, or null for the model's own default. */
  function chosenEffort(chosen = provider(), model = chosenModel(chosen)) {
    const effort = chosenEfforts[effortKey(chosen.id, model.id)] ?? null;
    return effort !== null && model.efforts?.includes(effort) ? effort : null;
  }

  // -------------------------------------------------------------- Drawing

  function setStatus(text, tone = 'muted') {
    if (dom.status.textContent !== text) dom.status.textContent = text;
    dom.status.dataset.tone = tone;
    dom.status.title = text;
  }

  function renderHeader() {
    const chosen = provider();
    const label = `Ask ${chosen.agent}`;
    if (dom.toggleLabel.textContent !== label) dom.toggleLabel.textContent = label;
    dom.toggle.dataset.busy = String(running !== null);
    dom.toggle.setAttribute('aria-expanded', String(shownOpen()));
    dom.dock.dataset.chatOpen = String(shownOpen());
    if (!ready(chosen)) {
      // Short enough for a phone's header; the settings (open by themselves) name the provider and its key.
      setStatus('Add an API key to start.', 'info');
    } else if (running !== null && running.status !== null) {
      setStatus(workingTextOf(running.status), running.status.phase === 'waiting' ? 'warning' : 'info');
    } else if (!realmHosts.online()) {
      setStatus('This browser is offline; a message waits until it is back.', 'warning');
    } else {
      const model = chosenModel(chosen);
      const effort = chosenEffort(chosen, model);
      const name = model.label.startsWith(chosen.agent) ? model.label : `${chosen.agent} · ${model.label}`;
      setStatus(effort === null ? name : `${name} · ${EFFORT_LABELS[effort].toLowerCase()} effort`);
    }
    dom.send.hidden = running !== null;
    dom.stop.hidden = running === null;
    dom.newButton.disabled = running !== null || conversation.messages.length === 0;
    dom.exportButton.disabled = conversation.messages.length === 0;
  }

  function renderSettings() {
    const chosen = provider();
    if (dom.provider.options.length !== providers.length) {
      dom.provider.replaceChildren(...providers.map(candidate => new Option(candidate.label, candidate.id)));
    }
    dom.provider.value = chosen.id;
    const turnRunning = running === null ? null : 'a turn is running; stop it or wait for it to end to change this';
    setControlAvailability(dom.provider, turnRunning);
    dom.keyRow.hidden = !chosen.needsKey;
    const kept = chosen.needsKey ? keys.get(chosen.id) : null;
    if (chosen.needsKey) {
      dom.keyLabel.textContent = chosen.keyLabel;
      dom.key.placeholder = kept === null ? chosen.keyPlaceholder : 'Kept · type a new key to replace it';
      dom.keyLink.href = chosen.keyUrl;
      dom.remember.checked = kept?.remembered === true;
      setControlAvailability(dom.remember, kept === null ? 'no key is kept yet; enter one first' : null);
      dom.forget.disabled = kept === null;
    }
    const entry = modelEntry(chosen);
    const current = chosenModel(chosen);
    const listed = entry.list ?? [current];
    dom.model.replaceChildren(...listed.map(model => new Option(model.label === model.id ? model.id : `${model.label} (${model.id})`, model.id)));
    dom.model.value = current.id;
    setControlAvailability(dom.model, turnRunning ?? (ready(chosen) ? null : `enter your ${chosen.keyLabel} first to list its models`));
    const efforts = current.efforts ?? [];
    dom.effortRow.hidden = efforts.length === 0;
    dom.effort.replaceChildren(new Option('Model\'s default', MODEL_DEFAULT), ...efforts.map(effort => new Option(EFFORT_LABELS[effort], effort)));
    dom.effort.value = chosenEffort(chosen, current) ?? MODEL_DEFAULT;
    setControlAvailability(dom.effort, turnRunning);
    if (doc.activeElement !== dom.instructions) dom.instructions.value = personInstructions;
    if (doc.activeElement !== dom.budget) dom.budget.value = budget === null ? '' : String(budget);
    // Only a provider that offers a choice of cache length shows it (Claude's; OpenAI caches by itself).
    dom.cacheRow.hidden = !(chosen.cacheLengths?.length > 1);
    dom.cache.value = cacheLength;
    setControlAvailability(dom.cache, turnRunning);
    let text;
    let tone = 'muted';
    if (chosen.needsKey && kept === null) {
      text = `${chosen.agent} needs your ${chosen.keyLabel}; it stays in this browser.`;
      tone = 'info';
    } else if (entry.loading !== null) {
      text = 'Listing the models of this key…';
    } else if (entry.error !== null) {
      text = entry.error.message;
      tone = entry.error.kind === 'auth' ? 'danger' : 'warning';
    } else if (chosen.needsKey) {
      text = kept.remembered ? 'Key remembered on this browser until you forget it.' : 'Key kept for this tab only.';
    } else {
      text = `${chosen.label} needs no key.`;
    }
    dom.settingsStatus.textContent = text;
    dom.settingsStatus.dataset.tone = tone;
    const used = usageOf(conversation);
    const spent = used.input + used.output;
    const left = budget === null ? '' : ` Budget ${formatCount(budget)} tokens: ${spent >= budget ? 'spent' : `${formatCount(budget - spent)} left`}.`;
    dom.usage.textContent = `${used.calls === 0 ? 'This chat has used no tokens yet.' : `This chat: ${tokensText(used)}.`}${left}`;
  }

  /** The steps of each turn (counted again only when the history changed, not every frame of a reply). */
  let stepsCache = null;
  function stepsByTurn() {
    stepsCache ??= turnSteps(bound?.history === history.current() ? bound.history.active : null);
    return stepsCache;
  }

  let frame = null;
  function renderLog() {
    if (destroyed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (destroyed) return;
      drawLog();
    });
  }

  /** The log as it is, now and not on the next frame: a turn's end shows its last reply with Send. */
  function renderLogNow() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!destroyed) drawLog();
  }

  function drawLog() {
    // The status line follows the turn in the same frame as the log (a streamed piece changes both at most once a frame).
    renderHeader();
    view.render(conversation, {
      streaming: running?.streaming ?? null,
      status: running?.status ?? null,
      running: running?.turn ?? null,
      turnSteps: stepsByTurn(),
      toolIndex,
      sentOf: turn => sentText(sentOf(conversation, turn), providerLabelOfTurn(turn), { received: conversation.received.includes(turn) }),
      usageOf: turn => tokensText(usageOf(conversation, turn)),
      suggestions,
    });
  }

  function providerLabelOfTurn(turn) {
    const reply = conversation.messages.find(message => message.role === 'assistant' && message.turn === turn);
    const id = reply?.provider ?? provider().id;
    return providers.find(candidate => candidate.id === id)?.label.replace(/^.*\((.+)\)$/, '$1') ?? id;
  }

  /**
   * Whether the open chat is folded to its button for a playing camera path
   * (`chatFoldsForFilm`): the person's choice to keep it open is untouched,
   * and it comes back when the path stops.
   */
  function foldedForFilm() {
    return open && chatFoldsForFilm({
      playing: filmPlaying,
      sidePanel: opensAsSide(),
      drafting: dom.input.value.trim() !== '',
      asking: running === null && pendingQuestion(conversation) !== null,
      kept: keptForFilm,
    });
  }

  /** Whether the chat is shown open: open, and not folded for a film. */
  function shownOpen() {
    return open && !foldedForFilm();
  }

  function render() {
    if (destroyed) return;
    stepsCache = null;
    const folding = foldedForFilm();
    if (folding && dom.panel.contains(doc.activeElement)) refocusAfterFilm = true;
    renderHeader();
    renderSettings();
    dom.panel.hidden = !open || folding;
    if (!folding && refocusAfterFilm) {
      refocusAfterFilm = false;
      // Back to the message field, unless the person has put the focus elsewhere since.
      const idle = doc.activeElement === null || doc.activeElement === doc.body;
      if (open && idle) dom.input.focus({ preventScroll: true });
    }
    dom.settings.hidden = !settingsOpen;
    dom.settingsButton.setAttribute('aria-expanded', String(settingsOpen));
    renderLog();
    renderTray();
    presence.refresh();
  }

  /** The suggestions of the empty chat, made from the dataset shown (`suggestions.js`). */
  function refreshSuggestions() {
    const tree = watched?.active ?? null;
    const key = tree === null ? null : `${watched.dataset?.id ?? ''}:${tree.id}`;
    if (key === suggestionsKey) return;
    suggestionsKey = key;
    // No dataset's history: no dataset is open.
    if (watched === null) {
      suggestions = suggestionsFor({ dataset: false });
      renderLog();
      return;
    }
    const steps = tree === null ? 0 : tree.steps.size - 1;
    void readSuggestionFacts(actions, steps).then(facts => {
      if (destroyed || suggestionsKey !== key) return;
      suggestions = suggestionsFor(facts);
      renderLog();
    });
  }

  function setOpen(next, { focus = true } = {}) {
    // Opened by the person while a path plays: it stays open for this play.
    if (next && filmPlaying) keptForFilm = true;
    open = next;
    writeChatPreferences({ open });
    render();
    if (open) {
      refreshSuggestions();
      // Opening the chat says, once per dataset, what agents send, before anything goes out.
      presence.showNotice?.();
    }
    if (open && focus) {
      if (!ready()) openSettings();
      else dom.input.focus({ preventScroll: true });
    } else if (!open && focus) {
      dom.toggle.focus({ preventScroll: true });
    }
  }

  function openSettings() {
    settingsOpen = true;
    render();
    const chosen = provider();
    if (chosen.needsKey && keys.get(chosen.id) === null) dom.key.focus({ preventScroll: true });
    else dom.provider.focus({ preventScroll: true });
  }

  function exportChat() {
    if (conversation.messages.length === 0) return;
    const version = pageVersion(doc);
    const text = conversationMarkdown(conversation, { dataset: watched?.dataset?.name ?? null, version, toolIndex });
    downloadBlob(new Blob([text], { type: 'text/markdown' }), `cellucid-chat-${fileTimestamp()}.md`);
  }

  // ---------------------------------------------------------------- Saving

  /** Keep `which` conversation with the tracker `home` (nothing before its first message). */
  function saveConversation(home, which) {
    if (home === null || which.messages.length === 0 || home.history.destroyed) return;
    try {
      home.history.setChat(home.trackerId, which.id, transcriptOf(which));
    } catch (error) {
      console.error('[agent chat] the conversation could not be kept with the history', error);
    }
  }

  /** Keep the conversation shown with the tracker shown. */
  function save() {
    saveConversation(bound, conversation);
  }

  function show(next) {
    conversation = next;
    lastUsage = null;
    view.reset();
    render();
    turnsChanged();
  }

  /** The tracker in use changed (another dataset, another tracker, a loaded session). */
  function followTracker({ loaded = false } = {}) {
    const tree = watched?.active ?? null;
    if (tree === null) return;
    // What the empty chat offers is made when the chat is open (`setOpen` makes it on opening).
    if (open) refreshSuggestions();
    if (!loaded && bound !== null && bound.history === watched && bound.trackerId === tree.id) return;
    const previous = bound;
    bound = { history: watched, trackerId: tree.id };
    if (running !== null && (loaded ? running.datasetActions > 0 : running.openedDataset || running.historyActions > 0)) {
      // The agent of this turn opened another dataset, or one of its history
      // actions shows another tracker (verifying a branch replays it on a
      // tracker of its own and comes back; starting, using or replaying one
      // shows that one), or a saved state was loaded by its own opening of
      // one (`history.saved.open`, under way): the chat belongs to the tab,
      // so the turn goes on where the agent now acts, and the conversation
      // is kept with that tracker too (the one it left keeps it up to here).
      running.home = bound;
      save();
      render();
      return;
    }
    // Anything else shown under a running turn (the person opened another
    // dataset or tracker, a session was loaded) stops it; it is kept where it began.
    if (running !== null) {
      stopTurn(loaded ? 'A saved state was loaded, so the turn stopped.' : 'Another dataset or tracker was shown, so the turn stopped.');
    }
    const keptChats = watched.chatsOf(tree.id);
    const saved = latestConversation(keptChats);
    // A kept conversation this version cannot show is said, never dropped silently (F155).
    const tellUnread = (error = undefined) => {
      const notice = unreadConversationNotice(keptChats, error);
      if (notice !== null) getNotificationCenter().warning(notice.message, { category: 'session', details: notice.details });
    };
    if (saved === null) tellUnread();
    if (saved !== null) {
      try {
        const kept = conversationFrom(saved);
        // Kept mid-turn (the page closed while a call ran or waited): each call left is answered with what became of it.
        if (closeInterrupted(kept, {
          stepsOfTurn: turn => [...tree.steps.values()].filter(step => step.by.turn === turn && step.type !== null),
          toolOf: name => toolIndex.get(name),
        }) > 0) saveConversation({ history: watched, trackerId: tree.id }, kept);
        show(kept);
        return;
      } catch (error) {
        console.error('[agent chat] a saved conversation could not be shown', error);
        tellUnread(error);
      }
    }
    // A conversation begun with nothing to keep it with goes on here.
    if (previous === null && conversation.messages.length > 0) {
      save();
      render();
      return;
    }
    // The agent's last turn was in the conversation left behind: the first message of this new
    // one says which history is shown now and what is in effect there (F270).
    const fresh = createConversation();
    fresh.seen = conversation.seen;
    show(fresh);
  }

  function watchHistory() {
    const next = history.current();
    if (next === watched) return;
    unwatch();
    watched = next;
    suggestionsKey = null;
    unwatch = watched === null ? () => {} : watched.subscribe(event => {
      if (event.kind === 'tracker') followTracker();
      else if (event.kind === 'loaded') followTracker({ loaded: true });
      // A step made, a move, and an edit (a delete, a turn undone, a restore): the turns' steps change.
      else if (event.kind === 'step' || event.kind === 'moved' || event.kind === 'edited') {
        stepsCache = null;
        renderLog();
      }
    });
    followTracker();
    render();
  }

  // ------------------------------------------------------------------ Turns

  function stopTurn(reason = 'Stopped by the person.') {
    if (running === null) return;
    cancel(running.controller, 'user', reason);
  }

  /** The dataset's switch as the model is told it. */
  /**
   * What Cellucid tells the model with this message: the person's
   * permissions, the dataset's switch, what their History settings leave
   * out of the history (camera moves; panels) and their own instructions, when any
   * changed since the last message that told them (the model plans by them).
   */
  function contextFor() {
    const told = [settingsTold({
      permissions: presence.permissions.get(), summariesOnly: dataScope.now().summariesOnly, offDomains: offDomainsOf(historySettings()),
    })];
    const own = personInstructions.trim();
    if (own !== '') told.push(`The person's own instructions for agents: ${own}`);
    const now = told.join(' ');
    const last = conversation.messages.findLast(message => message.role === 'user' && message.context)?.context ?? null;
    return now === last ? null : now;
  }

  /**
   * Send the message field's words, or `given` (a choice clicked: the field
   * keeps what the person was typing).
   * @param {string|null} [given]
   */
  async function send(given = null) {
    const text = (given ?? dom.input.value).trim();
    if (text === '' || running !== null || destroyed) return;
    // What agents send of this dataset is said before the first message goes out (once per dataset).
    presence.showNotice?.();
    const chosen = provider();
    if (!ready(chosen)) {
      openSettings();
      return;
    }
    const turn = `turn-${createOpaqueId()}`;
    if (given === null) {
      dom.input.value = '';
      resizeInput();
      // What the person typed (not a choice the agent offered): the addresses in it are
      // ones they have seen, which the agent may open without asking (F121).
      noteSeenAddressesIn(text);
    }
    const context = contextFor();
    // What the person did since the agent's last turn (`conversation.seen`, kept with the conversation:
    // its turn undone, their steps, another history shown), bug hunts L3-15, F270.
    const since = historySinceSentence(boundTree(), conversation.seen, ownTurnsOf(conversation), { conversation: conversation.id });
    // Where the tracker stood as the turn began: a step someone else takes while it runs is told next time (L18-4).
    const startTree = boundTree();
    const turnStart = startTree === null ? null : { tracker: startTree.id, next: startTree.nextStep ?? 0 };
    const attached = attachedSelection();
    if (attached !== null) knownSelections.set(conversation, attached);
    appendMessage(conversation, {
      role: 'user', text, turn, at: Date.now(),
      ...(context === null ? {} : { context }),
      ...(since === null ? {} : { since }),
      ...(attached === null ? {} : { attached: { selection: attached } }),
    });
    if (bound === null && watched?.active) bound = { history: watched, trackerId: watched.active.id };
    save();
    turnsChanged();
    const turnController = new AbortController();
    const turnConversation = conversation;
    running = {
      turn, controller: turnController, status: { phase: 'thinking' }, streaming: null, detach: () => {}, before: null,
      // Where the turn's conversation is kept, whether its agent opened another dataset,
      // and how many of its history actions run now (each may show another tracker).
      conversation, home: bound, openedDataset: false, datasetActions: 0, historyActions: 0, provider: chosen.id,
    };
    running.detach = presence.attach({
      agent: chosen.agent,
      turn,
      connection: { id: conversation.id, kind: 'chat' },
      stop: () => cancel(turnController, 'user', `The person stopped ${chosen.agent}.`),
      shownElsewhere: () => open,
    });
    render();
    let result;
    try {
      // The model list may be a round trip to the provider: the turn is under way meanwhile, the
      // message taken and Stop on offer, and the model is chosen from the list once it is here.
      await loadModels(chosen);
      if (destroyed) return;
      const model = chosenModel(chosen);
      const effort = chosenEffort(chosen, model);
      result = await runAgentTurn({
        conversation, provider: chosen, key: keyOf(chosen), model, effort, cacheLength, budget, system, tools, toolIndex, actions, turn,
        signal: turnController.signal, lastUsage, win,
        onChange: change => {
          if (running?.turn !== turn) return;
          if (change.kind === 'status') {
            if (running.status?.phase !== 'asking') running.status = change.status;
            else running.before = change.status;
            tickCountdown();
          } else if (change.kind === 'text') {
            running.streaming = change.message;
          } else if (change.kind === 'message') {
            if (change.message.role === 'assistant') running.streaming = null;
            saveConversation(running.home, running.conversation);
          }
          renderLog();
        },
      });
    } finally {
      const ended = running;
      running = null;
      ended?.detach();
      // What is highlighted as the turn ends is known to its conversation (its agent may have made it).
      knownSelections.set(turnConversation, selection.current());
      // The history as the turn ends (others' steps taken while it ran left out, L18-4), kept with the
      // conversation (a reload, a save or a share keeps it): the next message says what changed since.
      if (turnConversation === conversation) {
        const endTree = boundTree();
        if (endTree !== null) {
          turnConversation.seen = historySeen(endTree, {
            from: turnStart !== null && turnStart.tracker === endTree.id ? turnStart.next : null,
            ownTurns: ownTurnsOf(turnConversation),
            conversation: turnConversation.id,
          });
        }
      }
      if (ended !== null) saveConversation(ended.home, ended.conversation);
      tickCountdown();
    }
    // A turn that made steps keeps the chat's account of it as its summary note when the agent wrote none.
    try {
      await noteTurn(history.current(), { turn, agent: chosen.agent, text: turnNoteOf(turnConversation, turn) });
    } catch (error) {
      console.error('[chat] the turn\'s note could not be kept', error);
    }
    // The context budget follows the conversation the turn was in, if it is still the one shown.
    if (conversation === turnConversation) lastUsage = result.lastUsage;
    if (result.error?.kind === 'auth' || result.error?.kind === 'model') {
      modelLists.delete(chosen.id);
      if (result.error.kind === 'auth') openSettings();
    }
    // Send comes back with the turn's last reply in the log: `render` alone drew the log a frame after it.
    render();
    renderLogNow();
    turnsChanged();
  }

  /** A wait's countdown on the status line, each second while the turn waits. */
  function tickCountdown() {
    const waiting = running?.status?.phase === 'waiting';
    if (waiting && countdown === null) {
      countdown = win.setInterval(() => {
        renderHeader();
        renderLog();
      }, 1000);
    } else if (!waiting && countdown !== null) {
      win.clearInterval(countdown);
      countdown = null;
    }
  }

  async function undoTurn(turn) {
    const current = history.current();
    if (current === null || bound?.history !== current) return;
    try {
      // Others acted after it began: the person chooses only its steps or everything since (`history-link.js`).
      await undoAgentTurn(current, turn);
    } catch (error) {
      appendMessage(conversation, { role: 'note', turn: null, kind: 'error', text: `Undoing the turn failed: ${sayFailure(error)}` });
    }
    renderLog();
  }

  function newChat() {
    if (running !== null) return;
    show(createConversation());
    dom.input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- Wiring

  function resizeInput() {
    dom.input.style.height = 'auto';
    dom.input.style.height = `${dom.input.scrollHeight}px`;
  }

  const unregisterTurnLink = registerTurnLink({
    /** A model's name as its provider's list gives it ("Claude Sonnet 4.6"), the id when no list holds it. */
    modelLabel(model) {
      for (const entry of modelLists.values()) {
        const label = entry?.list?.find(each => each.id === model)?.label;
        if (label) return label;
      }
      return model;
    },
    reveal(turn) {
      if (!conversation.messages.some(message => message.role === 'user' && message.turn === turn)) return false;
      if (!shownOpen()) setOpen(true, { focus: false });
      requestAnimationFrame(() => view.reveal(turn));
      return true;
    },
  });

  // The button of a chat folded for a film opens it again for the rest of the play.
  dom.toggle.addEventListener('click', () => setOpen(!shownOpen()), { signal });
  dom.collapseButton.addEventListener('click', () => setOpen(false), { signal });
  dom.newButton.addEventListener('click', newChat, { signal });
  dom.exportButton.addEventListener('click', exportChat, { signal });
  dom.settingsButton.addEventListener('click', () => {
    if (settingsOpen) {
      settingsOpen = false;
      render();
    } else {
      openSettings();
    }
  }, { signal });
  dom.provider.addEventListener('change', () => {
    providerId = dom.provider.value;
    writeChatPreferences({ provider: providerId });
    void loadModels();
    render();
  }, { signal });
  dom.key.addEventListener('change', () => {
    const value = dom.key.value.trim();
    dom.key.value = '';
    if (value === '') return;
    const chosen = provider();
    keys.set(chosen.id, value, { remember: dom.remember.checked });
    modelLists.delete(chosen.id);
    void loadModels(chosen);
    render();
  }, { signal });
  dom.key.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      dom.key.dispatchEvent(new Event('change'));
    }
  }, { signal });
  dom.remember.addEventListener('change', () => {
    keys.remember(provider().id, dom.remember.checked);
    renderSettings();
  }, { signal });
  dom.forget.addEventListener('click', () => {
    const chosen = provider();
    // A turn running on this key stops with it: no call goes out with a key the person took back.
    if (running !== null && running.provider === chosen.id) stopTurn(`The ${chosen.keyLabel} was forgotten, so the turn stopped.`);
    keys.forget(chosen.id);
    modelLists.delete(chosen.id);
    render();
    dom.key.focus({ preventScroll: true });
  }, { signal });
  dom.model.addEventListener('change', () => {
    chosenModels[provider().id] = dom.model.value;
    writeChatPreferences({ models: { [provider().id]: dom.model.value } });
    renderSettings();
    renderHeader();
  }, { signal });
  dom.effort.addEventListener('change', () => {
    const chosen = provider();
    const key = effortKey(chosen.id, chosenModel(chosen).id);
    const value = dom.effort.value === MODEL_DEFAULT ? null : dom.effort.value;
    if (value === null) delete chosenEfforts[key];
    else chosenEfforts[key] = value;
    writeChatPreferences({ efforts: { [key]: value } });
    renderHeader();
  }, { signal });
  const unbindPermissionsLine = presence.bindPermissionsLine({ summary: dom.permissionsSummary, change: dom.permissionsChange });
  const unsubscribePermissions = presence.permissions.subscribe(() => renderSettings());
  // The person is asked about a call of this chat's turn (`asking`, then
  // `answered`, from the dispatcher): the chat says it waits for them.
  // An action of this turn that opens another dataset, or a history action
  // of it while it runs: the turn goes on where it shows (`followTracker`).
  const unsubscribeAsking = actions.subscribe(event => {
    if (running === null || event.meta?.turn !== running.turn || event.meta.connection?.kind !== 'chat') return;
    const effect = actions.catalog.get(event.type).effect;
    if (effect === 'dataset' && (event.kind === 'start' || event.kind === 'done' || event.kind === 'failed')) {
      if (event.kind !== 'done') running.openedDataset = event.kind === 'start';
      running.datasetActions = Math.max(0, running.datasetActions + (event.kind === 'start' ? 1 : -1));
      return;
    }
    if (effect === 'history' && (event.kind === 'start' || event.kind === 'done' || event.kind === 'failed')) {
      running.historyActions = Math.max(0, running.historyActions + (event.kind === 'start' ? 1 : -1));
      return;
    }
    if (event.kind !== 'asking' && event.kind !== 'answered') return;
    if (event.kind === 'asking') {
      if (running.status?.phase !== 'asking') running.before = running.status;
      running.status = { phase: 'asking' };
    } else {
      running.status = running.before ?? { phase: 'thinking' };
      running.before = null;
    }
    renderHeader();
    renderLog();
  });
  dom.instructions.addEventListener('change', () => {
    personInstructions = dom.instructions.value.trim();
    writeChatPreferences({ instructions: personInstructions });
  }, { signal });
  dom.cache.addEventListener('change', () => {
    cacheLength = dom.cache.value;
    writeChatPreferences({ cache: cacheLength });
    renderSettings();
  }, { signal });
  dom.budget.addEventListener('change', () => {
    const value = Number(dom.budget.value);
    budget = dom.budget.value.trim() === '' || !Number.isSafeInteger(value) || value <= 0 ? null : value;
    writeChatPreferences({ budget });
    renderSettings();
  }, { signal });
  dom.form.addEventListener('submit', event => {
    event.preventDefault();
    void send();
  }, { signal });
  dom.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }, { signal });
  dom.input.addEventListener('input', resizeInput, { signal });
  dom.stop.addEventListener('click', () => stopTurn(), { signal });
  // `/` (`shortcut-table.js`) opens the chat at its message field.
  const withdrawChatKey = provideShortcut('chat.open', () => {
    if (!shownOpen()) setOpen(true);
    else dom.input.focus({ preventScroll: true });
  });
  // A window turned wide or narrow during a film: the chat folds as the bar only.
  win?.addEventListener?.('resize', () => { if (filmPlaying) render(); }, { signal });
  win?.addEventListener?.('online', () => renderHeader(), { signal });
  win?.addEventListener?.('offline', () => renderHeader(), { signal });

  // The highlights can change many times a frame (a drag of a range): the chip follows once a frame.
  let selectionFrame = null;
  const unsubscribeSelection = selection.subscribe(() => {
    if (selectionFrame !== null || destroyed) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = null;
      // A selection made anew attaches again (one left out stays out only while it is the same).
      if (leftOut !== null && !sameSelection(selection.current(), leftOut)) leftOut = null;
      renderTray();
    });
  });
  const unsubscribeCurrent = history.subscribe(watchHistory);
  watchHistory();
  if (open) {
    void loadModels();
    refreshSuggestions();
  }
  render();

  return Object.freeze({
    /** Open or collapse the chat. */
    setOpen: next => setOpen(next, { focus: false }),
    get open() { return open; },
    /**
     * A camera path started or stopped playing: while it plays, the open chat
     * as the bar over the plot folds to its button (`chatFoldsForFilm`).
     */
    setFilmPlaying(playing) {
      if (typeof playing !== 'boolean') throw new TypeError('setFilmPlaying takes whether a camera path plays.');
      if (playing === filmPlaying) return;
      filmPlaying = playing;
      if (!playing) keptForFilm = false;
      render();
    },
    /** Whether the open chat is folded for a playing camera path. */
    get foldedForFilm() { return foldedForFilm(); },
    /** Whether a turn runs now. */
    get busy() { return running !== null; },
    /** The conversation shown (tests). */
    get conversation() { return conversation; },
    destroy() {
      if (destroyed) return;
      stopTurn('Cellucid closed.');
      destroyed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      if (countdown !== null) win.clearInterval(countdown);
      unregisterTurnLink();
      unsubscribePermissions();
      unbindPermissionsLine();
      unsubscribeAsking();
      unsubscribeSelection();
      if (selectionFrame !== null) cancelAnimationFrame(selectionFrame);
      unsubscribeCurrent();
      unwatch();
      withdrawChatKey();
      controller.abort();
      view.destroy();
    },
  });
}
