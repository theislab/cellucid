/**
 * @fileoverview Where the history's memory goes (History v2 §3.5, §3.15.4
 * "Warnings, not walls"). The history keeps every value of the person's
 * work in memory, never evicted; the memory model counts its typed arrays
 * as part of what is drawn (`data/memory-budget.js`, part `history`). Once
 * the history passes what the budget leaves for it (what is drawn, the
 * history included, is more than the app may use), the status line shows
 * "⚠ 1.2 GB" and says once which parts take the most ("Highlights at step
 * 31: 8 MB"). The chip opens the dialog: every part that holds memory,
 * largest first (`history.memoryParts()`), each step's part with Show, and
 * Recently deleted… to empty what it keeps.
 *
 * `memoryWords` and `historyOverBudget` are pure (Node).
 *
 * @module ui/modules/state/memory-dialog
 */

import { wireAppDialog } from '../../components/app-dialog.js';
import { createButton } from '../../components/controls.js';
import { formatBytes } from '../../../../utils/format-units.js';
import { idNumber } from '../../../history/model.js';

/**
 * Whether the history passes what the memory budget leaves for it: what is
 * drawn (the open cells, a graph, the history: `workingSetBytes`) is more
 * than the app may use (`memoryAllowanceBytes`), and the history holds
 * memory at all. No threshold of its own: the budget's.
 * @param {{historyBytes: number, workingSetBytes: number, allowanceBytes: number}} memory
 */
export function historyOverBudget({ historyBytes, workingSetBytes, allowanceBytes }) {
  return historyBytes > 0 && workingSetBytes > allowanceBytes;
}

/**
 * One part in words: "Highlights at step 31", "Recently deleted: Deleted
 * “Hid alpha”", "Changes made while paused", "Colors shown now".
 * @param {{kind: string, tracker: string|null, step: string|null, domain: string|null, label: string}} part
 * @param {{domainName: (id: string) => string, trackerName: (id: string) => string|null, shownTracker: string|null}} context
 */
export function memoryPartWords(part, { domainName, trackerName, shownTracker }) {
  const elsewhere = part.tracker !== null && part.tracker !== shownTracker ? ` (${trackerName(part.tracker) ?? 'another tracker'})` : '';
  switch (part.kind) {
    case 'step': return `${domainName(part.domain)} at ${part.step === null ? 'a step' : `step ${idNumber(part.step)}`}${elsewhere}`;
    case 'deleted': return `Recently deleted: ${part.label}${elsewhere}`;
    case 'paused': return `Changes made while paused${elsewhere}`;
    default: return `${domainName(part.domain)} shown now`;
  }
}

/**
 * The status line's warning and its one sentence naming the largest parts
 * (as many as the sentence holds without wrapping is not known here: the
 * two largest, the rest in the dialog).
 * @param {{total: number, parts: object[]}} memory - `history.memoryParts()`
 * @param {object} context - `memoryPartWords`'s
 */
export function memoryWords(memory, context) {
  const largest = memory.parts.slice(0, 2).map(part => `${memoryPartWords(part, context)}: ${formatBytes(part.bytes)}`);
  return {
    chip: `⚠ ${formatBytes(memory.total)}`,
    sentence: `The history keeps ${formatBytes(memory.total)}, more than this device has room for now. Largest: ${largest.join('; ')}.`,
  };
}

/**
 * @param {object} options
 * @param {HTMLDialogElement} options.dialog
 * @param {() => {history: object, view: object}|null} options.shown - the history and the panel's view
 * @param {(id: string) => string} options.domainName
 * @param {(stepId: string) => void} options.reveal - shows a step's row (details open)
 * @param {(opener: HTMLElement|null) => void} options.openDeleted - Recently deleted
 */
export function createMemoryDialog({ dialog, shown, domainName, reveal, openDeleted }) {
  const doc = dialog.ownerDocument;
  const app = wireAppDialog(dialog);
  const status = doc.getElementById('history-memory-status');
  const list = doc.getElementById('history-memory-list');
  const deletedButton = doc.getElementById('history-memory-deleted');
  deletedButton.addEventListener('click', () => {
    app.close();
    openDeleted(null);
  });

  function contextOf(history, view) {
    return {
      domainName,
      shownTracker: view?.id ?? null,
      trackerName: id => history.allTrackers().find(tracker => tracker.id === id)?.name ?? null,
    };
  }

  function fill() {
    const now = shown();
    if (now === null) {
      app.close();
      return;
    }
    const { history, view } = now;
    const memory = history.memoryParts();
    const context = contextOf(history, view);
    status.textContent = `The history keeps ${formatBytes(memory.total)} in memory: every value of every step, Recently deleted included. Largest first:`;
    list.replaceChildren(...memory.parts.map(part => {
      const item = doc.createElement('li');
      item.className = 'history-memory-item';
      item.dataset.kind = part.kind;
      const words = doc.createElement('span');
      words.className = 'history-memory-part';
      words.textContent = memoryPartWords(part, context);
      const size = doc.createElement('span');
      size.className = 'history-memory-bytes';
      size.textContent = formatBytes(part.bytes);
      item.append(words, size);
      if (part.kind === 'step' && part.tracker === view?.id && view.step(part.step) !== undefined) {
        // A row of the list: its action is quiet.
        const show = createButton({
          label: 'Show',
          variant: 'quiet',
          ariaLabel: `Show step ${idNumber(part.step)} (${part.label})`,
          className: 'history-memory-show',
        });
        show.addEventListener('click', () => {
          app.close();
          reveal(part.step);
        });
        item.append(show);
      }
      return item;
    }));
    deletedButton.hidden = !memory.parts.some(part => part.kind === 'deleted');
  }

  return {
    /** @param {HTMLElement|null} [opener] */
    open(opener = null) {
      fill();
      app.open(opener);
    },
    /** Kept current while open (the history changed). */
    refresh() {
      if (dialog.open) fill();
    },
    close: () => app.close(),
    destroy: () => app.destroy(),
  };
}
