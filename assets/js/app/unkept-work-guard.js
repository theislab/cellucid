/**
 * @fileoverview The one guard before the dataset shown is replaced, and
 * before the page is left, while work on it is not kept (with Autosave off,
 * opening another dataset would drop every step without a word).
 *
 * The work is not kept when the history shown holds steps (notes,
 * conversations, changes while paused) made since it was last saved and this
 * browser is not keeping them: Autosave switched off, no storage, or no room
 * (`dataset-history.js` `unkept`). Then:
 *
 * - **Opening another dataset** (the sample list, My datasets, a file, a
 *   link, a server, a catalog, a saved state or session file of another
 *   dataset, None, the benchmark, an agent's `dataset.open`) asks first, from
 *   the one place every replacement passes (`app/dataset/reload.js`, the
 *   benchmark's `benchmark-controls.js`): **Save…** (the
 *   history's Save file dialog; the opening waits for you to open it again),
 *   **Open anyway** or **Cancel**. Declined, the opening ends as cancelled and
 *   the dataset shown stays.
 * - **An agent's opening** is asked about through the app's one consent path
 *   (the dispatcher's confirmer, `ctx.confirm`: the person's card), not a
 *   dialog of its own (`app/ui/modules/dataset-open-action.js` sets
 *   `setAgentReplacementAsk`).
 * - **Reloading or closing the tab** gets the browser's leave-page question
 *   (`beforeunload`), in the same condition and only then.
 *
 * Reading the same dataset again on other cells (Cells to open) keeps its
 * history and asks nothing.
 *
 * @module app/unkept-work-guard
 */

import { cancelled } from '../utils/abort.js';
import { formatCountOf } from '../utils/format-units.js';
import { plainSentence, quoteName } from './actions/targets/names.js';

/**
 * Who asks for the agent's opening under way, or null when no agent is
 * opening a dataset: resolves to ask through the agent's consent path
 * (`text` → resolves to go on, throws when declined).
 *
 * @type {(() => ((text: string) => Promise<void>)|null)|null}
 */
let agentAsk = null;

/**
 * Set who asks when the opening is an agent's (one at a time); returns the
 * remover, which removes only this one.
 *
 * @param {() => ((text: string) => Promise<void>)|null} ask
 * @returns {() => void}
 */
export function setAgentReplacementAsk(ask) {
  if (typeof ask !== 'function') throw new TypeError('An agent replacement ask is a function.');
  if (agentAsk !== null) throw new Error('An agent replacement ask is set already.');
  agentAsk = ask;
  return () => {
    if (agentAsk === ask) agentAsk = null;
  };
}

const WHY = Object.freeze({
  off: 'Autosave in this browser is off',
  unavailable: 'this browser keeps nothing for this site',
  room: 'this browser has no room left to keep it',
});

/**
 * The sentence that says what would be lost, its names marked as data
 * (`quoteName`): "The 4 steps on "Pancreas" are not kept: Autosave in this
 * browser is off."
 *
 * @param {{dataset: string|null, steps: number, why: 'off'|'unavailable'|'room'}} unkept
 */
export function unkeptWorkSentence(unkept) {
  const on = unkept.dataset === null ? '' : ` on ${quoteName(unkept.dataset)}`;
  const steps = unkept.steps === 1 ? 'The step' : `The ${formatCountOf(unkept.steps, 'step')}`;
  return `${steps}${on} ${unkept.steps === 1 ? 'is' : 'are'} not kept: ${WHY[unkept.why]}.`;
}

/**
 * The guard, for `app/main.js`.
 *
 * @param {{
 *   unkept: () => ({dataset: string|null, steps: number, why: 'off'|'unavailable'|'room'}|null),
 *   ask: (question: {title: string, message: string}) => Promise<'save'|'open'|'cancel'>,
 *   save: () => void,
 * }} options - `unkept`: the work not kept now (`DatasetHistories.unkept`);
 *   `ask`: the person's question (Save…, Open anyway, Cancel); `save`: open
 *   the history's Save file dialog
 */
export function createUnkeptWorkGuard({ unkept, ask, save }) {
  return Object.freeze({
    /**
     * Before the dataset shown is replaced by `to` (its name, null when no
     * listing named it yet) or closed (`closing`, None): resolves when it
     * may be, and throws a cancellation when the person keeps it (Save… or
     * Cancel, or an agent's opening declined).
     *
     * @param {{to?: string|null, closing?: boolean}} change
     */
    async confirmReplacement({ to = null, closing = false }) {
      const work = unkept();
      if (work === null) return;
      const lost = unkeptWorkSentence(work);
      const what = closing ? 'Closing the dataset' : to === null ? 'Opening another dataset' : `Opening ${quoteName(to)}`;
      const agent = agentAsk?.() ?? null;
      if (agent !== null) {
        try {
          await agent(`${what} replaces the dataset shown. ${lost}`);
        } catch (error) {
          throw cancelled('user', 'The person kept the dataset shown: its work is not kept.', error);
        }
        return;
      }
      const answer = await ask({
        title: 'Your work is not kept',
        message: plainSentence(`${lost} ${what} replaces it.`),
      });
      if (answer === 'open') return;
      if (answer === 'save') save();
      throw cancelled('user', answer === 'save'
        ? 'The person is saving the work first; the dataset shown stays.'
        : 'The person kept the dataset shown.');
    },
    /** The page is being left (`beforeunload`): ask the browser's question when work would be lost. */
    onBeforeUnload(event) {
      if (unkept() === null) return;
      event.preventDefault();
      // Older engines show their question only when this is set.
      event.returnValue = '';
    },
  });
}
