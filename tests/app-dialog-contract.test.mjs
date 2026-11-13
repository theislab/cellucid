/**
 * One implementation for every modal dialog: a native `<dialog>` opened with
 * `showModal()` through `wireAppDialog` (`ui/components/app-dialog.js`).
 *
 * The browser part (backdrop, inert page, top layer, Escape's `cancel`, focus
 * moving in) is proved in the real app (`ui-keyboard-lifecycle.spec.mjs`,
 * `welcome-dialog.spec.mjs`, `ui-reachability.spec.mjs`). Here, on a small
 * stand-in for the DOM: what the helper adds — focus back to the opener at
 * once on close(), a later native close settling the same way, a backdrop
 * click only when the press began there too, keys kept inside, the
 * notification cards following the topmost dialog — and the confirmation
 * dialog built on it. A source sweep keeps every other module off the old
 * shapes (an overlay `div` with `aria-modal`, a Tab trap, `showModal()` of
 * its own).
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JS_ROOT = path.join(ROOT, 'assets/js');

// ---------------------------------------------------------------------------
// A stand-in DOM: nodes in a tree, listeners with abort signals, a dialog
// whose native close event comes a task later, as in every engine.
// ---------------------------------------------------------------------------

const queued = [];
const runQueuedTasks = () => {
  while (queued.length > 0) queued.shift()();
};

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.value = '';
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  insertBefore(node, reference) {
    node.parentNode?.removeChild(node);
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (parent === null) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...nodes);
  }

  get nextSibling() {
    const parent = this.parentNode;
    if (parent === null) return null;
    return parent.children[parent.children.indexOf(this) + 1] ?? null;
  }

  contains(node) {
    for (let at = node; at !== null && at !== undefined; at = at.parentNode) if (at === this) return true;
    return false;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node === fakeDocument.documentElement;
  }

  get ownerDocument() {
    return fakeDocument;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    if (selector === ':disabled') return this.disabled;
    return false;
  }

  focus() {
    fakeDocument.activeElement = this;
  }

  addEventListener(type, listener, options = {}) {
    const list = this.listeners.get(type) ?? [];
    const entry = { listener, capture: options === true || options?.capture === true };
    list.push(entry);
    this.listeners.set(type, list);
    options?.signal?.addEventListener('abort', () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    });
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    const at = list.findIndex(entry => entry.listener === listener);
    if (at >= 0) list.splice(at, 1);
  }

  /** Bubble an event from this node up the tree. */
  dispatch(type, init = {}) {
    let stopped = false;
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...init,
    };
    for (let node = this; node !== null && !stopped; node = node.parentNode) {
      for (const { listener } of [...(node.listeners.get(type) ?? [])]) listener(event);
    }
    return event;
  }

  click() {
    this.dispatch('pointerdown');
    this.dispatch('click');
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector === '[data-dialog-close]' && child.hasAttribute('data-dialog-close')) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeDialog extends FakeNode {
  constructor() {
    super('dialog');
    this.open = false;
    this.parts = new Map();
    /** What a focus listener does when showModal() focuses the dialog. */
    this.onFocusedWhileOpening = null;
  }

  showModal() {
    if (!this.isConnected) throw new Error('InvalidStateError: not connected');
    if (this.open) throw new Error('InvalidStateError: already open');
    this.open = true;
    // Every engine focuses the dialog's first control before showModal() returns.
    this.onFocusedWhileOpening?.();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    queued.push(() => this.dispatch('close'));
  }

  /** Escape as the browser does: `cancel`, then the close. */
  pressEscape() {
    const key = (fakeDocument.activeElement ?? this).dispatch('keydown', { key: 'Escape' });
    if (key.defaultPrevented) return;
    if (this.dispatch('cancel').defaultPrevented) return;
    this.close();
  }

  /** The confirmation's parts, found by the class its markup carries. */
  querySelector(selector) {
    const name = selector.split(' ')[0].replace(/^\./, '');
    if (!String(this.innerHTML ?? '').includes(name)) return null;
    if (!this.parts.has(selector)) {
      const part = new FakeNode(selector.endsWith('input') ? 'input' : 'div');
      this.append(part);
      this.parts.set(selector, part);
    }
    return this.parts.get(selector);
  }
}

class FakeElement extends FakeNode {}

/** The document's selection as a caret: where it is, or none (no range). */
const fakeSelection = {
  anchorNode: null,
  anchorOffset: 0,
  get rangeCount() {
    return this.anchorNode === null ? 0 : 1;
  },
  collapse(node, offset = 0) {
    this.anchorNode = node;
    this.anchorOffset = offset;
  },
};

const fakeDocument = {
  activeElement: null,
  documentElement: new FakeNode('html'),
  body: new FakeNode('body'),
  createElement(tag) {
    return tag === 'dialog' ? new FakeDialog() : new FakeElement(tag);
  },
  createComment() {
    return new FakeNode('#comment');
  },
  getSelection() {
    return fakeSelection;
  },
};
fakeDocument.documentElement.append(fakeDocument.body);
globalThis.document = fakeDocument;
globalThis.HTMLElement = FakeNode;
globalThis.HTMLDialogElement = FakeDialog;
globalThis.HTMLButtonElement = FakeNode;

const { wireAppDialog, keepAboveModals } = await import('../assets/js/app/ui/components/app-dialog.js');
const { showConfirmDialog } = await import('../assets/js/app/ui/components/confirm-dialog.js');

function connectedDialog() {
  const dialog = new FakeDialog();
  fakeDocument.body.append(dialog);
  return dialog;
}

function opener(name) {
  const button = new FakeNode('button');
  button.name = name;
  fakeDocument.body.append(button);
  button.focus();
  return button;
}

test('close() hands focus back to the opener at once; a native close settles the same way, once', () => {
  const dialog = connectedDialog();
  let closes = 0;
  const owner = wireAppDialog(dialog, { onClose: () => { closes += 1; } });
  const button = opener('a');
  const inside = new FakeNode('button');
  dialog.append(inside);

  owner.open(null, { focus: inside });
  assert.equal(dialog.open, true);
  assert.equal(fakeDocument.activeElement, inside, 'focus moves to what open() names');
  owner.close();
  assert.equal(fakeDocument.activeElement, button, 'focus is back before close() returns');
  assert.equal(closes, 1);
  runQueuedTasks();
  assert.equal(closes, 1, 'the native close event that follows settles nothing twice');

  owner.open(button);
  dialog.pressEscape();
  assert.equal(closes, 1, 'Escape closes on the native close event, a task later');
  runQueuedTasks();
  assert.equal(closes, 2);
  assert.equal(fakeDocument.activeElement, button);

  // A focus listener closes the dialog while showModal() focuses it.
  dialog.onFocusedWhileOpening = () => owner.close();
  owner.open(button, { focus: inside });
  dialog.onFocusedWhileOpening = null;
  assert.equal(dialog.open, false);
  assert.equal(closes, 3, 'a close while the dialog opens settles before open() returns');
  assert.equal(fakeDocument.activeElement, button, 'focus stays with the opener, not in the closed dialog');
  runQueuedTasks();
  assert.equal(closes, 3);
  owner.open(button);
  assert.equal(dialog.open, true, 'the dialog opens again');
  owner.close();
  assert.equal(closes, 4);

  // A dialog showModal() refuses (not in the page) was never open: nothing to settle.
  const loose = new FakeDialog();
  let looseCloses = 0;
  const looseOwner = wireAppDialog(loose, { onClose: () => { looseCloses += 1; } });
  assert.throws(() => looseOwner.open(button), /not connected/);
  looseOwner.close();
  assert.equal(looseCloses, 0);
});

test('a close that settles a task later leaves focus where the person moved it meanwhile', () => {
  const dialog = connectedDialog();
  const owner = wireAppDialog(dialog);
  const button = opener('rename');
  const inside = new FakeNode('button');
  dialog.append(inside);
  owner.open(null, { focus: inside });
  dialog.pressEscape();
  // Before the native close event: another control is focused (a row clicked, a key's move).
  const row = opener('step row');
  assert.equal(fakeDocument.activeElement, row);
  runQueuedTasks();
  assert.equal(fakeDocument.activeElement, row, 'the row keeps its focus; the opener does not take it back');
  // Nothing moved on: focus goes back to the opener, from the dialog or the body.
  owner.open(button, { focus: inside });
  dialog.pressEscape();
  runQueuedTasks();
  assert.equal(fakeDocument.activeElement, button);
  owner.open(button, { focus: inside });
  dialog.pressEscape();
  fakeDocument.activeElement = fakeDocument.body;
  runQueuedTasks();
  assert.equal(fakeDocument.activeElement, button, 'focus lost with the dialog goes back');
});

test('a caret left in the page behind moves to the dialog\'s start on open, where Tab coming back from the browser starts; one inside stays', () => {
  const dialog = connectedDialog();
  const owner = wireAppDialog(dialog);
  const inside = new FakeNode('button');
  const text = new FakeNode('p');
  dialog.append(inside, text);
  const behind = opener('renamed page tab');
  fakeSelection.collapse(behind, 2);
  owner.open(behind, { focus: inside });
  assert.deepEqual([fakeSelection.anchorNode, fakeSelection.anchorOffset], [dialog, 0]);
  owner.close();
  fakeSelection.collapse(text, 1);
  owner.open(behind, { focus: inside });
  assert.deepEqual([fakeSelection.anchorNode, fakeSelection.anchorOffset], [text, 1], 'a selection inside the dialog is the person\'s own');
  owner.close();
  fakeSelection.anchorNode = null;
  owner.open(behind, { focus: inside });
  assert.equal(fakeSelection.rangeCount, 0, 'no selection: none is made');
  owner.close();
});

test('a close event queued before the dialog opened again does not settle the new opening', () => {
  const dialog = connectedDialog();
  let closes = 0;
  const owner = wireAppDialog(dialog, { onClose: () => { closes += 1; } });
  owner.open(opener('b'));
  owner.close();
  owner.open(opener('c'));
  runQueuedTasks();
  assert.equal(dialog.open, true);
  assert.equal(closes, 1);
  owner.close();
  assert.equal(closes, 2);

  // Closed by Escape and opened again before its close event: the first
  // opening settles (its `onClose`) as the second begins.
  const first = opener('d');
  const inside = new FakeNode('button');
  dialog.append(inside);
  owner.open(first, { focus: inside });
  dialog.pressEscape();
  const second = opener('e');
  fakeDocument.activeElement = inside;
  owner.open(second, { focus: inside });
  assert.equal(closes, 3, 'the opening Escape closed has settled');
  runQueuedTasks();
  assert.equal(closes, 3);
  owner.close();
  assert.equal(closes, 4, 'the second opening settles on its own close');
  assert.equal(fakeDocument.activeElement, second);
});

test('focus goes back to what a function names at close time, never to the body or a disabled control', () => {
  const dialog = connectedDialog();
  const owner = wireAppDialog(dialog);
  const gone = opener('gone');
  const fallback = opener('fallback');
  owner.open(() => (gone.isConnected ? gone : fallback));
  gone.remove();
  fakeDocument.activeElement = null;
  owner.close();
  assert.equal(fakeDocument.activeElement, fallback);

  const disabled = opener('disabled');
  disabled.disabled = true;
  owner.open(disabled);
  fakeDocument.activeElement = null;
  owner.close();
  assert.equal(fakeDocument.activeElement, null);
});

test('the backdrop closes only on a press that began there; the close button closes', () => {
  const dialog = connectedDialog();
  const card = new FakeNode();
  const closeButton = new FakeNode('button');
  closeButton.setAttribute('data-dialog-close', '');
  card.append(closeButton);
  dialog.append(card);
  const owner = wireAppDialog(dialog);

  owner.open(opener('d'));
  card.dispatch('pointerdown');
  dialog.dispatch('click');
  assert.equal(dialog.open, true, 'a selection dragged out of the card is no backdrop click');
  dialog.click();
  assert.equal(dialog.open, false);

  owner.open(opener('e'));
  closeButton.click();
  assert.equal(dialog.open, false);
});

test('a dialog that is not dismissible stays open on Escape and the backdrop; close() closes it', () => {
  // The graphics reset: nothing behind it can be used meanwhile.
  const dialog = connectedDialog();
  const owner = wireAppDialog(dialog, { dismissible: false });
  owner.open(opener('g'));
  dialog.pressEscape();
  assert.equal(dialog.open, true, 'Escape');
  dialog.click();
  assert.equal(dialog.open, true, 'the backdrop');
  owner.close();
  assert.equal(dialog.open, false);
  assert.throws(() => wireAppDialog(connectedDialog(), { dismissible: 'no' }), /boolean/);
});

test('keys pressed in a dialog never reach the page behind it', () => {
  const dialog = connectedDialog();
  const owner = wireAppDialog(dialog);
  const field = new FakeNode('input');
  dialog.append(field);
  const heard = [];
  fakeDocument.body.addEventListener('keydown', event => heard.push(event.key));
  owner.open(opener('f'), { focus: field });
  field.dispatch('keydown', { key: 'w' });
  field.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(heard, []);
  owner.close();
});

test('what is kept above dialogs lives inside the topmost one and goes home after the last', () => {
  const cards = new FakeNode();
  const after = new FakeNode();
  fakeDocument.body.append(cards, after);
  const release = keepAboveModals(cards);
  const lower = connectedDialog();
  const upper = connectedDialog();
  const lowerOwner = wireAppDialog(lower);
  const upperOwner = wireAppDialog(upper);

  lowerOwner.open(opener('g'));
  assert.equal(cards.parentNode, lower);
  upperOwner.open(opener('h'));
  assert.equal(cards.parentNode, upper);
  upperOwner.close();
  assert.equal(cards.parentNode, lower);
  lowerOwner.close();
  assert.equal(cards.parentNode, fakeDocument.body);
  assert.equal(cards.nextSibling, after, 'back in its own place');
  assert.equal(release(), true);
  assert.equal(release(), false);
});

test('what is kept above dialogs goes back to its place whatever its parent gains or loses meanwhile', () => {
  // Kept while a dialog is open, as the last child of the page (the
  // notification center made under the welcome): what the page gains
  // meanwhile comes after it. Kept before a sibling that leaves while it is
  // away: it goes back between the same neighbors still there.
  for (const change of ['gains', 'loses']) {
    const asker = opener(`home-${change}`);
    const before = new FakeNode();
    const cards = new FakeNode();
    const sibling = new FakeNode();
    const later = new FakeNode();
    const dialog = connectedDialog();
    const owner = wireAppDialog(dialog);
    let release;
    if (change === 'gains') {
      owner.open(asker);
      fakeDocument.body.append(before, cards);
      release = keepAboveModals(cards);
      fakeDocument.body.append(later);
    } else {
      fakeDocument.body.append(before, cards, sibling, later);
      release = keepAboveModals(cards);
      owner.open(asker);
      sibling.remove();
    }
    assert.equal(cards.parentNode, dialog);
    owner.close();
    assert.deepEqual(
      [cards.parentNode === fakeDocument.body, before.nextSibling === cards, cards.nextSibling === later],
      [true, true, true],
      `in its place (the page ${change} a sibling)`,
    );
    assert.equal(
      fakeDocument.body.children.some(node => node.tagName === '#COMMENT'),
      false,
      'nothing is left where it lived',
    );
    release();
    for (const node of [asker, before, cards, later, dialog]) node.remove();
  }
});

test('two neighbors kept above dialogs go home in their own places, whichever goes first', () => {
  // The notification center and the agents' dock stand side by side, and
  // which is drawn over the other follows their order.
  for (const releaseFirst of [null, 'first', 'second']) {
    const before = new FakeNode();
    const first = new FakeNode();
    const second = new FakeNode();
    const after = new FakeNode();
    fakeDocument.body.append(before, first, second, after);
    const releaseOfFirst = keepAboveModals(first);
    const releaseOfSecond = keepAboveModals(second);
    const dialog = connectedDialog();
    const owner = wireAppDialog(dialog);
    owner.open(opener(`neighbors-${releaseFirst}`));
    assert.equal(first.parentNode, dialog);
    assert.equal(second.parentNode, dialog);
    // One let go while the dialog is open goes home at once, the other with the dialog.
    if (releaseFirst === 'first') releaseOfFirst();
    if (releaseFirst === 'second') releaseOfSecond();
    owner.close();
    assert.deepEqual(
      [before.nextSibling === first, first.nextSibling === second, second.nextSibling === after],
      [true, true, true],
      `in their places (let go first: ${releaseFirst})`,
    );
    if (releaseFirst !== 'first') releaseOfFirst();
    if (releaseFirst !== 'second') releaseOfSecond();
    for (const node of [before, first, second, after]) node.remove?.();
  }
});

test('the confirmation: an answer closes first, then is handed on; Escape and a newer question cancel', () => {
  const asker = opener('ask');
  const events = [];
  const cancelFirst = showConfirmDialog({
    title: 'First',
    message: 'First question',
    onConfirm: () => events.push(['confirm-1', fakeDocument.activeElement === asker]),
    onCancel: () => events.push('cancel-1'),
  });
  const first = fakeDocument.body.children.find(node => node instanceof FakeDialog && node.open);
  assert.ok(first, 'the question is an open <dialog>');
  assert.equal(first.className, 'app-dialog confirm-dialog');
  assert.equal(fakeDocument.activeElement, first.querySelector('.confirm-dialog-confirm'),
    'focus starts on the answer');

  // A newer question replaces it: the first is canceled at once and leaves.
  showConfirmDialog({
    title: 'Second',
    message: 'Second question',
    onConfirm: (note, option) => events.push(['confirm-2', note, option]),
    onCancel: () => events.push('cancel-2'),
  });
  assert.deepEqual(events, ['cancel-1']);
  assert.equal(first.isConnected, false);
  assert.equal(typeof cancelFirst, 'function');
  const second = fakeDocument.body.children.find(node => node instanceof FakeDialog && node.open);
  second.querySelector('.confirm-dialog-confirm').click();
  assert.deepEqual(events, ['cancel-1', ['confirm-2', null, false]]);
  assert.equal(second.isConnected, false);

  showConfirmDialog({
    title: 'Third',
    message: 'Third question',
    onConfirm: () => events.push('confirm-3'),
    onCancel: () => events.push('cancel-3'),
  });
  const third = fakeDocument.body.children.find(node => node instanceof FakeDialog && node.open);
  third.pressEscape();
  runQueuedTasks();
  assert.deepEqual(events.at(-1), 'cancel-3');
  assert.equal(third.isConnected, false);
  runQueuedTasks();
  assert.equal(events.filter(event => event === 'cancel-3').length, 1);
});

// ---------------------------------------------------------------------------
// The sweep: no module builds a modal any other way.
// ---------------------------------------------------------------------------

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      files.push(...await sourceFiles(absolute));
    } else if (entry.name.endsWith('.js')) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * Surfaces that state `aria-modal` without being one of these dialogs, each
 * with why. A new entry is a new modal implementation: build it on
 * `wireAppDialog` instead.
 */
const NOT_APP_DIALOGS = Object.freeze({
  // Reads them: Undo and Redo wait while a dialog or such a surface is open.
  'app/ui/modules/state/keyboard.js': 1,
  // Reads them: a key pressed in a modal window stays in it, never reaching
  // the page's shortcuts.
  'utils/key-ownership.js': 1,
});

test('every modal dialog is a <dialog> opened through wireAppDialog', async () => {
  const offenders = [];
  for (const file of await sourceFiles(JS_ROOT)) {
    const relative = path.relative(JS_ROOT, file).split(path.sep).join('/');
    const source = await readFile(file, 'utf8');
    if (relative !== 'app/ui/components/app-dialog.js' && /\.showModal\(\)/.test(source)) {
      offenders.push(`${relative}: calls showModal() itself (open through wireAppDialog)`);
    }
    const modal = source.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .filter(line => /aria-modal|ariaModal/.test(line)).length;
    if (modal !== (NOT_APP_DIALOGS[relative] ?? 0)) {
      offenders.push(`${relative}: states aria-modal ${modal} time(s) (a hand-built modal)`);
    }
  }
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  if (/aria-modal="true"/.test(html)) offenders.push('index.html: a hand-built modal (aria-modal="true")');
  if (/<script[^>]+license-modal\.js/.test(html)) offenders.push('index.html: the license script is back');
  assert.deepEqual(offenders, []);
});
