/**
 * The active selection tool is part of a saved session (CEL-0249).
 *
 * The highlight toolbelt — Annotation based / KNN drag / Proximity drag /
 * Lasso — is the mode every drag on the canvas is interpreted in. It is not
 * in-progress interaction state: it is a standing choice that decides what the
 * pointer does, and switching it publishes `setLassoEnabled`,
 * `setProximityEnabled`, and `setKnnEnabled` to the viewer. Saving a session in
 * Lasso and reopening it in Annotation means the next drag does something the
 * user did not ask for.
 *
 * It was invisible to the session because `state-serializer/ui-controls.js`
 * derived its inventory from `input[id]`, `select[id]`, and
 * `details.accordion-section`, and the toolbelt is a group of `<button>`s. That
 * is the recurring defect in this subsystem in a new place: the state that is
 * republished is whatever the derivation happens to reach, and a control shaped
 * differently from the three shapes it reaches is simply lost.
 *
 * The correction adds a fourth *derivation*, not a fourth list: any element
 * carrying `data-state-serializer-pressed-group` with a stable id is
 * inventoried, its value is the id of its one `aria-pressed="true"` button, and
 * it is restored the way every other control is — by dispatching the event its
 * owner already listens for, here a `click`. A second toolbelt marked the same
 * way is carried the day it lands, with no edit here and none in the serializer.
 *
 * These tests hold three separate things, because each fails on its own:
 *  - the markup declares the toolbelt as a serialized group;
 *  - the serializer's own collector inventories such a group and refuses a
 *    malformed one;
 *  - a restored group reaches the highlight-mode owner and the viewer, proven
 *    against the real `initHighlightModeUI` rather than a mock of it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import {
  initHighlightModeUI,
} from '../assets/js/app/ui/modules/highlight/mode-ui.js';
import {
  createHighlightSelectionState,
} from '../assets/js/app/ui/modules/highlight/selection-state.js';

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

class FakeSidebar {
  constructor(groups) {
    this.groups = groups;
  }

  querySelectorAll(selector) {
    if (selector === 'input[id]' || selector === 'select[id]') return [];
    if (selector === 'details.accordion-section') return [];
    if (selector === '[data-state-serializer-pressed-group]') {
      return this.groups.filter(group => group.marked);
    }
    throw new Error(
      `Unexpected sidebar query ${JSON.stringify(selector)}`,
    );
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

function installDocument(sidebar) {
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  globalThis.document = {
    getElementById(id) {
      if (id === 'floating-panels-root') return null;
      return null;
    },
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
    sidebar,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousEvent === undefined) delete globalThis.Event;
      else globalThis.Event = previousEvent;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. The markup declares the toolbelt as a serialized pressed group.
 * ------------------------------------------------------------------ */

test('the highlight toolbelt is declared a serialized pressed-button group', () => {
  const groupMatch =
    /<div[^>]*class="highlight-mode-buttons"[^>]*>/.exec(indexHtml);
  assert.ok(
    groupMatch !== null,
    'index.html must still carry the highlight toolbelt container, or this '
      + 'file is measuring markup that no longer exists',
  );
  const groupTag = groupMatch[0];

  assert.match(
    groupTag,
    /\bdata-state-serializer-pressed-group\b/,
    'the highlight toolbelt must declare itself a serialized pressed group, or '
      + 'the active selection tool is silently dropped from every saved session',
  );
  assert.match(
    groupTag,
    /\bid="[^"]+"/,
    'a serialized pressed group needs a stable DOM id: it is the session key',
  );

  // Each mode button needs a stable id, because the group's serialized value is
  // the id of the pressed one. A missing id would make the saved value name a
  // button that cannot be found on restore.
  const buttonTags = [...indexHtml.matchAll(
    /<button[^>]*class="[^"]*highlight-mode-btn[^"]*"[^>]*>/g,
  )].map(match => match[0]);
  assert.equal(
    buttonTags.length,
    TOOLBELT_MODES.length,
    'the toolbelt must still hold exactly one button per selection mode',
  );
  for (const tag of buttonTags) {
    const mode = /\bdata-mode="([^"]+)"/.exec(tag)?.[1] ?? '(none)';
    assert.match(
      tag,
      /\bid="[^"]+"/,
      `the "${mode}" toolbelt button must carry a stable DOM id, because the `
        + 'session records the pressed button by id',
    );
  }

  const pressed = buttonTags.filter(
    tag => /\baria-pressed="true"/.test(tag),
  );
  assert.equal(
    pressed.length,
    1,
    'exactly one toolbelt button starts pressed; the serializer refuses a '
      + 'group with none or several, so the markup has to agree',
  );
});

/* ------------------------------------------------------------------ *
 * 2. The serializer's own collector inventories the group.
 * ------------------------------------------------------------------ */

test('the session control inventory carries the active selection tool', () => {
  const { group } = makeToolbelt({ pressedMode: 'lasso' });
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    const controls = createUiControlSerializer({ sidebar: fixture.sidebar })
      .collectUIControls();
    assert.deepEqual(
      controls,
      {
        'highlight-mode': {
          type: 'pressed-group',
          pressedId: 'highlight-mode-lasso',
        },
      },
      'a marked pressed-button group is one control whose value is the id of '
        + 'its pressed button',
    );
  } finally {
    fixture.restore();
  }
});

test('a pressed group under a skip marker is not serialized', () => {
  const { group } = makeToolbelt({ pressedMode: 'knn', skipped: true });
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    assert.deepEqual(
      createUiControlSerializer({ sidebar: fixture.sidebar })
        .collectUIControls(),
      {},
      'data-state-serializer-skip governs pressed groups exactly as it governs '
        + 'every other serialized control',
    );
  } finally {
    fixture.restore();
  }
});

test('a pressed group without exactly one pressed button is refused', () => {
  for (const [label, mutate] of [
    ['none pressed', buttons => {
      for (const button of buttons) button.setAttribute('aria-pressed', 'false');
    }],
    ['two pressed', buttons => {
      for (const button of buttons) button.setAttribute('aria-pressed', 'true');
    }],
    ['a coercive value', buttons => {
      buttons[0].setAttribute('aria-pressed', 'TRUE');
    }],
  ]) {
    const { group, buttons } = makeToolbelt();
    mutate(buttons);
    const fixture = installDocument(new FakeSidebar([group]));
    try {
      assert.throws(
        () => createUiControlSerializer({ sidebar: fixture.sidebar })
          .collectUIControls(),
        /pressed/i,
        `a group with ${label} must be refused rather than guessed at`,
      );
    } finally {
      fixture.restore();
    }
  }
});

test('a restore naming a button the group does not have is refused', () => {
  const { group } = makeToolbelt();
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        'highlight-mode': {
          type: 'pressed-group',
          pressedId: 'highlight-mode-retired',
        },
      }),
      /highlight-mode-retired/,
      'a saved tool the interface no longer offers is named and refused, the '
        + 'way an unavailable select option already is',
    );
    assert.throws(
      () => serializer.restoreUIControls({
        'highlight-mode': { type: 'pressed-group', pressedId: 42 },
      }),
      /pressedId/i,
      'a coercive pressedId is refused rather than stringified',
    );
    assert.throws(
      () => serializer.restoreUIControls({
        'highlight-mode': {
          type: 'pressed-group',
          pressedId: 'highlight-mode-lasso',
          mode: 'lasso',
        },
      }),
      /exact keys/i,
      'a pressed-group record is closed, like every other control record',
    );
  } finally {
    fixture.restore();
  }
});

/* ------------------------------------------------------------------ *
 * 3. A restored group reaches the real highlight-mode owner and the
 *    viewer — not only the button's aria-pressed attribute.
 * ------------------------------------------------------------------ */

function makeModeOwner(buttons) {
  const viewerCalls = [];
  const noSelection = Object.freeze({
    inProgress: false,
    stepCount: 0,
    candidateCount: 0,
    candidates: [],
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
    dom: { modeButtons: buttons, modeDescription },
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

test('a restored selection tool reaches the highlight owner and the viewer', () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    const owner = makeModeOwner(buttons);
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });

    // The user works in Lasso and saves.
    owner.modeUi.setHighlightModeUI('lasso');
    assert.equal(owner.selectionState.activeMode, 'lasso');
    const saved = serializer.collectUIControls();
    assert.deepEqual(
      saved['highlight-mode'],
      { type: 'pressed-group', pressedId: 'highlight-mode-lasso' },
      'the capture must record the tool the user was actually working in',
    );

    // A later visit opens in the default tool.
    owner.modeUi.setHighlightModeUI('annotation');
    assert.equal(owner.selectionState.activeMode, 'annotation');
    owner.viewerCalls.length = 0;

    serializer.restoreUIControls(saved);

    assert.equal(
      owner.selectionState.activeMode,
      'lasso',
      'restoring the session must put the highlight owner back in the saved '
        + 'tool, not only repaint the button',
    );
    assert.equal(
      owner.modeUi.getActiveMode(),
      'lasso',
      'the mode owner and the shared selection state must agree after restore',
    );
    assert.deepEqual(
      buttons.map(button => button.getAttribute('aria-pressed')),
      ['false', 'false', 'false', 'true'],
      'exactly the restored tool is pressed',
    );
    assert.deepEqual(
      owner.viewerCalls.filter(call => call.includes(':')),
      ['lasso:true', 'proximity:false', 'knn:false'],
      'the viewer must be told which tool is live; a restore that stops at the '
        + 'DOM leaves the next drag doing what the previous session did',
    );
  } finally {
    fixture.restore();
  }
});

test('restoring the tool that is already live publishes nothing', () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    const owner = makeModeOwner(buttons);
    owner.modeUi.setHighlightModeUI('proximity');
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    const saved = serializer.collectUIControls();
    owner.viewerCalls.length = 0;

    serializer.restoreUIControls(saved);

    assert.deepEqual(
      owner.viewerCalls,
      [],
      'a control already holding its restored value is not republished, which '
        + 'is what keeps a restore from resetting the tool history it is '
        + 'restoring into',
    );
    assert.equal(owner.selectionState.activeMode, 'proximity');
  } finally {
    fixture.restore();
  }
});

test('an owner that refuses the restored tool fails the restore loudly', () => {
  const { group, buttons } = makeToolbelt({ pressedMode: 'annotation' });
  const fixture = installDocument(new FakeSidebar([group]));
  try {
    const owner = makeModeOwner(buttons);
    owner.modeUi.setHighlightModeUI('knn');
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    const saved = serializer.collectUIControls();
    owner.modeUi.setHighlightModeUI('annotation');

    // An owner that silently ignores the click is the failure this whole
    // mechanism exists to make impossible: the panel would claim a tool the
    // renderer was never told about.
    owner.modeUi.destroy();

    assert.throws(
      () => serializer.restoreUIControls(saved),
      /highlight-mode.*rejected/s,
      'a click no owner acted on must fail the restore, never pass silently',
    );
  } finally {
    fixture.restore();
  }
});
