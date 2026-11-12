/**
 * @fileoverview Load (History v2 §3.10: Saved states moved into Load…): every
 * history this browser keeps, autosaved and named, for every dataset, with
 * its dataset, name, dates, steps and size; open one (its dataset first when
 * another is shown), replay its steps on the dataset shown (in a new tracker
 * linked to it), rename it, delete it (asked first, in its row: the dialog is
 * modal, so nothing over it could be answered), or keep the history shown
 * under a name, as the history, the current state only or the steps only
 * (`history.save`, §3.15.3). Below, a session file is opened (`Open a session
 * file…`, `session-controls.js`) or replayed on the dataset shown.
 *
 * The store is this browser's saved histories (`app/history/current.js`
 * `SavedHistories`); while none is published, the list says so and a file
 * can still be opened. Whether every step is kept in this browser is a
 * History setting (the ⚙ box).
 *
 * @module ui/modules/state/saved-states-dialog
 */

import { formatAgo } from './model.js';
import { reportHistoryFailure } from './shared.js';
import { formatWhen } from '../../../history/exports/report.js';
import { ICONS, createButton, createIconButton } from '../../components/controls.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { InlineEditor } from '../../components/inline-editor.js';
import { formatBytes, formatCountOf } from '../../../../utils/format-units.js';
import { upperFirst } from '../../../../utils/text-case.js';

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {HTMLElement} options.list
 * @param {HTMLElement} options.empty
 * @param {HTMLElement} options.status
 * @param {HTMLInputElement} options.nameInput - The name the history shown is saved under
 * @param {HTMLSelectElement} options.contentSelect - What it keeps: history, state or steps
 * @param {HTMLButtonElement} options.saveAsButton
 * @param {(name: string, content: string) => Promise<unknown>} options.save - `history.save`
 * @param {(id: string) => Promise<unknown>} options.remove - `history.saved.delete`: the one way a
 *   saved state is deleted, for the person, an agent, a notebook and a replay
 * @param {HTMLButtonElement} options.replayFileButton - Replay a session file here…
 * @param {HTMLButtonElement} options.openFileButton - Open a session file… (its file chooser is the session controls')
 * @param {(() => void)|null} options.onReplayFile - picks a file inside the click and replays it; null where it cannot
 * @param {() => import('../../../history/current.js').SavedHistories|null} options.store
 * @param {() => boolean} options.hasHistory - Whether a history is shown (Save as and Replay need one)
 * @param {((entry: import('../../../history/current.js').SavedHistoryEntry) => void)|null} [options.onReplay] -
 *   Replay a saved state's steps on the dataset shown (the State panel runs it and shows its report)
 * @param {() => number} [options.now]
 */
/** What the list names a saved state: its name, or an autosave by its latest step. */
function listedName(entry) {
  return entry.name ?? entry.lastStep ?? 'Autosave';
}

/**
 * How the dialog's messages name it, as the list does: "Opening the autosave at
 * “Colored by gene CD8B”" (found 2026-11-10: the list named an autosave by its
 * latest step and its notice said "Opening Autosave").
 */
function spokenName(entry) {
  if (entry.name != null) return entry.name;
  return entry.lastStep != null ? `the autosave at “${entry.lastStep}”` : 'the autosave';
}

export function createSavedStatesDialog({
  dialog, list, empty, status, nameInput, contentSelect, saveAsButton, save, remove, replayFileButton, openFileButton, onReplayFile = null,
  store, hasHistory, onReplay = null, now = () => Date.now(),
}) {
  const ownerDocument = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const controller = new AbortController();
  replayFileButton.addEventListener('click', () => {
    if (onReplayFile === null || !hasHistory()) return;
    app.close();
    onReplayFile();
  }, { signal: controller.signal });
  // The file chooser opens from this click (the session controls'): the
  // dialog steps aside, and the file opens on the page as any session does.
  openFileButton.addEventListener('click', () => app.close(), { signal: controller.signal });
  let generation = 0;
  /** id → entry of the list shown */
  let entries = new Map();

  function say(text, tone = 'muted') {
    status.hidden = text.length === 0;
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function rowOf(entry) {
    const row = ownerDocument.createElement('div');
    row.className = 'saved-state';
    row.setAttribute('role', 'listitem');
    row.dataset.savedId = entry.id;
    row.dataset.kind = entry.kind;
    if (entry.current) row.dataset.current = 'true';
    const body = ownerDocument.createElement('div');
    body.className = 'saved-state-body';
    const head = ownerDocument.createElement('div');
    head.className = 'saved-state-head';
    const name = ownerDocument.createElement('span');
    name.className = 'saved-state-name';
    // An autosave is told apart by what it last did ("Colored by gene CD8B"); its badge says it is one.
    name.textContent = listedName(entry);
    name.title = name.textContent;
    const kind = ownerDocument.createElement('span');
    kind.className = 'history-badge';
    kind.dataset.origin = entry.kind === 'autosave' ? 'session' : 'person';
    kind.textContent = entry.kind === 'autosave' ? 'Auto' : 'Named';
    const size = ownerDocument.createElement('span');
    size.className = 'saved-state-size';
    size.textContent = formatBytes(entry.bytes);
    head.append(name, kind, size);
    const meta = ownerDocument.createElement('div');
    meta.className = 'saved-state-meta';
    const updated = formatAgo(entry.updatedAt, now());
    meta.textContent = `${entry.dataset?.name ?? entry.dataset?.id ?? 'Unknown dataset'} · ${formatCountOf(entry.steps, 'step')} · ${updated.long}`;
    meta.title = `Saved ${formatWhen(entry.createdAt)}, last changed ${formatWhen(entry.updatedAt)}`;
    body.append(head, meta);
    const actions = ownerDocument.createElement('div');
    actions.className = 'saved-state-actions';
    // A row of the list: its actions are quiet, Open the main one.
    const open = createButton({
      label: entry.current ? 'Shown' : 'Open',
      variant: 'quiet-primary',
      ariaLabel: entry.current ? `${name.textContent} is shown` : `Open ${name.textContent}`,
    });
    open.dataset.savedAction = 'open';
    open.disabled = entry.current === true;
    // Its steps applied again on the dataset shown, which may be another one.
    const replay = createButton({ label: 'Replay here', variant: 'quiet' });
    replay.dataset.savedAction = 'replay';
    replay.hidden = onReplay === null || entry.current === true;
    replay.disabled = !hasHistory();
    replay.setAttribute('aria-label', `Replay the steps of ${name.textContent} on the dataset shown`);
    replay.title = replay.disabled
      ? 'Open a dataset to replay these steps on it'
      : 'Apply these steps again, by name, on the dataset shown, in a new tracker';
    const rename = createIconButton({ label: `Rename ${name.textContent}`, icon: ICONS.rename });
    rename.dataset.savedAction = 'rename';
    const remove = createIconButton({ label: `Delete ${name.textContent}`, icon: ICONS.delete, tone: 'danger' });
    remove.dataset.savedAction = 'delete';
    actions.append(open, replay, rename, remove);
    // Asked in the row: Delete for good, or Keep.
    const confirm = ownerDocument.createElement('div');
    confirm.className = 'saved-state-confirm';
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-label', `Delete ${name.textContent} for good?`);
    confirm.hidden = true;
    const question = ownerDocument.createElement('span');
    question.className = 'saved-state-question';
    question.textContent = 'Delete for good?';
    const yes = createButton({ label: 'Delete', variant: 'danger', className: 'btn-compact', ariaLabel: `Delete ${name.textContent} for good` });
    yes.dataset.savedAction = 'delete-confirmed';
    const keep = createButton({ label: 'Keep', variant: 'quiet' });
    keep.dataset.savedAction = 'keep';
    confirm.append(question, yes, keep);
    row.append(body, actions, confirm);
    return row;
  }

  async function refresh() {
    const saved = store();
    const run = ++generation;
    const nothingToSave = hasHistory() ? null : 'there is no history to save yet; take a step first';
    setControlAvailability(nameInput, nothingToSave);
    setControlAvailability(contentSelect, nothingToSave);
    saveAsButton.disabled = !hasHistory() || nameInput.value.trim().length === 0;
    replayFileButton.hidden = onReplayFile === null;
    replayFileButton.disabled = !hasHistory();
    if (saved === null) {
      list.replaceChildren();
      list.hidden = true;
      empty.hidden = false;
      empty.textContent = 'Nothing is kept in this browser.';
      return;
    }
    empty.textContent = 'No states are saved in this browser yet.';
    let listed;
    try {
      listed = await saved.list();
    } catch (error) {
      if (run !== generation) return;
      say('The saved states could not be read.', 'danger');
      reportHistoryFailure('Reading the saved states', error);
      return;
    }
    if (run !== generation) return;
    const ordered = [...listed].sort((a, b) => b.updatedAt - a.updatedAt);
    entries = new Map(ordered.map(entry => [entry.id, entry]));
    const focused = list.contains(ownerDocument.activeElement) ? ownerDocument.activeElement : null;
    const focusKey = focused ? [focused.closest('.saved-state')?.dataset.savedId, focused.dataset.savedAction] : null;
    list.replaceChildren(...ordered.map(rowOf));
    list.hidden = ordered.length === 0;
    empty.hidden = ordered.length > 0;
    if (focusKey) {
      list.querySelector(`.saved-state[data-saved-id="${CSS.escape(focusKey[0] ?? '')}"] [data-saved-action="${focusKey[1]}"]`)?.focus();
    }
  }

  async function act(what, task, done) {
    say(`${what}…`);
    try {
      await task();
      say(done, 'success');
    } catch (error) {
      say(`${what} failed.`, 'danger');
      reportHistoryFailure(what, error);
    }
    await refresh();
  }

  list.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest('[data-saved-action]') : null;
    if (button === null || !list.contains(button)) return;
    const id = button.closest('.saved-state').dataset.savedId;
    const entry = entries.get(id);
    const saved = store();
    if (!entry || saved === null) return;
    const name = spokenName(entry);
    switch (button.dataset.savedAction) {
      case 'open': {
        say(`Opening ${name}…`);
        let outcome;
        try {
          outcome = await saved.open(id);
        } catch (error) {
          say(`Opening ${name} failed.`, 'danger');
          reportHistoryFailure(`Opening ${name}`, error);
          await refresh();
          break;
        }
        if (outcome.opened || outcome.problem === null) {
          // Opened; or not, and why is on the page (the opening's progress, a
          // newer choice), which this modal dialog would cover. It said
          // "Opened" whatever happened (2026-11-11).
          say(outcome.opened ? `Opened ${name}.` : '', outcome.opened ? 'success' : 'muted');
          if (dialog.open) app.close();
          break;
        }
        say(`${upperFirst(name)} was not opened: ${outcome.problem}`, 'danger');
        // The offer to reopen a file of this computer is on the page, under this dialog.
        if (outcome.code === 'needs-person' && dialog.open) app.close();
        else await refresh();
        break;
      }
      case 'replay':
        if (onReplay === null || !hasHistory()) break;
        // The replay runs on the page: its progress and report are the State panel's.
        app.close();
        onReplay(entry);
        break;
      case 'rename': {
        const nameEl = button.closest('.saved-state').querySelector('.saved-state-name');
        const input = InlineEditor.create(nameEl, entry.name ?? '', {
          minWidth: 140,
          validate: value => (value.trim().length > 0 ? true : 'A saved state needs a name'),
          onSave: value => void act(`Renaming ${name}`, () => saved.rename(id, value), `Renamed to ${value}.`),
          onCancel: () => button.focus(),
        });
        input?.setAttribute('aria-label', 'Saved state name');
        input?.focus();
        input?.select();
        break;
      }
      case 'delete': {
        const row = button.closest('.saved-state');
        row.dataset.confirming = 'true';
        row.querySelector('.saved-state-actions').hidden = true;
        row.querySelector('.saved-state-confirm').hidden = false;
        say(`${formatCountOf(entry.steps, 'step')} of ${entry.dataset?.name ?? 'this dataset'} would be removed from this browser.`, 'warning');
        row.querySelector('[data-saved-action="keep"]').focus();
        break;
      }
      case 'keep': {
        const row = button.closest('.saved-state');
        delete row.dataset.confirming;
        row.querySelector('.saved-state-confirm').hidden = true;
        row.querySelector('.saved-state-actions').hidden = false;
        say('');
        row.querySelector('[data-saved-action="delete"]').focus();
        break;
      }
      case 'delete-confirmed':
        await act(`Deleting ${name}`, () => remove(id), `Deleted ${name}.`);
        break;
      default:
    }
  }, { signal: controller.signal });

  async function saveAs() {
    const name = nameInput.value.trim();
    if (!hasHistory() || name.length === 0) return;
    await act(`Saving ${name}`, () => save(name, contentSelect.value), `Saved ${name}.`);
    if (status.dataset.tone === 'success') nameInput.value = '';
    saveAsButton.disabled = nameInput.value.trim().length === 0;
  }
  nameInput.addEventListener('input', () => {
    saveAsButton.disabled = !hasHistory() || nameInput.value.trim().length === 0;
  }, { signal: controller.signal });
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveAs();
    }
  }, { signal: controller.signal });
  saveAsButton.addEventListener('click', () => void saveAs(), { signal: controller.signal });

  return {
    /** @param {HTMLElement|null} [opener] */
    open(opener = null) {
      say('');
      app.open(opener);
      void refresh();
    },
    refresh() { if (dialog.open) void refresh(); },
    close: () => app.close(),
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}
