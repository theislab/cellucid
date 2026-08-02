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
const VIEWER_URL = new URL('../assets/js/rendering/viewer.js', import.meta.url);

const [indexSource, accessibilityCss, viewerSource] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(ACCESSIBILITY_CSS_URL, 'utf8'),
  readFile(VIEWER_URL, 'utf8')
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

/** The description host's text, whitespace-collapsed as a reader hears it. */
function describedText() {
  const describedBy = attributeValue(canvas.attributes, 'aria-describedby');
  const body = indexHtml
    .slice(indexHtml.indexOf('>', elementWithId(indexHtml, describedBy).index) + 1)
    .split('</p>')[0];
  assert.match(body, /\S/, 'the description host must not be empty');
  return body.replace(/\s+/g, ' ').trim();
}

/** Standalone single characters are the keys the description names. */
function keysIn(text) {
  return new Set(
    Array.from(text.matchAll(/(?:^|\s)([A-Z=?-])(?=\s|$)/g), match => match[1])
  );
}

/**
 * The description split into the clauses a reader hears as separate claims.
 *
 * A description is one spoken sentence, so "W A S D orbit or pan" and "= and -
 * zoom" are two promises, not one. A new claim begins wherever a new run of key
 * names begins — keys joined only by spaces or "and" belong to the same claim —
 * so the split survives however the prose between them is punctuated. That is
 * what lets a claim be checked against the handler that serves it rather than
 * against the whole sentence, where any word satisfies any key.
 */
function describedClauses() {
  const text = describedText().replace(/^Keyboard:\s*/, '');
  const starts = [];
  let previousEnd = null;
  for (const match of text.matchAll(/(?:^|\s)([A-Z=?-])(?=\s|$)/g)) {
    const keyIndex = match.index + match[0].length - 1;
    const between = previousEnd === null
      ? null
      : text.slice(previousEnd, keyIndex);
    if (between === null || !/^\s*(?:and\s+)?$/.test(between)) {
      starts.push(keyIndex);
    }
    previousEnd = keyIndex + 1;
  }
  assert.ok(starts.length >= 4, 'the description must still make several claims');
  return starts.map((start, index) => text
    .slice(start, index + 1 < starts.length ? starts[index + 1] : text.length)
    .replace(/[\s,]*(?:\band\b)?[\s,]*$/, '')
    .trim());
}

/** The one clause that names every key in `keys`, and no other clause may. */
function clauseNaming(keys) {
  const matching = describedClauses().filter(clause => {
    const named = keysIn(clause);
    return keys.every(key => named.has(key));
  });
  assert.equal(
    matching.length,
    1,
    `exactly one clause may describe ${keys.join(' ')} (found ${matching.length})`
  );
  return matching[0];
}

test('every key the canvas description names is a key the shortcuts panel lists', () => {
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
  const named = keysIn(describedText());
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

/*
 * Naming the right keys is not the same as saying the right thing about them.
 * The description shipped "W A S D orbit or pan, = and - zoom": both keys are
 * real, both are in the panel, and both claims were wrong — free-fly moves on
 * W A S D, and free-fly has no keyboard zoom at all. A presence check cannot
 * see that, and a screen-reader user hears this sentence on every focus with no
 * visible panel to check it against, so the claims are pinned to the handlers
 * (CEL-0200).
 */

/** The body of one `viewer.js` per-frame navigation update. */
function viewerFunctionBody(name, nextName) {
  const start = viewerSource.indexOf(`function ${name}(`);
  const end = viewerSource.indexOf(`function ${nextName}(`);
  assert.ok(
    start !== -1 && end > start,
    `viewer.js must still define ${name} before ${nextName}`
  );
  const body = viewerSource.slice(start, end);
  assert.ok(body.length > 200, `${name} must still have an implementation`);
  return body;
}

const freeflyBody = viewerFunctionBody('updateFreefly', 'updateOrbitPlanarKeys');

test('the movement keys are not described as orbit and pan only', () => {
  // Every one of W A S D moves the free-fly camera, so a description that
  // offers only the orbit and planar behaviours hides a whole navigation mode.
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    assert.match(
      freeflyBody,
      new RegExp(`activeKeys\\.has\\('${code}'\\)`),
      `free-fly must still move on ${code}`
    );
  }

  const clause = clauseNaming(['W', 'A', 'S', 'D']);
  assert.match(
    clause,
    /\bmove|\bfly/i,
    `"${clause}" describes only orbit and pan, but these keys also move the `
    + 'free-fly camera'
  );
});

test('the zoom keys are described as the two modes that answer them', () => {
  // `updateFreefly` reads no zoom key, so an unqualified "= and - zoom" is a
  // gesture the app ignores in one of its three navigation modes.
  for (const code of ['Equal', 'Minus', 'BracketLeft', 'BracketRight']) {
    assert.doesNotMatch(
      freeflyBody,
      new RegExp(`activeKeys\\.has\\('${code}'\\)`),
      `free-fly now reads ${code}: the description may drop its scope clause`
    );
  }
  assert.match(
    viewerSource,
    /activeKeys\.has\('Equal'\) \|\| activeKeys\.has\('BracketRight'\)/,
    'orbit and planar must still zoom in on = and ]'
  );

  const clause = clauseNaming(['=', '-']);
  for (const mode of [/\borbit/i, /\bplanar/i]) {
    assert.match(
      clause,
      mode,
      `"${clause}" must name the modes where these keys work, because the `
      + 'third mode ignores them'
    );
  }
  assert.doesNotMatch(
    clause,
    /free-fly/i,
    `"${clause}" offers keyboard zoom in free-fly, where nothing reads it`
  );
});

test('the mode-switch keys name every mode the description scopes claims to', () => {
  // The scope clauses above are only meaningful if the reader has been told the
  // modes exist, and the keys that reach them.
  const clause = clauseNaming(['O', 'P', 'G']);
  for (const mode of [/\borbit/i, /\bplanar/i, /free-fly/i]) {
    assert.match(
      clause,
      mode,
      `"${clause}" scopes other claims by mode without naming every mode`
    );
  }
});
