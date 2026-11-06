/**
 * @fileoverview The chat bar: talk to an agent (Claude, or OpenAI's models
 * behind ChatGPT) with your own API key, inside the Cellucid tab, about the
 * dataset shown; the agent reads it and acts in it through the same tools
 * and the same history as everything else.
 *
 * - **One system.** The tools are the catalogue's MCP tools
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
 * - **Attach the selection** (`selection.js`): while cells are highlighted,
 *   a chip above the message field ("Selection: 1,234 cells ×") attaches a
 *   reference to them (the page, its groups, the counts) to each message;
 *   × leaves it out until the selection changes.
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
  appendMessage, closeInterrupted, conversationFrom, createConversation, latestConversation, sentOf, transcriptOf, usageOf,
} from './conversation.js';
import { runAgentTurn } from './agent-loop.js';
import { createKeyStore } from './keys.js';
import { effortKey, readChatPreferences, writeChatPreferences } from './preferences.js';
import { createTranscriptView, sentText, tokensText, workingTextOf } from './transcript-view.js';
import { conversationMarkdown, turnNoteOf } from './export.js';
import { readSuggestionFacts, suggestionsFor } from './suggestions.js';
import { ASK_TOOL, pendingQuestion } from './ask.js';
import { createSelectionSource, sameSelection, selectionLabel, selectionTitle } from './selection.js';
import { dataScopeNow } from '../data-scope.js';
import { permissionsForAgent } from '../presence/permissions.js';
import { providersForPage } from '../providers/index.js';
import { instructionsFor } from '../instructions.js';
import { mcpToolsOf, notRecordedSentences, toolIndexOf } from '../bridge/mcp-tools.js';
import { historySettings, offDomainsOf } from '../../history/history-settings.js';
import { noteTurn, registerTurnLink, revealStep, turnSteps, turnsChanged, undoAgentTurn } from '../history-link.js';
import { catalogDocument } from '../../actions/catalog.js';
import { getCurrentHistory, subscribeCurrentHistory } from '../../history/current.js';
import { createOpaqueId } from '../../utils/opaque-id.js';
import { downloadBlob } from '../../utils/download.js';
import { pageVersion } from '../../utils/page-version.js';
import { copyWithFeedback } from '../../ui/components/app-dialog.js';
import { cancel } from '../../../utils/abort.js';
import { formatCount } from '../../../utils/format-units.js';

const REQUIRED = [
  'dock', 'toggle', 'toggleLabel', 'panel', 'status', 'newButton', 'exportButton', 'settingsButton', 'collapseButton',
  'settings', 'provider', 'keyRow', 'keyLabel', 'key', 'remember', 'forget', 'keyLink', 'model', 'effortRow', 'effort',
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
 *   win?: Window,
 * }} options - `selection`: the person's highlighted cells (`selection.js`); `dataScope`: what
 *   agents may be sent of the dataset shown (`../data-scope.js`)
 */
export function initAgentChat({
  dom, actions, presence,
  providers = providersForPage(),
  keys = createKeyStore(),
  history = { current: getCurrentHistory, subscribe: subscribeCurrentHistory },
  selection = createSelectionSource(null),
  dataScope = { now: () => dataScopeNow() },
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
  // The chat's own question with choices (`ask.js`) after the catalogue's tools.
  const tools = Object.freeze([...mcpToolsOf(catalogDoc, { withPermissions: false }), ASK_TOOL]);
  const titles = new Map([...[...toolIndex].map(([name, definition]) => [name, definition.title]), [ASK_TOOL.name, ASK_TOOL.title]]);
  const system = instructionsFor('chat');
  const preferences = readChatPreferences();

  let providerId = providers.some(provider => provider.id === preferences.provider) ? preferences.provider : providers[0].id;
  const chosenModels = { ...preferences.models };
  const chosenEfforts = { ...preferences.efforts };
  let personInstructions = preferences.instructions;
  let budget = preferences.budget;
  /** providerId → {key, list, error, loading} */
  const modelLists = new Map();
  let conversation = createConversation();
  let bound = null;
  let lastUsage = null;
  /** The turn running: {turn, controller, status, streaming, detach, asking}. */
  let running = null;
  let open = preferences.open;
  let settingsOpen = false;
  let watched = null;
  let unwatch = () => {};
  let destroyed = false;
  let countdown = null;
  let suggestions = suggestionsFor();
  let suggestionsKey = null;
  /** The selection the person left out (×), until it changes. */
  let leftOut = null;

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
      const asked = conversation.messages.find(message => message.role === 'user' && message.turn === turn);
      if (asked === undefined || running !== null) return;
      dom.input.value = asked.text;
      void send();
    },
    onCopy: (text, button) => void copyWithFeedback(button, text),
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
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn agent-chat-chip-remove';
    remove.textContent = '×';
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
    return now === null || sameSelection(now, leftOut) ? null : now;
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
    dom.toggle.setAttribute('aria-expanded', String(open));
    dom.dock.dataset.chatOpen = String(open);
    if (!ready(chosen)) {
      // Short enough for a phone's header; the settings (open by themselves) name the provider and its key.
      setStatus('Add an API key to start.', 'info');
    } else if (running !== null && running.status !== null) {
      setStatus(workingTextOf(running.status), running.status.phase === 'waiting' ? 'warning' : 'info');
    } else if (win?.navigator?.onLine === false) {
      setStatus('This browser is offline; a message waits until it is back.', 'warning');
    } else {
      const model = chosenModel(chosen);
      const effort = chosenEffort(chosen, model);
      const name = model.label.startsWith(chosen.agent) ? model.label : `${chosen.agent} · ${model.label}`;
      setStatus(effort === null ? name : `${name} · ${effort} effort`);
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
    dom.provider.disabled = running !== null;
    dom.keyRow.hidden = !chosen.needsKey;
    const kept = chosen.needsKey ? keys.get(chosen.id) : null;
    if (chosen.needsKey) {
      dom.keyLabel.textContent = chosen.keyLabel;
      dom.key.placeholder = kept === null ? chosen.keyPlaceholder : 'Kept · type a new key to replace it';
      dom.keyLink.href = chosen.keyUrl;
      dom.remember.checked = kept?.remembered === true;
      dom.remember.disabled = kept === null;
      dom.forget.disabled = kept === null;
    }
    const entry = modelEntry(chosen);
    const current = chosenModel(chosen);
    const listed = entry.list ?? [current];
    dom.model.replaceChildren(...listed.map(model => new Option(model.label === model.id ? model.id : `${model.label} (${model.id})`, model.id)));
    dom.model.value = current.id;
    dom.model.disabled = running !== null || !ready(chosen);
    const efforts = current.efforts ?? [];
    dom.effortRow.hidden = efforts.length === 0;
    dom.effort.replaceChildren(new Option('Model\'s default', MODEL_DEFAULT), ...efforts.map(effort => new Option(effort[0].toUpperCase() + effort.slice(1), effort)));
    dom.effort.value = chosenEffort(chosen, current) ?? MODEL_DEFAULT;
    dom.effort.disabled = running !== null;
    if (doc.activeElement !== dom.instructions) dom.instructions.value = personInstructions;
    if (doc.activeElement !== dom.budget) dom.budget.value = budget === null ? '' : String(budget);
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
      titles,
      sentOf: turn => sentText(sentOf(conversation, turn), providerLabelOfTurn(turn)),
      usageOf: turn => tokensText(usageOf(conversation, turn)),
      suggestions,
    });
  }

  function providerLabelOfTurn(turn) {
    const reply = conversation.messages.find(message => message.role === 'assistant' && message.turn === turn);
    const id = reply?.provider ?? provider().id;
    return providers.find(candidate => candidate.id === id)?.label.replace(/^.*\((.+)\)$/, '$1') ?? id;
  }

  function render() {
    if (destroyed) return;
    stepsCache = null;
    renderHeader();
    renderSettings();
    dom.panel.hidden = !open;
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
    const steps = tree === null ? 0 : tree.steps.size - 1;
    void readSuggestionFacts(actions, steps).then(facts => {
      if (destroyed || suggestionsKey !== key) return;
      suggestions = suggestionsFor(facts);
      renderLog();
    });
  }

  function setOpen(next, { focus = true } = {}) {
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
    const text = conversationMarkdown(conversation, { dataset: watched?.dataset?.name ?? null, version });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(new Blob([text], { type: 'text/markdown' }), `cellucid-chat-${stamp}.md`);
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
    if (running !== null && !loaded && running.openedDataset) {
      // The agent of this turn opened another dataset: the chat belongs to
      // the tab, so the turn goes on where the agent now acts, and the
      // conversation is kept with that dataset's history too (the one it
      // left keeps it up to here).
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
    const saved = latestConversation(watched.chatsOf(tree.id));
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
      }
    }
    // A conversation begun with nothing to keep it with goes on here.
    if (previous === null && conversation.messages.length > 0) {
      save();
      render();
      return;
    }
    show(createConversation());
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
  function dataScopeSentence() {
    return dataScope.now().summariesOnly
      ? 'This dataset is set to names and summaries only: reads of single cells\' values and pictures of the plot are refused; work from names, counts and summaries.'
      : 'Reads of this dataset are not limited (values of cells and pictures of the plot included).';
  }

  /**
   * What Cellucid tells the model with this message: the person's
   * permissions, the dataset's switch, what their History settings leave
   * out of the history (camera moves; panels) and their own instructions, when any
   * changed since the last message that told them (the model plans by them).
   */
  function contextFor() {
    const told = [`Permissions: ${permissionsForAgent(presence.permissions.get())}`, dataScopeSentence(),
      ...notRecordedSentences(offDomainsOf(historySettings()))];
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
    }
    const context = contextFor();
    const attached = attachedSelection();
    appendMessage(conversation, {
      role: 'user', text, turn, at: Date.now(),
      ...(context === null ? {} : { context }),
      ...(attached === null ? {} : { attached: { selection: attached } }),
    });
    if (bound === null && watched?.active) bound = { history: watched, trackerId: watched.active.id };
    save();
    turnsChanged();
    const turnController = new AbortController();
    const turnConversation = conversation;
    running = {
      turn, controller: turnController, status: { phase: 'thinking' }, streaming: null, detach: () => {}, before: null,
      // Where the turn's conversation is kept, and whether its agent opened another dataset.
      conversation, home: bound, openedDataset: false, provider: chosen.id,
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
        conversation, provider: chosen, key: keyOf(chosen), model, effort, budget, system, tools, toolIndex, actions, turn,
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
      appendMessage(conversation, { role: 'note', turn: null, kind: 'error', text: `Undoing the turn failed: ${error?.message ?? String(error)}` });
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
      if (!open) setOpen(true, { focus: false });
      requestAnimationFrame(() => view.reveal(turn));
      return true;
    },
  });

  dom.toggle.addEventListener('click', () => setOpen(!open), { signal });
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
  // An action of this turn that opens another dataset: the turn goes on there (`followTracker`).
  const unsubscribeAsking = actions.subscribe(event => {
    if (running === null || event.meta?.turn !== running.turn || event.meta.connection?.kind !== 'chat') return;
    if (actions.catalog.get(event.type).effect === 'dataset' && (event.kind === 'start' || event.kind === 'failed')) {
      running.openedDataset = event.kind === 'start';
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
  // `/` anywhere but a field opens the chat at its message field.
  doc.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, dialog[open]'))) return;
    event.preventDefault();
    if (!open) setOpen(true);
    else dom.input.focus({ preventScroll: true });
  }, { signal });
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
      controller.abort();
      view.destroy();
    },
  });
}
