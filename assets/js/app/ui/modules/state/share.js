/**
 * @fileoverview A history shared in words: copy it as pseudocode or a
 * methods paragraph (the history's reads `history.pseudocode` and
 * `history.methods`, which an agent and a notebook read too), or open a
 * printable report of the branch shown up to the step shown (made by
 * `app/history/exports/report.js` from the tracker, the catalog, the
 * dataset's facts and the version: its own methods text and pseudocode) in a
 * window of its own where the person reads, prints or saves it as PDF.
 *
 * An agent, a notebook and a replay make the same document with
 * `history.report` (provided by `index.js` through `report`): a window
 * opens only from the person's click, so it is written as an `.html` file
 * the person receives, or given as text.
 *
 * Pictures in the report (none is ever stored): when the
 * page can draw the selected view as a picture (`pictures`: the figure
 * export's own drawing, the read `view.picture`), the person chooses the
 * steps that get one (the bookmarks and the last step of each group by
 * default); each is shown in turn (`history.jump`), drawn, and the history
 * returns to the step it showed. Pictures are a setting of this browser
 * (`history-settings.js` `reportPictures`), switched in the report's dialog.
 *
 * @module ui/modules/state/share
 */

import { reportHistoryFailure } from './shared.js';
import { ActionRefused } from '../../../actions/dispatcher.js';
import { reportDocument, reportPictureDefaults } from '../../../history/exports/report.js';
import { pathTo } from './history-source.js';
import { historySettings, setHistorySetting } from '../../../history/history-settings.js';
import { wireAppDialog } from '../../components/app-dialog.js';
import { formatCountOf } from '../../../../utils/format-units.js';
import { quoteName } from '../../../actions/targets/names.js';
import { throwIfAborted } from '../../../../utils/abort.js';
import { copyText } from '../../../utils/clipboard.js';

/** The release version the page names (`<meta name="cellucid-version">`). */
export function pageVersion(ownerDocument) {
  return ownerDocument.querySelector('meta[name="cellucid-version"]')?.getAttribute('content') ?? null;
}

/**
 * @param {object} options
 * @param {Document} options.ownerDocument
 * @param {() => object|null} options.history
 * @param {() => import('./history-source.js').TrackerView|null} options.view - the tracker shown
 * @param {(type: string, params: object) => Promise<{text: string}>} options.read - a history read
 * @param {(stepId: string, how?: {signal?: AbortSignal|null}) => Promise<unknown>} options.jump - `history.jump`
 * @param {() => object} options.datasetFacts - `dataset-facts.js`
 * @param {(() => Promise<{png: string}>)|null} options.pictures - Draw the selected view as a PNG
 *   (base64, the read `view.picture`), or null when this page cannot
 * @param {{dialog: HTMLDialogElement, picturesToggle: HTMLInputElement, steps: HTMLElement,
 *   openButton: HTMLButtonElement}|null} options.reportDom
 * @param {(task: () => Promise<unknown>, what: string) => Promise<unknown>} options.run
 */
export function createHistorySharing({
  ownerDocument, history, view, read: readHistory, jump, datasetFacts, pictures, reportDom, run,
}) {
  const controller = new AbortController();
  const reportDialog = reportDom === null ? null : wireAppDialog(reportDom.dialog);

  /**
   * What the report covers: the branch shown up to the step shown (`to`;
   * null at its tip), and the steps of that path.
   */
  function shown() {
    const tracker = view();
    if (tracker === null) throw new Error('No history is shown');
    const branch = tracker.activeBranch;
    const to = tracker.branch(branch)?.tip === tracker.headId ? null : tracker.headId;
    return { tracker, branch, to, steps: pathTo(tracker, tracker.headId) };
  }

  /** The history's own text of a branch (its read; the branch shown when null). */
  async function textOf(type, branch) {
    return (await readHistory(type, branch === null ? {} : { branch })).text;
  }

  async function copy(text, what, count) {
    await copyText(text, {
      what,
      success: count === null ? `Copied ${what}.` : `Copied ${what} of ${formatCountOf(count, 'step')}.`,
      category: 'session',
    });
  }

  function writeReport(win, html) {
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
  }

  /**
   * Draw the views after each chosen step; back to the step shown after.
   * `signal` (an agent's `history.report`): stopped, no further step is
   * shown, the jump under way ends, and the step shown before comes back
   * before the report ends as a cancellation.
   */
  async function picturesOf(tracker, chosen, signal = null) {
    const out = new Map();
    if (pictures === null || chosen.length === 0) return out;
    const returnTo = tracker.headId;
    try {
      for (const step of chosen) {
        throwIfAborted(signal);
        await jump(step.id, { signal });
        throwIfAborted(signal);
        const { png } = await pictures();
        out.set(step.id, { src: `data:image/png;base64,${png}`, alt: `The view after “${step.label}”` });
      }
    } finally {
      if (view()?.id === tracker.id && view().headId !== returnTo) await jump(returnTo);
    }
    return out;
  }

  /**
   * The report of the branch shown up to the step shown, with a picture of
   * the views after each step of `chosenIds`: the document the window shows
   * and an agent's `history.report` writes or reads (`signal`: its Stop).
   */
  async function makeReport(chosenIds, signal = null) {
    const { tracker, branch, to, steps } = shown();
    const chosen = steps.filter(step => chosenIds.has(step.id));
    const shot = await picturesOf(tracker, chosen, signal);
    // The report's own methods text, pseudocode and entries (`report.js`), of the tracker record.
    const html = reportDocument({
      tracker: tracker.tracker, branch, to, catalog: history()?.catalog, generatedAt: Date.now(),
      version: pageVersion(ownerDocument), dataset: datasetFacts(), pictures: shot,
      picturesNote: pictures === null
        ? 'Pictures of the views are not available in this version of Cellucid.'
        : null,
    });
    return {
      html,
      tracker: { id: tracker.id, name: tracker.name },
      branch: { id: branch, name: tracker.branch(branch)?.name ?? branch },
      to,
      steps: steps.filter(step => step.parent !== null).length,
      pictures: shot.size,
    };
  }

  /**
   * The steps that get a picture: none, the dialog's default picks (the
   * bookmarks, the last step of each group, the step shown), or steps named
   * by id, each of the branch shown (else one sentence says which are).
   *
   * @param {'none'|'default'|string[]} choice
   * @returns {Set<string>}
   */
  function pictureChoice(choice) {
    if (choice === 'none') return new Set();
    const { tracker, branch, to, steps } = shown();
    const taken = steps.filter(step => step.parent !== null);
    if (choice === 'default') {
      const last = taken[taken.length - 1]?.id ?? null;
      return new Set([last, ...reportPictureDefaults(tracker.tracker, { branch, to })].filter(id => id !== null));
    }
    const onPath = new Set(taken.map(step => step.id));
    const off = choice.filter(id => !onPath.has(id));
    if (off.length > 0) {
      throw new ActionRefused(
        `${off.map(id => `${quoteName(id)}`).join(', ')} ${off.length === 1 ? 'is' : 'are'} not a step of the branch shown up to the step shown; its steps are ${taken.length === 0 ? 'none yet' : `${taken[0].id} to ${taken.at(-1).id}`} (history_get).`,
        { code: 'no-target', type: 'history.report' },
      );
    }
    return new Set(choice);
  }

  async function openReport(win, chosenIds) {
    try {
      const { html } = await makeReport(chosenIds);
      if (win.closed) return;
      writeReport(win, html);
    } catch (error) {
      if (!win.closed) win.close();
      throw error;
    }
  }

  /** A window opened inside the click (a browser allows no other), filled once the report is made. */
  function reportWindow() {
    const win = globalThis.open('', '_blank');
    if (win === null) throw new Error('The browser blocked the report window; allow pop-ups for this site');
    win.document.title = 'Preparing the report…';
    win.document.body.textContent = 'Preparing the report…';
    return win;
  }

  function fillReportChoices() {
    const { tracker, branch, to, steps } = shown();
    const taken = steps.filter(step => step.parent !== null);
    const last = taken[taken.length - 1]?.id ?? null;
    // The default picks: the bookmarks and the last step of each group (`reportPictureDefaults`), and the step shown.
    const picked = new Set([last, ...reportPictureDefaults(tracker.tracker, { branch, to })]);
    const rows = taken.map((step, index) => {
      const label = ownerDocument.createElement('label');
      label.className = 'checkbox-inline history-report-step';
      const box = ownerDocument.createElement('input');
      box.type = 'checkbox';
      box.value = step.id;
      box.checked = picked.has(step.id);
      const text = ownerDocument.createElement('span');
      text.textContent = `${index + 1} · ${step.label}`;
      text.title = step.label;
      label.append(box, text);
      return label;
    });
    reportDom.steps.replaceChildren(...rows);
    reportDom.picturesToggle.checked = historySettings().reportPictures;
    reportDom.steps.hidden = !reportDom.picturesToggle.checked;
  }

  if (reportDom !== null) {
    reportDom.picturesToggle.addEventListener('change', () => {
      // Kept in this browser for the next report.
      setHistorySetting('reportPictures', reportDom.picturesToggle.checked);
      reportDom.steps.hidden = !reportDom.picturesToggle.checked;
    }, { signal: controller.signal });
    reportDom.openButton.addEventListener('click', () => {
      let win;
      try { win = reportWindow(); } catch (error) { reportHistoryFailure('Opening the report', error); return; }
      const chosen = new Set(reportDom.picturesToggle.checked
        ? [...reportDom.steps.querySelectorAll('input:checked')].map(box => box.value)
        : []);
      reportDialog.close();
      void run(() => openReport(win, chosen), 'Making the report');
    }, { signal: controller.signal });
  }

  return {
    /** @param {string|null} branch - a branch's pseudocode; the one shown when null */
    async copyPseudocode(branch = null) {
      try {
        const text = await textOf('history.pseudocode', branch);
        await copy(text, 'the pseudocode', null);
      } catch (error) {
        reportHistoryFailure('Copying the pseudocode', error);
      }
    },
    async copyMethods() {
      try {
        const text = await textOf('history.methods', null);
        await copy(text, 'the methods paragraph', null);
      } catch (error) {
        reportHistoryFailure('Copying the methods paragraph', error);
      }
    },
    /** @param {HTMLElement|null} [opener] */
    printReport(opener = null) {
      if (pictures !== null && reportDom !== null) {
        fillReportChoices();
        reportDialog.open(opener);
        return;
      }
      let win;
      try { win = reportWindow(); } catch (error) { reportHistoryFailure('Opening the report', error); return; }
      void run(() => openReport(win, new Set()), 'Making the report');
    },
    /**
     * The report as `history.report` makes it: its HTML and what it covers.
     * Pictures need the page's drawing of a view; a text is never given any.
     *
     * @param {{pictures: 'none'|'default'|string[], signal?: AbortSignal|null}} options - `signal`:
     *   what stops it (the action's Stop): the steps shown for pictures stop and the step shown comes back
     */
    async report({ pictures: choice, signal = null }) {
      if (choice !== 'none' && pictures === null) {
        throw new ActionRefused('This page cannot draw the views as pictures, so the report can have none: ask for pictures "none".', {
          code: 'unavailable', type: 'history.report',
        });
      }
      return makeReport(pictureChoice(choice), signal);
    },
    destroy() {
      controller.abort();
      reportDialog?.destroy();
    },
  };
}
