/**
 * What a person does that an agent does too, driven through the chat bar
 * with the scripted model on a real page: the guided tour, Print report,
 * My datasets' Forget and sizes, the Stored dialog's list and removal, the
 * figure export's Download, the highlighted cells and a field as files,
 * community annotation and Share's link (`tests/action-catalog-contract.test.mjs`
 * `PERSON_FEATURES`). Each call is asked of the person where its kind says
 * (`writes-file`, `deletes-saved`, `publishes`; a move of the history and a
 * read never), answers as its schema promises, and, with the dataset set to
 * names and summaries only, an export still runs and tells the agent no
 * value of a cell.
 */
import { expect, test } from './helpers/test.mjs';
import {
  CELL_TYPE, agentRequests, installScriptedModel, observeProductErrors, openAgentDataset, openChat, queueReplies,
  resultJson, waitForTurnEnd,
} from './helpers/agent-chat.mjs';

const card = page => page.locator('#agent-presence .agent-confirm');

/** Send a message; the turn goes on while the person answers cards. */
async function send(page, text) {
  await page.locator('#agent-chat-input').fill(text);
  await page.locator('#agent-chat-input').press('Enter');
}

/** The result the model was sent for its last call of tool `name`. */
async function lastResult(page, name) {
  const requests = await agentRequests(page);
  for (let index = requests.length - 1; index >= 0; index--) {
    const results = requests[index].messages.at(-1)?.results ?? [];
    const found = results.findLast(result => result.name === name);
    if (found !== undefined) return { isError: found.isError === true, text: found.content.find(item => item.type === 'text')?.text ?? '' };
  }
  throw new Error(`No result of ${name} was sent`);
}

/** One call of the scripted model, then its closing words; the card it asks (or none) answered with `answer`. */
async function callTool(page, name, args, { asks = null, answer = 'allow' } = {}) {
  await queueReplies(page, [{ calls: [{ name, args }] }, { text: `Done with ${name}.` }]);
  await send(page, `Please ${name}`);
  if (asks !== null) {
    await expect(card(page)).toHaveAttribute('data-asking', asks);
    await card(page).locator(answer === 'allow' ? '.agent-confirm-allow' : '.agent-confirm-deny').click();
  }
  await waitForTurnEnd(page);
  await expect(card(page)).toHaveCount(0);
  return lastResult(page, name);
}

/** The person's own steps, so the tour and the report have something to show. */
async function makeSteps(page) {
  await page.evaluate(async field => {
    const { getActions } = await import('/assets/js/app/actions/index.js');
    const actions = getActions();
    await actions.dispatch('color.by', { field });
    await actions.dispatch('highlight.cells', { cells: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  }, CELL_TYPE);
}

async function setSummariesOnly(page, on) {
  await page.evaluate(value => {
    const id = window._cellucidHistories.current().dataset.id;
    window._cellucidUi.agents.dataStore.setSummariesOnly(id, value);
  }, on);
}

test.describe('agent: what a person does', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  test('the guided tour starts and stops as the panel\'s does; the report as text is not asked, as a file it is', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await makeSteps(page);
    await openChat(page);
    const head = await page.evaluate(() => window._cellucidHistories.current().active.headId);

    const started = await callTool(page, 'history_tour_start', {});
    expect(started.isError, started.text).toBe(false);
    const tour = resultJson(started.text);
    expect(tour).toMatchObject({ returns_to: head, branch: { name: 'Main' } });
    expect(tour.steps).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.history-tour-bar')).toBeVisible();

    const stopped = await callTool(page, 'history_tour_stop', {});
    expect(resultJson(stopped.text)).toEqual({ stopped: true, head });
    await expect(page.locator('.history-tour-bar')).toHaveCount(0);
    expect(resultJson((await callTool(page, 'history_tour_stop', {})).text)).toEqual({ stopped: false, head });

    const text = await callTool(page, 'history_report', { as: 'text' });
    const asText = resultJson(text.text);
    expect(asText).toMatchObject({ as: 'text', file: null, steps: tour.steps, pictures: 0 });
    expect(asText.html.startsWith('<!doctype html>')).toBe(true);
    expect(asText.html).toContain('History report');

    const refusedPictures = await callTool(page, 'history_report', { as: 'text', pictures: 'default' });
    expect(refusedPictures.isError).toBe(true);
    expect(refusedPictures.text).toContain('A report as text has no pictures');

    const download = page.waitForEvent('download');
    const asFile = await callTool(page, 'history_report', { file: 'My report.html' }, { asks: 'writes-file' });
    expect((await download).suggestedFilename()).toBe('My report.html');
    expect(resultJson(asFile.text)).toMatchObject({ as: 'file', file: 'My report.html', html: null, steps: tour.steps });

    const declined = await callTool(page, 'history_report', {}, { asks: 'writes-file', answer: 'deny' });
    expect(declined.isError).toBe(true);
    expect(declined.text).toContain('The person declined');
    expect(errors).toEqual([]);
  });

  test('a tour stopped before the panel draws again goes back to the step shown all the same', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await makeSteps(page);
    const head = await page.evaluate(() => window._cellucidHistories.current().active.headId);
    // A busy page, or a tab in the background: no frame comes, so the panel draws nothing.
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    const tour = action => page.evaluate(async type => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      return (await getActions().dispatch(type, {})).outcome;
    }, action);
    const started = await tour('history.tour.start');
    expect(started.returns_to).toBe(head);
    await expect.poll(() => page.evaluate(() => { const { active } = window._cellucidHistories.current(); return active.headId === active.rootId; })).toBe(true);
    expect(await tour('history.tour.stop')).toEqual({ stopped: true, head });
    expect(errors).toEqual([]);
  });

  test('exports write files the person receives, asked first; with names and summaries only they still run and tell no value of a cell', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await makeSteps(page);
    await openChat(page);

    let download = page.waitForEvent('download');
    const cells = await callTool(page, 'cells_export', {}, { asks: 'writes-file' });
    expect((await download).suggestedFilename()).toBe('Page_1_cells.csv');
    expect(resultJson(cells.text)).toMatchObject({ file: 'Page_1_cells.csv', format: 'csv', page: 'Page 1', cells: 10, renamed: [] });

    await setSummariesOnly(page, true);
    download = page.waitForEvent('download');
    const field = await callTool(page, 'field_export', { field: CELL_TYPE }, { asks: 'writes-file' });
    expect((await download).suggestedFilename()).toBe('cell_type.csv');
    const fieldResult = resultJson(field.text);
    expect(Object.keys(fieldResult).sort()).toEqual(['bytes', 'field', 'file', 'kind']);
    expect(fieldResult).toMatchObject({ field: 'cell_type', kind: 'categorical' });

    download = page.waitForEvent('download');
    const figure = await callTool(page, 'figure_export', {}, { asks: 'writes-file' });
    expect(figure.isError, figure.text).toBe(false);
    const written = resultJson(figure.text);
    const name = (await download).suggestedFilename();
    if (written.zip) expect(name).toMatch(/\.zip$/);
    else expect(name).toBe(written.files[0].file);
    expect(written.files.length).toBeGreaterThan(0);

    const noPage = await callTool(page, 'cells_export', { page: 'Nowhere' }, { asks: 'writes-file' });
    expect(noPage.isError).toBe(true);
    expect(noPage.text).toContain('There is no highlight page');
    expect(errors).toEqual([]);
  });

  test('what this browser keeps: listed with sizes, removed only once the person allows it; My datasets forgets by name', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);

    const stored = resultJson((await callTool(page, 'stored_list', {})).text);
    expect(stored).toMatchObject({ saved_states: { count: expect.any(Number) }, my_datasets: { count: expect.any(Number) } });
    expect(Array.isArray(stored.datasets)).toBe(true);

    const nothing = await callTool(page, 'stored_remove', {}, { asks: 'deletes-saved' });
    expect(nothing.isError).toBe(true);
    expect(nothing.text).toContain('Name what to remove');
    const declined = await callTool(page, 'stored_remove', { connection_speeds: true }, { asks: 'deletes-saved', answer: 'deny' });
    expect(declined.isError).toBe(true);
    const removed = resultJson((await callTool(page, 'stored_remove', { connection_speeds: true }, { asks: 'deletes-saved' })).text);
    expect(removed).toMatchObject({ removed: 0, saved_states: 0, my_datasets: 0, decoder_choices: 0, said: expect.any(String) });

    const listed = resultJson((await callTool(page, 'datasets_list', {})).text);
    for (const entry of listed.my_datasets) {
      expect(entry).toMatchObject({ size: expect.anything(), saved_states_bytes: expect.any(Number), kept_bytes: expect.any(Number) });
    }
    const unknown = await callTool(page, 'my_datasets_forget', { name: 'No such dataset' }, { asks: 'deletes-saved' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No dataset in My datasets is called');
    if (listed.my_datasets.length > 0) {
      const name = listed.my_datasets[0].name;
      const forgotten = resultJson((await callTool(page, 'my_datasets_forget', { name }, { asks: 'deletes-saved' })).text);
      expect(forgotten).toMatchObject({ name, saved_states: 0 });
      const after = resultJson((await callTool(page, 'datasets_list', {})).text);
      expect(after.my_datasets.map(entry => entry.name)).not.toContain(name);
    }
    expect(errors).toEqual([]);
  });

  test('publishing is asked as publishes: the share link once allowed, a vote refused in one sentence, before any question, until the person connects a repository', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);

    const link = await callTool(page, 'dataset_share_link', {}, { asks: 'publishes' });
    const made = resultJson(link.text);
    expect(made.link).toMatch(/^https:\/\/www\.cellucid\.com\/\?/);
    expect(made.badge).toContain(made.link);
    expect(made.embed).toContain('<iframe');
    expect(made.access_left_out).toBe(false);

    const suggestions = await callTool(page, 'annotation_suggestions', { field: CELL_TYPE });
    expect(suggestions.isError).toBe(true);
    expect(suggestions.text).toContain('Community annotation is not connected for the dataset shown');
    // A vote is asked about once it is known to publish something (`confirmAt: 'handler'`): refused first, nothing asked.
    const vote = await callTool(page, 'annotation_vote', { field: CELL_TYPE, category: 'T cells', suggestion: 'CD4+ T cell', vote: 'up' });
    expect(vote.isError).toBe(true);
    expect(vote.text).toContain('Community annotation is not connected for the dataset shown');
    expect(errors).toEqual([]);
  });
});
