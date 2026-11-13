/**
 * @fileoverview One concept, one implementation. Each rule names a concept, the module that owns it,
 * and the hand-written forms a copy takes; a new copy anywhere in
 * `assets/js` fails here with the owner to use instead. Sibling sweeps:
 * `byte-text-contract` (bytes as text, SHA-256), `hex-color-contract`
 * (`#rrggbb`), `key-ownership` (who a key press belongs to),
 * `web-storage-contract`, `csv-quoting-contract`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fnv1a32 } from '../assets/js/utils/fnv1a.js';
import { StringIndex } from '../assets/js/utils/string-index.js';
import { downloadBlob, fileTimestamp, safeFileName } from '../assets/js/app/utils/download.js';
import { copyFileName, copyFileNamed } from '../assets/js/app/history/anndata-copy-save.js';
import { buildExportFilename } from '../assets/js/app/ui/modules/figure-export/utils/export-helpers.js';
import { onNextMacrotask, yieldToMacrotask } from '../assets/js/utils/yield-macrotask.js';
import { formatCompactCount, formatPValue, formatRemaining } from '../assets/js/utils/format-units.js';
import * as geneReadPlan from '../assets/js/data/gene-read-plan.js';
import { lowerFirst, upperFirst } from '../assets/js/utils/text-case.js';
import * as displayFormat from '../assets/js/app/ui/components/display-format.js';
import { backoffDelayMs } from '../assets/js/utils/backoff.js';
import { createListenerSet } from '../assets/js/utils/listener-set.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'assets', 'js');

/** Every page and worker module: its path from `assets/js/` and its text. */
function sources(directory = SOURCES, out = []) {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'vendor') sources(full, out);
    } else if (name.endsWith('.js')) {
      out.push({ file: path.relative(SOURCES, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** Each match of `pattern` in `text` outside comments, as `file:line: code`. */
function matchesOf({ file, text }, pattern) {
  const found = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  for (const match of code.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
    const line = code.slice(0, match.index).split('\n').length;
    found.push(`${file}:${line}: ${match[0].replace(/\s+/g, ' ').trim()}`);
  }
  return found;
}

/**
 * The concepts. `except` names a file whose match is a different thing,
 * with the reason.
 */
const RULES = [
  {
    concept: 'FNV-1a over a string\'s UTF-16 code units',
    owner: 'utils/fnv1a.js',
    pattern: /\^=?\s*\w+\.charCodeAt\(\w+\)(?:,\s*|;\s*\w+\s*=\s*Math\.imul\(\w+,\s*)(?:0x01000193|16777619)/,
    except: {
      // A running hash of several facts, mirrored in Python and R byte for byte: its names continue the
      // counts' hash, they do not start one.
      'data/input-formats.js': 'the registry\'s structure digest continues one running hash',
    },
  },
  {
    concept: 'the characters a file name cannot hold',
    owner: 'app/utils/download.js',
    pattern: /\[(?:\/\\\\|\\\\\/)(?:<>|:\*\?)/,
    except: {
      // A store's element names (inside a Zarr or HDF5 file), a different rule: reserved device names and
      // a byte limit too.
      'data/anndata/write/names.js': 'element names inside a store',
    },
  },
  {
    concept: 'HTML escaping',
    owner: 'app/utils/dom-utils.js',
    pattern: /['"]&amp;['"]|replace(?:All)?\(\s*\/?&\/?g?\s*,\s*['"]&amp;/,
  },
  {
    concept: 'whether a host is this machine (or a loopback host a browser trusts: `isSecureContextLoopbackHost`)',
    owner: 'utils/loopback.js',
    // A host list, a `.localhost` suffix, a 127.0.0.0/8 pattern, a bracketed `[::1]` compared.
    pattern: /['"]127\.0\.0\.1['"]\s*,|\.endsWith\(['"]\.localhost['"]\)|\/\^127(?:\\\.|\(\?:\\\.)|===\s*['"]\[::1\]['"]/,
    except: {
      // A worker's bootstrap list, written into index.html's boot script by the inventory generator.
      'workers/worker-script.js': 'the boot script\'s host list',
    },
  },
  {
    concept: 'a cancellation made by hand (no kind: every one read as the person\'s)',
    owner: 'utils/abort.js',
    pattern: /name:\s*'AbortError'|new DOMException\([^)]*'AbortError'\)/,
  },
  {
    concept: 'an abort\'s reason thrown raw (`abortReason` makes any reason an error)',
    owner: 'utils/abort.js',
    pattern: /throw\s+[\w.?]*[sS]ignal\??\.reason\b|reject\(\s*[\w.?]*[sS]ignal\??\.reason\s*\)/,
  },
  {
    concept: 'running something on the next macrotask',
    owner: 'utils/yield-macrotask.js',
    pattern: /new Promise\(\s*(\w+)\s*=>\s*setTimeout\(\1,\s*0\)\s*\)|setImmediate\(|\.onmessage = \(\) => \{?\s*\w+\.port1\.close\(\)/,
    except: {
      // Waits for a Web Lock this tab let go to be released by the browser (a timer's task),
      // before asking whether anyone else holds it: not a yield.
      'data/anndata/transcode/space.js': 'waits for a released lock',
    },
  },
  {
    concept: 'reading a Retry-After header (seconds or an HTTP date)',
    owner: 'formats/io/hosts.js',
    pattern: /Number\.isFinite\(seconds\)\s*&&\s*seconds\s*>=\s*0[^\n]*\n[^\n]*Date\.parse\(/,
  },
  {
    concept: 'a status that fails on the host\'s side (5xx, 408, 429)',
    owner: 'formats/io/byte-source.js',
    pattern: /status\s*>=\s*500\s*\|\|\s*status\s*===\s*408/,
  },
  {
    concept: 'writing the clipboard (and saying how it went: copied, or why not)',
    owner: 'app/utils/clipboard.js',
    pattern: /clipboard\??\.writeText\(|execCommand\(\s*['"]copy['"]/,
  },
  {
    concept: 'whether this computer is online',
    owner: 'formats/io/hosts.js',
    pattern: /navigator\??\.onLine\b/,
    except: {
      // Reads the scope a failed worker was started from, given to it (a test's stand-in or a worker's
      // own `self`), to say why its code did not load.
      'workers/worker-failure.js': 'the given scope of a failed worker',
    },
  },
  {
    concept: 'a duration in words (ms, s, min, h)',
    owner: 'utils/format-units.js',
    // Seconds written by hand from milliseconds: "took ${(ms / 1000).toFixed(1)} s", "about ${Math.round(ms / 1000)} s",
    // "in ${Math.max(1, Math.ceil(delayMs / 1000))} s", "~${Math.round((end - now) / 1000)}s"; minutes or hours
    // ("~${Math.round(ms / 60_000)} min", a second "time left" formatter beside `formatRemaining`).
    pattern: /\$\{[^`}]*?\/\s*1000\s*\)(?:\.toFixed\([^)]*\))?\)?\s*\}\s*s\b|\$\{[^`}]*?\/\s*(?:60_?000|3_?600_?000)\s*\)[^`}]*\}\s*(?:min|h)\b/,
  },
  {
    concept: 'how long ago, in words ("4 minutes ago", "just now")',
    owner: 'app/ui/modules/state/model.js',
    pattern: /`\$\{\w+\}[mhd] ago`|\$\{[^}]*\}\s*days? ago`|['"`]\s*\w*\s*yesterday['"`]/,
  },
  {
    concept: 'whether the person is editing a field (typing or choosing in it)',
    owner: 'utils/key-ownership.js',
    pattern: /\^\(INPUT\|TEXTAREA|['"]TEXTAREA['"]\s*\]|tagName\s*===\s*['"]TEXTAREA['"]/,
  },
  {
    concept: 'a growing wait before trying again (exponential backoff with jitter)',
    owner: 'utils/backoff.js',
    pattern: /\*\s*2\s*\*\*\s*\w*attempt|Math\.pow\(\s*2\s*,\s*\w*attempt|0\.5\s*\+\s*\w*(?:\.random|random)\(\)\s*\/\s*2/i,
  },
  {
    concept: 'a compact count ("4M", never "4.0M": `formatCompactCount`)',
    owner: 'utils/format-units.js',
    pattern: /\.toFixed\(\d\)\s*\+\s*['"][KMB]['"]|\.toFixed\(\d\)\}[KMB]\b|\bformatCompactNumber\b/,
  },
  {
    concept: 'a p-value shown as text (`formatPValue`: two significant figures; a CSV keeps the number)',
    owner: 'utils/format-units.js',
    pattern: /\b(?:p|pVal|pValue|p_value|adj(?:usted)?P\w*|padj\w*)\??\.(?:toExponential|toPrecision|toFixed)\(/,
  },
  {
    concept: 'a first letter upper- or lower-cased by hand (`upperFirst`, `lowerFirst`)',
    owner: 'utils/text-case.js',
    pattern: /(?:\.charAt\(0\)|\[0\])\??\.to(?:Upper|Lower)Case\(\)\s*(?:\+|\}\$\{)/,
  },
  {
    concept: 'a time stamp in a file name',
    owner: 'app/utils/download.js',
    pattern: /toISOString\(\)\.replace\(|padStart\(2, '0'\)[^\n]*getHours|getFullYear\(\)\)?[^\n]*padStart/,
  },
  {
    // Policies for a listener that throws are one: every listener is told, a throw is reported (hand-written
    // sets chose among: the rest not told, told and the error swallowed, logged, collected and thrown back at the notifier, rethrown later).
    concept: 'a set of listeners told of a change (`createListenerSet`: every one told, a throw reported)',
    owner: 'utils/listener-set.js',
    // A loop calling each of a set named …listeners/callbacks/watchers/subscribers/observers/
    // handlers, its `forEach`, or such a set made as a plain `Set`.
    pattern: (() => {
      const names = String.raw`(?:\w(?:Listeners|Callbacks|Watchers|Subscribers|Observers|Handlers)|\b_?(?:listeners|callbacks|watchers|subscribers|observers|handlers))`;
      return new RegExp(String.raw`for \(const (\w+) of (?:\[\.\.\.)?(?:[\w.]*\.)?${names}\b[^)\n]*\)\s*\{?\s*(?:try\s*\{\s*)?(?:(?:const|let) \w+ = )?\1\(|${names}\]?\)?\.forEach\(|${names}\s*[=:]\s*new Set\(\)`);
    })(),
    except: {
      // Each caller joined on one gene read gets its own copy of a dense column (the first the
      // read's own): a different argument per listener.
      'data/base-anndata-adapter.js': 'a copy of the column for each caller',
      // A notebook command's handlers: their promises are awaited, and the reply waits on them.
      'data/viewer-host-source.js': 'handlers whose results are awaited',
    },
  },
  {
    // A debounce: run once calls stop coming for a while. The split forms (the clear in a
    // cancel function, the set elsewhere) are found with it; this finds the form a copy is
    // written in.
    concept: 'a debounce: run once calls stop coming for a while (`debounce`, with cancel/flush/pending)',
    owner: 'utils/debounce.js',
    pattern: /clearTimeout\(\s*([\w.$]+)\s*\);?[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*?\b\1\s*=\s*(?:globalThis\.|window\.|self\.)?setTimeout\(/,
    except: {
      // A notification's own auto-dismiss deadline, set anew with each update's duration (0: never),
      // kept on its record with the record's other timers: not calls settling.
      'app/notification-center.js': 'a notification\'s auto-dismiss deadline',
    },
  },
  {
    // Validators of a signal (`assertAbortSignalOrNull`, `requireAbortSignal`,
    // `assertSignal`, `isAbortSignal`, figure export's brand check, …) and inline checks; a
    // duck-typed one takes any object with an `aborted` boolean (gzip, cell sets, bundles) for one.
    concept: 'whether a value is an AbortSignal (`isAbortSignal`, `requireSignal`, `requireSignalOrNull`)',
    owner: 'utils/abort.js',
    pattern: /instanceof AbortSignal|\.aborted\s*[!=]==\s*['"]boolean['"]|function\s+(?:assert|require|validate|is)\w*Signal(?:OrNull)?\s*\(|getOwnPropertyDescriptor\(\s*\w*AbortSignal\w*\.prototype/,
    except: {
      // The Cloudflare Worker asks whether its runtime gives requests a signal (`enable_request_signal`).
      'app/community-annotations/_worker-code.js': 'the Worker runtime\'s request signal',
    },
  },
  {
    concept: 'a method group mixed onto a class (its members defined on the prototype by their descriptors)',
    owner: 'utils/apply-mixin.js',
    pattern: /Object\.defineProperties\(\s*\w+\.prototype\s*,\s*(?:Object\.getOwnPropertyDescriptors\(|descriptors\b)|delete\s+descriptors\.constructor\b/,
  },
];

test('FNV-1a is the published function, so every hash it replaced keeps its value', () => {
  // Reference values of 32-bit FNV-1a (offset basis 0x811c9dc5, prime 0x01000193).
  assert.equal(fnv1a32(''), 0x811c9dc5);
  assert.equal(fnv1a32('a'), 0xe40c292c);
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
  // Values the copies it replaced gave (checked against them): a contributor's pull-request branch
  // (`toAnnotationHeadBranch`) and a figure's seed keep their names.
  assert.equal(fnv1a32('main').toString(36), '1t30hzc');
  assert.equal(fnv1a32('pancreas'), 2706948136);
  const index = StringIndex.of(['CD4', 'CD8A', 'CD4']);
  assert.equal(index.get('CD4'), 2);
  assert.equal(index.get('MS4A1'), undefined);
});

test('every download is named safely, at the one exit, with one time stamp', () => {
  assert.equal(safeFileName('Pancreas a/b: 1|2'), 'Pancreas a_b_ 1_2');
  assert.equal(safeFileName(' ..x\u0000y.. '), 'x_y');
  assert.equal(safeFileName('', 'fallback'), 'fallback');
  assert.equal(safeFileName('Lunge — Übersicht 肺 (v2).csv'), 'Lunge — Übersicht 肺 (v2).csv');
  assert.equal(fileTimestamp(new Date(2026, 10, 4, 9, 3, 7)), '20261104_090307');
  // The AnnData copy's names: one rule for the one it makes and the one it is given.
  assert.equal(copyFileName('a/b'), 'a_b with this state.zarr.zip');
  assert.equal(copyFileNamed('x:y.zarr.zip'), 'x_y.zarr.zip');
  // A figure keeps a dataset's name in every script (every letter outside ASCII stays).
  assert.equal(
    buildExportFilename({ datasetName: 'Lunge Übersicht 肺', fieldKey: 'cell_type', viewLabel: null, variant: null, ext: 'png', timestamp: '20261104_090307' }),
    'Lunge_Übersicht_肺_cell_type_20261104_090307.png',
  );
  // A name the app did not make safe (a history report of "a/b") leaves safe.
  const clicked = [];
  const previous = { document: globalThis.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  globalThis.document = {
    createElement: () => ({ remove() {}, click() { clicked.push(this.download); } }),
    body: { appendChild() {} },
  };
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = () => {};
  try {
    downloadBlob(new Blob(['x']), 'a/b history report.html');
  } finally {
    globalThis.document = previous.document;
    URL.createObjectURL = previous.createObjectURL;
    URL.revokeObjectURL = previous.revokeObjectURL;
  }
  assert.deepEqual(clicked, ['a_b history report.html']);
});

test('the next macrotask comes after every promise continuation of this task, in the order asked', async () => {
  const order = [];
  onNextMacrotask(() => order.push('first'));
  const yielded = yieldToMacrotask().then(() => order.push('second'));
  onNextMacrotask(() => order.push('third'));
  Promise.resolve().then(() => order.push('continuation'));
  await yielded;
  await yieldToMacrotask();
  assert.deepEqual(order, ['continuation', 'first', 'second', 'third']);
});

test('the backoff doubles per attempt up to its ceiling, in the upper half of each wait', () => {
  const options = { firstMs: 1_000, ceilingMs: 60_000 };
  assert.equal(backoffDelayMs(0, { ...options, random: () => 0 }), 500);
  assert.equal(backoffDelayMs(3, { ...options, random: () => 0 }), 4_000);
  assert.equal(backoffDelayMs(20, { ...options, random: () => 0.999999 }) < 60_000, true);
  assert.equal(backoffDelayMs(20, { ...options, random: () => 0 }), 30_000);
  assert.throws(() => backoffDelayMs(-1, options), RangeError);
});

test('one compact count: "4M", "2.5M", "1M" for 999,960, and no second formatter', () => {
  // Two formatters wrote "4.0M" and "4M" for one count.
  assert.deepEqual([950, 999.6, 1_500, 15_000, 250_000, 999_960, 2_500_000, 4_000_000, 1.2e9, -1_500].map(formatCompactCount),
    ['950', '1K', '1.5K', '15K', '250K', '1M', '2.5M', '4M', '1.2B', '-1.5K']);
  assert.equal(displayFormat.formatCompactCount, undefined, 'the display module keeps no copy');
});

test('one time left: `formatRemaining`, in its largest unit where room is short, and no second formatter', () => {
  assert.deepEqual([400, 40_000, 690_000, 4_680_000, 43_200_000].map(ms => formatRemaining(ms, { compact: true })),
    ['<1 s', '~40 s', '~12 min', '~1.3 h', '~12 h']);
  assert.deepEqual([400, 40_000, 690_000].map(ms => formatRemaining(ms)), ['<1 s', '~40 s', '~11 min 30 s']);
  assert.equal(geneReadPlan.roughRemaining, undefined, 'the gene read plan keeps no copy');
});

test('one p-value: two significant figures, "< 1e-300" where the double underflowed', () => {
  // Five rules wrote one p-value as "< 0.0001", "4.12e-8", "4.123e-8", "4.1e-8" and "0.0000412".
  assert.deepEqual([0.0321, 4.123e-8, 0.5, 1, 0, 1e-310, Number.NaN, null].map(formatPValue),
    ['0.032', '4.1e-8', '0.5', '1', '< 1e-300', '< 1e-300', '—', '—']);
});

test('one first-letter case: a name in capitals keeps them inside a sentence', () => {
  assert.equal(upperFirst('colored by x'), 'Colored by x');
  assert.equal(upperFirst(''), '');
  assert.equal(lowerFirst('Colored by x'), 'colored by x');
  assert.equal(lowerFirst('PCA computed on 2,000 genes'), 'PCA computed on 2,000 genes');
  assert.equal(lowerFirst('HTTP 404 from the host'), 'HTTP 404 from the host');
  assert.equal(lowerFirst(''), '');
});

test('one listener set: every listener is told, a throw is reported once, a notice reaches who was in when it began', () => {
  const set = createListenerSet('the test');
  const heard = [];
  const reports = [];
  const consoleError = console.error;
  console.error = (...args) => reports.push(args);
  try {
    const failure = new Error('one listener failed');
    let stopLate = null;
    const late = () => heard.push('late');
    const removed = () => heard.push('removed');
    let stopRemoved = null;
    set.add(value => {
      heard.push(`first ${value}`);
      throw failure;
    });
    set.add(() => {
      heard.push('second');
      stopRemoved();
      stopLate = set.add(late);
    });
    stopRemoved = set.add(removed);
    set.notify(1);
    // The throw is reported, naming the set; the one removed during the notice is not told; the one
    // added during it hears the next.
    assert.deepEqual(heard, ['first 1', 'second']);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], '[cellucid] A listener of the test failed:');
    assert.equal(reports[0][1], failure);
    heard.length = 0;
    set.notify(2);
    assert.deepEqual(heard, ['first 2', 'second', 'late']);
    // An unsubscribe is idempotent and removes only its own subscription.
    const stopAgain = set.add(late);
    stopLate();
    stopLate();
    assert.equal(set.size, 2);
    const readded = set.add(late);
    stopAgain();
    assert.equal(set.size, 3, 'an earlier unsubscribe does not remove the listener added since');
    readded();
    assert.equal(set.delete(late), false);
    assert.throws(() => set.add(null), TypeError);
    assert.throws(() => createListenerSet(''), TypeError);
    // notifyWhile: a listener that makes the news stale stops the older one.
    let current = true;
    const told = createListenerSet('a stale test');
    const order = [];
    told.add(() => { order.push('a'); current = false; });
    told.add(() => order.push('b'));
    assert.equal(told.notifyWhile(() => current), false);
    assert.deepEqual(order, ['a']);
    told.clear();
    assert.equal(told.size, 0);
  } finally {
    console.error = consoleError;
  }
});

/**
 * Where a request goes out without the one transport (`formats/io/byte-source.js` `fetchOnce`: the
 * host's request budget and Retry-After, a stall ends a request, offline and a host refusing said by
 * who is at fault, the retry line), with why: each file's raw calls to the global `fetch`, counted. A
 * raw `fetch` that fails rejects with a bare `TypeError`, which reads as a problem inside Cellucid
 * (`utils/errors.js` `isInternalFailure`).
 */
const RAW_FETCH = {
  // The transport's own.
  'formats/io/host-fetch.js': [1, 'routedFetch: the fetch the transport sends through (or the notebook host)'],
  'app/community-annotations/orcid-client.js': [1, 'a fetch handed to fetchOnce'],
  'app/community-annotations/worker-request.js': [1, 'a fetch handed to fetchOnce'],
  'data/sources/providers/gdrive.js': [2, 'a fetch with the sign-in\'s headers handed to readFileHead; and the one-byte probe that '
    + 'waits as long as Google takes (~7 s, past a stall\'s patience), its failure being the answer'],
  // Probes whose answer must not count in the book of hosts, nor be held by it.
  'data/sources/remote-file.js': [2, 'the no-cors probe of whether a host answers at all (an opaque answer is no delivery), and the '
    + 'probe of whether an address that answered before still lets this site read it'],
  // Endpoints with their own semantics.
  'data/sources/auth/microsoft.js': [1, 'the OAuth token endpoint: a one-time code or a rotating refresh token, never abandoned as '
    + 'stalled nor sent twice'],
  'data/sources/auth/google.js': [1, 'the keepalive token revocation, which outlives the page'],
  'app/community-annotations/github-auth.js': [1, 'the keepalive token revocation, which outlives the page'],
  'app/agent/providers/anthropic.js': [1, 'a model API: an answer streamed with long silences while the model works, with its own retries'],
  'app/agent/providers/openai.js': [1, 'a model API: an answer streamed with long silences while the model works, with its own retries'],
  'app/agent/bridge/relay-client.js': [1, 'the agent relay: long-held requests with their own reconnect rule'],
  'app/community-annotations/_worker-code.js': [2, 'the Cloudflare Worker (server side): its fetch handler and its requests to GitHub'],
  // This page's own server and files.
  'app/main.js': [1, 'the page\'s own server\'s health at startup, under the startup step\'s deadline'],
  'app/citation.js': [1, 'the page\'s own CITATION.cff (readCitationFile, the one reader)'],
  'app/ui/core/code-load-watch.js': [1, 'a classic script that runs before any module: the page\'s own HTML'],
  'formats/io/wasm-codecs.js': [1, 'the page\'s own WebAssembly module, compiled as it streams'],
  'dev/benchmark.js': [1, 'a developer benchmark\'s own file'],
};

test('every request goes through the one transport, except where a raw fetch says why', () => {
  const counts = new Map();
  for (const source of sources()) {
    const hits = matchesOf(source, /(?<![\w$.])fetch\(|\b(?:globalThis|window|self)\.fetch\(/);
    if (hits.length > 0) counts.set(source.file, hits);
  }
  const offenders = [];
  for (const [file, hits] of counts) {
    const allowed = RAW_FETCH[file]?.[0] ?? 0;
    if (hits.length !== allowed) {
      offenders.push(`${file}: ${hits.length} raw fetch call(s), ${allowed} allowed (use fetchOnce, fetchWhenNotBusy or fetchAnswer, `
        + `or name the reason here): ${hits.join(' | ')}`);
    }
  }
  for (const file of Object.keys(RAW_FETCH)) {
    if (!counts.has(file)) offenders.push(`${file}: allowed a raw fetch it no longer makes (remove it from the list)`);
  }
  assert.deepEqual(offenders, []);
});

test('every concept has one implementation: no copy beside its owner', () => {
  const all = sources();
  const offenders = [];
  for (const rule of RULES) {
    assert.ok(all.some(source => source.file === rule.owner), `${rule.owner} exists`);
    for (const source of all) {
      if (source.file === rule.owner || rule.except?.[source.file]) continue;
      for (const hit of matchesOf(source, rule.pattern)) offenders.push(`${rule.concept} (use ${rule.owner}): ${hit}`);
    }
  }
  assert.deepEqual(offenders, []);
});
