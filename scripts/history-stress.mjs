#!/usr/bin/env node
/**
 * The history stress suite (`tests/stress/`, `cellucid-private/plans/history-v2.md`
 * §3.15.4): builds mixed histories on a synthetic dataset and measures the
 * recording overhead, jumps, undo and redo, delete-a-step, replay, the
 * autosave, the memory accounting, `history.get`, the session file and
 * memory, at each checkpoint; and each kind of step alone (bytes per step,
 * recording cost). Results are JSON, one file per run, and a summary table.
 *
 *   npm run stress:history -- [--steps 1000,10000,50000,100000] [--cells 1000000]
 *     [--genes 20000] [--repeat 2] [--seed 1] [--kinds-only | --no-kinds] [--mixed-only]
 *     [--out <dir>] [--guard-gib 8] [--quick]
 *   npm run stress:history -- --readers [--python <interpreter>] [--rscript <Rscript>] [--out <dir>]
 *
 * - `--steps`: the checkpoints; one history is built up to the largest and
 *   measured at each (the default is 1k, 10k, 50k and 100k steps).
 * - `--repeat N`: N runs of the mixed history (seeds `seed`, `seed+1`, …), each
 *   in a process of its own, so every figure the report claims is seen twice.
 * - `--quick`: 2k steps on 100k cells and 2000 genes (a check of the suite).
 * - `--guard-gib`: a run stops (and says where) when its process holds more
 *   memory than this; it guards the machine, it is not a limit of the history.
 * - `--readers`: cellucid-python's `read_session` and cellucid-r's
 *   `cellucid_read_session` timed on the golden history made 1k, 10k and 100k
 *   steps longer (`tests/stress/scaled-golden.mjs`), and on a file the web app
 *   writes today (a mixed history of 1000 steps). The packages are found
 *   beside this checkout or where `CELLUCID_PYTHON_ROOT` and
 *   `CELLUCID_R_ROOT` say; the interpreter is `--python` (or `CELLUCID_PYTHON`)
 *   and `--rscript` (or `Rscript` on the path).
 *
 * Each run is one Node process with `--expose-gc` (memory is read after a
 * collection). Run it alone: on a 16 GB machine through
 * `.cellucid-maintenance/heavy.sh`, never beside another heavy job. Nothing it
 * writes is committed; `tests/stress/RESULTS.md` records what it measured.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

function parseArgs(argv) {
  const options = {
    steps: [1_000, 10_000, 50_000, 100_000], cells: 1_000_000, genes: 20_000, repeat: 1, seed: 1,
    kinds: true, mixed: true, out: path.join(ROOT, 'test-results', 'history-stress'), guardGib: 8, child: null,
    readers: false, python: process.env.CELLUCID_PYTHON ?? 'python3', rscript: 'Rscript',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--steps') options.steps = next().split(',').map(Number);
    else if (arg === '--cells') options.cells = Number(next());
    else if (arg === '--genes') options.genes = Number(next());
    else if (arg === '--repeat') options.repeat = Number(next());
    else if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--guard-gib') options.guardGib = Number(next());
    else if (arg === '--kinds-only') options.mixed = false;
    else if (arg === '--mixed-only' || arg === '--no-kinds') options.kinds = false;
    else if (arg === '--quick') Object.assign(options, { steps: [500, 2_000], cells: 100_000, genes: 2_000 });
    else if (arg === '--child') options.child = next();
    else if (arg === '--readers') options.readers = true;
    else if (arg === '--python') options.python = next();
    else if (arg === '--rscript') options.rscript = next();
    else throw new Error(`Unknown argument "${arg}" (see the header of scripts/history-stress.mjs)`);
  }
  for (const [key, value] of Object.entries({ cells: options.cells, genes: options.genes, repeat: options.repeat })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
  }
  if (options.steps.some(step => !Number.isSafeInteger(step) || step < 1)) throw new Error('--steps must list positive integers');
  return options;
}

function machine() {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: cpus[0]?.model ?? 'unknown', cores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version,
  };
}

async function child(options) {
  const job = JSON.parse(options.child);
  const stress = await import(pathToFileURL(path.join(ROOT, 'tests', 'stress', 'history-stress.mjs')).href);
  const log = line => process.stderr.write(`[${job.name}] ${line}\n`);
  const result = job.kind === 'mixed'
    ? await stress.runMixedHistory({
      steps: Math.max(...job.steps), checkpoints: job.steps, cells: job.cells, genes: job.genes, seed: job.seed,
      memoryGuardBytes: job.guardGib * 2 ** 30, onProgress: log,
    })
    : await stress.runStepKinds({
      cells: job.cells, genes: job.genes, seed: job.seed, onProgress: log,
      // The large kinds are fewer: each holds megabytes.
      counts: { 'brush-1m': 20, 'brush-500k': 20, 'brush-100k': 50, 'user-field': 20, de: 20, markers: 10, correlation: 20 },
    });
  await writeFile(job.file, JSON.stringify({ job, machine: machine(), result }, null, 1));
}

function run(job, guardGib) {
  return new Promise((resolve, reject) => {
    const heapMiB = Math.max(2048, Math.floor(guardGib * 1024));
    const proc = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, '--expose-gc', SELF, '--child', JSON.stringify(job)], {
      cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${job.name} exited with ${signal ?? code}`));
    });
  });
}

const fmt = (value, digits = 1) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
const mib = bytes => (bytes === null || bytes === undefined ? '—' : (bytes / 2 ** 20).toFixed(1));

function summaryOf(runs) {
  const lines = [];
  for (const { job, machine: m, result } of runs) {
    if (job.kind === 'mixed') {
      lines.push(`## ${job.name} (seed ${job.seed}, ${job.cells.toLocaleString('en')} cells, ${m.cpu}, ${m.node})`, '');
      lines.push('| steps | branches | trackers | rec p50 / p95 ms | +accounting ms | autosave/step ms | jump p50 / max ms | undo p50 ms | delete 10 / 100 / 1000 ms | replay ms/step | chars (history.get page / history.summary) | file MiB | write s | load s | heap MiB | arrays MiB |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const c of result.checkpoints) {
        const del = Object.fromEntries(c.deleteStep.map(entry => [entry.below, entry.ms]));
        const get = key => (c[key] ? c[key].characters : `fails (${c.failures[key]?.message.slice(0, 40)})`);
        lines.push(`| ${c.steps} | ${c.branches} | ${c.trackers} | ${fmt(c.recordingAll.recorder?.p50, 2)} / ${fmt(c.recordingAll.recorder?.p95, 2)} | ${fmt(c.memoryAccountingMs?.p50)} | ${fmt(c.sampledStep.autosave?.p50)} | ${fmt(c.jump?.p50)} / ${fmt(c.jump?.max)} | ${fmt(c.undo?.p50, 2)} | ${fmt(del[10])} / ${fmt(del[100])} / ${fmt(del[1000])} | ${fmt(c.replay?.msPerStep, 2)} | ${get('historyGetPage')} / ${get('historySummary')} | ${mib(c.session?.bytes)} | ${fmt(c.session?.writeMs / 1000, 2)} | ${fmt(c.session?.totalLoadMs / 1000, 2)} | ${mib(c.memory.heapUsed)} | ${mib(c.memory.arrayBuffers)} |`);
      }
      for (const c of result.checkpoints) {
        for (const [name, failure] of Object.entries(c.failures ?? {})) lines.push(`- at ${c.steps} steps, ${name} failed: ${failure.message} (${failure.at})`);
      }
      if (result.stoppedEarly) lines.push('', `Stopped early at ${result.stoppedEarly.at} steps: ${result.stoppedEarly.reason}.`);
      lines.push('');
    } else {
      lines.push(`## ${job.name} (${job.cells.toLocaleString('en')} cells)`, '');
      lines.push('| kind | file B/step | of which turn record B/step | steps chunk B/step | values B/step | arrays B/step | autosave B/step | rec p50 ms | hash p50 ms | autosave write p50 ms |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const [kind, k] of Object.entries(result)) {
        lines.push(`| ${kind} | ${Math.round(k.fileBytesPerStep)} | ${Math.round(k.turnRecordBytesPerStep)} | ${Math.round(k.stepsChunkBytesPerStep)} | ${Math.round(k.valueBytesPerStep)} | ${Math.round(k.arrayBytesPerStep)} | ${Math.round(k.autosaveBytesPerStep)} | ${fmt(k.recording.recorder?.p50, 2)} | ${fmt(k.recording.hash?.p50, 2)} | ${fmt(k.autosaveWrite?.p50, 2)} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

const PYTHON_READ = `
import json, sys, time
from cellucid import read_session
out = []
for path in sys.argv[1:]:
    times = []
    error = None
    for _ in range(3):
        start = time.perf_counter()
        try:
            read_session(path)
        except Exception as caught:  # a refusal is a result
            error = f"{type(caught).__name__}: {caught}"
            break
        times.append((time.perf_counter() - start) * 1000)
    out.append({"file": path, "ms": times, "error": error})
print(json.dumps(out))
`;

const R_READ = `
args <- commandArgs(trailingOnly = TRUE)
suppressMessages(pkgload::load_all(args[[1]], quiet = TRUE))
out <- lapply(args[-1], function(path) {
  times <- c()
  error <- NULL
  for (i in 1:3) {
    start <- proc.time()[["elapsed"]]
    caught <- tryCatch({ cellucid_read_session(path); NULL }, error = function(e) conditionMessage(e))
    if (!is.null(caught)) { error <- caught; break }
    times <- c(times, (proc.time()[["elapsed"]] - start) * 1000)
  }
  list(file = path, ms = as.list(times), error = error)
})
cat(jsonlite::toJSON(out, auto_unbox = TRUE, null = "null"))
`;

/** The Cellucid version `index.html` names (`CELLUCID_VERSION`). */
function appVersion() {
  return /<meta name="cellucid-version" content="([^"]+)"/.exec(readFileSync(path.join(ROOT, 'index.html'), 'utf8'))[1];
}

/** A repository beside this checkout (or beside the main checkout, from a worktree). */
function siblingRepository(name) {
  const beside = path.join(ROOT, '..', name);
  if (existsSync(beside)) return beside;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return path.join(path.dirname(path.dirname(common)), name);
}

/** The packages' session readers on scaled golden files and on a file the web app writes today. */
async function readers(options) {
  const { scaleGoldenSession } = await import(pathToFileURL(path.join(ROOT, 'tests', 'stress', 'scaled-golden.mjs')).href);
  const { createStressPage } = await import(pathToFileURL(path.join(ROOT, 'tests', 'stress', 'history-stress.mjs')).href);
  const { SAVE_DEFAULTS, writeSharedHistory } = await import(pathToFileURL(path.join(ROOT, 'assets', 'js', 'app', 'session', 'share-scope.js')).href);
  const golden = new Uint8Array(await readFile(path.join(ROOT, 'tests', 'fixtures', 'history-golden.cellucid-session')));
  const files = [];
  for (const extra of [0, 1_000, 10_000, 100_000]) {
    const file = path.join(options.out, `golden-plus-${extra}.cellucid-session`);
    const bytes = extra === 0 ? golden : await scaleGoldenSession(golden, extra);
    await writeFile(file, bytes);
    files.push({ file, kind: 'golden (History v2 shape)', extraSteps: extra, bytes: bytes.byteLength });
  }
  // What the web app writes (its Save, `writeSharedHistory`), 1000 mixed steps.
  const stress = await createStressPage({ cells: 100_000, genes: 2_000, autosave: false, correlationCells: 2_000 });
  await stress.history.startTracker();
  const recipes = ['camera', 'colorField', 'filterCategory', 'labelEdit', 'setting', 'panel'];
  for (let i = 0; stress.history.active.steps.size - 1 < 1_000; i++) {
    const [type, params] = stress.page.params[recipes[i % recipes.length]]();
    await stress.page.dispatcher.dispatch(type, params);
  }
  const { blob } = await writeSharedHistory({
    snapshot: stress.history.snapshot(), shown: stress.history.shownHashes(), valueOf: hash => stress.history.pool.get(hash),
    choice: SAVE_DEFAULTS, header: stress.dataset.header, catalog: stress.page.dispatcher.catalog, version: appVersion(),
    newTrackerId: () => 't-00000000-0000-4000-8000-0000000000ff', now: Date.now(),
  });
  const webFile = path.join(options.out, 'web-app-1000.cellucid-session');
  await writeFile(webFile, Buffer.from(await blob.arrayBuffer()));
  files.push({ file: webFile, kind: 'written by the web app (its Save)', extraSteps: null, bytes: blob.size });

  const pythonRoot = process.env.CELLUCID_PYTHON_ROOT ?? siblingRepository('cellucid-python');
  const rRoot = process.env.CELLUCID_R_ROOT ?? siblingRepository('cellucid-r');
  const paths = files.map(entry => entry.file);
  const python = spawnSync(options.python, ['-c', PYTHON_READ, ...paths], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: [path.join(pythonRoot, 'src'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    maxBuffer: 64 * 2 ** 20,
  });
  const r = spawnSync(options.rscript, ['-e', R_READ, rRoot, ...paths], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  const parse = (run, name) => {
    try {
      return JSON.parse(run.stdout.trim().split('\n').at(-1));
    } catch {
      return paths.map(file => ({ file, ms: [], error: `${name} did not run: ${(run.stderr || run.error?.message || '').slice(-400)}` }));
    }
  };
  const result = { machine: machine(), python: parse(python, 'Python'), r: parse(r, 'R'), files };
  await writeFile(path.join(options.out, 'readers.json'), JSON.stringify(result, null, 1));
  const lines = ['| file | bytes | Python read ms (3 runs) | R read ms (3 runs) |', '| --- | --- | --- | --- |'];
  files.forEach((entry, i) => {
    const show = run => (run.error ? `refused: ${run.error.slice(0, 160)}` : run.ms.map(ms => ms.toFixed(0)).join(', '));
    lines.push(`| ${path.basename(entry.file)} | ${entry.bytes} | ${show(result.python[i])} | ${show(result.r[i])} |`);
  });
  process.stdout.write(`${lines.join('\n')}\nResults: ${options.out}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.child !== null) return child(options);
  await mkdir(options.out, { recursive: true });
  if (options.readers) return readers(options);
  const jobs = [];
  const base = { cells: options.cells, genes: options.genes, guardGib: options.guardGib };
  if (options.kinds) jobs.push({ ...base, kind: 'kinds', name: 'step-kinds', seed: options.seed + 100 });
  if (options.mixed) {
    for (let i = 0; i < options.repeat; i++) jobs.push({ ...base, kind: 'mixed', name: `mixed-${i + 1}`, seed: options.seed + i, steps: options.steps });
  }
  const runs = [];
  for (const job of jobs) {
    job.file = path.join(options.out, `${job.name}.json`);
    process.stderr.write(`running ${job.name}\n`);
    await run(job, options.guardGib);
    runs.push(JSON.parse(await readFile(job.file, 'utf8')));
  }
  const summary = summaryOf(runs);
  await writeFile(path.join(options.out, 'summary.md'), summary);
  process.stdout.write(`${summary}\nResults: ${options.out}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
