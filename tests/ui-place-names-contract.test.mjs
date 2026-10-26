/**
 * The places a message sends someone to (`app/ui/place-names.js`) are named
 * as their headings write them, and no message names one in words of its
 * own: a renamed panel or block is renamed in every message with it.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLACES, placePath } from '../assets/js/app/ui/place-names.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function textOf(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function panelTitle(id) {
  const match = new RegExp(`<details[^>]*\\bid="${id}"[^>]*>\\s*<summary[^>]*>([\\s\\S]*?)</summary>`).exec(INDEX);
  return match === null ? null : textOf(match[1]);
}

function headingTitle(id) {
  const match = new RegExp(`<(h[1-6]|div|span)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(INDEX);
  return match === null ? null : textOf(match[2]);
}

function sourceFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (name.endsWith('.js')) files.push(full);
  }
  return files;
}

test('every place is named as its heading in index.html writes it', () => {
  for (const [key, place] of Object.entries(PLACES)) {
    if (place.panel !== undefined) {
      assert.equal(panelTitle(place.panel), place.name, `PLACES.${key}: the summary of #${place.panel}`);
    } else if (place.heading !== undefined) {
      assert.equal(headingTitle(place.heading), place.name, `PLACES.${key}: the heading #${place.heading}`);
    }
  }
  assert.equal(placePath(PLACES.session, PLACES.dataMapping), 'Session › Data mapping');
});

test('a place the page builds itself is headed with its place name', () => {
  const legend = readFileSync(path.join(ROOT, 'assets/js/app/ui/modules/legend-renderer.js'), 'utf8');
  assert.match(legend, /filterHeader\.textContent = PLACES\.visibleRange\.name;/);
  const annotation = readFileSync(path.join(ROOT, 'assets/js/app/ui/modules/community-annotation/controls-panel.js'), 'utf8');
  assert.match(annotation, /createPeerDisclosure\(\s*'manage',\s*PLACES\.annotatedColumns\.name,/);
});

test('no message names a place in words of its own', () => {
  const names = Object.values(PLACES).map(place => place.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const reference = new RegExp(
    `(?:\\b(?:under|in|in the|open|opens|first in the) (?:${names.join('|')})(?=[ ,.;:)'\`"]| ›|$)` +
    `(?! (?:mode|setting|settings|key|keys|of|the|a|an|for|and|is|are|file|files|data|state|this)\\b))` +
    `|(?:\\b(?:${names.join('|')}) ›)`
  );
  const found = [];
  for (const file of sourceFiles(path.join(ROOT, 'assets/js'))) {
    if (file.endsWith(`${path.sep}place-names.js`)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
      // Only what a person reads: the text inside the line's string literals.
      for (const literal of code.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
        const text = literal[0].replace(/\$\{[^}]*\}/g, '');
        if (reference.test(text)) found.push(`${path.relative(ROOT, file)}:${index + 1}: ${text.slice(0, 120)}`);
        // A place a message calls a panel, section, block or box is one of PLACES.
        for (const named of text.matchAll(/\bthe ([A-Z][\w&]*(?: [\w&]+){0,3}?) (?:panel|section|block|box)\b/g)) {
          if (!Object.values(PLACES).some(place => place.name === named[1])) {
            found.push(`${path.relative(ROOT, file)}:${index + 1}: names "${named[1]}", which is no place`);
          }
        }
      }
    });
  }
  assert.deepEqual(found, [], 'name the place with PLACES (app/ui/place-names.js)');
});
