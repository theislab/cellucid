/**
 * @fileoverview Every accordion section must carry a unique DOM id.
 *
 * The layout actions (`layout.panel.dock`, `layout.panel.float`) name a panel
 * by the section element's own id, and `dockable-accordions.js` leaves a
 * section without an id out of the sidebar's sections, so it can be neither
 * docked, floated nor restored from a session. That is a developer mistake,
 * not a state a user's data can reach, so it belongs here rather than on
 * someone's machine: every section has an id, as a property and not by luck.
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
