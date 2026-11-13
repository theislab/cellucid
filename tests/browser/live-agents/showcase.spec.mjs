/**
 * The four showcase tasks, end to end, with a real model in the chat bar:
 * annotate clusters, compare populations, a guided first look at the open
 * dataset, and explain a history. Claude's flagship (Anthropic, the main
 * provider) and OpenAI's cheapest model (the parity run) each do all four.
 *
 * Each task is judged on the app, never on the model's words: the steps the
 * turn made exist and are the agent's (origin, name, turn), the state they
 * reach is what the task asks (a new annotation field colored by; a
 * differential expression run and a gene colored by; a first coloring; a
 * history read with nothing changed), the model wrote an answer, and one
 * click of Undo turn puts every state domain back.
 *
 * Local only, with the owner's keys (`live-harness.mjs`); skipped otherwise.
 */
import { expect, test } from '../helpers/test.mjs';
import {
  LIVE_USE, createLedger, fingerprint, liveSkipReason, liveTurn, openLiveChat, stepsOfTurn, undoTurnByClick,
} from './live-harness.mjs';

const RUNS = [
  { provider: 'anthropic', model: 'claude-opus-5-5', agent: 'Claude' },
  { provider: 'openai', model: 'gpt-6-luna', agent: 'ChatGPT' },
];
const CELL_TYPE = Object.freeze({ source: 'obs', key: 'cell_type' });

async function shownField(page) {
  return page.evaluate(async () => {
    const { getStateDomains } = await import('/assets/js/app/actions/index.js');
    // The live view's field (the first view): {source, key}, or null.
    return (await getStateDomains().owner('active-field').capture()).views[0];
  });
}

async function obsFields(page) {
  return page.evaluate(() => (window._cellucidState.obsData?.fields ?? []).filter(field => field._isDeleted !== true)
    .map(field => ({ key: field.key, user: field._userDefinedId ?? null, kind: field.kind, categories: field.categories ?? null })));
}

// No trace, screenshot or video: nothing that could keep a request.
test.use(LIVE_USE);

for (const run of RUNS) {
  test.describe(`live showcase: ${run.provider} ${run.model}`, () => {
    const ledger = createLedger();
    test.skip(() => liveSkipReason(run.provider) !== null, liveSkipReason(run.provider) ?? '');
    test.afterAll(() => {
      console.log(ledger.report(`Live showcase, ${run.provider}`));
    });

    async function task(page, text) {
      const turn = await liveTurn(page, text);
      for (const usage of turn.usage) ledger.add(usage.model, usage);
      ledger.addProgress(test.info().title.split(':')[0], turn.progress, turn.usage);
      expect(turn.notes.filter(note => ['error', 'refusal', 'empty', 'limit'].includes(note.kind))).toEqual([]);
      expect(turn.replied).toBe(true);
      return turn;
    }

    test('annotate clusters: markers read, labels written as a new annotation field, colored by it, one click undoes it', async ({ page }) => {
      test.setTimeout(15 * 60_000);
      await openLiveChat(page, run);
      const before = await fingerprint(page);
      const fieldsBefore = await obsFields(page);
      // The fixture's genes barely tell its clusters apart: a careful model asks or declines unless told to label anyway.
      const turn = await task(page, 'Annotate the clusters of cell_type: read their marker genes, propose a cell-type label for each cluster, write the labels as a new annotation field (keep cell_type as it is), color by it, and explain each label. This is a small test dataset: where the markers are weak, still give each cluster your best label and say how unsure it is.');
      const steps = await stepsOfTurn(page, turn.turn);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every(step => step.origin === 'agent' && step.agent === run.agent)).toBe(true);
      const fieldsAfter = await obsFields(page);
      const added = fieldsAfter.filter(field => !fieldsBefore.some(old => old.key === field.key));
      expect(added.length, 'a new annotation field').toBeGreaterThan(0);
      expect(fieldsAfter.find(field => field.key === 'cell_type').categories).toEqual(fieldsBefore.find(field => field.key === 'cell_type').categories);
      const shown = await shownField(page);
      const shownNew = added.find(field => (shown?.user === undefined ? field.key === shown?.key : field.user === shown.user));
      expect(shownNew, 'colored by the new field').toBeDefined();
      await undoTurnByClick(page, turn.turn);
      expect(await fingerprint(page)).toEqual(before);
    });

    test('compare populations: two groups, differential expression run, a telling gene colored by, one click undoes it', async ({ page }) => {
      test.setTimeout(15 * 60_000);
      await openLiveChat(page, run);
      const before = await fingerprint(page);
      const turn = await task(page, 'Compare the alpha cells with the beta cells of cell_type: run differential expression between them, explain the top genes in each direction, and color by the most telling gene.');
      const steps = await stepsOfTurn(page, turn.turn);
      expect(steps.every(step => step.origin === 'agent' && step.agent === run.agent)).toBe(true);
      expect(turn.calls.some(call => /^analysis_/.test(call.name) && call.isError === false), 'an analysis ran').toBe(true);
      expect(steps.some(step => step.type.startsWith('analysis.'))).toBe(true);
      const shown = await shownField(page);
      expect(shown?.source, 'colored by a gene').toBe('var');
      await undoTurnByClick(page, turn.turn);
      expect(await fingerprint(page)).toEqual(before);
    });

    test('a guided first look: the dataset read, a sensible first coloring, one click undoes it', async ({ page }) => {
      test.setTimeout(15 * 60_000);
      await openLiveChat(page, run);
      // The dataset opens colored by its cell types: the person cleared that, so a first coloring is the agent's to choose.
      await page.evaluate(async () => {
        const { getActions } = await import('/assets/js/app/actions/index.js');
        await getActions().dispatch('color.by', { field: null });
      });
      const before = await fingerprint(page);
      const turn = await task(page, 'Give me a guided first look at this dataset.');
      const reads = turn.calls.filter(call => ['dataset_summary', 'fields_list', 'field_summary', 'field_categories'].includes(call.name));
      expect(reads.length, 'the dataset was read').toBeGreaterThan(0);
      const steps = await stepsOfTurn(page, turn.turn);
      expect(steps.some(step => step.type === 'color.by'), 'a first coloring').toBe(true);
      expect(steps.every(step => step.origin === 'agent' && step.agent === run.agent)).toBe(true);
      await undoTurnByClick(page, turn.turn);
      expect(await fingerprint(page)).toEqual(before);
    });

    test('explain a history: the history read, nothing changed, a methods paragraph written', async ({ page }) => {
      test.setTimeout(15 * 60_000);
      await openLiveChat(page, run);
      // What the person did before asking.
      await page.evaluate(async field => {
        const { getActions } = await import('/assets/js/app/actions/index.js');
        await getActions().dispatch('color.by', { field });
        await getActions().dispatch('filter.category.visibility', { field, categories: ['gamma'], visible: false });
        await getActions().dispatch('color.by', { field: { source: 'var', key: 'CD3E' } });
      }, CELL_TYPE);
      const before = await fingerprint(page);
      const turn = await task(page, 'Explain what was done in this history, step by step and by whom, then write a methods paragraph for a paper. Do not change anything.');
      expect(turn.calls.some(call => call.name === 'history_get' && call.isError === false), 'the history was read').toBe(true);
      expect(await stepsOfTurn(page, turn.turn)).toEqual([]);
      expect(await fingerprint(page)).toEqual(before);
    });
  });
}
