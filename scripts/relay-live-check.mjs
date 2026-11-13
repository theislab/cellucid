#!/usr/bin/env node
/**
 * Check the DEPLOYED Cellucid relay end to end, as Claude and ChatGPT use it,
 * without anyone's Claude or ChatGPT account: this script is the MCP client
 * and a Chromium page (Playwright) is the person's Cellucid tab.
 *
 *   node scripts/relay-live-check.mjs [--relay https://<relay>] [--idle 90] [--asking] [--port 8000] [--out <file.json>]
 *
 * What it checks, in order, each a line PASS or FAIL with what it saw:
 *
 * 1. Discovery: the MCP endpoint (the relay's root) without a token answers
 *    401 with `resource_metadata`; `/health` and a GET of the root (405);
 *    the protected-resource and authorization-server metadata (S256, `none`,
 *    CIMD and DCR advertised: what makes Claude choose CIMD).
 * 2. Dynamic Client Registration, PKCE S256, the authorize page shown in the
 *    tab's browser (who asks, the connect code, the approver cookie it sets),
 *    the approval link opened in the tab (`#cellucid_connect=`), Allow, the
 *    page's wait handing back the redirect with `code`, `state` and `iss`, the
 *    token exchange. A link whose page another browser shows is refused in
 *    the tab (`other-browser`): nothing to allow.
 * 3. MCP, both eras: `initialize` (2025-06-18), `server/discover` and
 *    `tools/list` (2026-07-28 headers); the tools are the tab's catalog,
 *    the view card's tools name `ui://cellucid/view`; `resources/read` gives
 *    the card's HTML.
 * 4. Tool calls reaching the tab and back: the datasets to open, a dataset
 *    opened by name (the tab shows it), a coloring (a step of the tab's
 *    history labeled as the agent's), a picture as image content within a
 *    chat's limits, one too large left out with a sentence, `cellucid_status`.
 *    The history through the tools: the agent's steps, undo, a jump.
 *    With `--asking`: a large download the person is asked about and does
 *    not answer within a call's time (225 s) is answered to the agent as
 *    such, stays open in the tab, and runs once allowed.
 * 5. After `--idle` seconds of silence (the pairing's Durable Object
 *    hibernates; the tab's keep-alive is answered without waking it), a call
 *    still reaches the tab.
 * 6. Refresh tokens rotate: a refresh gives new tokens; the used one, sent
 *    again, ends the connection (and the access token stops working).
 * 7. Client ID Metadata Documents: ChatGPT's (`https://chatgpt.com/oauth/client.json`,
 *    which declares `private_key_jwt` and supports `none`) and Claude Code's
 *    (`https://claude.ai/oauth/claude-code-client-metadata`, loopback
 *    redirects on any port), each approved with a code typed in the tab;
 *    the tab shows ChatGPT and Claude by the host that vouches for them.
 * 8. Forget in the tab ends every connection: calls answer 401.
 *
 * The tab is this checkout's Cellucid page, opened on the browser tests' small
 * demo catalog, in the same site as the relay, since a claim carries the
 * relay's `SameSite=Strict` approver cookie: for the deployed relay the page
 * is served as https://www.cellucid.com (Playwright answers that origin from
 * the local server; the relay allows it), for a local relay (`--relay
 * http://127.0.0.1:8787`, `wrangler dev`) it is http://127.0.0.1:8000,
 * pointed at it with `__CELLUCID_RELAY_ORIGIN__`. Each waiting page is opened
 * in the tab's browser (another tab of its context), as Claude opens it in
 * the person's browser, then closed: its code and secret are read from it.
 * Nothing secret is printed: tokens and codes stay in memory. It is not part
 * of CI (it needs the network and the deployed relay).
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserLaunchOptions } from './lib/browser-launch.mjs';
import { plainText, resultDataOf } from '../assets/js/app/agent/bridge/mcp-content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
// The relay's origin: also its MCP endpoint, the connector address and the OAuth resource.
const RELAY = new URL(option('relay', 'https://mcp.cellucid.com')).origin;
const IDLE_SECONDS = Number(option('idle', '90'));
const OUT = option('out', null);
const ASKING = args.includes('--asking');
const PORT = Number(option('port', '8000'));
const SAMPLE_PORT = PORT + 1;
const LOCAL = `http://127.0.0.1:${PORT}`;
// The page and the relay are one site: the deployed site's address, or the local relay's host.
const LOCAL_RELAY = new URL(RELAY).protocol === 'http:';
const APP = LOCAL_RELAY ? LOCAL : 'https://www.cellucid.com';
const PAGE_URL = `${APP}/?sampleCatalog=${encodeURIComponent(`${APP}/tests/browser/fixtures/demo-catalog/`)}&dataset=synthetic-cell-types-2d`;
const MCP = RELAY;

const results = [];
function record(name, ok, detail, ms = null) {
  results.push({ name, ok, detail, ms });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ms === null ? '' : ` (${Math.round(ms)} ms)`}: ${detail}`);
}
async function check(name, work) {
  const started = performance.now();
  try {
    const detail = await work();
    record(name, true, detail ?? 'ok', performance.now() - started);
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error), performance.now() - started);
    return false;
  }
}
function must(condition, message) {
  if (!condition) throw new Error(message);
}

const base64Url = bytes => Buffer.from(bytes).toString('base64url');
function pkce() {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}, not JSON: ${text.slice(0, 160)}`);
  }
}

/**
 * Start authorizing at the relay in `context`'s browser, as Claude opens the
 * page in the person's: the page a person sees (its approver cookie kept by
 * that browser), its code and the page's own secret. The page is closed once
 * read, so it never follows the answer to the client's address.
 */
async function authorize(context, { clientId, redirectUri, challenge, state }) {
  const url = new URL(`${RELAY}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state, scope: 'cellucid', resource: MCP,
  })) url.searchParams.set(key, value);
  const page = await context.newPage();
  try {
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const html = await response.text();
    must(response.status() === 200, `authorize answered ${response.status()}: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
    const main = page.locator('main[data-code]');
    const code = await main.getAttribute('data-code');
    const request = await main.getAttribute('data-request');
    const heading = await page.locator('h1').textContent();
    must(code && request, 'the authorize page carries no connect code');
    const headers = await response.allHeaders();
    must(headers['content-security-policy']?.includes("frame-ancestors 'none'"), 'the authorize page can be framed');
    must(/^__Host-cellucid-approver=[^;]+;.*Secure.*HttpOnly.*SameSite=Strict/.test(headers['set-cookie'] ?? ''), 'the authorize page sets no approver cookie');
    must((await context.cookies(RELAY)).some(cookie => cookie.name === '__Host-cellucid-approver'), 'the browser did not keep the approver cookie');
    return { code, request, heading, display: `${code.slice(0, 4)}-${code.slice(4)}` };
  } finally {
    await page.close();
  }
}

/** The authorize page's long poll, until the person answered in the tab. */
async function decision({ code, request }) {
  let seen = 'waiting';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const answer = await json(await fetch(`${RELAY}/oauth/authorize/wait`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, request, seen }),
    }));
    if (answer.status === 'approved' || answer.status === 'denied') return answer;
    if (answer.status === 'expired') throw new Error('the request expired');
    seen = answer.status;
  }
  throw new Error('no answer after 40 waits');
}

async function token(fields) {
  const response = await fetch(`${RELAY}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
  });
  return { status: response.status, body: await json(response) };
}

let rpcId = 1;
async function mcp(accessToken, method, params = {}, era = 'handshake') {
  const id = rpcId++;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (accessToken !== null) headers.Authorization = `Bearer ${accessToken}`;
  let body = { jsonrpc: '2.0', id, method, params };
  if (era === 'modern') {
    const version = '2026-07-28';
    body = { ...body, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } };
    Object.assign(headers, { 'MCP-Protocol-Version': version, 'Mcp-Method': method });
    if (method === 'tools/call') headers['Mcp-Name'] = params.name;
  } else {
    headers['MCP-Protocol-Version'] = '2025-06-18';
  }
  const started = performance.now();
  const response = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify(body) });
  const ms = performance.now() - started;
  if (response.status === 401) return { status: 401, auth: response.headers.get('www-authenticate'), ms };
  const answer = await json(response);
  return { status: response.status, answer, ms };
}

async function call(accessToken, name, toolArgs = {}) {
  const { status, answer, ms, auth } = await mcp(accessToken, 'tools/call', { name, arguments: toolArgs });
  if (status === 401) throw new Error(`401 ${auth}`);
  must(status === 200 && answer.result !== undefined, `tools/call ${name}: HTTP ${status} ${JSON.stringify(answer.error ?? answer).slice(0, 200)}`);
  return { result: answer.result, ms };
}

const textOf = result => result.content.find(item => item.type === 'text')?.text ?? '';
/** A result's data: the text between its data marks (`mcp-content.js`), as JSON. */
const dataOf = result => JSON.parse(resultDataOf(textOf(result)) ?? textOf(result));

function startServer() {
  const server = spawn(process.execPath, ['scripts/serve-browser-tests.mjs'], {
    cwd: ROOT,
    env: { ...process.env, CELLUCID_BROWSER_TEST_PORT: String(PORT), CELLUCID_BROWSER_TEST_SAMPLE_PORT: String(SAMPLE_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let said = '';
    const onData = chunk => {
      said += chunk;
      if (said.includes(`listening on http://127.0.0.1:${PORT}`)) resolve(server);
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
    server.on('exit', code => reject(new Error(`the page server stopped (${code}): ${said.slice(-300)}`)));
  });
}

/** A browser (a context) whose www.cellucid.com is this checkout's page, served by the local server. */
async function newBrowser(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
  if (!LOCAL_RELAY) {
    await context.route(`${APP}/**`, async route => {
      const local = route.request().url().replace(APP, LOCAL);
      await route.fulfill({ response: await route.fetch({ url: local }) });
    });
  } else {
    await context.addInitScript(origin => { window.__CELLUCID_RELAY_ORIGIN__ = origin; }, RELAY);
  }
  return context;
}

async function openTab(browser) {
  const context = await newBrowser(browser);
  const page = await context.newPage();
  page.on('pageerror', error => console.log(`  page error: ${error.message}`));
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-startup-phase="ready"]').waitFor({ timeout: 60_000 });
  await dismissWelcome(page);
  return { context, page };
}

/** The first visit's welcome, closed as a person closes it. */
async function dismissWelcome(page) {
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) {
    await page.keyboard.press('Escape');
    await welcome.waitFor({ state: 'hidden' });
  }
}

/** Approve in the tab: by the relay page's link (a fresh load with the fragment) or by typing the code. */
async function approveInTab(page, display, { via, expectWho }) {
  if (via === 'link') {
    await page.goto('about:blank');
    await page.goto(`${PAGE_URL}#cellucid_connect=${display}`, { waitUntil: 'domcontentloaded' });
  } else {
    const section = page.locator('#agents-section');
    if (!(await section.evaluate(element => element.open))) await page.locator('#agents-section > summary').click();
    await page.locator('#agent-connect-code').fill(display.toLowerCase());
    await page.locator('#agent-connect-code').press('Enter');
  }
  const dialog = page.locator('#agent-approval-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  const who = await page.locator('#agent-approval-who').textContent();
  must(who.startsWith(expectWho), `the tab says "${who.slice(0, 80)}", not "${expectWho}…"`);
  must((await page.locator('#agent-approval-code').textContent()) === display, 'the tab shows another code');
  await page.locator('#agent-approval-allow').click();
  await dialog.waitFor({ state: 'hidden' });
  await dismissWelcome(page);
  return who;
}

async function connectClient(page, { clientId, redirectUri, via, expectWho, extraToken = {} }) {
  const { verifier, challenge } = pkce();
  const state = base64Url(randomBytes(12));
  const asked = await authorize(page.context(), { clientId, redirectUri, challenge, state });
  const waiting = decision(asked);
  const who = await approveInTab(page, asked.display, { via, expectWho });
  const answer = await waiting;
  must(answer.status === 'approved', `the page was answered ${answer.status}`);
  const redirect = new URL(answer.redirect);
  must(redirect.searchParams.get('state') === state, 'state did not come back');
  must(redirect.searchParams.get('iss') === RELAY, `iss is ${redirect.searchParams.get('iss')}`);
  const code = redirect.searchParams.get('code');
  must(`${redirect.origin}${redirect.pathname}` === redirectUri.replace(/\?.*$/, ''), `redirected to ${redirect.origin}${redirect.pathname}`);
  const exchanged = await token({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource: MCP, ...extraToken,
  });
  must(exchanged.status === 200, `token exchange: ${exchanged.status} ${JSON.stringify(exchanged.body)}`);
  must(exchanged.body.token_type === 'Bearer' && exchanged.body.expires_in === 3600 && typeof exchanged.body.refresh_token === 'string', 'the tokens are not a bearer pair');
  // A code works once.
  const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri });
  must(again.status === 400 && again.body.error === 'invalid_grant', 'the authorization code worked twice');
  return { tokens: exchanged.body, heading: asked.heading, who, clientId };
}

async function main() {
  console.log(`Relay: ${RELAY}\nTab:   ${PAGE_URL}\n`);
  const server = await startServer();
  const browser = await chromium.launch(browserLaunchOptions('chromium'));
  let tab = null;
  try {
    tab = await openTab(browser);
    const { page } = tab;

    let metadata = null;
    await check('discovery: 401 names the metadata; S256, none, CIMD and DCR advertised', async () => {
      const unauthenticated = await mcp(null, 'tools/list');
      must(unauthenticated.status === 401, `answered ${unauthenticated.status}`);
      must(unauthenticated.auth.includes(`resource_metadata="${RELAY}/.well-known/oauth-protected-resource"`), unauthenticated.auth);
      const resource = await json(await fetch(`${RELAY}/.well-known/oauth-protected-resource`));
      must(resource.resource === MCP, `resource is ${resource.resource}, not the connector address ${MCP}`);
      const health = await json(await fetch(`${RELAY}/health`));
      must(health.status === 'ok' && health.mcp === MCP, `health: ${JSON.stringify(health)}`);
      must((await fetch(`${RELAY}/`)).status === 405, 'a GET of the MCP endpoint is not 405');
      metadata = await json(await fetch(`${RELAY}/.well-known/oauth-authorization-server`));
      must(metadata.code_challenge_methods_supported.includes('S256'), 'no S256');
      must(metadata.token_endpoint_auth_methods_supported.includes('none') && metadata.client_id_metadata_document_supported === true,
        'Claude would not choose CIMD');
      must(typeof metadata.registration_endpoint === 'string', 'no DCR');
      return `issuer ${metadata.issuer}; Claude chooses CIMD (none + client_id_metadata_document_supported)`;
    });

    // ---- DCR, the approval link, MCP ------------------------------------------------
    const redirectUri = 'http://127.0.0.1:53682/callback';
    let dcr = null;
    await check('DCR + PKCE + approval link in the tab + token exchange', async () => {
      const registered = await fetch(`${RELAY}/oauth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Cellucid live check', token_endpoint_auth_method: 'none' }),
      });
      const client = await json(registered);
      must(registered.status === 201 && client.client_id.startsWith('cd1.'), `register: ${registered.status}`);
      // Registered with a loopback redirect and no client document: no site vouches for it, so it is
      // an app on this computer, its own name only quoted.
      dcr = await connectClient(page, {
        clientId: client.client_id, redirectUri, via: 'link', expectWho: 'An app on this computer, which calls itself “Cellucid live check”, asks',
      });
      return `client registered (${client.client_id.length} chars); the page asks "${dcr.heading}"; the tab shows "${dcr.who.slice(0, 60)}…"`;
    });
    if (dcr === null) throw new Error('No connection: the rest cannot run.');
    let access = dcr.tokens.access_token;

    await check('a link whose waiting page another browser shows is refused in the tab: nothing to allow', async () => {
      const other = await newBrowser(browser);
      try {
        const { challenge } = pkce();
        const asked = await authorize(other, { clientId: dcr.clientId, redirectUri, challenge, state: base64Url(randomBytes(12)) });
        await page.goto('about:blank');
        await page.goto(`${PAGE_URL}#cellucid_connect=${asked.display}`, { waitUntil: 'domcontentloaded' });
        const notice = page.locator('#notification-center').filter({ hasText: 'started in another browser' });
        await notice.waitFor({ timeout: 30_000 });
        must(!(await page.locator('#agent-approval-dialog').isVisible()), 'the tab asks to allow it');
        await dismissWelcome(page);
        return 'refused: "This connect code was started in another browser…"';
      } finally {
        await other.close();
      }
    });

    await check('the tab lists the connection', async () => {
      await page.locator('#agent-connect-status').filter({ hasText: 'connected' }).waitFor({ timeout: 15_000 });
      return await page.locator('#agent-connect-status').textContent();
    });

    await check('initialize (2025-06-18): tools and resources, instructions', async () => {
      const { answer } = await mcp(access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-check', version: '1' } });
      must(answer.result.protocolVersion === '2025-06-18', answer.result.protocolVersion);
      must(answer.result.capabilities.resources !== undefined && answer.result.capabilities.tools !== undefined, JSON.stringify(answer.result.capabilities));
      must(answer.result.instructions.length > 1000, 'no instructions');
      return `server ${answer.result.serverInfo.name} ${answer.result.serverInfo.version}`;
    });

    let toolNames = [];
    await check('tools/list (handshake): the tab\'s catalog, the view card on its tools', async () => {
      const { answer, ms } = await mcp(access, 'tools/list');
      toolNames = answer.result.tools.map(tool => tool.name);
      for (const name of ['dataset_open', 'datasets_list', 'view_picture', 'cellucid_status', 'color_by', 'history_get']) {
        must(toolNames.includes(name), `no ${name}`);
      }
      const card = answer.result.tools.filter(tool => tool._meta?.ui?.resourceUri === 'ui://cellucid/view').map(tool => tool.name);
      must(card.join() === 'dataset_open,view_picture', `card tools: ${card}`);
      return `${toolNames.length} tools in ${Math.round(ms)} ms; the card on ${card.join(', ')}`;
    });

    await check('2026-07-28 era: server/discover and tools/list with headers', async () => {
      const discover = await mcp(access, 'server/discover', {}, 'modern');
      must(discover.answer.result.supportedVersions.includes('2026-07-28'), JSON.stringify(discover.answer).slice(0, 200));
      const listed = await mcp(access, 'tools/list', {}, 'modern');
      must(listed.answer.result.resultType === 'complete' && listed.answer.result.tools.length === toolNames.length, 'modern list differs');
      return `resources capability ${JSON.stringify(discover.answer.result.capabilities.resources)}`;
    });

    await check('resources/read ui://cellucid/view: the card\'s HTML, nothing loaded from elsewhere', async () => {
      const { answer } = await mcp(access, 'resources/read', { uri: 'ui://cellucid/view' });
      const [card] = answer.result.contents;
      must(card.mimeType === 'text/html;profile=mcp-app' && card.text.startsWith('<!doctype html>'), card.mimeType);
      must(!/\b(?:src|href)=["']?https?:/.test(card.text), 'it loads something from elsewhere');
      return `${card.text.length} characters; csp ${JSON.stringify(card._meta.ui.csp)}`;
    });

    await check('tools/call datasets_list reaches the tab', async () => {
      const { result, ms } = await call(access, 'datasets_list');
      const list = dataOf((result));
      must(list.samples.length === 3, `${list.samples.length} samples`);
      return `${list.samples.length} samples, open: ${list.open?.name}; round trip ${Math.round(ms)} ms`;
    });

    await check('tools/call dataset_open by a word of its name: the tab shows it', async () => {
      const { result, ms } = await call(access, 'dataset_open', { name: 'trajectory' });
      must(!result.isError, textOf(result));
      const opened = dataOf((result));
      await page.locator('#dataset-name', { hasText: opened.name }).waitFor({ timeout: 30_000 });
      must(result._meta?.['cellucid/view']?.dataset === opened.name, 'no card metadata');
      return `${opened.name}, ${opened.cells} cells, ${Math.round(ms)} ms`;
    });

    await check('a refusal names what exists', async () => {
      const { result } = await call(access, 'dataset_open', { name: 'zebrafish' });
      must(result.isError && /^There is no dataset "zebrafish": the samples are /.test(plainText(textOf(result))), textOf(result).slice(0, 120));
      return plainText(textOf(result)).slice(0, 110);
    });

    await check('a coloring is a step of the tab\'s history, labeled as the agent\'s', async () => {
      const fields = dataOf(((await call(access, 'fields_list', { kind: 'categorical' })).result));
      // A field other than the one shown, so the coloring is a change (one already shown makes no step).
      let body = null;
      for (const field of fields.fields) {
        body = dataOf((await call(access, 'color_by', { field: { source: 'obs', key: field.key } })).result);
        if (body.step !== null) break;
      }
      must(body?.step != null, 'no step');
      const history = dataOf(((await call(access, 'history_get')).result));
      const step = history.steps.find(each => each.id === body.step.id);
      // No site vouches for this registered app: its steps carry the name Manage… gives it.
      const named = 'An app on this computer (calls itself “Cellucid live check”)';
      must(step.origin === 'agent' && step.agent === named, `origin ${step.origin} ${step.agent}`);
      return `"${body.step.label}" by ${step.agent}`;
    });

    await check('the history is the agent\'s too: undo and a jump through the tools', async () => {
      const history = dataOf(((await call(access, 'history_get')).result));
      const mine = history.steps.filter(step => step.origin === 'agent');
      must(mine.length > 0, 'no step of the agent');
      const last = mine.at(-1);
      const undone = dataOf(((await call(access, 'history_undo')).result));
      must(undone.moved === true && undone.head !== last.id, `undo: ${JSON.stringify(undone)}`);
      const shown = dataOf(((await call(access, 'history_jump', { step: last.id })).result));
      must(shown.head === last.id, `jump: ${JSON.stringify(shown)}`);
      return `${mine.length} step(s) by ${last.agent} in turn ${last.turn.slice(0, 12)}…; undone and shown again`;
    });

    let pictureBytes = 0;
    await check('view_picture: image content within a chat\'s limits', async () => {
      const { result, ms } = await call(access, 'view_picture', { width: 640, height: 480 });
      const image = result.content.find(item => item.type === 'image');
      must(image && image.mimeType === 'image/png', 'no image');
      const body = dataOf((result));
      must(body.png?.image === 1 && !textOf(result).includes(image.data.slice(0, 64)), 'the picture traveled as text');
      pictureBytes = image.data.length;
      must(pictureBytes < 10 * 1024 * 1024, 'over 10 MiB');
      return `${body.width} × ${body.height} px, ${pictureBytes} base64 characters, text ${textOf(result).length} characters, ${Math.round(ms)} ms`;
    });

    await check('a picture larger than a chat takes is left out with a sentence', async () => {
      // The picture fits the pane inside the box asked for and keeps its shape (`reads/views.js`), so
      // the box must be large on both sides for the picture to pass 8,000 px on its longer side.
      const { result } = await call(access, 'view_picture', { width: 8200, height: 8200, legend: false });
      must(!result.content.some(item => item.type === 'image'), 'sent anyway');
      must(/more than a chat takes \(/.test(textOf(result)), textOf(result).slice(-200));
      return textOf(result).split('\n').at(-1);
    });

    await check('cellucid_status (answered by the relay)', async () => {
      const status = dataOf(((await call(access, 'cellucid_status')).result));
      must(status.connected === true && status.tabs.length >= 1, JSON.stringify(status));
      return `connected; dataset "${status.tabs[0].dataset}"`;
    });

    if (ASKING) {
      await check('a question the person has not answered within a call\'s time: the agent is told, the question stays open, and runs once answered', async () => {
        const url = `http://127.0.0.1:${SAMPLE_PORT}/whole-only/current-ui.h5ad`;
        const bytes = await readFile(path.join(ROOT, 'tests', 'browser', 'fixtures', 'catalog', 'current-ui.h5ad'));
        await page.route(url, route => {
          const headers = {
            'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, ETag',
            'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), ETag: '"whole-1"',
          };
          return route.fulfill({ status: 200, headers, body: route.request().method() === 'HEAD' ? '' : bytes });
        });
        // The person's answer, held back: a confirmer that waits until told (the presence layer's card does this in the app).
        await page.evaluate(async () => {
          const { getActions } = await import('/assets/js/app/actions/index.js');
          getActions().setConfirmer(() => new Promise(resolve => { window.__answerConfirm = resolve; }));
        });
        const started = performance.now();
        const { result } = await call(access, 'dataset_open', { name: url });
        const waited = performance.now() - started;
        must(result.isError && /^Cellucid is asking the person in their tab whether to go ahead \(It downloads the whole file current-ui\.h5ad/.test(textOf(result)), textOf(result).slice(0, 160));
        must(waited < 240_000, `the answer took ${Math.round(waited)} ms`);
        // The question stayed open: the person answers now, and it runs.
        await page.evaluate(() => window.__answerConfirm(true));
        await page.locator('#dataset-name', { hasText: 'Current UI fixture' }).waitFor({ timeout: 30_000 });
        return `told after ${Math.round(waited / 1000)} s (under 240 s); opened once the person allowed it`;
      });
    }

    await check(`after ${IDLE_SECONDS} s of silence (the pairing hibernates) a call still reaches the tab`, async () => {
      await new Promise(resolve => setTimeout(resolve, IDLE_SECONDS * 1000));
      const { result, ms } = await call(access, 'datasets_list');
      must(!result.isError, textOf(result));
      return `answered in ${Math.round(ms)} ms after ${IDLE_SECONDS} s idle`;
    });

    await check('refresh tokens rotate; a used one ends the connection', async () => {
      const first = await token({ grant_type: 'refresh_token', refresh_token: dcr.tokens.refresh_token, resource: MCP });
      must(first.status === 200 && first.body.refresh_token !== dcr.tokens.refresh_token, `refresh: ${first.status}`);
      const works = await call(first.body.access_token, 'cellucid_status');
      must(!works.result.isError, 'the new access token does not work');
      const reused = await token({ grant_type: 'refresh_token', refresh_token: dcr.tokens.refresh_token });
      must(reused.status === 400 && reused.body.error === 'invalid_grant', `reuse: ${reused.status} ${reused.body.error}`);
      const after = await mcp(first.body.access_token, 'tools/list');
      must(after.status === 401 && /removed in Cellucid/.test(after.auth), `after reuse: ${after.status}`);
      access = null;
      return `reuse refused: "${reused.body.error_description}"`;
    });

    // ---- Client ID Metadata Documents ---------------------------------------------
    let chatgpt = null;
    await check('ChatGPT\'s client metadata document (private_key_jwt declared, none supported): approved by a typed code', async () => {
      chatgpt = await connectClient(page, {
        clientId: 'https://chatgpt.com/oauth/client.json',
        redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        via: 'typed',
        expectWho: 'ChatGPT (chatgpt.com) asks',
      });
      const { result } = await call(chatgpt.tokens.access_token, 'history_get');
      must(!result.isError, textOf(result));
      return `the page asks "${chatgpt.heading}"; public-client token exchange works`;
    });

    let claudeCode = null;
    await check('Claude Code\'s client metadata document (loopback redirect, any port)', async () => {
      claudeCode = await connectClient(page, {
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        redirectUri: 'http://localhost:51515/callback',
        via: 'typed',
        expectWho: 'Claude (claude.ai) asks',
      });
      const { result } = await call(claudeCode.tokens.access_token, 'cellucid_status');
      must(dataOf((result)).agent === 'Claude', textOf(result));
      return `the page asks "${claudeCode.heading}"; the connection is Claude's`;
    });

    await check('Manage… lists the connections', async () => {
      await page.locator('#agent-connections-open-btn').click();
      const rows = page.locator('#agent-connections-list .agent-connection-row .agent-connection-title');
      await rows.first().waitFor({ timeout: 10_000 });
      const titles = await rows.allTextContents();
      must(titles.includes('ChatGPT') && titles.includes('Claude (Claude Code)'), titles.join(', '));
      return titles.join(', ');
    });

    await check('Forget in the tab ends every connection: calls answer 401', async () => {
      await page.locator('#agent-forget-btn').click();
      await page.locator('#agent-forget-yes').click();
      await page.locator('#agent-connections-empty').waitFor({ state: 'visible', timeout: 10_000 });
      await page.keyboard.press('Escape');
      for (const [name, connection] of [['ChatGPT', chatgpt], ['Claude Code', claudeCode]]) {
        if (connection === null) continue;
        const after = await mcp(connection.tokens.access_token, 'tools/list');
        must(after.status === 401 && after.auth.includes('invalid_token'), `${name}: ${after.status}`);
      }
      const secret = await page.evaluate(() => localStorage.getItem('cellucid:agent-relay:tab-secret'));
      must(secret === null, 'the tab secret is still kept');
      return `401 for both; status "${await page.locator('#agent-connect-status').textContent()}"`;
    });
  } finally {
    await tab?.context.close();
    await browser.close();
    server.kill();
  }
  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (OUT !== null) await writeFile(OUT, `${JSON.stringify({ relay: RELAY, at: new Date().toISOString(), results }, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
