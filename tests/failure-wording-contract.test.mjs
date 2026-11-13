/**
 * The words a person reads when something fails.
 *
 * A failure is said in a sentence, its technical words under Details. A
 * notification or a status line that quotes an error's own message (or
 * `failureText`) shows whatever the thrower wrote: an invariant of the code
 * ("options cannot replace the owned key field"), a tracker's uuid, a GPU
 * code. Every such line goes through `sayFailure`, which says a broken
 * invariant as one, and `failureDetails`, which folds its words under the
 * card's Details (`utils/errors.js`). One function says an error in words; no
 * file keeps its own copy. An option list shows a value through its label.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../assets/js/', import.meta.url));

async function sources(dir = ROOT) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored code, and the developer benchmark (its words are for the console).
      if (entry.name !== 'vendor' && full !== path.join(ROOT, 'dev')) out.push(...await sources(full));
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** The source with comments blanked out, line numbers kept. */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map(line => (/^\s*\/\//.test(line) ? '' : line));
}

/** A call that shows words to the person: a notification, or a status line. */
const SAYS = /\b(?:notifications?|_notifications|center|getNotificationCenter\(\))\.(?:error|fail|warning|info|failCalculation|failDownload)\(|\bnotify\(|\b(?:status|statusElement)\.textContent\s*=|\btext:\s*`|\bsaid\s*=\s*`/;
/** An error's own words, quoted as they are. */
const RAW = /\$\{[^}]*\b(?:err|error|exactError|failure|cause)\??\.message\b|\b(?:err|error|exactError|failure)\??\.message\s*(?:\|\||\?\?|\))|failureText\(/;

test('a failure shown to a person is said with sayFailure, never in its own raw words', async () => {
  const offenders = [];
  for (const file of await sources()) {
    const lines = withoutComments(await readFile(file, 'utf8'));
    lines.forEach((line, index) => {
      // The call and the words it shows may sit on the next lines.
      const call = lines.slice(index, index + 3).join(' ');
      if (!SAYS.test(line) || !RAW.test(call)) return;
      // Details are where the raw words belong.
      // A hover title holds them too (`status.title = failureText(error)`).
      const shown = call.replace(/details:\s*[^,}]+/g, '').replace(/failureDetails\([^)]*\)/g, '').replace(/\.title\s*=\s*failureText\([^)]*\)/g, '');
      if (!RAW.test(shown)) return;
      offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no file keeps its own copy of "an error in words"', async () => {
  // `utils/errors.js` is the one place: `failureText`, `sayFailure`, `failureDetails`.
  const COPY = /function\s+(describeError|errorText|errorMessage|describeThrownError|failureMessage|failureWords|describeErrorMessage)\s*\(/;
  const offenders = [];
  for (const file of await sources()) {
    const relative = path.relative(ROOT, file);
    // Analytics records an error's class, never its words (`analytics/schema.js`).
    if (relative === path.join('analytics', 'schema.js')) continue;
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      const found = line.match(COPY);
      if (found !== null) offenders.push(`${relative}:${index + 1}: ${found[1]}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('a failure said after its lead is said once: "X could not be opened: The linked data could not be opened: …" never', async () => {
  // Every link refusal must not read "… could not be opened: The linked data could not be opened: …".
  const { joinFailure, sayFailure } = await import('../assets/js/utils/errors.js');
  assert.equal(joinFailure('"Beta" could not be opened', 'The linked data could not be opened: the server answered 404.'), '"Beta" could not be opened: the server answered 404.');
  assert.equal(joinFailure('"Beta" could not be opened', 'The linked data could not be opened. Try again; if it keeps failing, report it.'), '"Beta" could not be opened. Try again; if it keeps failing, report it.');
  assert.equal(joinFailure('The neighbor graph could not be read on the new cells', 'The neighbor graph could not be read: the server answered 404.'), 'The neighbor graph could not be read on the new cells: the server answered 404.');
  assert.equal(joinFailure('X could not be opened', 'it could not be opened'), 'X could not be opened.');
  // Another failure, or the same verb said of something else as the whole reason, stays.
  assert.equal(joinFailure('The gene names could not be read', 'the var index could not be read'), 'The gene names could not be read: the var index could not be read');
  assert.equal(joinFailure('The vector field could not be shown', sayFailure(new TypeError('x'))), 'The vector field could not be shown: a problem inside Cellucid stopped it.');
  // Every wrapper of a failure's sentence in a lead naming what failed goes through it.
  const WRAPPED = /`[^`\n]*?(?:could not|cannot|can not|did not|was not|were not)(?: be)? \w+[^`\n]*?: \$\{(?:sayFailure|failureSentence|failureText)\(/;
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      if (/\b(?:console|debug)\.\w+\(/.test(line)) return;
      if (WRAPPED.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, [], 'use joinFailure(lead, sayFailure(error))');
});

test('an error whose message names a code class is an InternalError: the person reads that a problem inside Cellucid stopped it', async () => {
  // "The vector field could not be shown: VelocityOverlay could not allocate transform-feedback ownership."
  // A code class's own words are said to the person as a problem inside Cellucid. Names of products and web APIs are not code.
  const { InternalError, isInternalFailure, sayFailure, failureDetails } = await import('../assets/js/utils/errors.js');
  const error = new InternalError('VelocityOverlay could not allocate transform-feedback ownership.');
  assert.ok(isInternalFailure(error));
  assert.equal(sayFailure(error), 'a problem inside Cellucid stopped it.');
  assert.match(failureDetails(error).details, /transform-feedback/);
  const NOT_CODE = new Set(['GitHub', 'AnnData', 'IndexedDB', 'WebGL', 'WebGL2', 'TextEncoder', 'LinkedIn', 'CustomEvent', 'AbortController', 'MuData', 'OneDrive', 'JavaScript', 'SharePoint', 'WebAssembly', 'ReadableStream', 'OffscreenCanvas', 'SharedArrayBuffer', 'WebGPU', 'DataView', 'ArrayBuffer']);
  const offenders = [];
  for (const file of await sources()) {
    const text = withoutComments(await readFile(file, 'utf8')).join('\n');
    for (const found of text.matchAll(/new Error\(\s*['`]([A-Z][a-z]+(?:[A-Z][a-z0-9]*)+)\b/g)) {
      if (!NOT_CODE.has(found[1])) offenders.push(`${path.relative(ROOT, file)}: ${found[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'throw new InternalError(…) (utils/errors.js)');
});

test('an option list shows words, never an API or enum value capitalised', async () => {
  // The chat's Effort menu read "Xhigh": the provider's value with its first
  // letter raised. A value is shown through its labels.
  const { EFFORT_LABELS } = await import('../assets/js/app/agent/providers/contract.js');
  const { ANTHROPIC_EFFORTS } = await import('../assets/js/app/agent/providers/anthropic.js');
  const { OPENAI_EFFORTS } = await import('../assets/js/app/agent/providers/openai.js');
  for (const effort of new Set([...ANTHROPIC_EFFORTS, ...OPENAI_EFFORTS])) {
    assert.equal(typeof EFFORT_LABELS[effort], 'string', `effort "${effort}" has a label`);
  }
  assert.equal(EFFORT_LABELS.xhigh, 'Extra high');
  const { CHOICE_LABELS, PERMISSION_CHOICES } = await import('../assets/js/app/agent/presence/permissions.js');
  assert.deepEqual(Object.keys(CHOICE_LABELS).sort(), [...PERMISSION_CHOICES].sort());
  const offenders = [];
  for (const file of await sources()) {
    withoutComments(await readFile(file, 'utf8')).forEach((line, index) => {
      if (/new Option\([^)]*(?:\[0\]|charAt\(0\))\.toUpperCase\(\)/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
