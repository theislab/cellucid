import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { SessionSerializer } from '../assets/js/app/session/session-serializer.js';

class FakeControl {
  constructor({
    id,
    tagName = 'INPUT',
    type = '',
    value = '',
    checked = false,
    options = [],
    open = false,
    summary = '',
    skipped = false,
  }) {
    this.id = id;
    this.tagName = tagName;
    this.type = type;
    this.value = value;
    this.checked = checked;
    this.options = options.map(optionValue => ({ value: optionValue }));
    this.open = open;
    this.summary = summary;
    this.skipped = skipped;
    this.events = [];
    this.dispatchFailure = null;
  }

  closest(selector) {
    return selector === '[data-state-serializer-skip]' && this.skipped ? this : null;
  }

  querySelector(selector) {
    if (selector !== 'summary' || this.tagName !== 'DETAILS') return null;
    return { textContent: this.summary };
  }

  dispatchEvent(event) {
    if (this.dispatchFailure) throw this.dispatchFailure;
    this.events.push(event.type);
    return true;
  }
}

class FakeRoot {
  constructor(controls) {
    this.controls = controls;
  }

  querySelectorAll(selector) {
    if (selector === 'input[id]') {
      return this.controls.filter(control => control.tagName === 'INPUT' && control.id);
    }
    if (selector === 'select[id]') {
      return this.controls.filter(control => control.tagName === 'SELECT' && control.id);
    }
    if (selector === 'details.accordion-section') {
      return this.controls.filter(control => control.tagName === 'DETAILS');
    }
    return [];
  }
}

function installDocument(controls) {
  const previousDocument = globalThis.document;
  const previousEvent = globalThis.Event;
  const sidebar = new FakeRoot(controls);
  const byId = new Map(controls.filter(control => control.id).map(control => [control.id, control]));
  globalThis.document = {
    getElementById(id) {
      if (id === 'floating-panels-root') return null;
      return byId.get(id) ?? null;
    },
  };
  globalThis.Event = class {
    constructor(type) {
      this.type = type;
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

test('UI restore rejects an unavailable select option before mutating any control or scheduling work', () => {
  const enabled = new FakeControl({ id: 'enabled', type: 'checkbox', checked: false });
  const mode = new FakeControl({
    id: 'mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'],
  });
  const fixture = installDocument([enabled, mode]);
  const previousSetTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = () => {
    scheduled += 1;
    return 1;
  };

  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        enabled: { type: 'checkbox', checked: true },
        mode: { type: 'select', value: 'removed-mode' },
      }),
      /option.*removed-mode.*mode/i,
    );
    assert.equal(enabled.checked, false);
    assert.deepEqual(enabled.events, []);
    assert.equal(scheduled, 0);
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    fixture.restore();
  }
});

test('UI restore rejects missing controls instead of warning and continuing', () => {
  const fixture = installDocument([]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        removed: { type: 'text', value: 'stale' },
      }),
      /control.*removed.*current interface/i,
    );
  } finally {
    fixture.restore();
  }
});

test('UI restore rejects coercive and open control records', () => {
  const enabled = new FakeControl({ id: 'enabled', type: 'checkbox', checked: false });
  const fixture = installDocument([enabled]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        enabled: { type: 'checkbox', checked: 'false' },
      }),
      /checked.*boolean/i,
    );
    assert.throws(
      () => serializer.restoreUIControls({
        enabled: { type: 'checkbox', checked: false, legacyValue: 0 },
      }),
      /exact keys/i,
    );
    assert.equal(enabled.checked, false);
  } finally {
    fixture.restore();
  }
});

test('UI restore propagates a control event failure', () => {
  const enabled = new FakeControl({ id: 'enabled', type: 'checkbox', checked: false });
  const failure = new Error('consumer failed');
  enabled.dispatchFailure = failure;
  const fixture = installDocument([enabled]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        enabled: { type: 'checkbox', checked: true },
      }),
      error => error === failure,
    );
  } finally {
    fixture.restore();
  }
});

test('UI capture omits controls owned by exact domain restorers', () => {
  const navigation = new FakeControl({
    id: 'navigation-mode',
    tagName: 'SELECT',
    value: 'planar',
    options: ['planar', 'orbit', 'free'],
  });
  const theme = new FakeControl({
    id: 'theme-select',
    tagName: 'SELECT',
    value: 'light',
    options: ['light', 'dark'],
  });
  const pointerLock = new FakeControl({
    id: 'pointer-lock',
    type: 'checkbox',
    checked: true,
  });
  const fixture = installDocument([navigation, pointerLock, theme]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.deepEqual(serializer.collectUIControls(), {
      'theme-select': { type: 'select', value: 'light' },
    });
  } finally {
    fixture.restore();
  }
});

test('UI capture requires a stable id for every serialized accordion', () => {
  const details = new FakeControl({
    id: '',
    tagName: 'DETAILS',
    summary: 'Localized title',
    open: true,
  });
  const fixture = installDocument([details]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.collectUIControls(),
      /accordion.*stable.*id/i,
    );
  } finally {
    fixture.restore();
  }
});

test('UI restore requires the complete current control inventory', () => {
  const enabled = new FakeControl({ id: 'enabled', type: 'checkbox', checked: false });
  const mode = new FakeControl({
    id: 'mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'],
  });
  const fixture = installDocument([enabled, mode]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        enabled: { type: 'checkbox', checked: true },
      }),
      /missing current control.*mode/i,
    );
    assert.equal(enabled.checked, false);
  } finally {
    fixture.restore();
  }
});

test('UI restore applies one complete exact record synchronously', () => {
  const enabled = new FakeControl({ id: 'enabled', type: 'checkbox', checked: false });
  const mode = new FakeControl({
    id: 'mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'],
  });
  const details = new FakeControl({
    id: 'visualization-section',
    tagName: 'DETAILS',
    summary: 'Visualization',
    open: true,
  });
  const fixture = installDocument([enabled, mode, details]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    serializer.restoreUIControls({
      enabled: { type: 'checkbox', checked: true },
      mode: { type: 'select', value: 'smoke' },
      'accordion:visualization-section': { type: 'details', open: false },
    });
    assert.equal(enabled.checked, true);
    assert.equal(mode.value, 'smoke');
    assert.equal(details.open, false);
    assert.deepEqual(enabled.events, ['change']);
    assert.deepEqual(mode.events, ['change']);
  } finally {
    fixture.restore();
  }
});

test('UI restore validates the complete record before deferring exact controls', () => {
  const enabled = new FakeControl({
    id: 'enabled',
    type: 'checkbox',
    checked: false,
  });
  const mode = new FakeControl({
    id: 'mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'],
  });
  const fixture = installDocument([enabled, mode]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    const controls = {
      enabled: { type: 'checkbox', checked: true },
      mode: { type: 'select', value: 'smoke' },
    };
    serializer.validateUIControls(controls);
    assert.equal(enabled.checked, false);
    assert.equal(mode.value, 'points');

    const restoreDeferred = serializer.restoreUIControls(controls, {
      deferControlIds: ['mode'],
    });
    assert.equal(enabled.checked, true);
    assert.equal(mode.value, 'points');
    assert.deepEqual(mode.events, []);

    controls.mode.value = 'points';
    restoreDeferred();
    assert.equal(mode.value, 'smoke');
    assert.deepEqual(mode.events, ['change']);
  } finally {
    fixture.restore();
  }
});

test('UI restore rejects a consumer that silently reverts an exact value', () => {
  const mode = new FakeControl({
    id: 'mode',
    tagName: 'SELECT',
    value: 'points',
    options: ['points', 'smoke'],
  });
  mode.dispatchEvent = (event) => {
    mode.events.push(event.type);
    mode.value = 'points';
    return true;
  };
  const fixture = installDocument([mode]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    assert.throws(
      () => serializer.restoreUIControls({
        mode: { type: 'select', value: 'smoke' },
      }),
      /mode.*rejected restored value.*smoke/i,
    );
    assert.equal(mode.value, 'points');
    assert.deepEqual(mode.events, ['change']);
  } finally {
    fixture.restore();
  }
});

test('UI restore preserves an exact empty select when the current feature has no choices', () => {
  const unavailableField = new FakeControl({
    id: 'velocity-field',
    tagName: 'SELECT',
    value: '',
    options: [],
  });
  const fixture = installDocument([unavailableField]);
  try {
    const serializer = createUiControlSerializer({ sidebar: fixture.sidebar });
    serializer.restoreUIControls({
      'velocity-field': { type: 'select', value: '' },
    });
    assert.equal(unavailableField.value, '');
    assert.deepEqual(unavailableField.events, []);
  } finally {
    fixture.restore();
  }
});

function installFilePicker({ outcome, selectedFile = null }) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const listeners = new Map();
  let appended = 0;
  let removed = 0;
  let fileSystemPickerCalls = 0;
  let focusListenerCalls = 0;

  const input = {
    type: '',
    accept: '',
    style: {},
    files: selectedFile === null ? [] : [selectedFile],
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    remove() {
      removed += 1;
    },
    click() {
      if (outcome === 'change') {
        listeners.get('change')?.({ target: input });
      } else {
        listeners.get('cancel')?.();
      }
    },
  };

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'input');
      return input;
    },
    body: {
      appendChild(element) {
        assert.equal(element, input);
        appended += 1;
      },
    },
  };
  globalThis.window = {
    async showOpenFilePicker() {
      fileSystemPickerCalls += 1;
      return [{
        async getFile() {
          return { name: 'alternate-api.cellucid-session' };
        },
      }];
    },
    addEventListener(type) {
      if (type === 'focus') focusListenerCalls += 1;
    },
  };

  return {
    input,
    metrics() {
      return {
        appended,
        removed,
        fileSystemPickerCalls,
        focusListenerCalls,
      };
    },
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test('session loading uses one cross-browser file-input contract even when another picker API exists', async () => {
  const selectedFile = { name: 'current.cellucid-session' };
  const fixture = installFilePicker({ outcome: 'change', selectedFile });
  try {
    const result = await SessionSerializer.prototype._pickSessionFile.call({});
    assert.equal(result, selectedFile);
    assert.equal(fixture.input.type, 'file');
    assert.equal(fixture.input.accept, '.cellucid-session,application/octet-stream');
    assert.deepEqual(fixture.metrics(), {
      appended: 1,
      removed: 1,
      fileSystemPickerCalls: 0,
      focusListenerCalls: 0,
    });
  } finally {
    fixture.restore();
  }
});

test('session file-picker cancellation terminates once without polling', async () => {
  const fixture = installFilePicker({ outcome: 'cancel' });
  try {
    const result = await SessionSerializer.prototype._pickSessionFile.call({});
    assert.equal(result, null);
    assert.deepEqual(fixture.metrics(), {
      appended: 1,
      removed: 1,
      fileSystemPickerCalls: 0,
      focusListenerCalls: 0,
    });
  } finally {
    fixture.restore();
  }
});
