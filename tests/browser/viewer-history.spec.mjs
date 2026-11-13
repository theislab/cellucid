/**
 * The viewer's history, live, in a real browser against a real
 * cellucid-python viewer:
 *
 * - every action Python sends inside `viewer.turn(label)` carries the turn's
 *   id and label, and the page's history records each as a step of that
 *   turn; the action sent after the turn carries none;
 * - every change of the page's history (the tracker started, each step, an
 *   undo Python asked for through the generated `history_undo()`) reaches
 *   Python as a `history_changed` event: its hooks run and
 *   `viewer.history.last_change` follows;
 * - a session file `viewer.load_session(path)` pushes arrives whole as one
 *   binary frame and is answered by `session_loaded` (the tracker shown and
 *   its head); one the page refuses is Python's error, with the page's reason.
 *
 * The page runs the viewer's own modules (`helpers/host-history-page.mjs`).
 * Needs CELLUCID_PYTHON set to an interpreter that has cellucid's
 * dependencies; without it the file is skipped, as the other live-server specs
 * are, and CELLUCID_REQUIRE_VIEWERS=1 (set by the CI job that runs this spec)
 * makes that a failure. The server runs the cellucid-python checkout beside
 * this repository (or CELLUCID_PYTHON_ROOT), never whichever `cellucid` the
 * interpreter has.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { openHostHistoryPage } from './helpers/host-history-page.mjs';
import { expect, test } from './helpers/test.mjs';
import { viewerInterpreter } from './helpers/viewer-interpreters.mjs';

const PYTHON = viewerInterpreter('CELLUCID_PYTHON');
const PYTHON_SOURCE = path.join(
  process.env.CELLUCID_PYTHON_ROOT
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cellucid-python'),
  'src',
);
const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'history-golden.cellucid-session');

const SERVER = `
import json, pathlib, sys, time
import anndata as ad, numpy as np, pandas as pd
import cellucid.jupyter as jupyter
from cellucid._server_base import CELLUCID_WEB_URL
from cellucid.anndata_server import AnnDataServer

def say(value):
    print(json.dumps(value), flush=True)

adata = ad.AnnData(
    X=np.zeros((6, 1), np.float32),
    obs=pd.DataFrame(index=[f"c{i}" for i in range(6)]),
    var=pd.DataFrame(index=["g"]),
    obsm={"X_umap_2d": np.zeros((6, 2), np.float32)},
)
viewer = object.__new__(jupyter.AnnDataViewer)
viewer._init_state(port=None, client_server_url=None,
                   web_source_url=CELLUCID_WEB_URL, web_cache_dir=None, allowed_hosts=None)
viewer.data = adata
viewer._activate()
server = AnnDataServer(adata, host="127.0.0.1", port=0, quiet=True, serve_web_ui=False,
                       dataset_name="history", dataset_id="history")
server.start_background()
host, port = server._server.server_address
golden = pathlib.Path(sys.argv[1])
seen = []
viewer.history.on_change(seen.append)

def changes(count):
    deadline = time.monotonic() + 60
    while len(seen) < count and time.monotonic() < deadline:
        time.sleep(0.05)
    return list(seen)

try:
    say({"url": f"http://{host}:{port}", "viewerId": viewer._viewer_id, "viewerToken": viewer._viewer_token})
    viewer.wait_for_event("ready", timeout=60)
    with viewer.turn("  Mark   the doublets ") as turn:
        first = viewer.highlight_cells(cells=[0, 1], color="#ff0000", label="One")
        second = viewer.highlight_cells(cells=[2], color="#00ff00", label="Two")
    third = viewer.highlight_cells(cells=[3], color="#0000ff", label="Three")
    outcomes = [request.result(timeout=60) for request in (first, second, third)]
    steps = [request.step["id"] for request in (first, second, third)]
    recorded = changes(4)
    viewer.history_undo().result(timeout=60)
    after_undo = changes(5)
    say({"turn": turn, "outcomes": outcomes, "steps": steps, "seen": after_undo, "last": viewer.history.last_change,
         "head": viewer.history.head, "recorded": len(recorded)})
    loaded = viewer.load_session(golden).result(timeout=60)
    try:
        viewer.load_session(golden).result(timeout=60)
        refused = None
    except RuntimeError as error:
        refused = str(error)
    say({"loaded": loaded, "refused": refused})
finally:
    server.stop()
`;

test.skip(PYTHON === null, 'CELLUCID_PYTHON names no interpreter for the data server');

test('a notebook turn, history changes and a pushed session travel the channel', async ({ page }) => {
  test.setTimeout(180_000);
  const child = spawn(PYTHON, ['-c', SERVER, GOLDEN], {
    env: {
      ...process.env,
      PYTHONPATH: [PYTHON_SOURCE, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`the data server exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  try {
    const config = await next();
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await openHostHistoryPage(page, { ...config, dataset: 'history', cells: 6 });

    const live = await next();
    expect(live.turn).toMatch(/^python-[0-9a-f]{12}$/);
    expect(live.outcomes).toEqual([
      { group: 'highlight_1', page: 'Page 1', cells: 2 },
      { group: 'highlight_2', page: 'Page 1', cells: 1 },
      { group: 'highlight_3', page: 'Page 1', cells: 1 },
    ]);
    const tracker = 't-00000000-0000-4000-8000-000000000001';
    // The tracker started before Python's actions, each step, then the undo.
    expect(live.seen.map(change => change.kind)).toEqual(['tracker', 'step', 'step', 'step', 'moved']);
    expect(live.seen.slice(1, 4).map(change => change.step)).toEqual(live.steps);
    for (const change of live.seen) {
      expect(change.tracker).toBe(tracker);
      expect(Object.keys(change).sort()).toEqual(['branch', 'head', 'kind', 'step', 'tracker']);
    }
    expect(live.last).toEqual(live.seen[4]);
    expect(live.head).toBe(live.steps[1]);
    // The page's history records the turn's two steps in it, the third in none.
    expect(await page.evaluate(() => window.__hostHistory.steps().map(step => step.turn)))
      .toEqual([live.turn, live.turn, null]);
    expect(await page.evaluate(() => window.__hostHistory.commands)).toEqual([
      { action: 'highlight.cells', turn: live.turn, turnLabel: 'Mark the doublets' },
      { action: 'highlight.cells', turn: live.turn, turnLabel: 'Mark the doublets' },
      { action: 'highlight.cells', turn: null, turnLabel: null },
      { action: 'history.undo', turn: null, turnLabel: null },
    ]);
    expect(await page.evaluate(() => window.__hostHistory.errors)).toEqual([]);

    expect(await next()).toEqual({
      loaded: { tracker: { id: 't-0b7c6f0e-3c1a-4a52-9d1e-5f2b8c4a7e10', name: 'Annotation' }, head: 's13' },
      refused: 'The viewer did not load history-golden.cellucid-session: This page loads one session.',
    });
    expect(await page.evaluate(() => window.__hostHistory.loaded)).toEqual([
      { name: 'history-golden.cellucid-session', bytes: expect.any(Number) },
    ]);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
