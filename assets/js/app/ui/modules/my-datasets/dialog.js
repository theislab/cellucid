/**
 * @fileoverview My datasets › All…: every dataset opened in this browser,
 * the five of the menu included, most recently opened first, as compact
 * rows. A row shows the dataset's name, kind and when it was last opened,
 * and one line (format, cells, genes, saved states); its name opens the
 * facts behind it (where the data comes from and how it opens again, format,
 * size, cells and genes and the cells it opens with, when it was first and
 * last opened, its saved states, what is stored of it). Open opens it again,
 * Continue opens it with its latest saved state, Forget asks first, in the
 * row (the dialog is modal), saying what goes and what stays: its saved
 * states stay unless ticked. A filter narrows the rows by name.
 *
 * Export… opens, in place of the rows, the choice of a library file
 * (`app/library/library-file.js`): every dataset ticked with its saved
 * states under it, saved states of datasets no longer listed unticked under
 * their own heading, and a line of what is ticked; Export writes it.
 * Import… chooses a `.cellucid-library` file and adds what it holds beside
 * what is kept; the status line says what was added and what was already
 * there.
 *
 * A native `<dialog>` (`components/app-dialog.js`): focus trap, Escape and
 * the return of focus come from the browser.
 *
 * @module ui/modules/my-datasets/dialog
 */

import { wireAppDialog } from '../../components/app-dialog.js';
import { setControlAvailability } from '../../core/control-availability.js';
import { ICONS, createButton, createIconButton, renderFactList } from '../../components/controls.js';
import { formatAgo } from '../state/model.js';
import { formatBytes, formatCountOf } from '../../../../utils/format-units.js';
import { failureDetailsText, joinFailure, sayFailure } from '../../../../utils/errors.js';
import {
  KIND_LABELS, datasetKind, describeEntryFacts, describeExport, describeExportChoice, describeImport, describeListStatus,
  describeRowMeta, describeSavedStateLine, keptOf, latestSavedState, matchesFilter, savedStatesOf,
} from './model.js';

/**
 * @typedef {Object} LibraryView
 * @property {Object[]} entries - every dataset of the list (`listMyDatasets`)
 * @property {Object[]} saved - every saved state (`listSavedStates`, `current` marking the history shown)
 * @property {Object[]} kept - what the Stored machinery keeps (`listKeptStores`)
 * @property {string|null} currentId - the identity of the dataset open now
 * @property {(entry: Object) => 'click'|'ask'|'choose'} way - how each opens again
 * @property {number} now
 */

/**
 * @param {{dialog: HTMLDialogElement, filter: HTMLInputElement, status: HTMLElement, list: HTMLElement,
 *   empty: HTMLElement, exportButton: HTMLButtonElement, importButton: HTMLButtonElement,
 *   importInput: HTMLInputElement, exportPanel: HTMLElement}} dom
 * @param {{onOpen: (entry: Object, state: Object|null) => void,
 *   onForget: (entry: Object, options: {savedStates: boolean}) => Promise<{datasets: number, savedStates: number}>,
 *   onExport: (choice: {datasets: string[], savedStates: string[]}) => Promise<{datasets: number, histories: number, paused: number}>,
 *   onImport: (file: File) => Promise<Object>}} handlers -
 *   `onOpen` runs inside the person's click (Open: `state` null; Continue: the saved state); `onExport`
 *   writes and downloads a library file (`exportLibrary`), `onImport` imports one (`importLibrary`'s report)
 * @returns {{open: (opener?: HTMLElement|null) => void, render: (view: LibraryView) => void,
 *   importFile: (file: File) => Promise<void>, close: () => void,
 *   readonly isOpen: boolean, destroy: () => void}}
 */
export function createMyDatasetsDialog(dom, { onOpen, onForget, onExport, onImport }) {
  for (const key of ['dialog', 'filter', 'status', 'list', 'empty', 'exportButton', 'importButton', 'importInput', 'exportPanel']) {
    if (!dom?.[key]) throw new TypeError(`The My datasets dialog needs its ${key}.`);
  }
  const doc = dom.dialog.ownerDocument;
  const app = wireAppDialog(dom.dialog);
  const controller = new AbortController();
  const { signal } = controller;
  /** @type {LibraryView|null} */
  let view = null;
  /** The rows whose facts are open, by dataset id. */
  const expanded = new Set();
  /** The row whose Forget is being asked, or null, and whether its saved states are ticked to go too. */
  let confirming = null;
  let alsoTicked = false;
  /** What the last action said, kept over the counts until the filter or the list changes. */
  let said = null;
  /** The words of the failure `said` names, shown on hover (`say`). */
  let saidDetails = '';
  /** id → {entry, state} of the rows drawn */
  let rows = new Map();
  /** The export's choice while it is open (dataset ids and saved state ids ticked), else null. */
  let exporting = null;
  /** An export or an import under way. */
  let busy = false;
  const exportList = dom.exportPanel.querySelector('[data-export-list]');
  const exportSummary = dom.exportPanel.querySelector('[data-export-summary]');
  const exportConfirm = dom.exportPanel.querySelector('[data-export-action="confirm"]');

  /** A row's action: quiet, as every action nested in a list's row (`createButton`). */
  function button(text, action, label, variant = 'quiet') {
    // The confirmation that forgets is the one filled button, asked for in the row.
    const element = createButton({ label: text, variant, ariaLabel: label, className: variant === 'danger' ? 'btn-compact' : undefined });
    element.dataset.libraryAction = action;
    return element;
  }

  function rowOf(entry, index) {
    const saved = savedStatesOf(entry, view.saved);
    const state = latestSavedState(entry, view.saved);
    const way = view.way(entry);
    const current = entry.id === view.currentId;
    const row = doc.createElement('div');
    row.className = 'library-row';
    row.setAttribute('role', 'listitem');
    row.dataset.datasetId = entry.id;
    if (current) row.dataset.current = 'true';

    // The name opens the facts behind it.
    const detailsId = `my-datasets-details-${index}`;
    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = 'library-row-toggle';
    toggle.dataset.libraryAction = 'details';
    toggle.setAttribute('aria-expanded', String(expanded.has(entry.id)));
    toggle.setAttribute('aria-controls', detailsId);
    const head = doc.createElement('span');
    head.className = 'library-row-head';
    const name = doc.createElement('span');
    name.className = 'library-row-name';
    name.textContent = entry.name;
    name.title = entry.name;
    const kind = doc.createElement('span');
    kind.className = 'history-badge';
    kind.textContent = KIND_LABELS[datasetKind(entry)];
    const when = doc.createElement('span');
    when.className = 'library-row-when';
    when.textContent = current ? 'open now' : formatAgo(entry.lastOpenedAt, view.now).long;
    const chevron = doc.createElement('span');
    chevron.className = 'disclosure-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    head.append(name, kind, when, chevron);
    const meta = doc.createElement('span');
    meta.className = 'library-row-meta';
    meta.textContent = describeRowMeta(entry, saved);
    meta.title = meta.textContent;
    toggle.append(head, meta);

    const actions = doc.createElement('div');
    actions.className = 'library-row-actions';
    const open = button('Open', 'open', current ? `${entry.name} is open now` : `Open ${entry.name}`, 'quiet-primary');
    open.disabled = current;
    if (way === 'choose') open.title = `Choose ${entry.name} again: this browser does not let a page reopen a file by itself.`;
    const resume = button('Continue', 'continue', state === null
      ? `${entry.name} has no saved state to continue`
      : `Continue ${entry.name} where you left off: its latest saved state, ${formatCountOf(state.steps, 'step')} from ${formatAgo(state.updatedAt, view.now).long}`);
    resume.disabled = state === null || way === 'choose';
    if (state !== null && way === 'choose') resume.title = `Open ${entry.name} first (choose it again); its saved states are then offered.`;
    else if (state === null) resume.title = 'No saved state of this dataset is kept in this browser.';
    const forget = createIconButton({ label: `Forget ${entry.name}`, icon: ICONS.delete, tone: 'danger' });
    forget.dataset.libraryAction = 'forget';
    actions.append(open, resume, forget);

    // Forget is asked in the row: what goes, what stays, and the saved states only when ticked.
    const confirm = doc.createElement('div');
    confirm.className = 'library-row-confirm';
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-label', `Forget ${entry.name}?`);
    const question = doc.createElement('p');
    question.className = 'library-row-question';
    question.textContent = `Forget ${entry.name}?`;
    const help = doc.createElement('p');
    help.className = 'field-help';
    const local = entry.source.kind === 'file';
    help.textContent = local
      ? 'It leaves My datasets, and this browser forgets its handle of the file. Its saved states and stored data stay.'
      : 'It leaves My datasets. Its saved states and stored data stay.';
    confirm.append(question, help);
    if (saved.length > 0) {
      const label = doc.createElement('label');
      label.className = 'checkbox-inline';
      const also = doc.createElement('input');
      also.type = 'checkbox';
      also.dataset.libraryAlso = 'saved-states';
      also.checked = confirming === entry.id && alsoTicked;
      const bytes = saved.reduce((sum, item) => sum + item.bytes, 0);
      const text = doc.createElement('span');
      text.textContent = `Also delete its ${formatCountOf(saved.length, 'saved state')} (${formatBytes(bytes)})`;
      label.append(also, text);
      confirm.append(label);
    }
    const answers = doc.createElement('div');
    answers.className = 'library-row-confirm-actions';
    const yes = button('Forget', 'forget-confirmed', `Forget ${entry.name}`, 'danger');
    answers.append(yes, button('Keep', 'keep', `Keep ${entry.name}`));
    confirm.append(answers);
    const asking = confirming === entry.id;
    confirm.hidden = !asking;
    actions.hidden = asking;

    const details = doc.createElement('div');
    details.className = 'library-row-details';
    details.id = detailsId;
    details.hidden = !expanded.has(entry.id);
    const facts = doc.createElement('dl');
    facts.className = 'fact-list';
    renderFactList(facts, describeEntryFacts(entry, { saved, kept: keptOf(entry, view.kept), way, now: view.now }));
    details.append(facts);

    row.append(toggle, actions, confirm, details);
    rows.set(entry.id, { entry, state });
    return row;
  }

  function check(text, attributes, { checked, unavailable = null, title = text }) {
    const label = doc.createElement('label');
    label.className = 'checkbox-inline';
    label.title = title;
    const input = doc.createElement('input');
    input.type = 'checkbox';
    for (const [name, value] of Object.entries(attributes)) input.dataset[name] = value;
    input.checked = checked;
    setControlAvailability(input, unavailable);
    const span = doc.createElement('span');
    span.textContent = text;
    label.append(input, span);
    return label;
  }

  /** A saved state's line in the export's choice; one this version cannot open is offered unticked, disabled. */
  function stateCheck(state) {
    const line = describeSavedStateLine(state, view.now);
    return check(line, { exportState: state.id }, {
      checked: exporting.states.has(state.id),
      unavailable: state.openable === false ? 'kept by another version of Cellucid, which this version cannot read' : null,
      title: state.openable === false ? `${line}: kept by another version of Cellucid, which this version cannot read` : line,
    });
  }

  /** The export's choice: each dataset with its saved states under it, then those of datasets not listed. */
  function drawExport() {
    const focused = exportList.contains(doc.activeElement) ? doc.activeElement : null;
    const focusKey = focused === null ? null : focused.dataset.exportDataset !== undefined
      ? `[data-export-dataset="${CSS.escape(focused.dataset.exportDataset)}"]`
      : focused.dataset.exportState !== undefined ? `[data-export-state="${CSS.escape(focused.dataset.exportState)}"]` : null;
    const listed = new Set(view.entries.map(entry => entry.id));
    const parts = [];
    for (const entry of view.entries) {
      parts.push(check(entry.name, { exportDataset: entry.id }, { checked: exporting.datasets.has(entry.id) }));
      const saved = savedStatesOf(entry, view.saved);
      if (saved.length > 0) {
        const states = doc.createElement('div');
        states.className = 'library-export-states';
        states.append(...saved.map(stateCheck));
        parts.push(states);
      }
    }
    const others = view.saved.filter(state => !listed.has(state.dataset?.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    if (others.length > 0) {
      const heading = doc.createElement('p');
      heading.className = 'library-export-group';
      heading.textContent = 'Saved states of datasets not listed';
      const states = doc.createElement('div');
      states.className = 'library-export-states';
      states.append(...others.map(state => {
        const label = stateCheck(state);
        const name = state.dataset?.name ?? 'a dataset';
        label.querySelector('span').textContent = `${name}: ${label.querySelector('span').textContent}`;
        label.title = `${name}: ${label.title}`;
        return label;
      }));
      parts.push(heading, states);
    }
    exportList.replaceChildren(...parts);
    if (focusKey !== null) exportList.querySelector(focusKey)?.focus();
    summarizeExport();
  }

  function summarizeExport() {
    const states = view.saved.filter(state => exporting.states.has(state.id));
    exportSummary.textContent = describeExportChoice({ datasets: exporting.datasets.size, states });
    exportConfirm.disabled = busy || (exporting.datasets.size === 0 && states.length === 0);
  }

  /** Open the export's choice: every dataset and its saved states this version opens, ticked. */
  function openExport() {
    const listed = new Set(view?.entries.map(entry => entry.id) ?? []);
    exporting = {
      datasets: new Set(listed),
      states: new Set((view?.saved ?? []).filter(state => listed.has(state.dataset?.id) && state.openable !== false).map(state => state.id)),
    };
    said = null;
    draw();
    exportList.querySelector('input:not(:disabled)')?.focus();
  }

  function closeExport() {
    exporting = null;
    draw();
    dom.exportButton.focus();
  }

  function draw() {
    if (view === null) return;
    const choosing = exporting !== null;
    dom.exportPanel.hidden = !choosing;
    dom.exportButton.setAttribute('aria-expanded', String(choosing));
    dom.exportButton.disabled = busy || (view.entries.length === 0 && view.saved.length === 0);
    dom.importButton.disabled = busy;
    if (choosing) {
      // The choice takes the rows' place: one thing at a time in a modal dialog.
      dom.list.hidden = true;
      dom.empty.hidden = true;
      dom.filter.hidden = true;
      drawExport();
      say(said ?? '', said === null ? 'muted' : dom.status.dataset.tone);
      return;
    }
    const focused = dom.list.contains(doc.activeElement) ? doc.activeElement : null;
    const focusKey = focused === null
      ? null
      : [focused.closest('.library-row')?.dataset.datasetId, focused.dataset.libraryAction ?? (focused.dataset.libraryAlso ? 'also' : null)];
    const query = dom.filter.value;
    const shown = view.entries.filter(entry => matchesFilter(entry, query));
    rows = new Map();
    dom.list.replaceChildren(...shown.map(rowOf));
    dom.list.hidden = shown.length === 0;
    dom.empty.hidden = view.entries.length > 0;
    dom.filter.hidden = view.entries.length === 0;
    const withSaved = view.entries.filter(entry => savedStatesOf(entry, view.saved).length > 0).length;
    const counts = describeListStatus({ total: view.entries.length, shown: shown.length, query, withSaved });
    say(said ?? counts, said === null ? 'muted' : dom.status.dataset.tone);
    if (focusKey !== null && focusKey[0] !== undefined) {
      const row = dom.list.querySelector(`.library-row[data-dataset-id="${CSS.escape(focusKey[0])}"]`);
      const target = focusKey[1] === 'also'
        ? row?.querySelector('[data-library-also]')
        : row?.querySelector(`[data-library-action="${focusKey[1]}"]`);
      (target && !target.closest('[hidden]') ? target : row?.querySelector('[data-library-action="details"]'))?.focus();
    }
  }

  function say(text, tone = 'muted') {
    dom.status.textContent = text;
    // A failure's own words (a damaged file's offsets and keys) on hover, out of its sentence.
    dom.status.title = tone === 'danger' ? saidDetails : '';
    dom.status.dataset.tone = tone;
    dom.status.hidden = text === '';
  }

  dom.filter.addEventListener('input', () => {
    said = null;
    draw();
  }, { signal });
  // What is ticked stays ticked when the list is drawn again meanwhile.
  dom.list.addEventListener('change', event => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.libraryAlso !== undefined) alsoTicked = event.target.checked;
  }, { signal });

  dom.list.addEventListener('click', async event => {
    const control = event.target instanceof Element ? event.target.closest('[data-library-action]') : null;
    if (control === null || !dom.list.contains(control) || control.disabled) return;
    const row = control.closest('.library-row');
    const drawn = rows.get(row?.dataset.datasetId);
    if (drawn === undefined) return;
    const { entry, state } = drawn;
    switch (control.dataset.libraryAction) {
      case 'details':
        if (expanded.has(entry.id)) expanded.delete(entry.id);
        else expanded.add(entry.id);
        control.setAttribute('aria-expanded', String(expanded.has(entry.id)));
        row.querySelector('.library-row-details').hidden = !expanded.has(entry.id);
        break;
      case 'open':
      case 'continue':
        // Closed first, so the opening and any question of the browser are seen; inside the click.
        app.close();
        onOpen(entry, control.dataset.libraryAction === 'continue' ? state : null);
        break;
      case 'forget':
        // One question at a time: another row asked before is answered Keep.
        for (const asked of dom.list.querySelectorAll('.library-row-confirm:not([hidden])')) {
          asked.hidden = true;
          asked.parentElement.querySelector('.library-row-actions').hidden = false;
        }
        confirming = entry.id;
        alsoTicked = false;
        row.querySelector('.library-row-actions').hidden = true;
        row.querySelector('.library-row-confirm').hidden = false;
        row.querySelector('[data-library-action="keep"]').focus();
        break;
      case 'keep':
        confirming = null;
        row.querySelector('.library-row-confirm').hidden = true;
        row.querySelector('.library-row-actions').hidden = false;
        row.querySelector('[data-library-action="forget"]').focus();
        break;
      case 'forget-confirmed': {
        const savedStates = row.querySelector('[data-library-also]')?.checked === true;
        const next = row.nextElementSibling?.querySelector('[data-library-action="details"]') ?? null;
        confirming = null;
        say(`Forgetting ${entry.name}…`);
        let result;
        try {
          result = await onForget(entry, { savedStates });
        } catch (error) {
          console.error('[My datasets] Forgetting failed:', error);
          result = null;
        }
        said = result === null || result.datasets === 0
          ? `${entry.name} could not be forgotten.`
          : `Forgot ${entry.name}.${result.savedStates > 0 ? ` Deleted ${formatCountOf(result.savedStates, 'saved state')}.` : ''}`;
        say(said, result === null || result.datasets === 0 ? 'danger' : 'success');
        // Focus stays in the dialog: the next row, else the filter.
        if (dom.dialog.open && !dom.dialog.contains(doc.activeElement)) (next?.isConnected ? next : dom.filter).focus();
        break;
      }
      default:
    }
  }, { signal });

  dom.exportButton.addEventListener('click', () => {
    if (exporting === null) openExport();
    else closeExport();
  }, { signal });
  dom.exportPanel.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || exporting === null) return;
    if (input.dataset.exportDataset !== undefined) {
      const id = input.dataset.exportDataset;
      if (input.checked) exporting.datasets.add(id);
      else exporting.datasets.delete(id);
      // A dataset ticked or unticked takes its saved states with it.
      for (const state of view.saved) {
        if (state.dataset?.id !== id || state.openable === false) continue;
        if (input.checked) exporting.states.add(state.id);
        else exporting.states.delete(state.id);
        const box = exportList.querySelector(`[data-export-state="${CSS.escape(state.id)}"]`);
        if (box !== null) box.checked = input.checked;
      }
    } else if (input.dataset.exportState !== undefined) {
      if (input.checked) exporting.states.add(input.dataset.exportState);
      else exporting.states.delete(input.dataset.exportState);
    }
    summarizeExport();
  }, { signal });
  dom.exportPanel.addEventListener('click', async event => {
    const control = event.target instanceof Element ? event.target.closest('[data-export-action]') : null;
    if (control === null || control.disabled || exporting === null) return;
    if (control.dataset.exportAction === 'cancel') {
      closeExport();
      return;
    }
    const choice = { datasets: [...exporting.datasets], savedStates: [...exporting.states] };
    busy = true;
    said = 'Exporting…';
    draw();
    say(said);
    let tone = 'success';
    try {
      said = describeExport(await onExport(choice));
      exporting = null;
    } catch (error) {
      console.error('[My datasets] Export failed:', error);
      said = `${joinFailure(`The library file could not be written`, sayFailure(error))}`;
      saidDetails = failureDetailsText(error);
      tone = 'danger';
    }
    busy = false;
    draw();
    say(said, tone);
    if (exporting === null && dom.dialog.open) dom.exportButton.focus();
  }, { signal });
  // Import… chooses the file inside the click.
  dom.importButton.addEventListener('click', () => {
    dom.importInput.value = '';
    dom.importInput.click();
  }, { signal });
  dom.importInput.addEventListener('change', () => {
    const file = dom.importInput.files?.[0] ?? null;
    dom.importInput.value = '';
    if (file !== null) void importFile(file);
  }, { signal });

  /** Import a library file, saying in the status line what was added; the focus goes to Import…. */
  async function importFile(file) {
    if (busy) return;
    exporting = null;
    busy = true;
    said = `Importing ${file.name}…`;
    draw();
    say(said);
    let tone = 'success';
    try {
      const report = await onImport(file);
      said = describeImport(report);
    } catch (error) {
      // A file that is not one this version imports is the person's choice, said in the status line.
      said = `${joinFailure(`${file.name} was not imported`, sayFailure(error))}`;
      saidDetails = failureDetailsText(error);
      tone = 'danger';
    }
    busy = false;
    draw();
    say(said, tone);
    if (dom.dialog.open) dom.importButton.focus();
  }

  return {
    /** @param {HTMLElement|null} [opener] - where focus returns on close */
    open(opener = null) {
      said = null;
      confirming = null;
      exporting = null;
      dom.filter.value = '';
      app.open(opener);
      draw();
    },
    /** @param {LibraryView} next */
    render(next) {
      view = next;
      const live = new Set(next.entries.map(entry => entry.id));
      for (const id of [...expanded]) if (!live.has(id)) expanded.delete(id);
      if (confirming !== null && !live.has(confirming)) confirming = null;
      if (exporting !== null) {
        // What left the list, or is no longer kept, leaves the choice.
        const kept = new Set(next.saved.map(state => state.id));
        for (const id of [...exporting.datasets]) if (!live.has(id)) exporting.datasets.delete(id);
        for (const id of [...exporting.states]) if (!kept.has(id)) exporting.states.delete(id);
      }
      draw();
      // A row Forget removed leaves the focus on nothing: the filter takes it.
      if (dom.dialog.open && !dom.dialog.contains(doc.activeElement)) dom.filter.focus();
    },
    /**
     * Import a library file chosen elsewhere (dropped on the page, or in
     * Open… › File…): as Import… does, in the open dialog.
     * @param {File} file
     */
    importFile: file => importFile(file),
    close: () => app.close(),
    get isOpen() {
      return dom.dialog.open;
    },
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}
