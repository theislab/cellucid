/**
 * @fileoverview Recently deleted (History v2 §3.3.9): every edit of the
 * history that can still be undone, newest first, across the trackers of
 * this dataset (a removed tracker's removal included): what it did, who did
 * it and when, Restore (`history.journal.undo`) and Empty for one entry or
 * all (`history.journal.empty`, asked first: it can no longer be restored).
 * A restore says when it came back as new objects ("X (restored)").
 *
 * Ctrl+Z stays for the state; this is undo for the history itself.
 *
 * @module ui/modules/state/recently-deleted
 */

import { authorOf, formatAgo } from './model.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { ICONS, createButton, createIconButton } from '../../components/controls.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/**
 * The entries Recently deleted lists: every unpurged journal entry of every
 * tracker, newest first.
 * @param {object[]} trackers - Tracker records (journal as a list)
 * @returns {Array<{tracker: object, entry: object}>}
 */
export function journalEntries(trackers) {
  const out = [];
  for (const tracker of trackers) {
    const journal = tracker.journal instanceof Map ? [...tracker.journal.values()] : tracker.journal ?? [];
    for (const entry of journal) if (!entry.purged) out.push({ tracker, entry });
  }
  return out.sort((a, b) => (b.entry.at ?? 0) - (a.entry.at ?? 0));
}

/**
 * @param {object} options
 * @param {object} options.dom - `dom-cache.js` `state`
 * @param {(type: string, params: object) => Promise<unknown>} options.act
 * @param {() => object|null} options.history
 * @param {(question: object) => Promise<object|null>} options.ask
 * @param {(text: string, tone?: string) => void} options.notify
 * @param {() => number} [options.now]
 */
export function createRecentlyDeleted({ dom, act, history, ask, notify, now = () => Date.now() }) {
  const doc = dom.deletedDialog.ownerDocument;
  const app = wireAppDialog(dom.deletedDialog);
  const controller = new AbortController();
  const { signal } = controller;

  function trackersOf() {
    return history()?.trackers?.() ?? [];
  }

  function draw() {
    if (!dom.deletedDialog.open) return;
    const entries = journalEntries(trackersOf());
    const several = new Set(entries.map(each => each.tracker.id)).size > 1;
    dom.deletedStatus.textContent = entries.length === 0
      ? 'Nothing to restore. Deleted branches and steps, squashes, groups and notes come here.'
      : `${formatCountOf(entries.length, 'edit')} can be undone.`;
    dom.deletedEmpty.disabled = entries.length === 0;
    dom.deletedList.replaceChildren(...entries.map(({ tracker, entry }) => {
      const item = doc.createElement('li');
      item.className = 'history-deleted-item';
      item.dataset.entry = entry.id;
      const body = doc.createElement('div');
      body.className = 'history-deleted-body';
      const label = doc.createElement('span');
      label.className = 'history-deleted-label';
      label.textContent = entry.label;
      const meta = doc.createElement('span');
      meta.className = 'history-deleted-meta';
      meta.textContent = [authorOf(entry.by, null).name, formatAgo(entry.at, now()).long, several ? tracker.name : null].filter(Boolean).join(' · ');
      body.append(label, meta);
      // A row of the list: Restore is its quiet main action.
      const restore = createButton({ label: 'Restore', variant: 'quiet-primary', ariaLabel: `Restore: ${entry.label}` });
      restore.addEventListener('click', async () => {
        const outcome = await act('history.journal.undo', { entry: entry.id, tracker: tracker.id });
        if (outcome?.restored === 'as-new') notify(`${entry.label}: restored as new, since what it changed was changed again.`, 'warning');
        else if (outcome !== undefined) notify(`Restored: ${entry.label}.`, 'success');
        draw();
      });
      const empty = createIconButton({ label: `Empty from Recently deleted: ${entry.label}`, icon: ICONS.delete, tone: 'danger' });
      empty.title = 'Empty it: it can no longer be restored';
      empty.addEventListener('click', async () => {
        await act('history.journal.empty', { entry: entry.id, tracker: tracker.id });
        draw();
      });
      item.append(body, restore, empty);
      return item;
    }));
  }

  dom.deletedEmpty.addEventListener('click', async () => {
    const entries = journalEntries(trackersOf());
    if (entries.length === 0) return;
    const answer = await ask({
      title: 'Empty Recently deleted?',
      lines: [`${formatCountOf(entries.length, 'edit')} can no longer be undone, and the memory they hold is freed.`],
      answers: [{ value: 'empty', label: 'Empty', tone: 'danger' }],
    });
    if (answer === null) return;
    app.open(dom.deletedEmpty);
    for (const tracker of new Set(entries.map(each => each.tracker))) {
      await act('history.journal.empty', { tracker: tracker.id });
    }
    draw();
  }, { signal });

  return {
    open(opener = null) {
      app.open(opener);
      draw();
    },
    refresh: draw,
    close: () => app.close(),
    destroy() {
      controller.abort();
      app.destroy();
    },
  };
}
