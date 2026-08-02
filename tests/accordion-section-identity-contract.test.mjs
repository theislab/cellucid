/**
 * @fileoverview Every accordion section must carry a unique DOM id.
 *
 * The session's dockable-layout contributor identifies a floating panel by the
 * element's own id, and `assertPanelId` throws when it is missing. Throwing is
 * right - a panel with no id cannot be restored, so capturing it would record
 * something that can never be put back - but the consequence lands in the wrong
 * place: the whole session save fails, and the user loses their filters, views
 * and camera because of an unrelated markup omission.
 *
 * That condition is a developer mistake, not a state a user's data can reach,
 * so it belongs here rather than at save time on someone's machine. Today every
 * section happens to have an id; nothing asserted it, which is why "unreachable"
 * was luck rather than a property.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INDEX_URL = new URL('../index.html', import.meta.url);
const DETAILS_OPEN_TAG = /<details\b[^>]*>/g;
const CLASS_ATTRIBUTE = /\bclass\s*=\s*"([^"]*)"/;
const ID_ATTRIBUTE = /\bid\s*=\s*"([^"]*)"/;

test('every accordion section in the markup has a unique id', async () => {
  const html = await readFile(INDEX_URL, 'utf8');
  const sections = [];

  for (const [tag] of html.matchAll(DETAILS_OPEN_TAG)) {
    const classes = tag.match(CLASS_ATTRIBUTE)?.[1] ?? '';
    if (!classes.split(/\s+/).includes('accordion-section')) continue;
    sections.push({ tag, id: tag.match(ID_ATTRIBUTE)?.[1] ?? '' });
  }

  assert.ok(
    sections.length > 0,
    'no accordion sections were found, so this test would pass vacuously'
  );

  const unidentified = sections
    .filter(section => section.id.trim().length === 0)
    .map(section => section.tag);
  assert.deepEqual(
    unidentified,
    [],
    'an accordion section without an id makes the whole session save fail when '
      + 'that panel is floating; give it a stable id'
  );

  const ids = sections.map(section => section.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(
    duplicates,
    [],
    'two accordion sections sharing an id collide in the saved layout'
  );
});
