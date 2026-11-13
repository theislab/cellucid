import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = fileURLToPath(
  new URL('../assets/js/app/ui/modules/', import.meta.url)
);
const DOM_MODULE = path.join(MODULES_DIR, 'community-annotation/dom.js');

function read(file) {
  return readFileSync(file, 'utf8');
}

/** Names `community-annotation/dom.js` owns for the whole annotation UI. */
function ownedHelperNames() {
  const source = read(DOM_MODULE);
  const names = [];
  const pattern = /^export function ([A-Za-z_$][\w$]*)\s*\(/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  return names;
}

/** Every community annotation UI source that could import from `dom.js`. */
function annotationUiSources() {
  const files = [];
  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (entry.isFile() && /^community-annotation.*\.js$/.test(entry.name)) {
      files.push(path.join(MODULES_DIR, entry.name));
    }
  }
  const nested = path.join(MODULES_DIR, 'community-annotation');
  for (const entry of readdirSync(nested, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const file = path.join(nested, entry.name);
    if (file !== DOM_MODULE) files.push(file);
  }
  return files.sort();
}

test('community-annotation/dom.js owns its helpers for the whole annotation UI', () => {
  const owned = ownedHelperNames();
  assert.ok(owned.includes('el'), 'dom.js must still export the shared element helper');

  const sources = annotationUiSources();
  assert.ok(
    sources.length >= 10,
    'the annotation UI surface should have been discovered, not assumed'
  );

  const offenders = [];
  for (const file of sources) {
    const source = read(file);
    for (const name of owned) {
      // A module-scope re-declaration is a second implementation of a helper
      // that already has exactly one owner; the two can drift apart silently.
      const declaration = new RegExp(
        `^(?:function ${name}\\s*\\(|(?:const|let|var) ${name}\\s*=)`,
        'm'
      );
      if (declaration.test(source)) {
        offenders.push(`${path.relative(MODULES_DIR, file)} re-declares ${name}()`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'community annotation UI modules must import these helpers from ' +
    'community-annotation/dom.js instead of re-declaring them'
  );
});

test('community annotation has one toCleanString (utils/clean-string.js)', () => {
  const owner = fileURLToPath(new URL('../assets/js/utils/clean-string.js', import.meta.url));
  assert.match(read(owner), /^export function toCleanString\(/m);
  const sources = [
    ...annotationUiSources(),
    DOM_MODULE,
    ...readdirSync(fileURLToPath(new URL('../assets/js/app/community-annotations/', import.meta.url)))
      .filter(name => name.endsWith('.js'))
      .map(name => fileURLToPath(new URL(`../assets/js/app/community-annotations/${name}`, import.meta.url))),
  ];
  const offenders = sources.filter(file => /^(?:export )?function toCleanString\s*\(|^(?:const|let|var) toCleanString\s*=/m.test(read(file)));
  assert.deepEqual(offenders.map(file => path.relative(MODULES_DIR, file)), [], 'import toCleanString from utils/clean-string.js');
});
