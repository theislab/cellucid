/**
 * The viewer's history, live, in a real browser against a real cellucid-r
 * viewer (`cellucid_serve()`):
 *
 * - every action R sends inside `cellucid_turn(viewer, label, code)` carries
 *   the turn's id and label, and the page's history records each as a step
 *   of that turn; the action sent after the turn carries none;
 * - every change of the page's history (the tracker started, each step, an
 *   undo R asked for through the generated `cellucid_history_undo()`)
 *   reaches R as a `history_changed` event: its hooks run and
 *   `cellucid_last_history_change()` follows;
 * - a session file `cellucid_load_session()` pushes arrives whole as one
 *   binary frame and is answered by `session_loaded` (the tracker shown and
 *   its head); one the page refuses is R's error, with the page's reason.
 *
 * The page runs the viewer's own modules (`helpers/host-history-page.mjs`).
 * Needs CELLUCID_RSCRIPT set to an Rscript whose library (R_LIBS) has cellucid
 * and SingleCellExperiment installed; without it the file is skipped, as the
 * other live-server specs are, and CELLUCID_REQUIRE_VIEWERS=1 (set by the CI
 * job that runs this spec) makes that a failure.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { openHostHistoryPage } from './helpers/host-history-page.mjs';
import { expect, test } from './helpers/test.mjs';
import { viewerInterpreter } from './helpers/viewer-interpreters.mjs';

const RSCRIPT = viewerInterpreter('CELLUCID_RSCRIPT');
const GOLDEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'history-golden.cellucid-session');

const SERVER = `
suppressMessages({library(cellucid); library(SingleCellExperiment)})
golden <- commandArgs(TRUE)[[1L]]
say <- function(value) { cat(jsonlite::toJSON(value, auto_unbox = TRUE, null = "null", digits = NA), "\\n", sep = ""); flush(stdout()) }
counts <- matrix(0, 1L, 6L, dimnames = list("g", paste0("c", 0:5)))
sce <- SingleCellExperiment(assays = list(logcounts = counts))
reducedDim(sce, "UMAP") <- matrix(0, 6L, 2L)
v <- cellucid_serve(sce, dataset_id = "history", dataset_name = "history", serve_web_ui = FALSE, port = 0L, quiet = TRUE)
seen <- list()
cellucid_on(v, "history_changed", function(change) seen[[length(seen) + 1L]] <<- change)
changes <- function(count) {
  deadline <- proc.time()[["elapsed"]] + 60
  while (length(seen) < count && proc.time()[["elapsed"]] < deadline) later::run_now(0.02)
  seen
}
say(list(url = v$url, viewerId = v$viewer_id, viewerToken = v$viewer_token))
invisible(cellucid_wait_ready(v, timeout = 60))
requests <- list()
turn <- cellucid_turn(v, "  Mark   the doublets ", {
  requests$first <- cellucid_highlight_cells(v, c(1L, 2L), color = "#ff0000", label = "One")
  requests$second <- cellucid_highlight_cells(v, 3L, color = "#00ff00", label = "Two")
})
requests$third <- cellucid_highlight_cells(v, 4L, color = "#0000ff", label = "Three")
outcomes <- lapply(requests, cellucid_action_result, timeout = 60)
steps <- vapply(requests, function(request) request$step$id, "")
recorded <- length(changes(4L))
invisible(cellucid_action_result(cellucid_history_undo(v), timeout = 60))
after_undo <- changes(5L)
say(list(turn = turn, outcomes = unname(outcomes), steps = I(unname(steps)), seen = after_undo,
         last = cellucid_last_history_change(v), recorded = recorded))
loaded <- cellucid_load_session_result(cellucid_load_session(v, golden), timeout = 60)
refused <- tryCatch({
  cellucid_load_session_result(cellucid_load_session(v, golden), timeout = 60)
  NULL
}, error = function(error) conditionMessage(error))
say(list(loaded = loaded, refused = refused))
invisible(cellucid_stop(v))
`;

test.skip(RSCRIPT === null, 'CELLUCID_RSCRIPT names no Rscript for the R viewer');

test('an R turn, history changes and a pushed session travel the channel', async ({ page }) => {
  test.setTimeout(240_000);
  const control = mkdtempSync(path.join(os.tmpdir(), 'cellucid-r-history-'));
  const script = path.join(control, 'server.R');
  writeFileSync(script, SERVER);
  const child = spawn(RSCRIPT, [script, GOLDEN], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error(`the R server exited: ${stderr}`);
    return JSON.parse(line.value);
  };
  try {
    const config = await next();
    await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
    await openHostHistoryPage(page, { ...config, dataset: 'history', cells: 6 });

    const live = await next();
    expect(live.turn).toMatch(/^r-[0-9a-f]{12}$/);
    expect(live.outcomes).toEqual([
      { group: 'highlight_1', page: 'Page 1', cells: 2 },
      { group: 'highlight_2', page: 'Page 1', cells: 1 },
      { group: 'highlight_3', page: 'Page 1', cells: 1 },
    ]);
    const tracker = 't-00000000-0000-4000-8000-000000000001';
    expect(live.seen.map(change => change.kind)).toEqual(['tracker', 'step', 'step', 'step', 'moved']);
    expect(live.seen.slice(1, 4).map(change => change.step)).toEqual(live.steps);
    for (const change of live.seen) {
      expect(change.tracker).toBe(tracker);
      expect(Object.keys(change).sort()).toEqual(['branch', 'head', 'kind', 'step', 'tracker']);
    }
    expect(live.last).toEqual(live.seen[4]);
    expect(live.last.head).toBe(live.steps[1]);
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
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
