/**
 * The active selection tool is page chrome kept in sessions and saved
 * states, outside the history.
 *
 * The highlight toolbelt (Annotation based / KNN drag / Proximity drag /
 * Lasso) is the mode every drag on the canvas is read in: switching it
 * publishes `setLassoEnabled`, `setProximityEnabled` and `setKnnEnabled` to
 * the viewer. Saving in Lasso and reopening in Annotation would make the next
 * drag do something the person did not ask for, so a save and the autosave
 * keep it (`capturePageChrome`) and a load or Continue put it back after the
 * head is shown (`applyPageChrome`). It is never a history step: no action
 * sets it, no domain holds it (the settings inventory leaves the group out),
 * and undo or a jump leave it alone.
 *
 * These tests hold four things, each failing on its own:
 *  - the markup declares the toolbelt a pressed group with stable ids;
 *  - `capturePageChrome` reads it and refuses a malformed group;
 *  - `applyPageChrome` reaches the real `initHighlightModeUI` owner and the
 *    viewer, and refuses a malformed record before changing anything;
 *  - the history neither records a switch nor moves the tool.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { applyPageChrome, capturePageChrome, createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { initHighlightModeUI } from '../assets/js/app/ui/modules/highlight/mode-ui.js';
import { createHighlightSelectionState } from '../assets/js/app/ui/modules/highlight/selection-state.js';
import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { createSelectModeDom } from './helpers/select-mode-dom.mjs';

const INDEX_URL = new URL('../index.html', import.meta.url);
const indexHtml = await readFile(INDEX_URL, 'utf8');

const TOOLBELT_MODES = ['annotation', 'knn', 'proximity', 'lasso'];

/* ------------------------------------------------------------------ *
 * A DOM shaped like the real toolbelt: a marked container holding one
 * identified button per mode, exactly one of which is pressed.
 * ------------------------------------------------------------------ */

class FakeButton {
  constructor(id, mode, pressed) {
    this.id = id;
    this.tagName = 'BUTTON';
    this.dataset = { mode };
    this.attributes = pressed === null ? {} : { 'aria-pressed': String(pressed) };
    this.listeners = new Map();
    this.focusCount = 0;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  removeEventListener() {}

  focus() {
    this.focusCount += 1;
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }
}

class FakeGroup {
  constructor({ id, buttons, marked = true, skipped = false }) {
    this.id = id;
    this.tagName = 'DIV';
    this.buttons = buttons;
    this.marked = marked;
    this.skipped = skipped;
  }

  closest(selector) {
    if (selector === '[data-state-serializer-skip]') {
      return this.skipped ? this : null;
    }
    // The toolbelt's choices do not follow the embedding.
    if (selector === '[data-state-serializer-after-embedding]') return null;
    throw new Error(`Unexpected closest() selector ${JSON.stringify(selector)}`);
  }

  querySelectorAll(selector) {
    if (selector !== 'button[id]') {
      throw new Error(
        `Unexpected group query ${JSON.stringify(selector)}`,
      );
    }
    return this.buttons.filter(button => button.id.length > 0);
  }
}

/** The page: its marked groups, and no input, select or section (the settings inventory finds nothing). */
class FakePage {
  constructor(groups) {
    this.groups = groups;
  }

  querySelectorAll(selector) {
    if (selector === 'input[id]' || selector === 'select[id]') return [];
    if (selector === 'details.accordion-section') return [];
    if (selector === '[data-state-serializer-pressed-group]') {
      return this.groups.filter(group => group.marked);
    }
    throw new Error(`Unexpected page query ${JSON.stringify(selector)}`);
  }
}

function makeToolbelt({ pressedMode = 'annotation', ...options } = {}) {
  const buttons = TOOLBELT_MODES.map(mode => new FakeButton(
    `highlight-mode-${mode}`,
    mode,
    mode === pressedMode ? true : (mode === 'annotation' ? false : null),
  ));
  return {
    buttons,
    group: new FakeGroup({ id: 'highlight-mode', buttons, ...options }),
  };
}


function installDocument(page) {
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  globalThis.document = {
    getElementById: () => null,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.Event = class {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = init.bubbles === true;
      this.cancelable = init.cancelable === true;
    }
  };
  return {
    page,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousEvent === undefined) delete globalThis.Event;
      else globalThis.Event = previousEvent;
    },
  };
}

function makeModeOwner(buttons) {
  const viewerCalls = [];
  const noSelection = Object.freeze({
    inProgress: false,
    stepCount: 0,
    candidateCount: 0,
    candidates: new Uint32Array(0),
  });
  const viewer = {
    cancelAnnotationSelection() { viewerCalls.push('cancelAnnotation'); },
    cancelKnnSelection() { viewerCalls.push('cancelKnn'); },
    cancelProximitySelection() { viewerCalls.push('cancelProximity'); },
    cancelLassoSelection() { viewerCalls.push('cancelLasso'); },
    cancelUnifiedSelection() { viewerCalls.push('cancelUnified'); },
    getUnifiedSelectionState: () => noSelection,
    restoreUnifiedState() { viewerCalls.push('restoreUnified'); },
    setKnnEnabled(on) { viewerCalls.push(`knn:${on}`); },
    setLassoEnabled(on) { viewerCalls.push(`lasso:${on}`); },
    setProximityEnabled(on) { viewerCalls.push(`proximity:${on}`); },
    setSelectMode() {},
  };
  const modeDescriptionParent = { appendChild() {}, querySelector: () => null };
  const modeDescription = {
    textContent: '',
    style: {},
    parentElement: modeDescriptionParent,
  };
  const selectionState = createHighlightSelectionState();
  const modeUi = initHighlightModeUI({
    state: { pointCount: 8 },
    viewer,
    dom: { ...createSelectModeDom(), modeButtons: buttons, modeDescription },
    selectionState,
    modeHandlers: {
      restoreAnnotationSelection() {},
      restoreKnnSelection() {},
      restoreProximitySelection() {},
      restoreLassoSelection() {},
    },
  });
  return { viewer, viewerCalls, selectionState, modeUi };
}

test('the highlight toolbelt is declared a pressed group of page chrome, with stable ids and one pressed button', () => {
  const groupTag = /<div[^>]*class="highlight-mode-buttons"[^>]*>/.exec(indexHtml)?.[0];
  assert.ok(groupTag !== undefined, 'index.html still carries the highlight toolbelt');
  assert.match(groupTag, /\bdata-state-serializer-pressed-group\b/, 'the toolbelt is marked, or the tool is dropped from every save');
  assert.match(groupTag, /\bid="highlight-mode"/);
  const buttonTags = [...indexHtml.matchAll(/<button[^>]*class="[^"]*highlight-mode-btn[^"]*"[^>]*>/g)].map(match => match[0]);
  assert.equal(buttonTags.length, TOOLBELT_MODES.length);
  for (const tag of buttonTags) assert.match(tag, /\bid="[^"]+"/, 'each tool button carries a stable id (the saved value)');
  assert.equal(buttonTags.filter(tag => /\baria-pressed="true"/.test(tag)).length, 1);
});

test('capturePageChrome records the pressed button of each marked group, and none skipped', () => {
  const { group } = makeToolbelt({ pressedMode: 'lasso' });
  const skipped = makeToolbelt({ pressedMode: 'knn', skipped: true }).group;
  skipped.id = 'other-tools';
  const fixture = installDocument(new FakePage([group, skipped]));
  try {
    assert.deepEqual(capturePageChrome(fixture.page), { pressed: { 'highlight-mode': 'highlight-mode-lasso' } });
  } finally {
    fixture.restore();
  }
});

test('a group without exactly one pressed button is refused rather than guessed at', () => {
  for (const [label, mutate] of [
    ['none pressed', buttons => { for (const button of buttons) button.setAttribute('aria-pressed', 'false'); }],
    ['two pressed', buttons => { for (const button of buttons) button.setAttribute('aria-pressed', 'true'); }],
    ['a coercive value', buttons => { buttons[0].setAttribute('aria-pressed', 'TRUE'); }],
  ]) {
    const { group, buttons } = makeToolbelt();
    mutate(buttons);
    const fixture = installDocument(new FakePage([group]));
    try {
      assert.throws(() => capturePageChrome(fixture.page), /pressed/i, label);
    } finally {
      fixture.restore();
    }
  }
});

test('applyPageChrome refuses a malformed record before changing anything, and leaves out, saying so, a group or a button this page lacks', () => {
  const { group, buttons } = makeToolbelt();
  const fixture = installDocument(new FakePage([group]));
  try {
    const owner = makeModeOwner(buttons);
    assert.throws(() => applyPageChrome({ pressed: { 'highlight-mode': 42 } }, fixture.page), /stable nonempty DOM id/);
    assert.throws(() => applyPageChrome({ pressed: { 'highlight-mode': ' highlight-mode-lasso' } }, fixture.page), /stable nonempty DOM id/);
    assert.throws(() => applyPageChrome({ pressed: {}, mode: 'lasso' }, fixture.page), /exactly|unexpected|mode/i);
    assert.throws(() => applyPageChrome(null, fixture.page), /plain object/);
    assert.equal(owner.selectionState.activeMode, 'annotation', 'nothing changed');
    assert.deepEqual(applyPageChrome({ pressed: { 'retired-tools': 'whatever' } }, fixture.page), [
      'This page has no "retired-tools" buttons, so the one the session pressed there is left out.',
    ]);
    assert.deepEqual(applyPageChrome({ pressed: { 'highlight-mode': 'highlight-mode-retired' } }, fixture.page), [
      'This page has no "highlight-mode-retired" button in "highlight-mode", so that choice of the session is left out.',
    ]);
    assert.equal(owner.selectionState.activeMode, 'annotation');
  } finally {
    fixture.restore();
  }
});

test('a tool put back reaches the highlight owner and the viewer', () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakePage([group]));
  try {
    const owner = makeModeOwner(buttons);
    owner.modeUi.setHighlightModeUI('lasso');
    const saved = capturePageChrome(fixture.page);
    assert.deepEqual(saved, { pressed: { 'highlight-mode': 'highlight-mode-lasso' } });
    owner.modeUi.setHighlightModeUI('annotation');
    owner.viewerCalls.length = 0;
    applyPageChrome(saved, fixture.page);
    assert.equal(owner.selectionState.activeMode, 'lasso');
    assert.equal(owner.modeUi.getActiveMode(), 'lasso');
    assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true']);
    assert.deepEqual(owner.viewerCalls.filter(call => call.includes(':')), ['lasso:true', 'proximity:false', 'knn:false']);
    // The tool already live: nothing is published again.
    owner.viewerCalls.length = 0;
    applyPageChrome(saved, fixture.page);
    assert.deepEqual(owner.viewerCalls, []);
  } finally {
    fixture.restore();
  }
});

test('an owner that ignores the click fails the apply loudly', () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakePage([group]));
  try {
    const owner = makeModeOwner(buttons);
    owner.modeUi.destroy();
    assert.throws(() => applyPageChrome({ pressed: { 'highlight-mode': 'highlight-mode-knn' } }, fixture.page), /highlight-mode.*rejected/s);
  } finally {
    fixture.restore();
  }
});

test('switching the tool makes no history step, and undo and a jump leave it alone', async () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakePage([group]));
  try {
    const owner = makeModeOwner(buttons);
    // The settings domain is the control inventory, as on the page: the toolbelt is not in it.
    const serializer = createUiControlSerializer({ sidebar: fixture.page });
    assert.equal(Object.hasOwn(serializer.collectUIControls(), 'highlight-mode'), false);
    let a = 0;
    const domains = createDomainRegistry();
    domains.provide('settings', { capture: () => serializer.collectUIControls(), restore: value => serializer.restoreUIControls(value) });
    domains.provide('filters', { capture: () => a, restore: value => { a = value; } });
    for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
    const number = { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'integer' } } };
    const set = defineAction({ type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: number, touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})` });
    const dispatcher = createActionDispatcher({ catalog: createActionCatalog([set, ...historyActions]) });
    dispatcher.provide('a.set', ({ v }) => { a = v; });
    let n = 0;
    const history = createHistory({
      dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
      newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    });
    await history.startTracker();
    const s1 = (await dispatcher.dispatch('a.set', { v: 1 })).step;
    owner.modeUi.setHighlightModeUI('lasso');
    await history.reconcile();
    assert.equal(history.active.steps.size, 2, 'the switch is no step, not even one made outside the history');
    await history.undo();
    assert.equal(owner.selectionState.activeMode, 'lasso', 'undo leaves the tool');
    await history.jump(s1.id);
    assert.equal(owner.selectionState.activeMode, 'lasso', 'a jump leaves the tool');
    assert.equal(a, 1);
  } finally {
    fixture.restore();
  }
});
