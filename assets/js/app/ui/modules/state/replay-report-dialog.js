/**
 * @fileoverview The report of a replay (History v2 §3.10; E2's report, in a
 * dialog): "Replayed “Main” on Sample B · 14 of 16 steps applied", then each
 * step replayed, ✓ applied, = unchanged here, ✗ not applied (with why),
 * skipped or stopped; a step not applied is shown in the graph by its button.
 * It reads the tracker's own record (`start.report`), so a saved and loaded
 * replay reports the same.
 *
 * A step that did not match because a name it gave is not here (a field, a
 * category or a gene: `ReplayEntry.missing`) offers "Use instead ▾": the
 * names this dataset has, read as an agent reads them (`fields.list`,
 * `field.categories`, `genes.search`). "Replay again with these names"
 * shows where the replay started (its first step), then replays the same
 * steps from the same source in a new tracker, with the
 * tracker's mapping and the names chosen (`replay.js` `mappingWith`); "Keep
 * as is" closes. The same name missing in several steps is chosen once.
 *
 * @module ui/modules/state/replay-report-dialog
 */

import { wireAppDialog } from '../../components/app-dialog.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { mappingWith, missingKey } from '../../../history/replay.js';

const MARKS = Object.freeze({ applied: '✓', unchanged: '=', unmatched: '✗', skipped: '–', stopped: '■' });
const WORDS = Object.freeze({
  applied: 'applied', unchanged: 'changed nothing here', unmatched: 'not applied', skipped: 'skipped', stopped: 'stopped',
});
const KIND_WORDS = Object.freeze({ field: 'field', category: 'category', gene: 'gene' });

/**
 * The report's heading for a replayed tracker.
 * @param {object} tracker
 */
export function replayHeading(tracker) {
  const start = tracker.start;
  const report = start?.report ?? [];
  const applied = report.filter(entry => entry.outcome === 'applied' || entry.outcome === 'unchanged').length;
  const branch = start?.from?.branch?.name ? `“${start.from.branch.name}”` : 'the steps';
  return `Replayed ${branch} of ${start?.from?.dataset?.name ?? 'another dataset'}: ${applied} of ${formatCountOf(report.length, 'step')} applied`;
}

/**
 * The names a replay's report offers to choose for: each distinct name
 * missing here, in report order.
 * @param {Array<{outcome: string, missing?: object|null}>} report
 * @returns {Array<{kind: string, name: string, field: string|null}>}
 */
export function missingNames(report) {
  const seen = new Map();
  for (const entry of report) {
    if (entry.outcome !== 'unmatched' || entry.missing == null) continue;
    const key = missingKey(entry.missing);
    if (!seen.has(key)) seen.set(key, entry.missing);
  }
  return [...seen.values()];
}

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {(stepId: string) => void} options.reveal - shows a step's row in the graph
 * @param {(type: string, params: object) => Promise<unknown>} options.read - a read action's outcome
 * @param {{can: (trackerId: string) => boolean, replay: (tracker: object, mapping: object) => void}|null} options.again -
 *   replays the tracker's steps again with `mapping` (the panel's progress and report), or null where it cannot
 */
export function createReplayReport({ dialog, reveal, read, again }) {
  const doc = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const summary = doc.getElementById('history-replay-summary');
  const list = doc.getElementById('history-replay-list');
  const closeButton = dialog.querySelector('.app-dialog-actions [data-dialog-close]');
  const actions = closeButton.parentElement;
  const againButton = doc.createElement('button');
  againButton.type = 'button';
  againButton.className = 'btn btn-compact btn-primary history-replay-again';
  againButton.textContent = 'Replay again with these names';
  const againWhy = doc.createElement('p');
  againWhy.className = 'status-line history-replay-again-why';
  againWhy.hidden = true;
  actions.prepend(againButton);
  actions.before(againWhy);
  /** The tracker shown, and the name chosen for each missing one (by `missingKey`). */
  let shown = null;
  const chosen = new Map();
  /** One read per field, and the dataset's fields, while the dialog is open. */
  let reads = new Map();
  let suggestionLists = 0;

  function readOnce(key, task) {
    if (!reads.has(key)) reads.set(key, task().catch(error => {
      reads.delete(key);
      throw error;
    }));
    return reads.get(key);
  }

  const fieldsHere = () => readOnce('fields', async () => (await read('fields.list', {})).fields.map(field => field.key));
  const categoriesHere = field => readOnce(`categories\u0000${field}`, async () => (
    await read('field.categories', { field: { source: 'obs', key: field } })).categories.map(category => category.label));

  function renderAgain() {
    const offered = shown === null ? [] : missingNames(shown.start?.report ?? []);
    const able = offered.length > 0 && again !== null && again.can(shown.id);
    againButton.hidden = offered.length === 0;
    againButton.disabled = !able || ![...chosen.values()].some(value => value !== '');
    againWhy.hidden = offered.length === 0 || able;
    againWhy.textContent = able ? '' : 'The steps it replayed are not at hand on this page: replay the session file again (Load… › Replay a session file here…).';
    closeButton.textContent = offered.length === 0 ? 'Close' : 'Keep as is';
  }

  /** Every control of one missing name shows the same choice. */
  function choose(key, value) {
    chosen.set(key, value);
    for (const control of list.querySelectorAll('[data-missing-key]')) {
      if (control.dataset.missingKey === key && control.value !== value) control.value = value;
    }
    renderAgain();
  }

  /** "Use instead ▾" for a field or a category: the names this dataset has. */
  function selectFor(missing, key) {
    const select = doc.createElement('select');
    select.className = 'obs-select history-replay-instead-select';
    select.dataset.missingKey = key;
    select.setAttribute('aria-label', `Use instead of the ${KIND_WORDS[missing.kind]} “${missing.name}”`);
    const blank = doc.createElement('option');
    blank.value = '';
    blank.textContent = 'Use instead…';
    select.append(blank);
    select.disabled = true;
    const names = missing.kind === 'field' ? fieldsHere() : categoriesHere(missing.field);
    names.then(found => {
      for (const name of found) {
        const option = doc.createElement('option');
        option.value = name;
        option.textContent = name;
        select.append(option);
      }
      select.disabled = found.length === 0;
      select.value = chosen.get(key) ?? '';
    }, error => {
      blank.textContent = 'Names could not be read';
      select.title = error?.message ?? String(error);
    });
    select.addEventListener('change', () => choose(key, select.value));
    return select;
  }

  /** "Use instead ▾" for a gene: typed, with the dataset's genes that match as suggestions. */
  function geneInputFor(missing, key) {
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'obs-select history-replay-instead-input';
    input.dataset.missingKey = key;
    input.placeholder = 'Use instead…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Use instead of the gene “${missing.name}”`);
    const suggestions = doc.createElement('datalist');
    suggestions.id = `history-replay-genes-${++suggestionLists}`;
    input.setAttribute('list', suggestions.id);
    let asked = 0;
    const suggest = async query => {
      const ask = ++asked;
      try {
        const outcome = await read('genes.search', { query });
        if (ask !== asked) return;
        suggestions.replaceChildren(...outcome.genes.map(gene => {
          const option = doc.createElement('option');
          option.value = gene;
          return option;
        }));
      } catch {
        // A suggestion is a help; the name typed is replayed as it is.
      }
    };
    void suggest(missing.name);
    input.addEventListener('input', () => {
      choose(key, input.value.trim());
      if (input.value.trim() !== '') void suggest(input.value.trim());
    });
    input.value = chosen.get(key) ?? '';
    return [input, suggestions];
  }

  function insteadFor(missing) {
    const key = missingKey(missing);
    const box = doc.createElement('span');
    box.className = 'history-replay-instead';
    if (missing.kind === 'gene') box.append(...geneInputFor(missing, key));
    else box.append(selectFor(missing, key));
    return box;
  }

  againButton.addEventListener('click', () => {
    if (shown === null || again === null) return;
    const choices = missingNames(shown.start?.report ?? [])
      .map(missing => ({ missing, to: chosen.get(missingKey(missing)) ?? '' }))
      .filter(choice => choice.to !== '');
    if (choices.length === 0) return;
    const tracker = shown;
    app.close();
    void again.replay(tracker, mappingWith(tracker.start?.mapping ?? null, choices));
  });

  return {
    /**
     * @param {object} tracker - the replayed tracker
     * @param {HTMLElement|null} [opener]
     */
    open(tracker, opener = null) {
      shown = tracker;
      chosen.clear();
      reads = new Map();
      summary.textContent = replayHeading(tracker);
      list.replaceChildren(...(tracker.start?.report ?? []).map(entry => {
        const item = doc.createElement('li');
        item.className = 'history-replay-item';
        item.dataset.outcome = entry.outcome;
        const mark = doc.createElement('span');
        mark.className = 'history-replay-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = MARKS[entry.outcome] ?? '?';
        const label = entry.step === null ? doc.createElement('span') : doc.createElement('button');
        label.className = 'history-replay-step';
        label.textContent = entry.label;
        if (entry.step !== null) {
          label.type = 'button';
          label.title = 'Show this step in the graph';
          label.addEventListener('click', () => {
            app.close();
            reveal(entry.step);
          });
        }
        const what = doc.createElement('span');
        what.className = 'history-replay-reason';
        what.textContent = entry.reason === null ? WORDS[entry.outcome] : `${WORDS[entry.outcome]}: ${entry.reason}`;
        item.append(mark, label, what);
        if (entry.outcome === 'unmatched' && entry.missing != null) item.append(insteadFor(entry.missing));
        return item;
      }));
      renderAgain();
      app.open(opener);
    },
    close: () => app.close(),
    destroy: () => app.destroy(),
  };
}
