/**
 * A long turn in the chat (`assets/js/app/agent/chat/work.js`): each call's
 * row says what it was about; while the turn runs its latest calls show, not
 * a growing wall; once it ends its work folds under
 * one summary row (a disclosure, by keyboard too) and its answer is what
 * shows; a refusal stays in view; opened, Show still finds the step in the
 * history; the exported chat keeps every call, named. Scripted model
 * (`helpers/agent-chat.mjs`).
 */
import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import {
  CELL_TYPE, COLOR_BY_SCORE, installScriptedModel, observeProductErrors, openAgentDataset, openChat,
  queueReplies, releaseHold, say, stepFacts, waitForHold, waitForTurnEnd,
} from './helpers/agent-chat.mjs';

const ANSWER = 'The cells fall into the **cell_type** categories; score rises along them.';

test.describe('agent chat: a long turn', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installScriptedModel);
  });

  // One opening; the second long turn is made in a new chat, so each step counts its own rows.
  test("a long turn folds to its answer with its rows, refusals, Show and Export; a model's notes show before their calls, fold and are exported", async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);

    await test.step('its rows say what each call was; it folds to its answer, refusals stay, the summary opens by keyboard, Show and Export keep working', async () => {
      await queueReplies(page, [
        { text: 'Reading the design first.', calls: [{ name: 'dataset_summary', args: {} }, { name: 'fields_list', args: {} }, { name: 'field_categories', args: { field: CELL_TYPE } }] },
        { calls: [COLOR_BY_SCORE, { name: 'color_by', args: { field: { source: 'obs', key: 'no_such_field' } } }] },
        { text: 'One more look at the views.', hold: 'mid', calls: [{ name: 'views_state', args: {} }, { name: 'field_categories', args: { field: CELL_TYPE } }] },
        { text: ANSWER },
      ]);
      await page.locator('#agent-chat-input').fill('What are the cell types, and how does score vary?');
      await page.locator('#agent-chat-input').press('Enter');
      const log = page.locator('#agent-chat-log');
      const summary = log.locator('.agent-msg-work');
      const head = summary.locator('.agent-work-head');

      // Running: five calls made, the latest three shown (one of them the refusal), the rest under "so far".
      await waitForHold(page, 'mid');
      await expect(head).toHaveText('5 actions so far · 1 step · 1 refused');
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await expect(log.locator('.agent-tool:visible')).toHaveCount(3);
      await expect(log.locator('.agent-tool[data-tool="dataset_summary"]')).toBeHidden();
      await expect(log.locator('.agent-tool[data-tool="fields_list"]')).toBeHidden();
      await expect(log.locator('.agent-tool[data-tool="field_categories"]')).toBeVisible();
      await expect(log.locator('.agent-tool[data-tool="color_by"][data-state="step"]')).toBeVisible();
      await expect(log.locator('.agent-tool[data-state="refused"]')).toBeVisible();
      // The words that made a call shown stay with it.
      await expect(log.getByText('Reading the design first.')).toBeVisible();
      await releaseHold(page, 'mid');
      await waitForTurnEnd(page);

      // Ended: one summary row under the agent's name, the answer, and the refusal; nothing else of the work.
      await expect(head).toHaveText('Worked through 7 actions · 1 step · 1 refused');
      await expect(summary.locator('.agent-msg-who')).toHaveText('Claude');
      await expect(log.locator('.agent-msg-agent:visible').last()).toContainText('score rises along them');
      await expect(log.locator('.agent-tool:visible')).toHaveCount(1);
      await expect(log.locator('.agent-tool:visible .agent-tool-label')).toHaveText('Color the cells by a field or gene: no_such_field · refused');
      await expect(log.getByText('Reading the design first.')).toBeHidden();
      await expect(log.getByText('One more look at the views.')).toBeHidden();
      // The answer's own controls: Copy, and the turn's footer (steps, Sent, Undo turn).
      const turn = await log.locator('.agent-msg-user').getAttribute('data-turn');
      const foot = log.locator(`.agent-turn-foot[data-turn="${turn}"]`);
      await expect(foot.locator('.agent-turn-steps')).toHaveText('1 step ↗');
      await expect(foot.locator('.agent-turn-undo')).toBeVisible();

      // A real disclosure: Enter opens it, the turn as it was made, every row named by what it read.
      await head.focus();
      await page.keyboard.press('Enter');
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await expect(log.locator('.agent-tool:visible')).toHaveCount(7);
      await expect(log.getByText('Reading the design first.')).toBeVisible();
      await expect(log.locator('.agent-tool[data-tool="dataset_summary"] .agent-tool-label')).toHaveText('Read the dataset summary');
      await expect(log.locator('.agent-tool[data-tool="fields_list"] .agent-tool-label')).toHaveText('Listed the fields');
      await expect(log.locator('.agent-tool[data-tool="field_categories"] .agent-tool-label')).toHaveText(['Read the categories of cell_type', 'Read the categories of cell_type']);
      await expect(log.locator('.agent-tool[data-tool="views_state"] .agent-tool-label')).toHaveText('Read the views');
      await expect(log.locator('.agent-tool[data-tool="color_by"][data-state="step"] .agent-tool-label')).toHaveText('Colored by score');
      // A row still opens to what was asked and answered.
      await log.locator('.agent-tool[data-tool="field_categories"] .agent-tool-head').first().click();
      await expect(log.locator('.agent-tool[data-tool="field_categories"] .agent-tool-args').first()).toContainText('"key": "cell_type"');

      // Show finds the step in the history.
      const [step] = await stepFacts(page);
      await page.evaluate(() => { document.getElementById('state-section').open = false; });
      await log.locator('.agent-tool[data-tool="color_by"][data-state="step"] .agent-tool-show').click();
      await expect(page.locator('#state-section')).toHaveAttribute('open', '');
      await expect(page.locator(`#history-graph .hg-row[data-key="s:${step.id}"]`)).toBeVisible();

      // Space folds it again: the answer, the refusal.
      await head.focus();
      await page.keyboard.press('Space');
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await expect(log.locator('.agent-tool:visible')).toHaveCount(1);

      // A short turn after it is shown whole, with no summary row.
      await queueReplies(page, [{ calls: [{ name: 'fields_list', args: {} }] }, { text: 'Two fields.' }]);
      await say(page, 'Which fields?');
      await expect(summary).toHaveCount(1);
      await expect(log.locator('.agent-tool:visible')).toHaveCount(2);

      // The exported chat keeps every call of the folded turn, each named.
      const download = page.waitForEvent('download');
      await page.locator('#agent-chat-export').click();
      const markdown = await readFile(await (await download).path(), 'utf8');
      expect(markdown).toContain([
        '- `dataset_summary` — read: Read the dataset summary',
        '- `fields_list` — read: Listed the fields',
        '- `field_categories` — read: Read the categories of cell_type',
      ].join('\n'));
      expect(markdown).toContain('- `color_by` — step "Colored by score"\n- `color_by` — refused: ');
      expect(markdown).toContain('- `views_state` — read: Read the views');
      expect(markdown.match(/^- `/gm)).toHaveLength(8);
      expect(markdown).toContain('Reading the design first.');

      // Undo turn still takes the folded turn's step back (Show opened the State section since: a change of the person's, so it asks).
      await foot.locator('.agent-turn-undo').click();
      await page.getByRole('dialog', { name: 'Undo Claude\'s turn?' }).getByRole('button', { name: /^All \d+ steps since$/ }).click();
      await expect(foot.locator('.agent-turn-undo')).toHaveText('Undone');
      expect(errors).toEqual([]);
    });

    await test.step("a model's notes between its calls show before the call they introduce, fold with its row, and are exported", async () => {
      // A new conversation: the log and the export hold this step's turn only.
      await page.locator('#agent-chat-new').click();
      await expect(page.locator('#agent-chat-log .agent-msg-user')).toHaveCount(0);
      await queueReplies(page, [
        { calls: [{ name: 'dataset_summary', args: {}, note: 'Reading the summary first.' }, { name: 'fields_list', args: {} }] },
        { calls: [{ name: 'field_categories', args: { field: CELL_TYPE }, note: 'Now the categories of cell_type.' }, { ...COLOR_BY_SCORE, note: 'Coloring by score.' }] },
        { hold: 'notes', calls: [{ name: 'views_state', args: {}, note: 'Checking the views.' }] },
        { text: ANSWER },
      ]);
      await page.locator('#agent-chat-input').fill('Look around, then color by score.');
      await page.locator('#agent-chat-input').press('Enter');
      const log = page.locator('#agent-chat-log');
      const note = text => log.locator('.agent-tool-note', { hasText: text });

      // Running: the latest three calls show, each with the note that introduced it; the first call's note folds with it.
      await waitForHold(page, 'notes');
      await expect(log.locator('.agent-tool:visible')).toHaveCount(3);
      await expect(note('Reading the summary first.')).toBeHidden();
      await expect(note('Now the categories of cell_type.')).toBeVisible();
      await expect(note('Coloring by score.')).toBeVisible();
      // A note sits right before the row of the call it introduced.
      expect(await note('Coloring by score.').evaluate(element => element.nextElementSibling?.dataset.tool)).toBe('color_by');
      await releaseHold(page, 'notes');
      await waitForTurnEnd(page);

      // Ended and folded: the answer shows, the notes go with their rows.
      await expect(log.locator('.agent-tool-note:visible')).toHaveCount(0);
      await expect(log.locator('.agent-msg-agent:visible').last()).toContainText('score rises along them');
      // Opened: every note, in order, each before its call.
      await log.locator('.agent-msg-work .agent-work-head').click();
      await expect(log.locator('.agent-tool-note:visible')).toHaveText([
        'Reading the summary first.', 'Now the categories of cell_type.', 'Coloring by score.', 'Checking the views.',
      ]);
      expect(await note('Checking the views.').evaluate(element => element.nextElementSibling?.dataset.tool)).toBe('views_state');

      // The exported chat keeps them, as quiet lines; they are not the reply's words (no provider sends them as words).
      const download = page.waitForEvent('download');
      await page.locator('#agent-chat-export').click();
      const markdown = await readFile(await (await download).path(), 'utf8');
      expect(markdown).toContain('*Reading the summary first.*');
      expect(markdown).toContain('*Checking the views.*');
      const sent = await page.evaluate(() => window._cellucidUi.agents.chat.conversation.messages
        .filter(message => message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)));
      expect(sent).toEqual([ANSWER]);
      expect(errors).toEqual([]);
    });
  });

  // A long answer is shown from its first line, not left scrolled to its last.
  test('a long answer is shown from its first line when the turn ends; a person who scrolled keeps the place', async ({ page }) => {
    const errors = observeProductErrors(page);
    await openAgentDataset(page);
    await openChat(page);
    const long = Array.from({ length: 60 }, (_, at) => `Paragraph ${at + 1}: the cell types differ in score.`).join('\n\n');
    const log = page.locator('#agent-chat-log');
    /** Where the latest answer's top stands in the log (px from the log's top), and whether the log is at its end. */
    const place = () => log.evaluate(element => {
      const answer = [...element.querySelectorAll('.agent-msg-agent:not([data-empty="true"])')].at(-1);
      return {
        top: Math.round(answer.getBoundingClientRect().top - element.getBoundingClientRect().top),
        atEnd: element.scrollHeight - element.scrollTop - element.clientHeight < 24,
        scrollable: element.scrollHeight > element.clientHeight + 24,
      };
    });

    await queueReplies(page, [
      { text: 'Reading the design first.', calls: [{ name: 'dataset_summary', args: {} }, { name: 'fields_list', args: {} }] },
      { text: `Paragraph 0 opens the answer.\n\n${long}` },
    ]);
    await say(page, 'Describe the cell types in detail.');
    const held = await place();
    expect(held.scrollable).toBe(true);
    // The answer's first line at the top (its name above it), not its last line at the bottom.
    expect(held.top).toBeGreaterThanOrEqual(0);
    expect(held.top).toBeLessThanOrEqual(16);
    expect(held.atEnd).toBe(false);
    await expect(log.getByText('Paragraph 0 opens the answer.')).toBeInViewport();

    // A short answer after a new question: followed to the end.
    await queueReplies(page, [{ text: 'Yes.' }]);
    await say(page, 'Is score continuous?');
    expect((await place()).atEnd).toBe(true);

    // The person scrolls up while the next long answer is written: their place is kept.
    await queueReplies(page, [{ text: `Paragraph 0 opens the second answer.\n\n${long}`, hold: 'long' }]);
    await page.locator('#agent-chat-input').fill('And in more detail?');
    await page.locator('#agent-chat-input').press('Enter');
    await waitForHold(page, 'long');
    /** The log's scrollTop once it no longer moves (a draw or a wheel's scroll landed). */
    const settled = async () => {
      let last = -1;
      await expect.poll(async () => {
        const now = await log.evaluate(element => element.scrollTop);
        const still = now === last;
        last = now;
        return still;
      }, { intervals: [100] }).toBe(true);
      return last;
    };
    const held2 = await settled();
    await log.hover();
    await page.mouse.wheel(0, -400);
    await expect.poll(() => log.evaluate(element => element.scrollTop)).toBeLessThan(held2);
    const before = await settled();
    await releaseHold(page, 'long');
    await waitForTurnEnd(page);
    expect(await log.evaluate(element => element.scrollTop)).toBe(before);
    expect(errors).toEqual([]);
  });
});
