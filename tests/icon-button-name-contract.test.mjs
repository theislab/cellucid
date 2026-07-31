/**
 * Icon-only controls in index.html must carry a real accessible name
 * (CEL-AUDIT-0086).
 *
 * `title` is the last fallback in the accessible-name computation. It renders
 * as a hover tooltip, so a keyboard or touch user never sees it, and some
 * assistive-technology configurations suppress it entirely. A button whose
 * only name is a `title` is therefore a button that can disappear.
 *
 * The rule here is blanket: any button in index.html whose rendered content
 * carries no letters or digits has to name itself with `aria-label` or
 * `aria-labelledby`. The one control named at runtime instead is listed
 * explicitly, with the module that names it asserted to do so.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const INDEX_URL = new URL('../index.html', import.meta.url);
const SIDEBAR_CONTROLS_URL = new URL(
  '../assets/js/app/ui/modules/sidebar-controls.js',
  import.meta.url
);

/**
 * Controls whose name is published by application code rather than by markup,
 * because the name changes with their state.
 */
const RUNTIME_NAMED = new Map([['sidebar-toggle', SIDEBAR_CONTROLS_URL]]);

const [indexSource, sidebarControlsSource] = await Promise.all([
  readFile(INDEX_URL, 'utf8'),
  readFile(SIDEBAR_CONTROLS_URL, 'utf8')
]);
const indexHtml = indexSource.replace(/<!--[\s\S]*?-->/g, '');

function attributeValue(attributes, name) {
  const value = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  return value === undefined ? null : value;
}

const buttons = Array.from(
  indexHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)
).map(([, attributes, content]) => ({
  attributes,
  id: attributeValue(attributes, 'id'),
  className: attributeValue(attributes, 'class') ?? '',
  title: attributeValue(attributes, 'title'),
  ariaLabel: attributeValue(attributes, 'aria-label'),
  ariaLabelledby: attributeValue(attributes, 'aria-labelledby'),
  text: content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}));

/** A control the user can only recognise by its icon. */
const iconOnly = buttons.filter(button => !/[A-Za-z0-9]/.test(button.text));

test('index.html still has icon-only buttons to check', () => {
  assert.ok(buttons.length > 40, `expected the full button set, saw ${buttons.length}`);
  assert.ok(iconOnly.length >= 12, `expected the icon-only set, saw ${iconOnly.length}`);
});

test('no icon-only button is named by a tooltip alone', () => {
  for (const button of iconOnly) {
    const identity = button.id ?? button.className;
    if (RUNTIME_NAMED.has(button.id)) continue;
    const named =
      /\S/.test(button.ariaLabel ?? '') || /\S/.test(button.ariaLabelledby ?? '');
    assert.ok(
      named,
      `icon-only button "${identity}" has no accessible name of its own` +
      (button.title === null ? '' : ` (title="${button.title}" is not a name)`)
    );
  }
});

test('a control named at runtime is named by the module that owns it', () => {
  for (const [id] of RUNTIME_NAMED) {
    const button = buttons.find(candidate => candidate.id === id);
    assert.ok(button, `${id} must exist in index.html`);
    assert.equal(
      button.ariaLabel,
      null,
      `${id} is named at runtime, so a stale markup name would fight the module`
    );
  }
  // The sidebar toggle's name changes with the sidebar, so it is published
  // together with aria-expanded rather than frozen in markup.
  assert.match(sidebarControlsSource, /setAttribute\('aria-label',/);
  assert.match(sidebarControlsSource, /setAttribute\('aria-expanded',/);
});

test('the field action buttons name the field they act on', () => {
  const fieldActions = buttons.filter(button =>
    button.className.split(/\s+/).includes('field-action-btn')
  );
  assert.equal(fieldActions.length, 12);

  const names = fieldActions.map(button => button.ariaLabel);
  for (const [index, name] of names.entries()) {
    assert.match(
      name ?? '',
      /\S/,
      `${fieldActions[index].id} must carry an accessible name`
    );
    // The tooltip and the spoken name are the same string, so a voice-control
    // user can say what a mouse user reads.
    assert.equal(fieldActions[index].title, name);
  }

  // Three identical rows of four actions sit in one panel. Duplicated names
  // are what makes a screen reader's element list unusable here.
  assert.equal(
    new Set(names).size,
    names.length,
    `field action names must be unique, saw ${JSON.stringify(names)}`
  );
  for (const group of ['categorical', 'continuous', 'gene']) {
    const inGroup = fieldActions.filter(button => button.id.includes(group));
    assert.equal(inGroup.length, 4, `${group} must keep its four actions`);
  }
});

test('the field action groups are exposed as groups', () => {
  const containers = Array.from(
    indexHtml.matchAll(/<div\b([^>]*\bclass="[^"]*\bfield-actions\b[^"]*"[^>]*)>/g)
  ).map(([, attributes]) => attributes);
  assert.equal(containers.length, 3);
  for (const attributes of containers) {
    const label = attributeValue(attributes, 'aria-label');
    assert.match(label ?? '', /\S/);
    // Naming is prohibited on a generic element, so a bare <div> would carry
    // this label nowhere.
    assert.equal(attributeValue(attributes, 'role'), 'group', `role missing for "${label}"`);
  }
});
