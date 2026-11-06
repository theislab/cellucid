/**
 * Agents › Claude and ChatGPT (`app/agent/connect/`): this page's link to the
 * Cellucid relay, against a relay played by the spec (`helpers/relay-play.mjs`:
 * `page.routeWebSocket` on the deployed relay's `/tab`, so nothing leaves the
 * machine).
 *
 * - The approval link (`#cellucid_connect=…`): its code leaves the address
 *   before anything runs, the browser pairs, the dialog says who asks and
 *   the code; Allow answers the relay, the panel says who is connected.
 * - Manage… lists the connection, Remove ends it; Forget this browser asks
 *   in place, ends them all and deletes the pairing.
 * - A code typed from another device: a wrong one is said under the box; a
 *   typed code warns; Deny, and closing the dialog, deny.
 * - The status line follows the link: offline, retrying, back.
 * - A tool call through the relay runs as the agent: a dataset opened by
 *   name, a refusal naming what exists, a picture as image content with the
 *   card's metadata.
 * - A phone's width: the panel and the dialog fit without scrolling sideways.
 */
import { expect, test } from './helpers/test.mjs';
import { START, TRAJECTORY, expectSettledOn, observePage, startUrl } from './helpers/dataset-loading.mjs';
import { dismissWelcome } from './helpers/welcome.mjs';
import { openPhoneSheet } from './helpers/panels.mjs';
import { SECRET_KEY, callTool, playRelay, received } from './helpers/relay-play.mjs';
import { resultJson } from './helpers/agent-chat.mjs';
import { plainText } from '../../assets/js/app/agent/bridge/mcp-content.js';

const UNKNOWN_APP = Object.freeze({
  agent: 'Notes helper', name: 'Notes helper', host: null, redirectHost: '127.0.0.1', loopback: true, known: false, registration: 'registered',
});

const status = page => page.locator('#agent-connect-status');
const dialog = page => page.locator('#agent-approval-dialog');

test('the approval link: its code leaves the address, Allow connects, Manage… removes it, Forget ends all', async ({ page }) => {
  const errors = await observePage(page);
  const relay = await playRelay(page);
  await page.goto(`${startUrl()}#cellucid_connect=ABCD-EFGH`, { waitUntil: 'domcontentloaded' });
  await expect(dialog(page)).toBeVisible();
  // Taken out of the address before any module ran: a reload or a bookmark never carries it.
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('#agent-approval-title')).toHaveText('Connect Claude?');
  await expect(page.locator('#agent-approval-who')).toHaveText(/^Claude \(claude\.ai\) asks to work in Cellucid in this browser/);
  await expect(page.locator('#agent-approval-where')).toHaveText('The answer goes to claude.ai.');
  await expect(page.locator('#agent-approval-code')).toHaveText('ABCD-EFGH');
  await expect(page.locator('#agent-approval-warnings')).toBeHidden();
  // Deny comes first in the focus order.
  await expect(page.locator('#agent-approval-deny')).toBeFocused();
  expect((await received(relay, 'claim')).code).toBe('ABCDEFGH');
  // Claiming paired the browser: its tab secret is kept.
  expect(await page.evaluate(key => localStorage.getItem(key), SECRET_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.locator('#agent-approval-allow').click();
  expect(await received(relay, 'decide')).toMatchObject({ code: 'ABCDEFGH', allow: true });
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#notification-center')).toContainText('Claude is connected. Go back to Claude to continue.');
  await expect(status(page)).toHaveText('Claude connected');
  await expect(status(page)).toHaveAttribute('data-tone', 'success');
  await expect(page.locator('#agents-section')).toHaveJSProperty('open', true);
  // Opened to approve a connection: no welcome over it.
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expectSettledOn(page, START);
  // The relay hears which dataset the tab shows.
  await received(relay, 'state', message => message.dataset === START.name);

  await page.locator('#agent-connections-open-btn').click();
  const rows = page.locator('#agent-connections-list .agent-connection-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.agent-connection-title')).toHaveText('Claude');
  await expect(rows.locator('.agent-connection-meta')).toHaveText('claude.ai · connected now · used now');
  await rows.getByRole('button', { name: 'Remove Claude' }).click();
  expect((await received(relay, 'disconnect')).grant).toBe('g1');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('#agent-connections-empty')).toBeVisible();
  await expect(page.locator('#agent-connections-status')).toHaveText('Claude was removed: it must be approved again to work here.');

  await page.locator('#agent-forget-btn').click();
  await expect(page.locator('#agent-forget-confirm')).toBeVisible();
  await expect(page.locator('#agent-forget-no')).toBeFocused();
  await page.locator('#agent-forget-yes').click();
  await received(relay, 'forget');
  await expect(page.locator('#notification-center')).toContainText('This browser was forgotten: every agent connection made through it has ended.');
  await page.keyboard.press('Escape');
  await expect(status(page)).toHaveText('Not connected yet');
  expect(await page.evaluate(key => localStorage.getItem(key), SECRET_KEY)).toBeNull();
  expect(errors).toEqual([]);
});

test('a typed code: a wrong one is said, a typed one warns, Deny and closing the dialog deny', async ({ page }) => {
  const errors = await observePage(page);
  const relay = await playRelay(page, { client: UNKNOWN_APP });
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  // Never paired: nothing is dialled until the person connects.
  await expect(status(page)).toHaveText('Not connected yet');
  expect(relay.opened).toBe(0);
  await page.locator('#agents-section > summary').click();
  await expect(page.locator('#agent-connector-address')).toHaveValue('https://mcp.cellucid.com');

  await page.locator('#agent-connect-code').fill('XYZ');
  await page.locator('#agent-connect-code').press('Enter');
  await expect(page.locator('#agent-connect-code-status')).toHaveText('Codes look like ABCD-EFGH');
  await expect(page.locator('#agent-connect-code-status')).toHaveAttribute('title', 'A connect code has eight letters and digits, like ABCD-EFGH.');
  await expect(page.locator('#agent-connect-code-status')).toHaveAttribute('data-tone', 'warning');

  // Case, spaces and look-alike letters are forgiven, as on the relay's page.
  await page.locator('#agent-connect-code').fill('abcd efgo');
  await page.locator('#agent-connect-code-btn').click();
  await expect(dialog(page)).toBeVisible();
  expect((await received(relay, 'claim')).code).toBe('ABCDEFG0');
  await expect(page.locator('#agent-approval-title')).toHaveText('Connect Notes helper?');
  await expect(page.locator('#agent-approval-where')).toHaveText('The answer goes to an app on this computer (127.0.0.1).');
  await expect(page.locator('#agent-approval-warnings li')).toHaveText([
    'Allow only if you started connecting Cellucid from this app yourself, just now.',
    'Allow only a code you see on your own screen now, never one someone sent you.',
  ]);
  await page.locator('#agent-approval-deny').click();
  expect(await received(relay, 'decide')).toMatchObject({ code: 'ABCDEFG0', allow: false });
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#notification-center')).toContainText('Notes helper was not connected.');
  await expect(status(page)).toHaveText('Ready · no agent yet');

  // A code the relay does not know: one short line, the relay's sentence in a notification.
  await page.locator('#agent-connect-code').fill('ZZZZ-ZZZZ');
  await page.locator('#agent-connect-code').press('Enter');
  await expect(page.locator('#agent-connect-code-status')).toHaveText('Code not accepted');
  await expect(page.locator('#notification-center')).toContainText('was not accepted: This connect code is unknown or has expired. Start connecting again from Claude or ChatGPT.');
  await expect(dialog(page)).toBeHidden();

  // Closing the question (Escape) denies it too.
  await page.locator('#agent-connect-code').fill('WXYZ-2345');
  await page.locator('#agent-connect-code').press('Enter');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await received(relay, 'decide', message => message.code === 'WXYZ2345')).toMatchObject({ allow: false });
  await expect(dialog(page)).toBeHidden();
  expect(relay.connections).toEqual([]);
  expect(errors).toEqual([]);
});

test('the status line follows the link: offline and retrying, then back by itself', async ({ page }) => {
  const errors = await observePage(page);
  const relay = await playRelay(page, { refuseFirst: 2 });
  // A browser paired on an earlier visit connects at once.
  await page.addInitScript(key => localStorage.setItem(key, 'A'.repeat(43)), SECRET_KEY);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expect(status(page)).toHaveText(/^Offline · retrying (in ~\d+ s|now)$/);
  await expect(status(page)).toHaveAttribute('data-tone', 'warning');
  await expect(status(page)).toHaveText('Ready · no agent yet');
  expect(relay.opened).toBe(3);
  await expectSettledOn(page, START);
  // The relay redeployed while connected: its sockets close (1012, service restart); the tab comes back by itself.
  relay.sockets.at(-1).close({ code: 1012, reason: 'service restart' });
  await expect(status(page)).toHaveText(/^Offline · retrying/);
  await expect(status(page)).toHaveText('Ready · no agent yet');
  expect(relay.opened).toBe(4);
  expect(errors).toEqual([]);
});

test('a tool call through the relay runs as the agent: a dataset opened by name, a refusal, a picture', async ({ page }) => {
  const errors = await observePage(page);
  const relay = await playRelay(page);
  await page.addInitScript(key => localStorage.setItem(key, 'B'.repeat(43)), SECRET_KEY);
  await page.goto(startUrl(), { waitUntil: 'domcontentloaded' });
  await dismissWelcome(page);
  await expectSettledOn(page, START);
  await expect(status(page)).toHaveText('Ready · no agent yet');

  const listed = await callTool(page, relay, 'datasets_list', {});
  expect(listed.result.isError).toBe(false);
  const list = resultJson(listed.result.content[0].text);
  expect(list.open).toEqual({ name: START.name, kind: 'sample' });
  expect(list.samples.map(sample => sample.name)).toContain(TRAJECTORY.name);

  const refused = await callTool(page, relay, 'dataset_open', { name: 'zebrafish' });
  expect(refused.result.isError).toBe(true);
  // The names it quotes are marked as data (`refusalText`); as a person reads it, the sentence is whole.
  expect(refused.result.content[0].text.startsWith('There is no dataset <cellucid-data>"zebrafish"</cellucid-data>')).toBe(true);
  expect(plainText(refused.result.content[0].text)).toMatch(/^There is no dataset "zebrafish": the samples are .*"Synthetic trajectory — 1D"/);

  const opened = await callTool(page, relay, 'dataset_open', { name: 'trajectory' });
  expect(opened.result.isError).toBe(false);
  expect(resultJson(opened.result.content[0].text)).toEqual({
    name: TRAJECTORY.name, kind: 'sample', cells: TRAJECTORY.cells, total_cells: TRAJECTORY.cells, genes: TRAJECTORY.genes,
    saved_states: 0, already_open: false,
  });
  expect(opened.result._meta['cellucid/view'].dataset).toBe(TRAJECTORY.name);
  await expectSettledOn(page, TRAJECTORY);
  await received(relay, 'state', message => message.dataset === TRAJECTORY.name);

  const picture = await callTool(page, relay, 'view_picture', { width: 320, height: 240, legend: false });
  expect(picture.result.isError).toBe(false);
  expect(picture.result.content.map(item => item.type)).toEqual(['text', 'image']);
  expect(picture.result.content[1].mimeType).toBe('image/png');
  const body = resultJson(picture.result.content[0].text);
  expect(body.png).toMatchObject({ image: 1, mimeType: 'image/png' });
  expect(body.plot).toEqual({ width: 320, height: 240 });
  expect(picture.result._meta['cellucid/view']).toMatchObject({ dataset: TRAJECTORY.name });
  // The agent's opening is no step of either history; its colouring is, labelled as Claude's, and the
  // history reads, undoes and shows steps through the same tools.
  const field = resultJson((await callTool(page, relay, 'fields_list', { kind: 'categorical' })).result.content[0].text).fields[0];
  const coloured = await callTool(page, relay, 'color_by', { field: { source: 'obs', key: field.key } });
  const stepId = resultJson(coloured.result.content[0].text).step.id;
  expect(coloured.result._meta).toBeUndefined();
  const history = resultJson((await callTool(page, relay, 'history_get', {})).result.content[0].text);
  expect(history.steps.map(step => step.type)).not.toContain('dataset.open');
  const step = history.steps.find(each => each.id === stepId);
  expect(step).toMatchObject({ origin: 'agent', agent: 'Claude', type: 'color.by' });
  expect(step.turn).toMatch(/^turn-/);
  const undone = resultJson((await callTool(page, relay, 'history_undo', {})).result.content[0].text);
  expect(undone.moved).toBe(true);
  expect(undone.head).not.toBe(stepId);
  const shown = resultJson((await callTool(page, relay, 'history_jump', { step: stepId })).result.content[0].text);
  expect(shown.head).toBe(stepId);
  // The card's picture says which step it is after.
  const after = await callTool(page, relay, 'view_picture', { width: 320, height: 240, legend: false });
  expect(after.result._meta['cellucid/view'].step).toEqual({ id: stepId, label: step.label });
  expect(errors).toEqual([]);
});

test('at a phone\'s width the panel and the approval fit, and both read in the dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.addInitScript(() => localStorage.setItem('cellucid_theme', 'dark'));
  await playRelay(page);
  await page.goto(`${startUrl()}#cellucid_connect=ABCD-EFGH`, { waitUntil: 'domcontentloaded' });
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Dark: light text on a dark dialog.
  const luminance = await dialog(page).evaluate(element => {
    const channels = colour => colour.match(/[\d.]+/g).slice(0, 3).map(Number);
    const [br, bg, bb] = channels(getComputedStyle(element).backgroundColor);
    const [tr, tg, tb] = channels(getComputedStyle(element.querySelector('#agent-approval-who')).color);
    return { background: (br + bg + bb) / 3, text: (tr + tg + tb) / 3 };
  });
  expect(luminance.background).toBeLessThan(80);
  expect(luminance.text).toBeGreaterThan(160);
  const fits = selector => page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1);
  expect(await fits('#agent-approval-dialog')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#agent-approval-allow').click();
  await expect(dialog(page)).toBeHidden();
  await expect(status(page)).toHaveText('Claude connected');
  await openPhoneSheet(page);
  await expect(page.locator('#agents-section')).toHaveJSProperty('open', true);
  await page.locator('#agent-connect-block').scrollIntoViewIfNeeded();
  await expect(status(page)).toBeVisible();
  expect(await fits('#agent-connect-block')).toBe(true);
  // One line: the status line does not wrap.
  const lines = await status(page).evaluate(element => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)));
  expect(lines).toBe(1);
});
