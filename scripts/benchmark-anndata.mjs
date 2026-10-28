/**
 * The AnnData reading benchmark: the current reader, and optionally an
 * earlier revision's, on the same files, the same calls, the same simulated
 * link.
 *
 *   python scripts/benchmark-anndata/generate.py DATA [--cells N --genes G]
 *   npm run bench:anndata -- (--data DATA | --file /abs/real.h5ad) [--baseline REF]
 *     [--modes local,remote] [--files a.h5ad,b.zarr.zip] [--latency 80] [--bandwidth 50]
 *     [--protocol http/1.1|h2] [--streams 100] [--out results.json]
 *     [--subsample '{"mode":"subsample","method":"blocks","fraction":0.1,"seed":0}']
 *
 * The files are `.h5ad`, and Zarr v2 and v3 stores, each as a folder and as
 * a ZIP (`--file` takes any other file the app opens as well: `.loom`,
 * `.h5mu`, a 10x `.h5`). `npm run bench:hdf5` compares the HDF5 reader alone
 * with h5wasm on local files.
 *
 * `--baseline` is a git revision whose reader is measured as "earlier": it is
 * checked out into a temporary worktree (removed afterwards), so a change can
 * be measured against the revision before it. The revision must speak the
 * current reader-worker protocol (`open({source})`). Without it, only the
 * current reader is measured.
 *
 * Every run is its own process (`benchmark-anndata/run.mjs`), one at a time,
 * so each measures its own time and peak memory on an idle machine. The
 * table prints milliseconds per step; for remote runs also requests and
 * bytes fetched.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Generated files (`--data DIR`, with its manifest), or real ones (`--file`,
// absolute paths, comma-separated).
const realFiles = argument('--file');
const data = realFiles === null ? argument('--data') : '/';
if (data === null) {
  console.error('Usage: node scripts/benchmark-anndata.mjs (--data DIR | --file PATH[,PATH]) [--baseline REF] [--modes local,remote]');
  process.exit(2);
}
const manifest = realFiles === null ? JSON.parse(readFileSync(path.join(data, 'manifest.json'), 'utf8')) : { files: {} };
const files = realFiles !== null ? realFiles.split(',') : (argument('--files') ?? Object.keys(manifest.files).join(',')).split(',');
const modes = argument('--modes', 'local,remote').split(',');
const latency = argument('--latency', '80');
const bandwidth = argument('--bandwidth', '50');
const protocol = argument('--protocol', 'http/1.1');
const streams = argument('--streams', '100');
const baseline = argument('--baseline');
const out = argument('--out');
const subsample = argument('--subsample');

let baselineRoot = null;
let worktreeParent = null;
if (baseline !== null) {
  worktreeParent = mkdtempSync(path.join(tmpdir(), 'cellucid-benchmark-'));
  baselineRoot = path.join(worktreeParent, 'baseline');
  execFileSync('git', ['-C', REPOSITORY, 'worktree', 'add', '--detach', baselineRoot, baseline], { stdio: 'ignore' });
}

const results = [];
try {
  for (const file of files) {
    for (const mode of modes) {
      const implementations = [['current', REPOSITORY]];
      if (baselineRoot !== null) {
        implementations.unshift(['earlier', baselineRoot]);
      }
      for (const [implementation, root] of implementations) {
        const run = spawnSync(process.execPath, [
          path.join(HERE, 'benchmark-anndata', 'run.mjs'),
          '--root', root,
          '--implementation', implementation,
          '--file', path.join(data, file),
          '--mode', mode,
          '--latency', latency,
          '--bandwidth', bandwidth,
          '--protocol', protocol,
          '--streams', streams,
          ...(subsample === null ? [] : ['--subsample', subsample]),
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        const line = run.stdout.trim().split('\n').filter(text => text.startsWith('{')).at(-1);
        const result = line ? JSON.parse(line) : {
          implementation, file, mode, steps: [], error: run.stderr.trim().split('\n').at(-1) ?? 'no output',
        };
        results.push(result);
        const total = result.steps.reduce((sum, step) => sum + step.ms, 0);
        console.error(`${implementation.padEnd(8)} ${mode.padEnd(6)} ${file}: ${result.error ?? `${Math.round(total)} ms, peak ${result.peakRssMB} MB`}`);
      }
    }
  }
} finally {
  if (baselineRoot !== null) {
    execFileSync('git', ['-C', REPOSITORY, 'worktree', 'remove', '--force', baselineRoot], { stdio: 'ignore' });
    rmSync(worktreeParent, { recursive: true, force: true });
  }
}

// One table per file and mode: steps down, implementations across.
const format = value => (value === undefined ? '-' : String(value));
const lines = [];
for (const file of files) {
  for (const mode of modes) {
    const runs = results.filter(result => result.file === path.basename(file) && result.mode === mode);
    if (runs.length === 0) continue;
    lines.push(`\n${file} (${mode}${mode === 'remote' ? `, ${latency} ms, ${bandwidth} MB/s, ${protocol}` : ''})`);
    const header = ['step', ...runs.map(run => run.implementation)];
    lines.push(header.join(' | '));
    const steps = [...new Set(runs.flatMap(run => run.steps.map(step => step.step)))];
    for (const name of steps) {
      lines.push([name, ...runs.map(run => {
        const step = run.steps.find(candidate => candidate.step === name);
        if (step === undefined) return '-';
        return mode === 'remote'
          ? `${format(step.ms)} ms, ${step.requests} req, ${(step.bytes / 1e6).toFixed(1)} MB`
          : `${format(step.ms)} ms`;
      })].join(' | '));
    }
    lines.push(['peak memory', ...runs.map(run => `${format(run.peakRssMB)} MB`)].join(' | '));
    for (const run of runs) if (run.error) lines.push(`${run.implementation} failed: ${run.error}`);
  }
}
console.log(lines.join('\n'));
if (out !== null) {
  writeFileSync(out, JSON.stringify({
    date: new Date().toISOString(),
    baseline,
    latencyMs: Number(latency),
    bandwidthMBps: Number(bandwidth),
    protocol,
    dataset: { cells: manifest.cells, genes: manifest.genes, density: manifest.density },
    node: process.version,
    results,
  }, null, 2));
}
