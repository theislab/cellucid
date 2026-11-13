/**
 * One way to stop work (`assets/js/utils/abort.js`), kept so by a guard over
 * every module of the web app.
 *
 * A cancellation is an `AbortError` with a kind (user, superseded, closed,
 * released, page-left), made by `cancelled()`/`cancel()` and told apart by
 * `isCancellation()`/`cancellationKind()` alone. Private copies of
 * `throwIfAborted`/`abortError`/`isAbort` would disagree on what they throw,
 * a subsystem predicate that checks only its own code misses the others, and
 * an abort with a plain `Error` or with no reason at all is shown as a
 * failure by whichever check it passes through. The guard forbids each of
 * those forms outside the one module, so a new one cannot come back.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BROWSER_FEATURES } from '../assets/js/app/startup-failure.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = path.join(ROOT, 'assets/js');
const OWNER = 'utils/abort.js';

function sourceFiles(dir = SOURCES) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const files = sourceFiles().map(full => ({
  name: path.relative(SOURCES, full).split(path.sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

/** Line of `index` in `text`, 1-based. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Every match of `pattern` (global) outside the owner module, as `file:line: text`. */
function offenders(pattern, { skip = () => false } = {}) {
  const found = [];
  for (const { name, text } of files) {
    if (name === OWNER || skip(name)) continue;
    for (const match of text.matchAll(pattern)) {
      found.push(`${name}:${lineOf(text, match.index)}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  return found;
}

test('no module defines its own cancellation helpers', () => {
  const helper = '(?:throwIfAborted|abortError|abortReason|abortReasonOf|reasonOf|getAbortReason|isAbort|isAbortError|createAbortError|cancelledError|isCancellation|cancelled|cancellationKind)';
  assert.deepEqual(
    offenders(new RegExp(`(?:^|[^.\\w])(?:function\\s+${helper}\\s*\\(|(?:const|let|var)\\s+${helper}\\s*=)`, 'gm')),
    [],
    'import it from utils/abort.js'
  );
});

test('a cancellation is made only by utils/abort.js, with a kind', () => {
  // Any AbortError built by hand: a DOMException named so, or an Error renamed.
  assert.deepEqual(
    offenders(/new DOMException\((?:[^()]|\([^()]*\))*?,\s*['"]AbortError['"]\s*\)/gs),
    [],
    'use cancelled(kind, words) or cancel(controller, kind, words)'
  );
  assert.deepEqual(offenders(/\.name\s*=\s*['"]AbortError['"]/g), [], 'use cancelled(kind, words)');
});

test('work is never stopped with a plain Error, which every check files as a failure', () => {
  assert.deepEqual(
    offenders(/\.abort\(\s*new\s+(?:Error|TypeError|RangeError)\s*\(/g),
    [],
    'stop work with cancel(controller, kind, words)'
  );
});

test('a cancellation is recognised by isCancellation/cancellationKind alone, never by its name or a code', () => {
  assert.deepEqual(offenders(/\.name\s*[!=]==?\s*['"]AbortError['"]|['"]AbortError['"]\s*[!=]==?\s*[\w$.?]+\.name/g), []);
  assert.deepEqual(
    offenders(/['"](?:CELLUCID_[A-Z_]*_(?:SUPERSEDED|CANCELLED|CANCELED)|[A-Z_]+_ABORTED)['"]/g),
    [],
    'a kind of utils/abort.js replaces each subsystem code'
  );
});

test('no request runs under a signal nothing can abort', () => {
  assert.deepEqual(
    offenders(/new AbortController\(\)\s*\.signal/g),
    [],
    'pass the caller\'s signal: a request nobody can stop outlives its caller'
  );
});

/**
 * Layers whose controllers stop work: a reasonless `abort()` there leaves the
 * work's waiters with a `user` cancellation nobody asked for. The view layer
 * (`app/ui/**`, `app/analysis/ui/**`) also aborts controllers that only scope
 * event listeners (`{signal}`), whose reason nobody reads.
 */
const WORK_LAYERS = /^(?:data|formats|workers|utils|rendering|app\/(?:session|jobs|state|exports|registries|analysis\/(?:compute|data|stats|shared))|app\/[^/]+\.js$)/;

test('in the layers that stop work, every abort says its kind', () => {
  assert.deepEqual(
    offenders(/(?<![\w$])(?!(?:transaction|tx|request|xhr)\.)[\w$?.]+\.abort\(\s*\)/g, {
      skip: name => !WORK_LAYERS.test(name),
    }),
    [],
    'stop work with cancel(controller, kind, words)'
  );
});

test('every platform feature that sets the browser floor is checked before startup', () => {
  // `AbortSignal.any` is the newest feature the app calls (Chrome 116,
  // Firefox 124, Safari 17.4): startup refuses an older browser up front
  // instead of failing in the middle of an opening.
  const uses = files.filter(file => /AbortSignal\.any\(/.test(file.text));
  assert.ok(uses.length > 0, 'the floor feature is still used (else drop it from BROWSER_FEATURES)');
  assert.ok(BROWSER_FEATURES.some(feature => feature.name === 'AbortSignal.any'));
});
