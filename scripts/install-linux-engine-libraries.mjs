#!/usr/bin/env node
/**
 * Installs the Linux libraries a Playwright engine needs, on a CI runner
 * (`node scripts/install-linux-engine-libraries.mjs <chromium|firefox|webkit>`).
 *
 * Why not `npx playwright install-deps <engine>`: that runs `apt-get install`,
 * and apt cannot leave a slow connection. Its only stall guard
 * (`Acquire::http::Timeout`) fires when a connection sends nothing at all; a
 * mirror connection that trickles never trips it. On hosted Ubuntu runners
 * about one runner in twenty-four gets such a connection to
 * `azure.archive.ubuntu.com`'s package pool: 30 to 50 kB/s, while the same
 * runner fetched the package index from the same mirror at 13 MB/s seconds
 * earlier, and every other runner of the run fetched the same packages in 8 to
 * 36 s (run 42274413675 Linux WebKit 8/8 and run 42275099689 Linux Chromium
 * 5/8, 2026-11-06; runs 42180485733 and 42262565061 before them). Every run of
 * 48 Linux browser jobs therefore lost one to a 10-minute step bound, whatever
 * retries and timeouts apt was given.
 *
 * So the download is taken from apt and apt only installs:
 *
 * 1. `apt-get update` refreshes the index (small; each attempt bounded).
 * 2. Playwright names what is missing (`install-deps --dry-run <engine>`: the
 *    engine's library list resolved by `apt-get install -s`, every package apt
 *    would install), so its library list stays the one source.
 * 3. `apt-get install --print-uris` gives each package's URI, file name, size
 *    and hash.
 * 4. Each package is fetched here with a floor on its speed: a transfer under
 *    `FLOOR_BYTES_PER_SECOND` over `WINDOW_MS` is dropped and the package is
 *    fetched again, from the next mirror of the runner's own apt mirror list
 *    (`mirror+file:` in its sources) when the URI is one of that list's. Size
 *    and hash are checked before a file is kept.
 * 5. `apt-get install --no-download` installs from those files alone.
 * 6. `install-deps --dry-run <engine>` must then report nothing missing.
 *
 * The contract test is `tests/linux-engine-libraries-contract.test.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FLOOR_BYTES_PER_SECOND = 200_000;
export const WINDOW_MS = 10_000;
export const ATTEMPTS = 6;
export const PARALLEL_DOWNLOADS = 6;
const INDEX_ATTEMPTS = 3;
const INDEX_ATTEMPT_MS = 120_000;
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const HASHES = { SHA512: 'sha512', SHA256: 'sha256', SHA1: 'sha1', MD5Sum: 'md5' };
const SOURCE_FILES = ['/etc/apt/sources.list', '/etc/apt/sources.list.d'];

/** The mirror lists the apt sources name (`mirror+file:<path>`): each path with its mirrors' base URIs, in list order. */
export function mirrorListsFrom(sourcesText, readList) {
  const lists = [];
  for (const [, listPath] of sourcesText.matchAll(/mirror\+file:(\/[^\s]+)/g)) {
    const file = listPath.replace(/\/+$/, '');
    if (lists.some((list) => list.file === file)) continue;
    const bases = readList(file)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0].replace(/\/*$/, '/'));
    lists.push({ file, bases });
  }
  return lists;
}

/** Every URI one package may be fetched from: the mirrors of the list its URI belongs to, its own mirror first. */
export function candidateUris(uri, mirrorLists) {
  for (const { file, bases } of mirrorLists) {
    const viaList = `mirror+file:${file}/`;
    if (uri.startsWith(viaList)) return bases.map((base) => base + uri.slice(viaList.length));
    const own = bases.find((base) => uri.startsWith(base));
    if (own) {
      const rest = uri.slice(own.length);
      return [own, ...bases.filter((base) => base !== own)].map((base) => base + rest);
    }
  }
  if (uri.startsWith('mirror+')) throw new Error(`${uri} names a mirror list the apt sources do not`);
  return [uri];
}

/** `apt-get install --print-uris` lines: `'<uri>' <file name> <size> <hash type>:<hex>`. */
export function parsePrintUris(text) {
  const packages = [];
  for (const line of text.split('\n')) {
    const match = /^'([^']+)' (\S+) (\d+)(?: (\w+):([0-9a-f]+))?\s*$/.exec(line.trim());
    if (!match) continue;
    const [, uri, file, size, hashType, hash] = match;
    if (hashType && !HASHES[hashType]) throw new Error(`${file}: unknown hash type ${hashType}`);
    packages.push({ uri, file, size: Number(size), hash: hashType ? { algorithm: HASHES[hashType], hex: hash } : null });
  }
  return packages;
}

/** The packages `install-deps --dry-run` reports missing (none: it exited 0 saying so). */
export function parseMissingPackages(output, status) {
  if (status === 0 && /All system dependencies are installed\./.test(output)) return [];
  const header = /Missing system dependencies \((\d+)\):\n((?: {2}\S+\n?)+)/.exec(output);
  if (status !== 1 || !header) throw new Error(`playwright install-deps --dry-run exited ${status}:\n${output}`);
  const packages = header[2].split('\n').map((line) => line.trim()).filter(Boolean);
  if (packages.length !== Number(header[1])) throw new Error(`dry run counted ${header[1]} packages and listed ${packages.length}`);
  return packages;
}

/**
 * Fetches `uri` to `target`, dropping the transfer when the response does not
 * start within `windowMs` or brings fewer than `floor` bytes a second over the
 * last `windowMs`. Resolves to the bytes written; rejects naming why.
 *
 * The rate is the link's only while this process kept reading: a process that
 * did not run for a while (a loaded machine, a long pause of its own) counts
 * none of what arrived meanwhile until it reads again, and its first timer
 * after the pause runs before that read (timers come before I/O in Node's
 * loop). A watchdog tick that comes late therefore starts a new window
 * instead of judging the one the pause emptied. Times are monotonic
 * (`performance.now()`): a stepped wall clock is no transfer's speed.
 */
export async function fetchWithFloor(uri, target, { floor = FLOOR_BYTES_PER_SECOND, windowMs = WINDOW_MS, hash = null } = {}) {
  const controller = new AbortController();
  let windowStart = performance.now();
  let samples = [[windowStart, 0]];
  let received = 0;
  let reason = null;
  const tick = Math.max(50, Math.floor(windowMs / 5));
  let lastTick = windowStart;
  const watchdog = setInterval(() => {
    const now = performance.now();
    const late = now - lastTick > 2 * tick;
    lastTick = now;
    if (late) {
      windowStart = now;
      samples = [[now, received]];
      return;
    }
    samples.push([now, received]);
    while (samples.length > 1 && samples[1][0] <= now - windowMs) samples.shift();
    const [since, at] = samples[0];
    if (now - windowStart < windowMs) return;
    const rate = ((received - at) * 1000) / Math.max(1, now - since);
    if (rate < floor) {
      reason = `${Math.round(rate / 1000)} kB/s over the last ${windowMs / 1000} s, under the ${floor / 1000} kB/s floor`;
      controller.abort();
    }
  }, tick);
  const digest = hash ? createHash(hash.algorithm) : null;
  const out = createWriteStream(target);
  let writeError = null;
  out.on('error', (error) => {
    writeError = error;
    controller.abort();
  });
  try {
    const response = await fetch(uri, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for await (const chunk of response.body) {
      received += chunk.length;
      digest?.update(chunk);
      // `once` rejects on the stream's 'error': a write that fails (a full
      // disk) ends the transfer instead of waiting for a 'drain' never sent.
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    if (digest && digest.digest('hex') !== hash.hex) throw new Error(`${hash.algorithm} differs from the index`);
    return received;
  } catch (error) {
    out.destroy();
    throw new Error(reason ?? writeError?.message ?? error.message);
  } finally {
    clearInterval(watchdog);
  }
}

/** Fetches one package into `dir`, trying its candidates in turn; `log` hears each dropped attempt. */
export async function fetchPackage(pkg, candidates, dir, { attempts = ATTEMPTS, log = () => {}, ...options } = {}) {
  const partial = path.join(dir, 'partial', pkg.file);
  const failures = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const uri = candidates[attempt % candidates.length];
    try {
      const bytes = await fetchWithFloor(uri, partial, { ...options, hash: pkg.hash });
      if (bytes !== pkg.size) throw new Error(`${bytes} bytes, the index says ${pkg.size}`);
      renameSync(partial, path.join(dir, pkg.file));
      return uri;
    } catch (error) {
      rmSync(partial, { force: true });
      failures.push(`${uri}: ${error.message}`);
      log(`${pkg.file}: attempt ${attempt + 1} of ${attempts} dropped (${uri}: ${error.message})`);
    }
  }
  throw new Error(`${pkg.file} could not be fetched:\n  ${failures.join('\n  ')}`);
}

/** Fetches every package, `parallel` at a time. */
export async function fetchPackages(packages, mirrorLists, dir, { parallel = PARALLEL_DOWNLOADS, ...options } = {}) {
  mkdirSync(path.join(dir, 'partial'), { recursive: true });
  const queue = [...packages];
  const worker = async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      await fetchPackage(pkg, candidateUris(pkg.uri, mirrorLists), dir, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, packages.length) }, worker));
}

function run(command, args, { timeout, capture = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function sudo(args, options) {
  return run('sudo', ['DEBIAN_FRONTEND=noninteractive', ...args], options);
}

function playwrightDryRun(engine) {
  const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'));
  const result = run(process.execPath, [cli, 'install-deps', '--dry-run', engine], { capture: true });
  return parseMissingPackages(`${result.stdout}${result.stderr}`, result.status);
}

function aptSourcesText() {
  const files = [];
  for (const entry of SOURCE_FILES) {
    if (!existsSync(entry)) continue;
    if (entry.endsWith('.d')) files.push(...readdirSync(entry).filter((name) => /\.(list|sources)$/.test(name)).map((name) => path.join(entry, name)));
    else files.push(entry);
  }
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

function refreshIndex() {
  const failures = [];
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS; attempt += 1) {
    const result = sudo(['apt-get', 'update', '-o', 'Acquire::Retries=3', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30'], { timeout: INDEX_ATTEMPT_MS });
    if (result.status === 0) return;
    failures.push(result.signal ? `attempt ${attempt} took over ${INDEX_ATTEMPT_MS / 1000} s` : `attempt ${attempt} exited ${result.status}`);
    console.log(`apt-get update: ${failures.at(-1)}`);
  }
  throw new Error(`apt-get update failed: ${failures.join('; ')}`);
}

async function main(engine) {
  if (!ENGINES.has(engine)) throw new Error(`usage: install-linux-engine-libraries.mjs <${[...ENGINES].join('|')}>`);
  const started = Date.now();
  refreshIndex();
  const missing = playwrightDryRun(engine);
  if (missing.length === 0) {
    console.log(`Every library ${engine} needs is installed.`);
    return;
  }
  const uris = sudo(['apt-get', 'install', '--print-uris', '-qq', '-y', '--no-install-recommends', ...missing], { capture: true });
  if (uris.status !== 0) throw new Error(`apt-get install --print-uris exited ${uris.status}:\n${uris.stderr}`);
  const packages = parsePrintUris(uris.stdout);
  const mirrorLists = mirrorListsFrom(aptSourcesText(), (file) => readFileSync(file, 'utf8'));
  const dir = path.join(process.env.RUNNER_TEMP ?? tmpdir(), 'cellucid-engine-libraries');
  const megabytes = (packages.reduce((sum, pkg) => sum + pkg.size, 0) / 1e6).toFixed(1);
  console.log(`${engine}: ${missing.length} packages missing, ${packages.length} to fetch (${megabytes} MB); first URI ${packages[0]?.uri}; candidates ${candidateUris(packages[0]?.uri ?? '', mirrorLists).length}`);
  await fetchPackages(packages, mirrorLists, dir, { log: (line) => console.log(line) });
  console.log(`Fetched in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  const install = sudo(['apt-get', 'install', '-y', '--no-install-recommends', '--no-download', '-o', `Dir::Cache::Archives=${dir}/`, ...missing]);
  if (install.status !== 0) throw new Error(`apt-get install --no-download exited ${install.status}`);
  const still = playwrightDryRun(engine);
  if (still.length) throw new Error(`still missing after the install: ${still.join(' ')}`);
  console.log(`Every library ${engine} needs is installed (${((Date.now() - started) / 1000).toFixed(1)} s).`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
