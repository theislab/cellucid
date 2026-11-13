/**
 * A local agent connection end to end: an agent app on this computer drives
 * a Cellucid viewer through `cellucid mcp` (cellucid-python), with no relay
 * and no deployed site, in a real browser running this checkout's app.
 *
 * A notebook-like Python process serves a small dataset and publishes its
 * viewer to agents on this computer; `python -m cellucid.cli mcp` (another
 * process, as Claude Code would start it) finds it in the agents folder and
 * speaks MCP over stdio with this spec, which plays the app:
 *
 * - `initialize` gives the local instructions and a tool list that changes;
 *   `tools/list` is the page's own list for this connection;
 * - a call runs in the page as "Claude Code", through a local connection: a
 *   step of the person's history labeled as the agent's, and the activity
 *   line names it "Claude Code (local)"; its Undo turn takes the turn back;
 * - the tool list is the same whatever the person's settings (nothing says it
 *   changed); the agent is told the settings after its first result and again
 *   after a result once they changed;
 * - a change the settings ask about: the page's confirm card, and the app's
 *   own MCP elicitation; the app's Decline answers the card, and the agent
 *   reads that the person declined; the app giving up on a call while it
 *   waits withdraws the card; "This connection" in the card allows the next
 *   ones too;
 * - `cellucid mcp --open` serves a file itself, and its viewer stops with it.
 *
 * Needs CELLUCID_PYTHON set to an interpreter with cellucid's dependencies and
 * the MCP SDK (`pip install 'cellucid[mcp]'`); without it the file is skipped,
 * as the other live-server specs are, and CELLUCID_REQUIRE_VIEWERS=1 (set by
 * the CI job that runs this spec) makes that a failure. Both processes run the
 * cellucid-python checkout beside this repository (or CELLUCID_PYTHON_ROOT).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { APP_ORIGIN } from './helpers/origins.mjs';
import { waitForHistory } from './helpers/state-history.mjs';
import { fieldNotShown, observeProductErrors, resultJson } from './helpers/agent-chat.mjs';
import { expect, test } from './helpers/test.mjs';
import { viewerInterpreter } from './helpers/viewer-interpreters.mjs';

const PYTHON = viewerInterpreter('CELLUCID_PYTHON');
const PYTHON_SOURCE = path.join(
  process.env.CELLUCID_PYTHON_ROOT
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cellucid-python'),
  'src',
);

// The notebook side: a viewer of 60 cells in three clusters (a script's
// AnnDataViewer, its page this checkout's app), published to agents.
const HOST = `
import json, sys
import anndata as ad, numpy as np, pandas as pd
import cellucid.jupyter as jupyter

rng = np.random.default_rng(7)
adata = ad.AnnData(
    X=rng.random((60, 3), dtype=np.float32),
    obs=pd.DataFrame({"leiden": pd.Categorical([str(i % 3) for i in range(60)])}, index=[f"c{i}" for i in range(60)]),
    var=pd.DataFrame(index=["g1", "g2", "g3"]),
    obsm={"X_umap": rng.random((60, 2), dtype=np.float32)},
)
viewer = jupyter.AnnDataViewer(adata, auto_open=False, dataset_name="Local agents", dataset_id="local-agents",
                               web_source_url=sys.argv[1], web_cache_dir=sys.argv[2])
print(json.dumps({"url": viewer.viewer_url}), flush=True)
try:
    sys.stdin.readline()
finally:
    viewer.stop()
`;

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for the viewer and cellucid mcp');

/** One process, its stdout read line by line as JSON. */
function start(args, env) {
  const child = spawn(PYTHON, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const messages = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index === -1) messages.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  return {
    child,
    stderr: () => stderr,
    send: message => child.stdin.write(`${JSON.stringify(message)}\n`),
    next(match = () => true, timeout = 60_000) {
      const index = messages.findIndex(match);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
            reject(new Error(`no message in ${timeout} ms; stderr: ${stderr}`));
          }
        }, timeout);
      });
    },
  };
}

test('an agent app drives a notebook viewer through cellucid mcp: steps, Undo turn, changed settings, a card asked in the app, a cancelled call', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = observeProductErrors(page);
  const agents = mkdtempSync(path.join(tmpdir(), 'cellucid-agents-'));
  const env = {
    ...process.env,
    CELLUCID_AGENTS_DIR: agents,
    PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  // The viewer serves this checkout's app (its asset inventory, as www.cellucid.com publishes it).
  const host = start(['-c', HOST, APP_ORIGIN, path.join(agents, 'web')], env);
  let app = null;
  try {
    const { url } = await host.next(() => true, 120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#dataset-name')).toHaveText('Local agents', { timeout: 60_000 });
    await waitForHistory(page);

    app = start(['-m', 'cellucid.cli', 'mcp'], env);
    let id = 0;
    const request = (method, params = {}) => {
      id += 1;
      const own = id;
      app.send({ jsonrpc: '2.0', id: own, method, params });
      return app.next(message => message.id === own && !('method' in message));
    };
    const call = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result;

    const init = (await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'claude-code', version: '2' },
    })).result;
    app.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(init.serverInfo.name).toBe('cellucid');
    expect(init.capabilities.tools.listChanged).toBe(false);
    expect(init.instructions).toContain('a Cellucid viewer on this computer');

    // The page's own list, for this connection: the catalog's tools and the status tool.
    const tools = (await request('tools/list')).result.tools;
    const names = tools.map(tool => tool.name);
    expect(names).toContain('color_by');
    expect(names.at(-1)).toBe('cellucid_status');
    expect(JSON.stringify(tools)).not.toMatch(/person's settings|Cellucid asks the person before/);
    // The status is data, between the data tags (names written by others are marked as data).
    const status = resultJson((await call('cellucid_status')).content[0].text);
    expect(status).toMatchObject({ agent: 'Claude Code', connected: true, viewer: { dataset: { id: 'local-agents', name: 'Local agents' } } });

    // A change: a step of the person's history, the agent's; the line names it, local. The connection's
    // first result tells the person's settings after it.
    // (A gene: the page opens colored by leiden already, its only category field, so leiden would change nothing.)
    const colored = await call('color_by', { field: { source: 'var', key: 'g1' } });
    expect(colored.isError).toBe(false);
    expect(colored.content[0].text).toMatch(/\[Cellucid: the person's settings for you now\. Permissions: [^\]]*changes in this tab: run without asking/);
    const steps = () => page.evaluate(() => {
      const tree = window._cellucidHistories.current().active;
      const out = [];
      for (let step = tree.steps.get(tree.headId); step && step.type !== null; step = tree.steps.get(step.parent)) {
        out.unshift({ id: step.id, type: step.type, agent: step.by.agent, turn: step.by.turn });
      }
      return out;
    });
    expect(await steps()).toMatchObject([{ type: 'color.by', agent: 'Claude Code' }]);
    const line = page.locator('#agent-presence .agent-activity[data-agent="Claude Code"]');
    await expect(line).toContainText('Claude Code (local)');

    // Undo turn on the agent's line takes its turn back.
    await line.locator('.agent-activity-undo').click();
    await expect.poll(async () => (await steps()).length).toBe(0);

    // The person has every change asked first: the list stays the same; the next result tells the agent.
    await page.evaluate(() => window._cellucidUi.agents.presence.permissions.set({ kinds: { change: 'ask' } }));
    expect((await request('tools/list')).result.tools).toEqual(tools);
    const told = await call('fields_list');
    expect(told.content[0].text).toMatch(/\[Cellucid: the person's settings for you now\. Permissions: [^\]]*changes in this tab[^\]]*: are asked of the person first/);

    // A change now asks: the card in the page, and the same question in the app; the app's Decline answers it.
    const card = page.locator('#agent-presence .agent-confirm');
    const declining = call('color_by', { field: { source: 'obs', key: 'leiden' } });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.agent-confirm-title')).toContainText('Claude Code (local) asks to');
    const asked = await app.next(message => message.method === 'elicitation/create');
    expect(asked.params.message).toContain('Claude Code (local) asks to');
    app.send({ jsonrpc: '2.0', id: asked.id, result: { action: 'decline' } });
    const declined = await declining;
    expect(declined.isError).toBe(true);
    expect(declined.content[0].text).toMatch(/^The person declined/);
    await expect(card).toHaveCount(0);
    expect(await steps()).toEqual([]);

    // The app gives up on a call while the question waits (notifications/cancelled): the card goes, nothing is done.
    id += 1;
    const cancelledId = id;
    app.send({ jsonrpc: '2.0', id: cancelledId, method: 'tools/call', params: { name: 'color_by', arguments: { field: { source: 'obs', key: 'leiden' } } } });
    await expect(card).toHaveCount(1);
    const elicited = await app.next(message => message.method === 'elicitation/create');
    app.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelledId, reason: 'The person pressed Esc' } });
    await expect(card).toHaveCount(0);
    expect(await steps()).toEqual([]);
    // The app's answer coming after the question went changes nothing.
    app.send({ jsonrpc: '2.0', id: elicited.id, result: { action: 'accept', content: {} } });

    // Allowed in the card for this connection: the change runs, and the next one is not asked again.
    // (A gene again: the view is colored by leiden after the Undo turn, so leiden would change nothing.)
    const allowing = call('color_by', { field: { source: 'var', key: 'g2' } });
    await card.locator('.agent-confirm-allow-here').click();
    expect((await allowing).isError).toBe(false);
    expect((await call('color_by', { field: { source: 'var', key: 'g2' } })).isError).toBe(false);
    await expect(card).toHaveCount(0);
    expect((await steps()).map(entry => entry.agent)).toEqual(['Claude Code']);
    expect(errors).toEqual([]);
  } finally {
    // Both end when their stdin closes (the app ends cellucid mcp; the host stops its viewer).
    const ended = child => (child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)));
    app?.child.stdin.end();
    host.child.stdin.end();
    await Promise.all([app === null ? null : ended(app.child), ended(host.child)]);
    rmSync(agents, { recursive: true, force: true });
  }
});

test('cellucid mcp --open serves a file in a viewer of its own and drives it; the viewer stops with it', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = observeProductErrors(page);
  const agents = mkdtempSync(path.join(tmpdir(), 'cellucid-agents-'));
  const env = {
    ...process.env,
    CELLUCID_AGENTS_DIR: agents,
    PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const file = fileURLToPath(new URL('./fixtures/catalog/current-ui.h5ad', import.meta.url));
  const app = start(['-m', 'cellucid.cli', 'mcp', '--open', file, '--no-browser', '--web-source-url', APP_ORIGIN, '--web-cache-dir', path.join(agents, 'web')], env);
  let url = null;
  try {
    let id = 0;
    const request = (method, params = {}) => {
      id += 1;
      const own = id;
      app.send({ jsonrpc: '2.0', id: own, method, params });
      return app.next(message => message.id === own && !('method' in message), 120_000);
    };
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-vscode', version: '1' } });
    app.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Its address is said on stderr; stdout carries only the protocol.
    await expect.poll(() => /Cellucid viewer: (\S+)/.exec(app.stderr())?.[1] ?? null, { timeout: 120_000 }).not.toBeNull();
    url = /Cellucid viewer: (\S+)/.exec(app.stderr())[1];
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForHistory(page);
    await expect.poll(async () => resultJson((await request('tools/call', { name: 'cellucid_status', arguments: {} })).result.content[0].text).connected, { timeout: 60_000 }).toBe(true);
    const field = await fieldNotShown(page);
    const colored = (await request('tools/call', { name: 'color_by', arguments: { field: { source: 'obs', key: field } } })).result;
    expect(colored.isError, JSON.stringify(colored)).toBe(false);
    await expect(page.locator('#agent-presence .agent-activity[data-agent="Cursor"]')).toContainText('Cursor (local)');
    expect(errors).toEqual([]);
  } finally {
    app.child.stdin.end();
    // The app closed the server: the viewer it opened stops, and its page says so.
    await (app.child.exitCode !== null ? Promise.resolve() : new Promise(resolve => app.child.once('exit', resolve)));
    rmSync(agents, { recursive: true, force: true });
  }
  // Its server answers no more.
  const health = `${new URL(url).origin}/_cellucid/health`;
  await expect(fetch(health)).rejects.toThrow();
});
