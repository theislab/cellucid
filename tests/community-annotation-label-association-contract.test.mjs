/**
 * Every `<label>` the community annotation UI builds must be associated with
 * the control it names, either by `for` or by nesting the control inside it.
 *
 * An `aria-label` on the input is not a substitute: it fixes the accessible
 * name but not the label's click target, so a sighted pointer user clicking
 * the caption gets nothing. This whole subsystem had drifted into the
 * "bare label + sibling input carrying a duplicate aria-label" idiom, so the
 * rule is enforced over every label-creation site rather than the ones that
 * happened to be reported.
 *
 * Scope note: this pins the *construction* rule. `createInfoLabel()` in
 * `controls-panel.js` also renders section headings that name a group rather
 * than one control; those pass this rule because the helper offers `for`, and
 * their heading form is documented at the helper. See
 * `tests/browser/community-annotation-vote-outcome.spec.mjs` for the
 * behavioural counterpart (clicking a caption focuses its control).
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = fileURLToPath(
  new URL('../assets/js/app/ui/modules/', import.meta.url)
);
const ANNOTATIONS_DIR = fileURLToPath(
  new URL('../assets/js/app/community-annotations/', import.meta.url)
);

/** Every community annotation source that can build DOM. */
function annotationUiSources({
  modulesDir = MODULES_DIR,
  annotationsDir = ANNOTATIONS_DIR,
} = {}) {
  const files = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.isFile() && /^community-annotation.*\.js$/.test(entry.name)) {
      files.push(path.join(modulesDir, entry.name));
    }
  }
  const nested = path.join(modulesDir, 'community-annotation');
  for (const entry of readdirSync(nested, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(nested, entry.name));
    }
  }
  for (const entry of readdirSync(annotationsDir, { withFileTypes: true })) {
    // `_worker-code.js` is the deployed Cloudflare Worker bundle; it renders no
    // DOM and is generated from the same tree, so scanning it double-counts.
    if (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      entry.name !== '_worker-code.js'
    ) {
      files.push(path.join(annotationsDir, entry.name));
    }
  }
  return files.sort();
}

/**
 * Read the full text of the `el('label', …)` call that starts at `openIndex`
 * (the index of its `(`), honouring nesting and string literals so a `)` in a
 * caption cannot truncate the call.
 */
function readCallText(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error('Unterminated label construction call');
}

/** Every `el('label', …)` site in one source, with its association evidence. */
function labelSites(source) {
  const sites = [];
  const pattern = /el\(\s*(['"])label\1/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const openIndex = source.indexOf('(', match.index);
    const callText = readCallText(source, openIndex);
    const line = source.slice(0, match.index).split('\n').length;
    const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      source.slice(0, match.index)
    );
    const variable = assignment === null ? null : assignment[1];
    const nestsControl =
      variable !== null &&
      new RegExp(`\\b${variable}\\.appendChild\\(`).test(source);
    sites.push({
      line,
      declaresFor: /\bfor:\s*\S/.test(callText),
      nestsControl,
      variable,
    });
  }
  return sites;
}

test('every community annotation label is associated with the control it names', () => {
  const sources = annotationUiSources();
  assert.ok(
    sources.length >= 10,
    'the annotation UI surface should have been discovered, not assumed'
  );

  const offenders = [];
  let total = 0;
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const site of labelSites(source)) {
      total += 1;
      if (site.declaresFor || site.nestsControl) continue;
      offenders.push(
        `${path.relative(MODULES_DIR, file)}:${site.line} builds a <label> ` +
        'with no for= and no nested control'
      );
    }
  }

  assert.ok(
    total >= 10,
    `expected the label sites to be found, saw ${total}`
  );
  assert.deepEqual(
    offenders,
    [],
    'a bare <label> beside its input loses click-to-focus even when the input ' +
    'carries a duplicate aria-label'
  );
});

test('DOM ids come from the one owner rather than ad-hoc generators', () => {
  const offenders = [];
  for (const file of annotationUiSources()) {
    const source = readFileSync(file, 'utf8');
    if (/Math\.random\(\)/.test(source)) {
      offenders.push(
        `${path.relative(MODULES_DIR, file)} mints ids with Math.random()`
      );
    }
    if (/^function createDomId\s*\(/m.test(source) && !file.endsWith('dom.js')) {
      offenders.push(
        `${path.relative(MODULES_DIR, file)} re-declares createDomId()`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'community-annotation/dom.js owns createDomId(); a second generator drifts ' +
    'and Math.random() is collision-prone for ids that wire for/aria-controls'
  );
});
