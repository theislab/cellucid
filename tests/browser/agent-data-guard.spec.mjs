/**
 * What agents are sent of the data, on a real page (`app/agent/data-scope.js`,
 * `app/agent/bridge/data-guard.js`), and the chat's extras around it:
 *
 * - every read of the catalog, walked through the one tool call both ways
 *   in run, with the dataset set to names and summaries only: no picture and
 *   no array of the cells' own values leaves (the same walk with the switch
 *   off finds both, so the check sees what it looks for);
 * - a name written to look like instructions arrives marked as data;
 * - the notice, once per dataset, with the switch; the switch kept for the
 *   dataset after a reload and shown in the permission settings; the model
 *   told it with the message and refused with one sentence;
 * - the selection chip (a reference, keyboard reachable, following the
 *   selection) and a question's choices as buttons (a click is the answer).
 */
import { expect, test } from './helpers/test.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { tabKey } from './helpers/dialog-keys.mjs';
import {
  CELL_TYPE, agentRequests, installScriptedModel, observeProductErrors, openAgentDataset, openChat, queueReplies, say,
} from './helpers/agent-chat.mjs';

/** Switch "names and summaries only" for the dataset shown, as the settings do. */
async function setSummariesOnly(page, on) {
  await page.evaluate(value => {
    const id = window._cellucidHistories.current().dataset.id;
    window._cellucidUi.agents.dataStore.setSummariesOnly(id, value);
  }, on);
}

/**
 * Every read of the catalog run as an agent's call, with real names where
 * it takes them; each result with whether it carried a picture and the
 * arrays of numbers that are the cells' own values (of a continuous field
 * and a gene, read for every open cell).
 */
async function walkReads(page) {
  return page.evaluate(async () => {
    const { getActions, getActionCatalog } = await import('/assets/js/app/actions/index.js');
    const { runToolCall } = await import('/assets/js/app/agent/bridge/tool-call.js');
    const { toolIndexOf } = await import('/assets/js/app/agent/bridge/mcp-tools.js');
    const { resultDataOf } = await import('/assets/js/app/agent/bridge/mcp-content.js');
    const { exampleOf } = await import('/assets/js/app/actions/schema.js');
    const { toolNameOf } = await import('/assets/js/app/actions/catalog.js');
    const actions = getActions();
    const catalog = getActionCatalog();
    const read = async (type, params) => (await actions.dispatch(type, params)).outcome;
    const categorical = (await read('fields.list', { kind: 'categorical' })).fields[0].key;
    const continuous = (await read('fields.list', { kind: 'continuous' })).fields[0]?.key ?? null;
    const gene = (await read('genes.search', { query: 'a', limit: 1 })).genes[0] ?? null;
    const summary = await read('dataset.summary', {});
    const all = Array.from({ length: summary.cells.total }, (_, index) => index);
    const fields = [continuous === null ? null : { source: 'obs', key: continuous }, gene === null ? null : { source: 'var', key: gene }].filter(Boolean);
    // The cells' own values: what no result may carry while the switch is on.
    const own = new Set();
    for (const column of (await read('cells.values', { cells: all, fields })).columns) {
      for (const value of column.values) if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) own.add(value);
    }
    const args = {
      'field.categories': { field: { source: 'obs', key: categorical } },
      'field.summary': { field: fields.at(-1), by: { source: 'obs', key: categorical } },
      'cells.values': { cells: all.slice(0, 50), fields },
      'genes.search': { query: (gene ?? 'a').slice(0, 2) },
      'view.picture': { width: 200, height: 150 },
    };
    const tools = toolIndexOf(catalog);
    const ownArrays = value => {
      if (Array.isArray(value)) {
        const hits = value.filter(item => typeof item === 'number' && own.has(item)).length;
        return (hits >= 2 ? 1 : 0) + value.reduce((sum, item) => sum + ownArrays(item), 0);
      }
      if (value !== null && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + ownArrays(item), 0);
      return 0;
    };
    const out = [];
    for (const definition of catalog.list().filter(entry => entry.effect === 'read')) {
      const { result } = await runToolCall({
        actions, tools, name: toolNameOf(definition.type), args: args[definition.type] ?? exampleOf(definition.params),
        agent: 'Claude', turn: 'turn-walk', connection: { id: 'walk', kind: 'chat' }, signal: null,
      });
      const text = result.content.find(item => item.type === 'text')?.text ?? '';
      const data = resultDataOf(text);
      let json = null;
      try { json = data === null ? null : JSON.parse(data); } catch { json = null; }
      out.push({
        type: definition.type, isError: result.isError, text: text.slice(0, 300),
        pictures: result.content.filter(item => item.type === 'image').length, ownArrays: json === null ? 0 : ownArrays(json),
      });
    }
    return { reads: out, own: own.size };
  });
}

test.describe('agent data guard', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  // One opening, the chat never opened: both steps run agents' calls on the page's own handlers.
  test('names and summaries only, on the real reads: no picture or array of values leaves, and no summary that isolates one cell', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);

    await test.step("every read of the catalogue with names and summaries only: no picture, no array of the cells' values; off, the same walk finds both", async () => {
      const free = await walkReads(page);
      expect(free.own, 'the fixture has values of its own to look for').toBeGreaterThan(10);
      const freeOf = type => free.reads.find(entry => entry.type === type);
      expect(freeOf('cells.values')).toMatchObject({ isError: false });
      expect(freeOf('cells.values').ownArrays).toBeGreaterThan(0);
      expect(freeOf('view.picture')).toMatchObject({ isError: false, pictures: 1 });
      // The walk reaches the reads it means to: each answers on the fixture (the others refuse their example names, which send nothing).
      for (const type of ['dataset.summary', 'fields.list', 'field.categories', 'genes.search', 'field.summary', 'views.state', 'settings.list', 'layout.get', 'analysis.list', 'datasets.list']) {
        expect(freeOf(type)?.isError, type).toBe(false);
      }

      await setSummariesOnly(page, true);
      const guarded = await walkReads(page);
      expect(guarded.reads.length).toBe(free.reads.length);
      for (const entry of guarded.reads) {
        expect(entry.pictures, entry.type).toBe(0);
        expect(entry.ownArrays, `${entry.type}: ${entry.text}`).toBe(0);
      }
      for (const type of ['cells.values', 'view.picture']) {
        const entry = guarded.reads.find(each => each.type === type);
        expect(entry.isError).toBe(true);
        expect(entry.text).toMatch(/^The person set this dataset to “Agents see names and summaries only” in Cellucid/);
      }
      // Summaries still answer.
      for (const type of ['dataset.summary', 'fields.list', 'field.categories', 'field.summary', 'views.state']) {
        expect(guarded.reads.find(each => each.type === type).isError, type).toBe(false);
      }
      expect(errors).toEqual([]);
    });

    await test.step("three calls that isolate one cell: off, the summary is that cell's value; with names and summaries only, refused, and no extreme of any group leaves", async () => {
      // The walk above left the switch on: off again, as this step begins.
      await setSummariesOnly(page, false);
      const run = async (on, suffix) => {
        if (on !== null) await setSummariesOnly(page, on);
        return page.evaluate(async key => {
          const { getActions, getActionCatalog } = await import('/assets/js/app/actions/index.js');
          const { runToolCall } = await import('/assets/js/app/agent/bridge/tool-call.js');
          const { toolIndexOf } = await import('/assets/js/app/agent/bridge/mcp-tools.js');
          const { resultDataOf } = await import('/assets/js/app/agent/bridge/mcp-content.js');
          const actions = getActions();
          const tools = toolIndexOf(getActionCatalog());
          const call = async (name, args) => (await runToolCall({
            actions, tools, name, args, agent: 'Claude', turn: `turn-${key}`, connection: { id: key, kind: 'chat' }, signal: null,
          })).result;
          const continuous = (await actions.dispatch('fields.list', { kind: 'continuous' })).outcome.fields[0].key;
          const own = (await actions.dispatch('cells.values', { cells: [7], fields: [{ source: 'obs', key: continuous }] })).outcome.columns[0].values[0];
          const picked = await call('highlight_cells', { cells: [7], label: `Probe ${key}`, page: `Probe ${key}` });
          const made = await call('field_create_from_pages', { key: `probe_${key}`, pages: [{ page: `Probe ${key}`, label: 'probe' }] });
          const summary = await call('field_summary', { field: { source: 'obs', key: continuous }, by: { source: 'obs', key: `probe_${key}` } });
          // Any group's extremes (a field of the dataset by its categories): single cells' values.
          const byType = await call('field_summary', { field: { source: 'obs', key: continuous }, by: { source: 'obs', key: 'cell_type' } });
          const data = text => { const json = resultDataOf(text); return json === null ? null : JSON.parse(json); };
          return {
            own, picked: picked.isError, made: made.isError, summary: { isError: summary.isError, text: summary.content[0].text, data: data(summary.content[0].text) },
            byType: { isError: byType.isError, data: data(byType.content[0].text), text: byType.content[0].text },
          };
        }, suffix);
      };
      const free = await run(null, 'free');
      expect([free.picked, free.made, free.summary.isError]).toEqual([false, false, false]);
      const probe = free.summary.data.groups.find(group => group.label === 'probe');
      expect([probe.cells, probe.mean, probe.median, probe.min, probe.max]).toEqual([1, free.own, free.own, free.own, free.own]);
      expect(free.byType.data.groups.every(group => group.min !== null && group.max !== null)).toBe(true);

      const guarded = await run(true, 'guarded');
      // Naming cells and making a field of them are changes the person allowed; summarizing values over them is not.
      expect([guarded.picked, guarded.made]).toEqual([false, false]);
      expect(guarded.summary.isError).toBe(true);
      expect(guarded.summary.text).toMatch(/whose groups an agent made by naming cells/);
      expect(guarded.summary.text.includes(String(guarded.own))).toBe(false);
      // A field of the dataset's own categories is still summarized, without its extremes.
      expect(guarded.byType.isError).toBe(false);
      expect(guarded.byType.data.groups.every(group => group.min === null && group.max === null && group.median === null && group.mean !== null)).toBe(true);
      expect(guarded.byType.text).toMatch(/\[Cellucid: median, min, max left out: each is one cell's own value/);
      expect(errors).toEqual([]);
    });
  });

  test('the notice once per dataset with its switch; kept for the dataset after a reload; the model told and refused in one sentence', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await queueReplies(page, [{ calls: [{ name: 'fields_list', args: {} }] }, { text: 'Read.' }]);
    await say(page, 'What fields are there?');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Read.');
    const notice = page.locator('#agent-presence .agent-notice');
    await expect(notice).toBeVisible();
    await expect(notice.locator('.agent-notice-title')).toHaveText('What agents read here goes to their AI provider');
    await expect(notice).toContainText('The dataset\'s files stay in this browser.');
    const box = notice.locator('input.agent-summaries-only');
    await expect(box).not.toBeChecked();
    // Keyboard: the switch and Got it are reachable and work from the keyboard.
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await notice.locator('.agent-notice-done').focus();
    await page.keyboard.press('Enter');
    await expect(notice).toHaveCount(0);

    // Told with the next message; a read of cells' values refused with the sentence the model reads.
    await queueReplies(page, [{ calls: [{ name: 'cells_values', args: { cells: [0, 1], fields: [CELL_TYPE] } }] }, { text: 'I will use summaries.' }]);
    await say(page, 'Show me the first cells');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('I will use summaries.');
    const requests = await agentRequests(page);
    expect(requests.at(-2).messages.at(-1).text).toMatch(/This dataset is set to names and summaries only: reads of single cells' values and pictures of the plot are refused/);
    const refusal = requests.at(-1).messages.at(-1).results[0];
    expect(refusal.isError).toBe(true);
    expect(refusal.content[0].text).toMatch(/^The person set this dataset to “Agents see names and summaries only” in Cellucid, so “Read values of cells” was not done/);
    await expect(page.locator('#agent-chat-log .agent-tool[data-tool="cells_values"]')).toHaveAttribute('data-state', 'refused');
    const foot = page.locator('#agent-chat-log .agent-turn-foot').last();
    await foot.locator('.agent-turn-sent').click();
    await expect(foot.locator('.agent-turn-sent-line')).toContainText('the dataset was set to names and summaries only, so no result carried values of cells or a picture');

    // Kept for this dataset: after a reload the settings show it on, and no notice comes again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dismissWelcome(page);
    await expect(page.locator('#dataset-name')).toHaveText('Current UI fixture');
    await page.waitForFunction(() => window._cellucidHistories?.current()?.dataset?.id);
    await page.evaluate(() => { document.getElementById('agents-section').open = true; });
    await page.locator('#agent-connect-permissions-change').click();
    const dialog = page.locator('#agent-permissions-dialog');
    await expect(dialog.locator('.agent-permission-data input.agent-summaries-only')).toBeChecked();
    await expect(dialog.locator('.agent-permission-data .field-help')).toContainText('kept for it in this browser');
    await dialog.locator('.app-dialog-close').click();
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('fields.list', {}, { origin: 'agent', agent: 'Claude', turn: 'turn-again', connection: { id: 'c', kind: 'connector' } });
    });
    await expect(page.locator('#agent-presence .agent-notice')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the selection chip: a reference attached once, never one the conversation knows (sent before, or its agent\'s own), left out with × until the selection changes, reached from the keyboard', async ({ page, browserName }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    const chip = page.locator('#agent-chat-tray .agent-chat-chip');
    await expect(chip).toBeHidden();
    const highlight = cells => page.evaluate(async list => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('highlight.cells', { cells: list, label: 'Picked' });
    }, cells);
    const lastSent = async () => (await agentRequests(page)).at(-1).messages.at(-1).text;
    await highlight([0, 1, 2, 3, 4]);
    await expect(chip).toBeVisible();
    await expect(chip.locator('.agent-chat-chip-text')).toHaveText('Selection: 5 cells');
    await queueReplies(page, [{ text: 'Five cells.' }]);
    await say(page, 'What are these?');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Five cells.');
    const sent = await lastSent();
    expect(sent).toMatch(/^What are these\?\n\n\[Cellucid: Permissions: [^\n]*\]\n\n\[Cellucid: The person attached their selection: a reference to the cells highlighted on a highlight page, not the cells\./);
    expect(sent).toContain('<cellucid-data>{"page":');
    expect(sent).toContain('"cells":5');
    await expect(page.locator('#agent-chat-log .agent-msg-user .agent-msg-attached').last()).toHaveText('Selection: 5 cells');
    // Sent once: the conversation knows it, so the chip goes and the next message carries nothing.
    await expect(chip).toBeHidden();
    await queueReplies(page, [{ text: 'Still five.' }]);
    await say(page, 'And their types?');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Still five.');
    expect(await lastSent()).toBe('And their types?');

    // A new selection attaches again; × from the keyboard (Shift+Tab from the field reaches it) leaves it out.
    await highlight([10, 11]);
    await expect(chip.locator('.agent-chat-chip-text')).toHaveText('Selection: 7 cells');
    await page.locator('#agent-chat-input').focus();
    // WebKit on macOS moves to buttons with Option-Tab (Tab alone skips them, as Safari does by default).
    await page.keyboard.press(tabKey(browserName, { shift: true }));
    await expect(chip.locator('.agent-chat-chip-remove')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chip).toBeHidden();
    await expect(page.locator('#agent-chat-input')).toBeFocused();
    await queueReplies(page, [{ text: 'Nothing attached.' }]);
    await say(page, 'And now?');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Nothing attached.');
    // Left out: no reference to the cells goes with the message. What the person did since the
    // agent's last turn is still told (`history-link.js` `historySinceSentence`): the
    // highlight is a step of theirs, in effect now, whether or not they attach the selection.
    expect(await lastSent()).toBe('And now?\n\n[Cellucid: Since your last turn the history changed: The person\'s step '
      + '<cellucid-data>"Highlighted 2 cells as \\"Picked (2)\\" on page \\"Page 1\\""</cellucid-data> is now in effect. '
      + 'Rely on the state as it is now, not on what your earlier replies said.]');

    // What the agent highlights in its turn is its own: never attached back as the person's.
    await queueReplies(page, [
      { text: '', calls: [{ name: 'highlight_cells', args: { cells: [20, 21, 22], label: 'Agent picked' } }] },
      { text: 'Highlighted three more.' },
    ]);
    await say(page, 'Highlight three more cells');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Highlighted three more.');
    await expect(chip).toBeHidden();
    await queueReplies(page, [{ text: 'Ten in all.' }]);
    await say(page, 'How many now?');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Ten in all.');
    expect(await lastSent()).toBe('How many now?');

    // A new chat knows no selection; clearing the highlights clears the chip.
    await page.locator('#agent-chat-new').click();
    await expect(chip.locator('.agent-chat-chip-text')).toHaveText('Selection: 10 cells');
    await page.evaluate(async () => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      await getActions().dispatch('highlight.clear-all', {});
    });
    await expect(chip).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a question\'s choices as buttons above the field: a click, or Enter on one, is the person\'s answer', async ({ page, browserName }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    await queueReplies(page, [{ text: 'Before I color:', calls: [{ name: 'ask_person', args: { question: 'Color by which field?', choices: ['cell_type', 'leiden', 'Neither'] } }] }]);
    await say(page, 'Color it');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Before I color:');
    const choices = page.locator('#agent-chat-tray .agent-chat-choices');
    await expect(choices).toBeVisible();
    await expect(choices).toHaveAttribute('aria-label', 'Color by which field?');
    await expect(choices.locator('button')).toHaveText(['cell_type', 'leiden', 'Neither']);
    await expect(page.locator('#agent-chat-tray [role="status"]')).toHaveText('Choices: cell_type, leiden, Neither. They are above the message field; you can also type an answer.');
    // The question in the conversation, with its choices as words; the turn ended without another model call.
    await expect(page.locator('#agent-chat-log .agent-ask-question')).toHaveText('Color by which field?');
    await expect(page.locator('#agent-chat-log .agent-ask-choices')).toHaveText('cell_type · leiden · Neither');
    expect(await agentRequests(page)).toHaveLength(1);

    // From the field, Shift+Tab reaches the last choice; Enter answers with it, and what the person was typing stays.
    await queueReplies(page, [{ text: 'Then I leave it.' }]);
    await page.locator('#agent-chat-input').fill('half a thought');
    await page.locator('#agent-chat-input').focus();
    // WebKit on macOS moves to buttons with Option-Tab (Tab alone skips them, as Safari does by default).
    await page.keyboard.press(tabKey(browserName, { shift: true }));
    await expect(choices.locator('button').last()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#agent-chat-log .agent-msg-agent').last()).toContainText('Then I leave it.');
    await expect(page.locator('#agent-chat-send')).toBeVisible();
    await expect(page.locator('#agent-chat-log .agent-msg-user .agent-msg-text').last()).toHaveText('Neither');
    await expect(choices).toBeHidden();
    await expect(page.locator('#agent-chat-input')).toHaveValue('half a thought');
    await expect(page.locator('#agent-chat-input')).toBeFocused();
    const requests = await agentRequests(page);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-2).results[0].content[0].text).toBe('Asked. The person sees your question with its choices; their answer comes as their next message.');
    expect(requests[1].messages.at(-1).text).toMatch(/^Neither/);
    expect(errors).toEqual([]);
  });
});
