/**
 * The plot canvas is `tabindex="0"`, which makes it the first Tab stop in the
 * document. An unnamed first stop is the first thing a screen-reader user meets
 * on every load, so the name, the role that permits the name, and the
 * description all have to be present in the shipped markup (CEL-AUDIT-0088).
 *
 * The description host is pinned deliberately. A collapsed `<details>` hides its
 * content with `content-visibility`, which drops the whole subtree out of the
 * accessibility tree, so pointing `aria-describedby` into the Keyboard
 * Shortcuts panel yields no description at all while that panel is shut. The
 * host has to be an element that is always rendered.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INDEX_URL = new URL('../index.html', import.meta.url);
const ACCESSIBILITY_CSS_URL = new URL(
  '../assets/css/base/_accessibility.css',
  import.meta.url
);

const [indexSource, accessibilityCss] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(ACCESSIBILITY_CSS_URL, 'utf8')
]);

/* Comments are blanked rather than removed so every offset stays comparable
   with the source file, while markup quoted inside a comment cannot be read as
   markup. */
const indexHtml = indexSource.replace(/<!--[\s\S]*?-->/g, comment =>
  comment.replace(/[^\n]/g, ' ')
);

function attributeValue(attributes, name) {
  const value = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  return value === undefined ? null : value;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `<details>…</details>` span in the document, by character offset. */
function detailsRanges(html) {
  const ranges = [];
  const tags = /<(\/?)details\b[^>]*>/g;
  let depth = 0;
  let start = -1;
  for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
    if (match[1] === '') {
      if (depth === 0) start = match.index;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) ranges.push([start, match.index + match[0].length]);
    }
  }
  assert.equal(depth, 0, 'index.html <details> elements must be balanced');
  return ranges;
}

function elementWithId(html, id) {
  const match = html.match(
    new RegExp(`<(\\w+)\\b([^>]*?)\\bid="${escapeRegExp(id)}"([^>]*)>`)
  );
  assert.ok(match, `index.html must contain one element with id="${id}"`);
  const duplicate = html.match(
    new RegExp(`\\bid="${escapeRegExp(id)}"`, 'g')
  );
  assert.equal(duplicate.length, 1, `id="${id}" must be unique`);
  return {
    tagName: match[1],
    attributes: `${match[2]} ${match[3]}`,
    index: match.index
  };
}

const canvas = elementWithId(indexHtml, 'glcanvas');

test('the plot canvas is a named, described first Tab stop', () => {
  assert.equal(canvas.tagName, 'canvas');
  assert.equal(attributeValue(canvas.attributes, 'tabindex'), '0');

  // <canvas> has no implicit ARIA role, so naming it is only well defined once
  // an explicit role that permits a name is present. `img` contradicts a
  // focusable, keyboard-operable element and makes descendants presentational;
  // `application` changes how a screen reader routes every key, which is a
  // product decision rather than a maintenance fix.
  assert.equal(attributeValue(canvas.attributes, 'role'), 'group');

  const label = attributeValue(canvas.attributes, 'aria-label');
  assert.match(label ?? '', /\S/, 'the canvas must carry a non-empty name');
  assert.equal(
    attributeValue(canvas.attributes, 'aria-labelledby'),
    null,
    'one naming mechanism only'
  );

  const describedBy = attributeValue(canvas.attributes, 'aria-describedby');
  assert.match(
    describedBy ?? '',
    /^\S+$/,
    'the canvas must reference exactly one description host'
  );

  const host = elementWithId(indexHtml, describedBy);
  assert.match(
    attributeValue(host.attributes, 'class') ?? '',
    /(?:^|\s)sr-only(?:\s|$)/,
    'the description host must be the shared screen-reader-only utility'
  );
  assert.match(
    accessibilityCss,
    /^\.sr-only\s*\{/m,
    'the .sr-only utility the description host relies on must exist'
  );

  for (const [start, end] of detailsRanges(indexHtml)) {
    assert.ok(
      host.index < start || host.index >= end,
      'the description host must not sit inside a <details>: a collapsed ' +
      '<details> is content-visibility:hidden, and Chromium then computes no ' +
      'description for the canvas at all'
    );
  }
});

test('every key the canvas description names is a key the shortcuts panel lists', () => {
  const describedBy = attributeValue(canvas.attributes, 'aria-describedby');
  const hostBody = indexHtml
    .slice(indexHtml.indexOf('>', elementWithId(indexHtml, describedBy).index) + 1)
    .split('</p>')[0];
  assert.match(hostBody, /\S/, 'the description host must not be empty');

  const [shortcutsStart, shortcutsEnd] =
    detailsRanges(indexHtml).find(([start, end]) => {
      const block = indexHtml.slice(start, end);
      return /\bid="shortcuts-section"/.test(block);
    }) ?? [];
  assert.ok(
    Number.isInteger(shortcutsStart),
    'the Keyboard Shortcuts panel must exist'
  );
  const shortcuts = indexHtml.slice(shortcutsStart, shortcutsEnd);

  // Standalone single characters in the description are key names. Anything
  // spoken as a key has to be a key the panel documents, or the two drift.
  const named = new Set(
    Array.from(hostBody.matchAll(/(?:^|\s)([A-Z=?-])(?=\s|$)/g), match => match[1])
  );
  assert.ok(
    named.size >= 8,
    `the description must still name the navigation keys (found ${named.size})`
  );
  for (const key of named) {
    assert.match(
      shortcuts,
      new RegExp(`<kbd>${escapeRegExp(key)}</kbd>`),
      `the shortcuts panel must document the "${key}" key the canvas announces`
    );
  }
});
