// The WebAssembly decoders: `assets/wasm/codecs.wasm` and the licenses of the
// code in it (`assets/wasm/LICENSES/`), built from pinned upstream releases.
//
// - Zstandard 1.5.6 (decompression only), LZ4 1.10.0 (block decoding) and
//   c-blosc 1.21.6 (Blosc 1 frames, with its blosclz, byte shuffle and
//   bitshuffle code; a frame's zlib streams are inflated by the page's
//   DEFLATE decoder, `codecs.c`, so no zlib code is built), each from its release
//   tarball on the project's own release page, checked against the SHA-256
//   that page publishes (c-blosc publishes none: its tag archive's digest is
//   the one Homebrew's formula pins for the same URL).
// - Built by zig 0.13.0 (`zig cc`, clang 18) for `wasm32-freestanding` with
//   SIMD and bulk memory, no C library: `scripts/wasm-codecs/` holds the
//   exports (`codecs.c`), the arena allocator and string functions
//   (`libc.c`), and the headers the sources include (`include/`). zig's
//   own tarball is pinned by the SHA-256 ziglang.org lists, one per host.
// - Downloads and the extracted trees are kept in
//   `node_modules/.cache/wasm-codecs/` (`--cache DIR` for another place), so
//   a second build needs no network; every file is checked against its
//   digest before it is used.
//
// The same zig, sources and flags give the same bytes on every host, which is
// what lets `--check` rebuild and compare; `tests/wasm-codecs-contract.test.mjs`
// pins the module's SHA-256 and runs `--check --offline` where the cache
// holds every input.
//
//   node scripts/build-wasm-codecs.mjs [--check] [--offline] [--cache DIR]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WASM_DIR = 'assets/wasm';
export const MODULE_PATH = `${WASM_DIR}/codecs.wasm`;
export const LICENSES_DIR = `${WASM_DIR}/LICENSES`;
const SHIM_DIR = join(ROOT, 'scripts', 'wasm-codecs');

export const ZIG_VERSION = '0.13.0';
/** zig 0.13.0 per host (`${process.platform}-${process.arch}`), as https://ziglang.org/download/index.json lists it. */
export const ZIG = Object.freeze({
  'darwin-arm64': { file: 'zig-macos-aarch64-0.13.0.tar.xz', sha256: '46fae219656545dfaf4dce12fb4e8685cec5b51d721beee9389ab4194d43394c' },
  'darwin-x64': { file: 'zig-macos-x86_64-0.13.0.tar.xz', sha256: '8b06ed1091b2269b700b3b07f8e3be3b833000841bae5aa6a09b1a8b4773effd' },
  'linux-x64': { file: 'zig-linux-x86_64-0.13.0.tar.xz', sha256: 'd45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea' },
  'linux-arm64': { file: 'zig-linux-aarch64-0.13.0.tar.xz', sha256: '041ac42323837eb5624068acd8b00cd5777dac4cf91179e8dad7a7e90dd0c556' },
  'win32-x64': { file: 'zig-windows-x86_64-0.13.0.zip', sha256: 'd859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158' },
  'win32-arm64': { file: 'zig-windows-aarch64-0.13.0.zip', sha256: '95ff88427af7ba2b4f312f45d2377ce7a033e5e3c620c8caaa396a9aba20efda' },
});

/** The upstream sources, by the SHA-256 their release pages publish. */
export const SOURCES = Object.freeze({
  zstd: {
    version: '1.5.6',
    url: 'https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz',
    sha256: '8c29e06cf42aacc1eafc4077ae2ec6c6fcb96a626157e0593d5e82a34fd403c1',
    root: 'zstd-1.5.6',
  },
  lz4: {
    version: '1.10.0',
    url: 'https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz',
    sha256: '537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b',
    root: 'lz4-1.10.0',
  },
  'c-blosc': {
    version: '1.21.6',
    url: 'https://github.com/Blosc/c-blosc/archive/refs/tags/v1.21.6.tar.gz',
    sha256: '9fcd60301aae28f97f1301b735f966cc19e7c49b6b4321b839b4579a0c156f38',
    root: 'c-blosc-1.21.6',
  },
});

/** The license of each part of the module, as shipped beside it, from its source tree. */
export const LICENSES = Object.freeze([
  { name: 'zstd.txt', source: 'zstd', path: 'LICENSE' },
  { name: 'lz4.txt', source: 'lz4', path: 'lib/LICENSE' },
  { name: 'c-blosc.txt', source: 'c-blosc', path: 'LICENSE.txt' },
  { name: 'bitshuffle.txt', source: 'c-blosc', path: 'LICENSES/BITSHUFFLE.txt' },
  { name: 'fastlz.txt', source: 'c-blosc', path: 'LICENSES/FASTLZ.txt' },
]);

/** The C files of the module, by source tree (`shim` is scripts/wasm-codecs). */
const UNITS = Object.freeze([
  ['shim', 'codecs.c'],
  ['shim', 'libc.c'],
  ['shim', 'no-compression.c'],
  ...['entropy_common', 'error_private', 'fse_decompress', 'zstd_common', 'xxhash', 'debug']
    .map(name => ['zstd', `lib/common/${name}.c`]),
  ...['huf_decompress', 'zstd_ddict', 'zstd_decompress', 'zstd_decompress_block']
    .map(name => ['zstd', `lib/decompress/${name}.c`]),
  ['lz4', 'lib/lz4.c'],
  ...['blosc', 'blosclz', 'shuffle', 'shuffle-generic', 'bitshuffle-generic', 'fastcopy']
    .map(name => ['c-blosc', `blosc/${name}.c`]),
]);

/**
 * The compiler's flags. SIMD (128-bit) and bulk memory are in every browser
 * the app supports (Chrome 116, Firefox 124, Safari 17.4).
 */
const FLAGS = Object.freeze([
  '-target', 'wasm32-freestanding',
  '-O3', '-msimd128', '-mbulk-memory', '-nostdlib',
  '-DNDEBUG',
  // Zstandard: frames of this version only, no error strings, no tracing.
  '-DZSTD_LEGACY_SUPPORT=0', '-DZSTD_STRIP_ERROR_STRINGS', '-DZSTD_TRACE=0', '-DDEBUGLEVEL=0', '-DZSTD_DISABLE_ASM',
  // LZ4 with no C library.
  '-DLZ4_FREESTANDING=1', '-DLZ4_memcpy=__builtin_memcpy', '-DLZ4_memmove=__builtin_memmove', '-DLZ4_memset=__builtin_memset',
  // c-blosc's codecs (zlib's header only: `uncompress` is codecs.c's).
  '-DHAVE_LZ4', '-DHAVE_ZSTD', '-DHAVE_ZLIB',
  '-Wl,--no-entry', '-s',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hostZig() {
  const host = `${process.platform}-${process.arch}`;
  const zig = ZIG[host];
  if (zig === undefined) throw new Error(`zig ${ZIG_VERSION} is pinned for ${Object.keys(ZIG).join(', ')}, not ${host}.`);
  return { ...zig, url: `https://ziglang.org/download/${ZIG_VERSION}/${zig.file}`, root: zig.file.replace(/\.(tar\.xz|zip)$/, '') };
}

/** A pinned file in the cache, downloaded when it is missing (unless offline), checked against its digest. */
async function pinned(cache, { url, sha256: digest }, { offline }) {
  const path = join(cache, 'downloads', `${digest.slice(0, 12)}-${url.split('/').at(-1)}`);
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) === digest) return path;
    rmSync(path);
  }
  if (offline) throw new Error(`${url} is not in ${cache} (offline).`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const found = sha256(bytes);
  if (found !== digest) throw new Error(`${url} has SHA-256 ${found}, not the pinned ${digest}.`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

/** The tree of a pinned archive, extracted once into the cache (its own folder, by digest). */
function extracted(cache, archive, digest, root) {
  const folder = join(cache, 'trees', digest.slice(0, 12));
  const tree = join(folder, root);
  if (existsSync(join(folder, '.complete'))) return tree;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  execFileSync('tar', ['-xf', archive, '-C', folder], { stdio: 'inherit' });
  writeFileSync(join(folder, '.complete'), '');
  return tree;
}

/** Every input: the zig of this host and the source trees, by name. */
export async function inputs({ cache, offline = false }) {
  const zig = hostZig();
  const trees = { shim: SHIM_DIR };
  const zigTree = extracted(cache, await pinned(cache, zig, { offline }), zig.sha256, zig.root);
  for (const [name, source] of Object.entries(SOURCES)) {
    trees[name] = extracted(cache, await pinned(cache, source, { offline }), source.sha256, source.root);
  }
  return { zig: join(zigTree, process.platform === 'win32' ? 'zig.exe' : 'zig'), trees };
}

/** The module's bytes and its licenses, by path under the repository. */
export function build({ zig, trees, cache }) {
  const version = execFileSync(zig, ['version'], { encoding: 'utf8' }).trim();
  if (version !== ZIG_VERSION) throw new Error(`${zig} is zig ${version}, not ${ZIG_VERSION}.`);
  const includes = [
    join(SHIM_DIR, 'include'),
    join(trees.zstd, 'lib'), join(trees.zstd, 'lib', 'common'),
    join(trees.lz4, 'lib'),
    join(trees['c-blosc'], 'blosc'), join(trees['c-blosc'], 'internal-complibs', 'zlib-1.3.1'),
  ].map(path => `-I${path}`);
  const work = join(tmpdir(), `cellucid-wasm-codecs-${process.pid}`);
  mkdirSync(work, { recursive: true });
  try {
    const output = join(work, 'codecs.wasm');
    execFileSync(zig, ['cc', ...FLAGS, ...includes, '-o', output, ...UNITS.map(([tree, path]) => join(trees[tree], path))], {
      // zig's caches in the build cache, not the user's home.
      env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(cache, 'zig-global'), ZIG_LOCAL_CACHE_DIR: join(work, 'zig-local') },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const files = new Map([[MODULE_PATH, readFileSync(output)]]);
    for (const { name, source, path } of LICENSES) files.set(`${LICENSES_DIR}/${name}`, readFileSync(join(trees[source], path)));
    return files;
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Paths whose committed bytes are not what the build gives. */
export function staleFiles(files, root = ROOT) {
  return [...files].filter(([path, bytes]) => {
    const file = join(root, ...path.split('/'));
    return !existsSync(file) || !readFileSync(file).equals(bytes);
  }).map(([path]) => path);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--cache');
  const cache = resolve(at === -1 ? join(ROOT, 'node_modules', '.cache', 'wasm-codecs') : args[at + 1]);
  const files = build({ ...(await inputs({ cache, offline: args.includes('--offline') })), cache });
  if (args.includes('--check')) {
    const stale = staleFiles(files);
    if (stale.length > 0) {
      console.error(`${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} not what the pinned sources build.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${MODULE_PATH} ${sha256(files.get(MODULE_PATH))}: as built.`);
    return;
  }
  for (const [path, bytes] of files) {
    const file = join(ROOT, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  console.log(`${MODULE_PATH} ${sha256(files.get(MODULE_PATH))} (${files.get(MODULE_PATH).length} bytes)`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
