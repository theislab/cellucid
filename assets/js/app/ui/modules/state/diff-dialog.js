/**
 * @fileoverview Compare two steps: what differs between the state after one
 * step and after another, part by part (the history's read `history.diff`:
 * the owners of the state describe their own values), for any two steps of
 * the tracker shown, on any branch. Each step is listed once, under its own
 * branch, by its number (History v2 §2.6 item 12: no number twice, every
 * option names its branch).
 *
 * @module ui/modules/state/diff-dialog
 */

import { reportHistoryFailure } from './shared.js';
import { pathTo } from './history-source.js';
import { idNumber } from '../../../history/model.js';
import { domainName } from '../../../actions/domains.js';
import { renderFactList } from '../../components/controls.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { failureText } from '../../../../utils/errors.js';

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {HTMLSelectElement} options.from
 * @param {HTMLSelectElement} options.to
 * @param {HTMLElement} options.status
 * @param {HTMLDListElement} options.list
 * @param {() => import('./history-source.js').TrackerView|null} options.view - the tracker shown
 * @param {(a: string, b: string) => Promise<{common: string|null, domains: Array<{domain: string, lines: string[]}>}>} options.read -
 *   `history.diff`
 */
export function createDiffDialog({ dialog, from, to, status, list, view, read }) {
  const ownerDocument = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const controller = new AbortController();
  let generation = 0;

  /** Every step once, under its own branch (branches in id order, steps in id order). */
  function choicesOf(tracker) {
    const out = [];
    for (const branch of tracker.branches()) {
      const own = branch.base === null ? pathTo(tracker, branch.tip).filter(step => step.branch === branch.id) : tracker.ownSteps(branch.id);
      for (const step of own) {
        out.push({ stepId: step.id, label: step.parent === null ? `Opening · ${step.label}` : `${idNumber(step.id)} · ${step.label}`, branch: branch.name });
      }
    }
    return out;
  }

  function fill(select, choices, value) {
    const groups = new Map();
    for (const choice of choices) {
      if (!groups.has(choice.branch)) {
        const group = ownerDocument.createElement('optgroup');
        group.label = choice.branch;
        groups.set(choice.branch, group);
      }
      const option = ownerDocument.createElement('option');
      option.value = choice.stepId;
      option.textContent = choice.label;
      groups.get(choice.branch).append(option);
    }
    select.replaceChildren(...groups.values());
    select.value = value;
  }

  async function compute() {
    const tracker = view();
    if (tracker === null) return;
    const run = ++generation;
    status.textContent = 'Comparing…';
    status.dataset.tone = 'muted';
    list.replaceChildren();
    try {
      const diff = await read(from.value, to.value);
      if (run !== generation) return;
      const branchOf = id => tracker.branch(tracker.step(id)?.branch)?.name ?? '';
      const parted = diff.common === from.value || diff.common === to.value
        ? `On one line of steps (${branchOf(diff.common === from.value ? to.value : from.value)})`
        : diff.common === null ? 'On two trackers'
          : `“${branchOf(from.value)}” and “${branchOf(to.value)}” part after step ${idNumber(diff.common)}`;
      if (diff.domains.length === 0) {
        status.textContent = `${parted}. Both show the same state.`;
        status.dataset.tone = 'success';
        return;
      }
      status.textContent = `${parted}. ${formatCountOf(diff.domains.length, 'part')} of the state ${diff.domains.length === 1 ? 'differs' : 'differ'}.`;
      status.dataset.tone = 'info';
      renderFactList(list, diff.domains.map(entry => ({
        label: domainName(entry.domain),
        value: '',
        lines: entry.lines.length > 0 ? entry.lines.map(String) : ['Changed'],
      })));
    } catch (error) {
      if (run !== generation) return;
      status.textContent = `These steps cannot be compared: ${failureText(error)}`;
      status.dataset.tone = 'danger';
      reportHistoryFailure('Comparing the steps', error);
    }
  }

  from.addEventListener('change', () => void compute(), { signal: controller.signal });
  to.addEventListener('change', () => void compute(), { signal: controller.signal });

  return {
    /**
     * Open on two steps of the tracker shown.
     * @param {string} fromId
     * @param {string} toId
     * @param {HTMLElement|null} [opener]
     */
    open(fromId, toId, opener = null) {
      const tracker = view();
      if (tracker === null) return;
      const choices = choicesOf(tracker);
      fill(from, choices, fromId);
      fill(to, choices, toId);
      from.setAttribute('aria-description', `The opening and ${formatCountOf(choices.length - 1, 'step')} on ${formatCountOf(new Set(choices.map(c => c.branch)).size, 'branch', 'branches')}`);
      app.open(opener);
      void compute();
    },
    close: () => app.close(),
    get isOpen() { return dialog.open; },
    /** The history changed: steps listed again; a step that is gone ends the comparison. */
    refresh() {
      if (!dialog.open) return;
      const tracker = view();
      if (tracker === null || tracker.step(from.value) === undefined || tracker.step(to.value) === undefined) {
        app.close();
        return;
      }
      const choices = choicesOf(tracker);
      fill(from, choices, from.value);
      fill(to, choices, to.value);
      void compute();
    },
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}

