/**
 * What a model writes, and the names an agent gives (a category, a page, a
 * tool it made up), never run as HTML: not in the chat, its tool rows or the
 * history, and not in the chat exported as Markdown (raw HTML escaped, a
 * script link left as text), which a renderer that does not sanitise may
 * show. From the agents bug hunt of 2026-11-04.
 */
import { readFile } from 'node:fs/promises';

import { expect, test } from './helpers/test.mjs';
import { installScriptedModel, observeProductErrors, openAgentDataset, openChat, queueReplies, say } from './helpers/agent-chat.mjs';

const hostile = n => `<img src=x${n} onerror="window.__xss=(window.__xss||[]).concat('${n}')">`;
const CELL_TYPE = { source: 'obs', key: 'cell_type' };

test('model text and names an agent writes never run as HTML, in the page or in the exported chat', async ({ page }) => {
  await page.addInitScript(installScriptedModel);
  const errors = observeProductErrors(page);
  page.on('dialog', dialog => {
    errors.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await openAgentDataset(page);
  await openChat(page);
  await queueReplies(page, [{ text: [
    `Plain ${hostile('t1')} and **bold ${hostile('t2')}**`,
    '[js](javascript:window.__xss=1) [data](data:text/html,<script>alert(1)</script>) [q](https://a.b/" onmouseover="window.__xss=1)',
    `| a | b |\n|---|---|\n| <script>window.__xss=1</script> | ${hostile('t3')} |`,
    `\`\`\`\n${hostile('t4')}\n\`\`\``,
    `> ${hostile('t5')}`,
    `- ${hostile('t6')}`,
    `# ${hostile('t7')}`,
  ].join('\n\n') }]);
  await say(page, `hi ${hostile('u1')}`);
  await queueReplies(page, [{ calls: [
    { name: hostile('tool'), args: { a: hostile('a1') } },
    { name: 'category_rename', args: { field: CELL_TYPE, category: 'alpha', name: hostile('cat') } },
    { name: 'highlight_page_create', args: { name: hostile('page') } },
  ] }, { text: 'Done.' }]);
  await say(page, 'Name things');
  // Every tool row opened (its details drawn), every disclosure of the page open.
  for (const head of await page.locator('#agent-chat-log .agent-tool-head').all()) await head.click();
  await page.evaluate(() => { for (const details of document.querySelectorAll('details')) details.open = true; });
  const download = page.waitForEvent('download');
  await page.locator('#agent-chat-export').click();
  const markdown = await readFile(await (await download).path(), 'utf8');
  const state = await page.evaluate(() => ({
    xss: window.__xss ?? null,
    images: [...document.querySelectorAll('img')].filter(image => /^x/.test(image.getAttribute('src') ?? '')).length,
    links: [...document.querySelectorAll('#agent-chat-log a')].map(link => link.getAttribute('href')),
  }));
  expect({ xss: state.xss, images: state.images }).toEqual({ xss: null, images: 0 });
  expect(state.links.every(href => /^https?:\/\//.test(href)), JSON.stringify(state.links)).toBe(true);
  // The export: raw HTML outside code escaped (and every [ that could open a link), the script and
  // data links left as text, code kept, and the text otherwise as written (window.__xss stays).
  const escaped = n => `\\${hostile(n).replace('[', '\\[')}`;
  expect(markdown).toContain(`> hi ${escaped('u1')}`);
  expect(markdown).toContain(`Plain ${escaped('t1')}`);
  expect(markdown).toContain(`step "Renamed alpha to ${escaped('cat')} in cell_type"`);
  expect(markdown).toContain('\\[js](javascript:window.__xss=1) \\[data](data:text/html,\\<script>alert(1)\\</script>)');
  expect(markdown).toContain(`\`\`\`\n${hostile('t4')}\n\`\`\``);
  // Outside code (fenced, or a code span such as a tool's name), no tag is left unescaped.
  const outsideCode = markdown.replace(/```[\s\S]*?```/g, '').replace(/(`+)[^`][\s\S]*?\1/g, '');
  expect(markdown).toContain(`- \`${hostile('tool')}\` — refused`);
  expect(outsideCode).not.toMatch(/(?<!\\)<(img|script)/);
  expect(errors).toEqual([]);
});
