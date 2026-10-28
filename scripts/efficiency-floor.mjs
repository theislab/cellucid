/**
 * The efficiency floor: how close every reader comes to the least a read
 * can cost, element by element, format by format, link by link, share by
 * share. Each case's floor is computed from the file's own stored layout
 * (`efficiency-floor/layout.py`, h5py and zarr-python; `floor.mjs`), never
 * from the reader measured; the reader is measured where its bytes are
 * fetched (`efficiency-floor/link.mjs`).
 *
 *   python -I scripts/efficiency-floor/generate.py CORPUS [--cells 40000] [--rscript Rscript]
 *   node scripts/efficiency-floor/codecs.mjs CORPUS [--python python]
 *   node scripts/efficiency-floor.mjs --corpus CORPUS --out results.jsonl
 *     [--plan full|links|local|kept|quick] [--files a.h5ad,b.zarr] [--parallel 3]
 *   node scripts/efficiency-floor.mjs --report results.jsonl > table.md
 *
 * Plans (`--plan`):
 * - `full`: every file over the slow link (150 ms, 5 MB/s, HTTP/1.1), all
 *   cells and 1 %; the representative files (one of each storage kind) at
 *   every share (all; 10, 1, 0.1 % by the file's default method; 10 and 1 %
 *   uniform; 1 % blocks; 10 % stratified by `cluster`; 10 % spatial);
 * - `links`: the representative files at every link (150 ms / 5 MB/s and
 *   20 ms / 50 MB/s, each over HTTP/1.1 and HTTP/2), all cells and 1 %;
 * - `local`: every file picked from this computer, all cells and 1 %;
 * - `kept`: every single-file store as a copy kept in this browser (a whole
 *   download read through its page checksums), all cells and 1 %;
 * - `quick`: one file, one link, all cells and 1 % (a check of the harness).
 *
 * Each case is its own process (`efficiency-floor/run.mjs`), `--parallel` at
 * a time; each prints one JSON line, appended to `--out`. `--report` turns
 * the lines into the tables of `cellucid-private/plans/efficiency-floor-*.md`
 * (element x format x source x share: actual and floor bytes, requests and
 * time, their ratio and a verdict).
 */

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const SLOW = { transport: 'remote', latency: 150, bandwidth: 5, protocol: 'http/1.1' };
const LINKS = [
  SLOW,
  { transport: 'remote', latency: 150, bandwidth: 5, protocol: 'h2' },
  { transport: 'remote', latency: 20, bandwidth: 50, protocol: 'http/1.1' },
  { transport: 'remote', latency: 20, bandwidth: 50, protocol: 'h2' },
];
const LOCAL = { transport: 'local' };
/** A copy kept in this browser: a whole download read through its page checksums. */
const KEPT = { transport: 'kept' };
const share = (fraction, method = null, extra = {}) => ({ mode: 'subsample', fraction, ...(method === null ? {} : { method }), ...extra });
const SHARES = [
  { mode: 'all' },
  share(0.1), share(0.01), share(0.001),
  share(0.1, 'uniform'), share(0.01, 'uniform'),
  share(0.01, 'blocks'),
  share(0.1, 'stratified', { field: 'cluster' }),
  share(0.1, 'spatial'),
];
const REPRESENTATIVE = ['csr-gzip.h5ad', 'csc-gzip.h5ad', 'dense-gzip.h5ad', 'csr-v3-zstd.zarr', 'prepared.h5ad', 'prepared.zarr'];
/** Formats read whole, then from a store converted in this browser: no partial reads to measure against a layout. */
const WHOLE = new Set(['cells-mtx', 'seurat.rds']);

function jobsOf(plan, files) {
  const jobs = [];
  const measurable = files.filter(file => !WHOLE.has(file));
  if (plan === 'full') {
    for (const file of measurable) {
      for (const subsample of REPRESENTATIVE.includes(file) ? SHARES : [SHARES[0], SHARES[2]]) jobs.push({ file, link: SLOW, subsample });
    }
  }
  if (plan === 'links') {
    for (const file of measurable.filter(name => REPRESENTATIVE.includes(name))) {
      for (const link of LINKS.slice(1)) for (const subsample of [SHARES[0], SHARES[2]]) jobs.push({ file, link, subsample });
    }
  }
  if (plan === 'local') for (const file of measurable) for (const subsample of [SHARES[0], SHARES[2]]) jobs.push({ file, link: LOCAL, subsample });
  if (plan === 'kept') {
    // A kept download is one file: the single-file stores.
    for (const file of measurable.filter(name => /\.(h5ad|h5mu|loom|zip)$/.test(name))) for (const subsample of [SHARES[0], SHARES[2]]) jobs.push({ file, link: KEPT, subsample });
  }
  if (plan === 'quick') for (const subsample of [SHARES[0], SHARES[2]]) jobs.push({ file: measurable[0], link: SLOW, subsample });
  return jobs;
}

function caseKey(file, subsample, link) {
  return JSON.stringify([file, subsample, link.transport, link.latency ?? null, link.bandwidth ?? null, link.protocol ?? null]);
}

function runJob(corpus, job) {
  const args = [path.join(HERE, 'efficiency-floor', 'run.mjs'), '--corpus', corpus, '--file', job.file, '--transport', job.link.transport,
    '--subsample', JSON.stringify(job.subsample)];
  if (job.link.transport === 'remote') args.push('--latency', String(job.link.latency), '--bandwidth', String(job.link.bandwidth), '--protocol', job.link.protocol);
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('close', () => {
      const line = out.trim().split('\n').filter(text => text.startsWith('{')).at(-1);
      resolve(line ?? JSON.stringify({ file: job.file, subsample: job.subsample, ...job.link, error: err.trim().split('\n').slice(-3).join(' ') || 'no output' }));
    });
  });
}

// ------------------------------------------------------------------ report

const fmtBytes = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);
const shareLabel = s => (s.mode === 'all' ? 'all' : `${+(s.fraction * 100).toPrecision(3)} %${s.method ? ` ${s.method}` : ''}`);
const sourceLabel = r => (r.transport === 'local' ? 'local File' : r.transport === 'kept' ? 'kept download'
  : `${r.latencyMs} ms, ${r.bandwidthMBps} MB/s, ${r.protocol}`);

/**
 * The verdict of one element: within 10 % of the floor (bytes; time where
 * a step read it) or not. Small absolute excesses (under one 16 KB block)
 * are within the floor's own rounding (metadata blocks, partial chunk
 * boundaries).
 */
export function verdictOf(row) {
  // The bytes floor is the quickest plan's: the needed chunks, and the gaps
  // between them that cost less than the requests they save.
  const floorBytes = Math.max(row.floor, row.floorPlanBytes ?? 0);
  const bytesOk = floorBytes === 0 ? row.actual <= 16384 : row.actual <= 1.1 * floorBytes || row.actual - floorBytes <= 16384;
  const timeOk = row.floorMs === undefined || row.ms === undefined || row.ms <= 1.1 * row.floorMs + 20;
  // An HDF5 file's metadata (headers, chunk B-tree nodes, heaps) is read in
  // aligned blocks of up to 64 KB (`byte-reader.js`), and h5py writes small
  // chunks next to it: up to a block of each array comes with the metadata,
  // costing no round trip (the floor counts only the chunks a read needs).
  const carried = !bytesOk && row.kind === 'hdf5' && row.arrays > 0 && row.actual - floorBytes <= METADATA_BLOCK_BYTES * row.arrays;
  return { bytesOk: bytesOk || carried, timeOk, ok: (bytesOk || carried) && timeOk, carried };
}

/** The largest aligned block an HDF5 metadata read fetches (`byte-reader.js`). */
const METADATA_BLOCK_BYTES = 65536;

function report(lines) {
  const results = lines.map(line => JSON.parse(line));
  const out = [];
  const rows = [];
  for (const r of results) {
    if (!r.totals) {
      rows.push({ file: r.file, source: sourceLabel(r), share: shareLabel(r.subsample ?? { mode: 'all' }), element: '(run failed)', error: r.error });
      continue;
    }
    for (const [element, e] of Object.entries(r.totals.elements)) {
      rows.push({
        file: r.file, source: sourceLabel(r), share: shareLabel(r.subsample), cells: r.cells, element,
        actual: e.actual, floor: e.floor, requests: e.requests ?? 0, floorRequests: e.floorRequests, ms: e.ms, floorMs: e.floorMs,
        kind: r.kind, arrays: Object.keys(e.arrays).length, floorPlanBytes: e.floorPlanBytes,
        overArrays: Object.entries(e.arrays).filter(([, a]) => a.actual > 1.1 * a.floor + 16384).map(([a, x]) => `${a} ${fmtBytes(x.actual)}/${fmtBytes(x.floor)}`),
      });
    }
    const open = r.steps.find(step => step.step === 'open');
    if (open) {
      rows.push({
        file: r.file, source: sourceLabel(r), share: shareLabel(r.subsample), cells: r.cells, element: 'open (structure)',
        actual: open.actual.bytes + (r.totals.headBytes ?? 0), floor: open.floor.bytes, requests: open.actual.requests, floorRequests: open.floor.requests,
        ms: open.actual.ms, floorMs: undefined, overArrays: [`head ${fmtBytes(r.totals.headBytes ?? 0)}, metadata ${fmtBytes(open.split.metadata)}`],
      });
    }
  }
  let ok = 0;
  let bad = 0;
  out.push('| element | file | source | share | bytes actual / floor | ratio | requests actual / floor | time actual / floor | verdict | where |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    if (row.error) {
      out.push(`| ${row.element} | ${row.file} | ${row.source} | ${row.share} | | | | | ✗ | ${String(row.error).slice(0, 160).replaceAll('|', '/')} |`);
      bad++;
      continue;
    }
    if (row.element === 'needed by no step' && row.actual <= 16384) continue;
    const verdict = row.element === 'open (structure)' ? null : verdictOf(row);
    if (verdict !== null) verdict.ok ? ok++ : bad++;
    const ratio = row.floor > 0 ? (row.actual / row.floor).toFixed(2) : row.actual === 0 ? '1.00' : '∞';
    const time = row.ms === undefined ? '' : `${Math.round(row.ms)} / ${row.floorMs === undefined ? '–' : Math.round(row.floorMs)} ms`;
    out.push(`| ${row.element} | ${row.file} | ${row.source} | ${row.share} | ${fmtBytes(row.actual)} / ${fmtBytes(row.floor)} | ${ratio} | ${row.requests} / ${row.floorRequests ?? '–'} | ${time} | ${verdict === null ? '·' : verdict.ok ? (verdict.carried ? '✓ (metadata blocks)' : '✓') : `✗${verdict.bytesOk ? ' time' : ' bytes'}`} | ${row.overArrays.join('; ').replaceAll('|', '/')} |`);
  }
  out.unshift(`${ok} ✓, ${bad} ✗ (elements; openings listed, judged in the text)\n`);
  return out.join('\n');
}

// -------------------------------------------------------------------- main

if (argument('--report') !== null) {
  const lines = readFileSync(argument('--report'), 'utf8').split('\n').filter(line => line.startsWith('{'));
  console.log(report(lines));
} else {
  const corpus = path.resolve(argument('--corpus'));
  const manifest = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
  const files = argument('--files')?.split(',') ?? Object.keys(manifest.files);
  const out = argument('--out');
  // Cases already in `--out` are not run again (a long plan resumes).
  const done = new Set();
  if (out !== null) {
    try {
      for (const line of readFileSync(out, 'utf8').split('\n').filter(text => text.startsWith('{'))) {
        const r = JSON.parse(line);
        if (r.totals) done.add(caseKey(r.file, r.subsample, r.transport === 'local' ? LOCAL : r.transport === 'kept' ? KEPT : { transport: 'remote', latency: r.latencyMs, bandwidth: r.bandwidthMBps, protocol: r.protocol }));
      }
    } catch {
      // No earlier results.
    }
  }
  const jobs = jobsOf(argument('--plan', 'quick'), files).filter(job => !done.has(caseKey(job.file, job.subsample, job.link)));
  const parallel = Number(argument('--parallel', '3'));
  let next = 0;
  let finished = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const line = await runJob(corpus, job);
      if (out !== null) appendFileSync(out, `${line}\n`);
      finished++;
      const parsed = JSON.parse(line);
      console.error(`${finished}/${jobs.length} ${job.file} ${JSON.stringify(job.subsample)} ${job.link.transport === 'local' ? 'local' : `${job.link.latency}/${job.link.bandwidth}/${job.link.protocol}`}: ${parsed.error ? `error ${String(parsed.error).split('\n')[0].slice(0, 120)}` : 'ok'}`);
    }
  }));
}
