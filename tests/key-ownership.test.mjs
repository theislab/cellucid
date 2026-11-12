/**
 * Who a key press belongs to (`utils/key-ownership.js`): one rule for every
 * page-wide key listener. Round 9, R9K-1: six listeners each kept their own
 * "is the person typing?" test and five treated every `<input>` as a text
 * field, so after a slider or a checkbox was used W A S D, H, R, O… did
 * nothing until the plot was clicked.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isInKeyKeepingWidget, isPageKey, isTextEntry } from '../assets/js/utils/key-ownership.js';
import { sourceFiles } from './helpers/source-files.mjs';

const input = type => ({ tagName: 'INPUT', getAttribute: name => (name === 'type' ? type : null), closest: () => null });
const element = (tagName, { inside = null, editable = false } = {}) => ({
  tagName,
  isContentEditable: editable,
  closest: selector => (inside !== null && selector.split(', ').includes(inside) ? {} : null),
});
const key = (target, extra = {}) => ({ target, defaultPrevented: false, ...extra });

test('a text field types its keys and keeps its undo; other inputs type nothing', () => {
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
  for (const type of ['text', 'search', 'number', 'email', 'password', 'date', null]) {
    assert.equal(isTextEntry(input(type)), true, `${type} input`);
  }
  for (const type of ['range', 'checkbox', 'radio', 'color', 'button', 'file', 'submit']) {
    assert.equal(isTextEntry(input(type)), false, `${type} input`);
  }
  assert.equal(isTextEntry({ tagName: 'SELECT' }), false, 'a select has no undo of its own');
});

test('a slider, a checkbox, a radio, a button or the plot leaves the keys to the page', () => {
  for (const type of ['range', 'checkbox', 'radio', 'color', 'button', 'file']) {
    assert.equal(isPageKey(key(input(type))), true, `${type} input`);
  }
  for (const tagName of ['BUTTON', 'CANVAS', 'SUMMARY', 'A', 'BODY']) {
    assert.equal(isPageKey(key(element(tagName))), true, tagName);
  }
  assert.equal(isPageKey(key(null)), true, 'no target (the window)');
});

test('a text field, a select, a menu, a list, a combo box or a dialog keeps its keys', () => {
  assert.equal(isPageKey(key(input('text'))), false);
  assert.equal(isPageKey(key(element('TEXTAREA'))), false);
  assert.equal(isPageKey(key(element('DIV', { editable: true }))), false);
  assert.equal(isPageKey(key(element('SELECT'))), false, 'a select jumps to the option a letter starts');
  for (const widget of ['[role="menu"]', '[role="listbox"]', '[role="combobox"]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog']) {
    assert.equal(isInKeyKeepingWidget(element('BUTTON', { inside: widget })), true, widget);
    assert.equal(isPageKey(key(element('BUTTON', { inside: widget }))), false, widget);
  }
});

test('a key the focused control already took is not the page\'s', () => {
  // The history list takes [ ] and / on a focused row: before, [ also zoomed
  // the camera behind it.
  assert.equal(isPageKey(key(element('DIV'), { defaultPrevented: true })), false);
});

test('no module keeps its own "is the person typing?" rule', async () => {
  // The shapes the six copies had: a tag list, a closest() over fields, a
  // named predicate.
  const copies = [
    /\[\s*'INPUT',\s*'TEXTAREA'/,
    /closest\(\s*'input,\s*textarea/,
    /\bfunction\s+is(?:Typing|TextEntry)Target\b/,
    /tagName\s*===\s*'TEXTAREA'/,
    /isContentEditable\s*\|\|\s*active\s+instanceof\s+HTMLTextAreaElement/,
  ];
  const offenders = [];
  for (const { path, relative } of sourceFiles('assets/js')) {
    if (relative === 'utils/key-ownership.js') continue;
    const source = await readFile(path, 'utf8');
    for (const pattern of copies) if (pattern.test(source)) offenders.push(`${relative}: ${pattern}`);
  }
  assert.deepEqual(offenders, [], 'decide who a key belongs to with utils/key-ownership.js');
});
