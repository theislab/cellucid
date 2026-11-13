/**
 * Real public links, as a new user's first five minutes meet them: each
 * link of `public-links.json` opened by the app's own path in Node (the
 * provider, the byte layer, the reader worker's handler and the adapter,
 * `LinkDataSource`), over the real network, every request recorded where
 * it leaves (`fetch`), as a browser sends it (its name, six connections to
 * an HTTP/1.1 host) and reads its answer (only the headers CORS lets a
 * page read). Per link:
 *
 * - **host**: how the host answers a cross-origin range request (HTTP
 *   version, ranges, CORS and the headers it exposes, content coding,
 *   validators, rate-limit headers), asked with `curl` as a browser would;
 * - **provider**: the requests before the first byte of the data (listings,
 *   APIs, probes) and their time;
 * - **layout**: the stored layout of what the reader opened (`X`'s
 *   encoding, chunking and compression, the embedding's chunks), read from
 *   the store's own metadata;
 * - **steps** (each: seconds, bytes, requests, and the bytes against the
 *   whole file): open and first view (the embedding the view draws, at the
 *   cells the default Cells-to-open setting opens), the first coloring
 *   field, a first gene, a second gene, twenty genes; then a **second
 *   visit** (a new reader over the same browser storage, on disk): what it
 *   fetched, and every request it sent;
 * - **memory**: the process's peak resident set.
 *
 * The browser's own run of the same corpus (time to the first picture,
 * growth to every cell asked for, the GPU and page memory) is
 * `scripts/benchmark-real-links.mjs --corpus`; this one needs no browser
 * and runs where the browser queue is busy.
 *
 *   node scripts/efficiency-floor/public-links.mjs [--corpus public-links.json]
 *     [--ids a,b] [--skip-heavy] [--share 1%,1%u,10%b] [--no-revisit] [--genes 20] [--linger-s 3]
 *     [--link variable [--drops 0.05]] [--out results.jsonl]
 *   node scripts/efficiency-floor/public-links.mjs --report results.jsonl [--browser bench.json]
 *
 * Each link runs in its own process (one JSON line each, appended to
 * `--out`), so one link's memory never counts against another's. A link
 * already in `--out` is not run again.
 *
 * @module scripts/efficiency-floor/public-links
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

/** A URL as it may be written down: no query (signed links, API keys), no fragment. */
export function publicUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0];
  }
}

// --------------------------------------------------------------------- host

/** How a host answers a browser's cross-origin range request, asked with curl. */
function probeHost(url) {
  let text;
  try {
    text = execFileSync('curl', ['-sS', '-L', '--max-time', '30', '-o', '/dev/null', '-D', '-', '--http2',
      '-H', 'Origin: https://www.cellucid.com', '-H', 'Range: bytes=0-1023', '-H', 'Accept-Encoding: gzip, deflate, br',
      '-w', '\n@@ %{http_version} %{http_code} %{time_starttransfer} %{num_redirects}\n', url], { encoding: 'utf8' });
  } catch (error) {
    return { error: String(error.message).split('\n')[0] };
  }
  // The last response's headers (after redirects).
  const blocks = text.split(/\r?\n\r?\n/).filter(block => /^HTTP\//.test(block.trim()));
  const last = blocks.at(-1) ?? '';
  const headers = {};
  for (const line of last.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const [, httpVersion, status, firstByteS, redirects] = /@@ (\S+) (\d+) (\S+) (\d+)/.exec(text) ?? [];
  const expose = (headers['access-control-expose-headers'] ?? '').toLowerCase().split(/\s*,\s*/).filter(Boolean);
  const exposed = name => expose.includes('*') || expose.includes(name);
  return {
    httpVersion: httpVersion === '2' ? 'h2' : httpVersion === '3' ? 'h3' : `http/${httpVersion}`,
    status: Number(status),
    redirects: Number(redirects),
    firstByteMs: Math.round(Number(firstByteS) * 1000),
    ranges: Number(status) === 206,
    cors: headers['access-control-allow-origin'] ?? null,
    exposes: {
      contentRange: exposed('content-range'),
      etag: exposed('etag'),
      // Last-Modified and Content-Length are CORS-safelisted.
      rateLimit: expose.some(name => name.includes('ratelimit')),
    },
    contentEncoding: headers['content-encoding'] ?? null,
    etag: headers.etag ?? null,
    lastModified: headers['last-modified'] ?? null,
    rateLimit: Object.fromEntries(Object.entries(headers).filter(([name]) => /ratelimit|retry-after/.test(name))),
    size: Number(/\/(\d+)$/.exec(headers['content-range'] ?? '')?.[1] ?? Number.NaN) || null,
  };
}

// -------------------------------------------------------------- one link

/** The site the app is (`www.cellucid.com`): what a browser names as the origin of its requests. */
const PAGE_ORIGIN = 'https://www.cellucid.com';

/** What a browser sends as its name (Node's own is refused by some hosts). */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/**
 * The HTTP version each origin answers in, asked once with curl: a browser
 * keeps six connections to an HTTP/1.1 host and multiplexes an HTTP/2 one;
 * Node opens connections freely, so the recorder holds HTTP/1.1 hosts to six.
 * Asked without blocking: a synchronous curl per new origin would hold the
 * event loop, so every request of the app would wait for it.
 */
const protocols = new Map();
function protocolOf(origin) {
  if (!protocols.has(origin)) {
    protocols.set(origin, new Promise(resolve => {
      execFile('curl', ['-sS', '--max-time', '15', '-o', '/dev/null', '--http2', '-w', '%{http_version}', '-I', `${origin}/`], { encoding: 'utf8' },
        // Unreachable for HEAD at its root: taken as HTTP/1.1, the stricter.
        (error, text) => resolve(error === null && text.trim() === '2' ? 'h2' : 'http/1.1'));
    }));
  }
  return protocols.get(origin);
}

/**
 * The headers of a cross-origin answer a page can read: the CORS-safelisted
 * response headers and those the host exposes (`Access-Control-Expose-Headers`,
 * `*` for all but cookies). Node reads every header; the app in a browser
 * cannot, and what it names a version by depends on it (Dropbox exposes no
 * `ETag` and sends no `Last-Modified`: nothing of it is kept across visits).
 */
const SAFELISTED_RESPONSE_HEADERS = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
function pageReadable(headers) {
  const exposed = new Set((headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/).filter(Boolean));
  const readable = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (SAFELISTED_RESPONSE_HEADERS.has(lower) || exposed.has(lower) || (exposed.has('*') && lower !== 'set-cookie')) readable.append(name, value);
  }
  return readable;
}

/** A browser's connections to one HTTP/1.1 host. */
const BROWSER_CONNECTIONS_PER_HOST = 6;

/**
 * A link that changes while it is read, laid over the real network
 * (`--link variable`): a cycle of phases, each holding every answer's first
 * byte back by `extraMs` and pacing every body, together, to `MBps` of one
 * shared bandwidth (null: as fast as the real link; 0: a stall, nothing
 * arrives); and `--drops <p>`: each body cut after a random part with
 * probability `p`, as a dropped connection cuts it (seeded: the same run
 * cuts the same answers).
 */
const VARIABLE_PHASES = [
  { ms: 8000, extraMs: 0, MBps: null },
  { ms: 6000, extraMs: 300, MBps: 0.5 },
  { ms: 3000, extraMs: 0, MBps: 0 },
  { ms: 8000, extraMs: 100, MBps: 2 },
];

function variableLink({ drops = 0 } = {}) {
  const startedAt = performance.now();
  const cycleMs = VARIABLE_PHASES.reduce((sum, phase) => sum + phase.ms, 0);
  const phaseAt = at => {
    let into = (at - startedAt) % cycleMs;
    for (const phase of VARIABLE_PHASES) {
      if (into < phase.ms) return { ...phase, endsAt: at - into + phase.ms };
      into -= phase.ms;
    }
    return { ...VARIABLE_PHASES[0], endsAt: at + 1 };
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  // One bandwidth every body shares: the time the link is free again.
  let freeAt = startedAt;
  let seed = 0x9e3779b9;
  const random = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) >>> 0;
    seed = (seed + 0x6d2b79f5) >>> 0;
    return seed / 0x100000000;
  };
  return {
    async firstByte() {
      await sleep(phaseAt(performance.now()).extraMs);
    },
    /** A body's pieces paced to the phase's bandwidth, and maybe cut. */
    pace(body) {
      const cutAfter = random() < drops ? random() : null;
      let seen = 0;
      return body.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          for (;;) {
            const phase = phaseAt(performance.now());
            if (phase.MBps === 0) {
              await sleep(phase.endsAt - performance.now());
              continue;
            }
            if (phase.MBps !== null) {
              const now = performance.now();
              freeAt = Math.max(freeAt, now) + chunk.byteLength / (phase.MBps * 1000);
              await sleep(freeAt - now);
            }
            break;
          }
          seen += chunk.byteLength;
          if (cutAfter !== null && seen > 65536 && random() < 0.05 + cutAfter) {
            controller.error(new TypeError('network connection was lost (variable link)'));
            return;
          }
          controller.enqueue(chunk);
        },
      }));
    },
  };
}

/** Every request the app sends, recorded where it leaves. */
function recordFetch() {
  const realFetch = globalThis.fetch;
  const variable = argument('--link') === 'variable' ? variableLink({ drops: Number(argument('--drops', '0')) }) : null;
  const log = [];
  const slots = new Map();
  const acquire = async origin => {
    if (await protocolOf(origin) !== 'http/1.1') return () => {};
    let slot = slots.get(origin);
    if (slot === undefined) slots.set(origin, slot = { busy: 0, waiting: [] });
    if (slot.busy >= BROWSER_CONNECTIONS_PER_HOST) await new Promise(resolve => slot.waiting.push(resolve));
    else slot.busy++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slot.waiting.shift();
      if (next) next();
      else slot.busy--;
    };
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const release = await acquire(new URL(url).origin);
    try {
      return await recordedFetch(input, init, url, release);
    } catch (error) {
      release();
      throw error;
    }
  };
  async function recordedFetch(input, init, url, release) {
    const headers = new Headers(init.headers ?? (typeof input === 'object' ? input.headers : undefined));
    const entry = { url: publicUrl(url), method: init.method ?? 'GET', range: headers.get('Range'), t0: performance.now(), t1: null, status: null, bytes: 0 };
    log.push(entry);
    // A browser names itself (some hosts, Zenodo, refuse Node's own name) and
    // the site a cross-origin request is made from.
    if (!headers.has('User-Agent')) headers.set('User-Agent', BROWSER_USER_AGENT);
    headers.set('Origin', PAGE_ORIGIN);
    let response;
    try {
      response = await realFetch(input, { ...init, headers });
    } catch (error) {
      entry.t1 = performance.now();
      entry.error = String(error?.message ?? error).slice(0, 120);
      throw error;
    }
    entry.status = response.status;
    await variable?.firstByte();
    // A `no-cors` request (whether a host answers at all, `remote-file.js`
    // `hostAnswers`) resolves with an opaque answer the page cannot read,
    // whatever the host allows.
    if (init.mode === 'no-cors') {
      entry.t1 = performance.now();
      response.body?.cancel().catch(() => {});
      release();
      return new Response(null, { status: 200 });
    }
    // A browser refuses a cross-origin answer its host does not allow the
    // page to read, as a failed request.
    const allowed = response.headers.get('access-control-allow-origin');
    if (allowed !== '*' && allowed !== PAGE_ORIGIN) {
      entry.t1 = performance.now();
      entry.error = 'no CORS';
      response.body?.cancel().catch(() => {});
      release();
      throw new TypeError('Failed to fetch (the host does not let this site read it: CORS)');
    }
    if (response.body === null) {
      entry.t1 = performance.now();
      release();
      const bodiless = new Response(null, { status: response.status, statusText: response.statusText, headers: pageReadable(response.headers) });
      Object.defineProperty(bodiless, 'url', { value: response.url });
      Object.defineProperty(bodiless, 'redirected', { value: response.redirected });
      return bodiless;
    }
    // Count the body's bytes as the reader takes them; the connection is
    // free once the body ends or is left.
    const counted = (variable === null ? response.body : variable.pace(response.body)).pipeThrough(new TransformStream({
      transform(chunk, controller) {
        entry.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        entry.t1 = performance.now();
        release();
      },
      cancel() {
        release();
      },
    }));
    init.signal?.addEventListener('abort', release, { once: true });
    const wrapped = new Response(counted, { status: response.status, statusText: response.statusText, headers: pageReadable(response.headers) });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    Object.defineProperty(wrapped, 'redirected', { value: response.redirected });
    return wrapped;
  };
  return {
    log,
    mark: () => log.length,
    since(mark) {
      const entries = log.slice(mark);
      return { requests: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function quietApp(getNotificationCenter) {
  for (const name of ['loading', 'complete', 'fail', 'dismiss', 'progress', 'updateProgress', 'warning', 'error', 'info', 'success',
    'startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload']) {
    getNotificationCenter()[name] = () => 'quiet';
  }
}

/** The stored layout of the opened dataset's `X` and first embedding, from its own metadata. */
function layoutOf(metadata) {
  const probes = metadata?.probes ?? {};
  const out = {};
  const matrix = (probes.matrices ?? probes.layers ?? []).find?.(item => item.key === 'X' || item.path === 'X') ?? null;
  if (matrix !== null) out.X = matrix;
  const embedding = (probes.obsm ?? []).find(item => item.storage === 'dense' && item.shape?.length === 2 && item.shape[1] <= 3) ?? null;
  if (embedding !== null) out.embedding = { key: embedding.key, shape: embedding.shape, chunks: embedding.chunks ?? null };
  return out;
}

/**
 * One visit of one link, in this process: a page of its own (its own tab,
 * `THIS_TAB`), over the browser storage on disk at `storage` (OPFS and
 * `localStorage`, `local-storage.json`), which a later visit, in another
 * process, finds as a browser's next page does.
 */
async function runOne(entry, { share, genes, label, storage }) {
  const { opfsOnDisk } = await import(path.join(REPOSITORY, 'tests/helpers/opfs-on-disk.mjs'));
  const disk = opfsOnDisk({ root: storage, handles: 'worker' });
  // This process stands for the page and its reader worker: one browser
  // storage (on disk), one set of locks.
  Object.defineProperty(globalThis.navigator, 'storage', { value: disk.environment.navigator.storage, configurable: true });
  Object.defineProperty(globalThis.navigator, 'locks', { value: disk.environment.navigator.locks, configurable: true });
  const storedAt = path.join(storage, 'local-storage.json');
  const memory = new Map(existsSync(storedAt) ? Object.entries(JSON.parse(readFileSync(storedAt, 'utf8'))) : []);
  const save = () => writeFileSync(storedAt, JSON.stringify(Object.fromEntries(memory)));
  globalThis.localStorage ??= {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { memory.set(key, String(value)); save(); },
    removeItem: key => { memory.delete(key); save(); },
    clear: () => { memory.clear(); save(); },
    key: index => [...memory.keys()][index] ?? null,
    get length() { return memory.size; },
  };
  await import(path.join(REPOSITORY, 'tests/helpers/anndata-reader-in-process.mjs'));
  const { getNotificationCenter } = await import(path.join(REPOSITORY, 'assets/js/app/notification-center.js'));
  quietApp(getNotificationCenter);
  const { LinkDataSource } = await import(path.join(REPOSITORY, 'assets/js/data/link-source.js'));
  const { setTabCellSubsetRequest } = await import(path.join(REPOSITORY, 'assets/js/data/cell-subset-policy.js'));
  const { parseSubsampleParameters } = await import(path.join(REPOSITORY, 'assets/js/app/subsample-url.js')).catch(() => ({}));
  if (share !== null) {
    // `1%` the file's default method, `1%u` uniform, `1%b` blocks.
    const [, percent, method] = /^([\d.]+)%([ub]?)$/.exec(share) ?? [null, share.replace('%', ''), ''];
    const fraction = Number(percent) / 100;
    const named = method === 'u' ? { method: 'uniform' } : method === 'b' ? { method: 'blocks' } : {};
    setTabCellSubsetRequest(fraction >= 1 ? { mode: 'all' } : { mode: 'subsample', fraction, ...named });
  }
  void parseSubsampleParameters;

  const recorder = recordFetch();
  const result = { id: entry.id, link: entry.link, source: entry.source, share: share ?? 'auto', steps: [], error: null };
  // The read activity log's lines (`read-activity-log.js`), kept per step when tracing.
  const activityLines = [];
  if (process.env.PUBLIC_LINKS_TRACE) {
    for (const level of ['info', 'debug']) {
      console[level] = (...parts) => {
        for (const line of parts.map(String).join(' ').split('\n')) if (line.includes(' — ')) activityLines.push(line.slice(0, 300));
      };
    }
  }
  const step = async (label, run) => {
    const mark = recorder.mark();
    const started = performance.now();
    const row = { step: label };
    try {
      Object.assign(row, (await run()) ?? {});
    } catch (error) {
      row.error = String(error?.message ?? error).split('\n')[0].slice(0, 400);
    }
    row.seconds = Math.round((performance.now() - started) / 100) / 10;
    Object.assign(row, recorder.since(mark));
    // What the step read, by the operations the app names (the read
    // activity log's lines: the structure, an embedding, a field, a gene).
    if (process.env.PUBLIC_LINKS_TRACE) row.activities = activityLines.splice(0);
    // Every request of the step, relative to its start (ms): where its time
    // went, and which host it went to (a mirror's, a redirect's first host).
    if (process.env.PUBLIC_LINKS_TRACE) {
      row.trace = recorder.log.slice(mark).map(item => [new URL(item.url).pathname.split('/').pop().slice(0, 40), item.method, item.range, item.status, item.bytes,
        Math.round(item.t0 - started), item.t1 === null ? null : Math.round(item.t1 - started), new URL(item.url).host]);
    }
    result.steps.push(row);
    process.stderr.write(`${entry.id} ${share ?? 'auto'}: ${label} ${row.seconds} s, ${(row.bytes / 1e6).toFixed(2)} MB, ${row.requests} req${row.error ? ` ERROR ${row.error}` : ''}\n`);
    return row;
  };

  const visit = async label => {
    const source = new LinkDataSource();
    let adapter = null;
    let datasetId = null;
    const opened = await step(`${label}: open and first view`, async () => {
      const connection = await source.connect(entry.link);
      datasetId = connection.defaultDatasetId ?? connection.datasets[0]?.id;
      const metadata = await source.getMetadata(datasetId);
      adapter = source.getAnnDataSource(datasetId).getAdapter();
      const raw = await adapter._loader?.getDatasetMetadata?.().catch(() => null);
      const subset = adapter._loader?.cellSubset ?? null;
      return {
        title: connection.title ?? null,
        datasets: connection.datasets?.length ?? null,
        cells: metadata?.stats?.n_cells ?? adapter._loader?.nObs ?? null,
        fileCells: subset?.of ?? subset?.nObs ?? null,
        method: subset?.spec?.method ?? null,
        // Why the default opened fewer cells than the file has, as the reader said it.
        autoFit: subset?.autoFit ?? null,
        spec: subset?.spec ?? null,
        growthPlan: subset?.growth == null ? null : { target: subset.growth.target, steps: subset.growth.steps, chunked: subset.growth.chunked },
        // The open cells genes are read for, when not every one (a sample sized to the gene-time target).
        genes: subset?.genes == null ? null : { cells: subset.genes.cells, of: subset.genes.of, fit: subset.genes.fit ?? null },
        subsetKeys: subset === null ? null : Object.keys(subset),
        progressive: subset?.chunks != null ? { target: subset.chunks.target ?? null } : null,
        link: adapter.linkMeasurement?.() ?? null,
        layout: layoutOf(raw),
      };
    });
    if (opened.error || adapter === null) return { source, adapter: null };
    const fields = adapter.getObsFields().fields;
    const field = fields.find(item => item.kind === 'category') ?? fields[0];
    if (field !== undefined) await step(`${label}: color by ${field.key}`, async () => { await adapter.getObsFieldData(field.key); });
    let genePaths = [];
    await step(`${label}: gene list`, async () => {
      const list = (await adapter.getGeneList()).fields;
      // Genes spread over the list, as a person picks markers: never
      // neighbors, which a reader may have read together.
      const count = Math.min(list.length, Math.max(2, genes));
      genePaths = Array.from({ length: count }, (_, i) => list[(i * 7919 + 13) % list.length].path);
      return { genes: list.length };
    });
    if (genePaths.length > 0) {
      await step(`${label}: first gene`, async () => { await adapter.getGeneValues(genePaths[0]); });
      if (genePaths.length > 1) await step(`${label}: second gene`, async () => { await adapter.getGeneValues(genePaths[1]); });
      if (genePaths.length > 2) {
        await step(`${label}: ${genePaths.length - 2} more genes`, async () => {
          await Promise.all(genePaths.slice(2).map(key => adapter.getGeneValues(key)));
        });
      }
    }
    return { source, adapter };
  };

  try {
    result.host = null;
    const opened = await visit(label);
    result.opened = opened.adapter !== null;
    if (label === 'first visit') {
      const firstUrl = recorder.log.find(item => item.range !== null)?.url ?? recorder.log.find(item => item.method === 'HEAD')?.url ?? null;
      // The data's host, as a browser's cross-origin range read meets it.
      result.dataUrl = firstUrl;
      result.host = firstUrl === null ? null : probeHost(firstUrl);
      result.fileBytes = result.host?.size ?? null;
      result.requestHosts = [...new Set(recorder.log.map(item => new URL(item.url).host))];
    } else {
      result.revisitRequests = recorder.log.map(item => ({ url: item.url, method: item.method, range: item.range, status: item.status, bytes: item.bytes }));
    }
    // A person looks at the view before leaving: what the page keeps for a
    // later visit is written once its reads are quiet. Then it leaves.
    await new Promise(resolve => setTimeout(resolve, Number(argument('--linger-s', '3')) * 1000));
    opened.source.disconnect?.();
  } catch (error) {
    result.error = String(error?.stack ?? error).slice(0, 600);
  } finally {
    recorder.restore();
    result.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  }
  return result;
}

// ------------------------------------------------------------------ report

const mb = bytes => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`);

function report(lines) {
  const out = ['| link | source | host | share | step | s | bytes | of the file | requests | note |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of lines) {
    const host = r.host ? `${r.host.httpVersion}${r.host.ranges ? '' : ', no ranges'}${r.host.contentEncoding ? `, ${r.host.contentEncoding}` : ''}` : '';
    if (r.error && r.steps.length === 0) {
      out.push(`| ${r.id} | ${r.source} | ${host} | ${r.share} | (failed) | | | | | ${String(r.error).split('\n')[0].slice(0, 160).replaceAll('|', '/')} |`);
      continue;
    }
    for (const s of r.steps) {
      const share = r.fileBytes ? `${(100 * s.bytes / r.fileBytes).toFixed(s.bytes / r.fileBytes < 0.01 ? 2 : 1)} %` : '';
      const genes = s.genes ? `; genes read for ${s.genes.cells} of them (${s.genes.fit?.matrix ?? 'X'})` : '';
      const note = s.error ? s.error.slice(0, 160).replaceAll('|', '/') : s.cells != null ? `${s.cells} cells${s.fileCells ? ` of ${s.fileCells}` : ''}${s.method ? ` (${s.method})` : ''}${genes}` : '';
      out.push(`| ${r.id} | ${r.source} | ${host} | ${r.share} | ${s.step} | ${s.seconds} | ${mb(s.bytes)} | ${share} | ${s.requests} | ${note} |`);
    }
    if (r.revisitRequests) {
      const sent = r.revisitRequests.map(item => `${item.method} ${new URL(item.url).host}${item.range ? ` ${item.range}` : ''}`);
      out.push(`| ${r.id} | | | ${r.share} | second visit sent | | ${mb(r.revisitRequests.reduce((sum, item) => sum + item.bytes, 0))} | | ${sent.length} | ${sent.slice(0, 4).join('; ')}${sent.length > 4 ? '; …' : ''} |`);
    }
  }
  return out.join('\n');
}

// -------------------------------------------------------------------- main

if (argument('--one') !== null) {
  const entry = JSON.parse(argument('--one'));
  const share = argument('--share');
  const result = await runOne(entry, { share, genes: Number(argument('--genes', '20')), label: argument('--visit'), storage: argument('--storage') });
  // A pipe takes a long line in parts: exit once all of it is written.
  await new Promise(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
  process.exit(0);
} else if (argument('--report') !== null) {
  const lines = readFileSync(argument('--report'), 'utf8').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  console.log(report(lines));
} else {
  const corpus = JSON.parse(readFileSync(path.resolve(argument('--corpus', path.join(HERE, 'public-links.json'))), 'utf8'));
  const ids = argument('--ids')?.split(',') ?? null;
  const out = argument('--out');
  const shares = argument('--share') === null ? [null] : argument('--share').split(',');
  const done = new Set();
  if (out !== null && existsSync(out)) {
    for (const line of readFileSync(out, 'utf8').split('\n').filter(text => text.startsWith('{'))) {
      const r = JSON.parse(line);
      done.add(`${r.id} ${r.share}`);
    }
  }
  for (const entry of corpus.links) {
    if (ids !== null && !ids.includes(entry.id)) continue;
    if (process.argv.includes('--skip-heavy') && entry.heavy) continue;
    for (const share of shares) {
      if (done.has(`${entry.id} ${share ?? 'auto'}`)) continue;
      // Each visit is a page of its own (a process), over one browser storage.
      const storage = mkdtempSync(path.join(tmpdir(), 'cellucid-public-links-'));
      const visitOf = label => new Promise(resolve => {
        const args = [fileURLToPath(import.meta.url), '--one', JSON.stringify(entry), '--genes', argument('--genes', '20'), '--visit', label, '--storage', storage,
          '--linger-s', argument('--linger-s', '3'), ...(argument('--link') === null ? [] : ['--link', argument('--link'), '--drops', argument('--drops', '0')])];
        if (share !== null) args.push('--share', share);
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        let text = '';
        child.stdout.on('data', chunk => { text += chunk; });
        child.on('close', code => {
          const line = text.trim().split('\n').filter(item => item.startsWith('{')).at(-1);
          resolve(line === undefined ? { id: entry.id, link: entry.link, source: entry.source, share: share ?? 'auto', steps: [], error: `exited ${code}` } : JSON.parse(line));
        });
      });
      const result = await visitOf('first visit');
      if (result.opened === true && !process.argv.includes('--no-revisit')) {
        const again = await visitOf('second visit');
        result.steps.push(...again.steps);
        result.revisitRequests = again.revisitRequests ?? [];
        result.peakRssMB = Math.max(result.peakRssMB ?? 0, again.peakRssMB ?? 0);
        if (again.error) result.error = again.error;
      }
      rmSync(storage, { recursive: true, force: true });
      const line = JSON.stringify(result);
      if (out !== null) appendFileSync(out, `${line}\n`);
      else console.log(line);
    }
  }
}
