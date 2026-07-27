import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const THEME_MANAGER_URL = new URL('../assets/js/utils/theme-manager.js', import.meta.url);
const THEME_BOOTSTRAP_URL = new URL('../assets/js/app/ui/core/theme-init.js', import.meta.url);
const INDEX_URL = new URL('../index.html', import.meta.url);
const SIDEBAR_CSS_URL = new URL('../assets/css/components/_sidebar.css', import.meta.url);

let importSequence = 0;

function createRoot({ theme = 'light', viewerBackground = 'grid' } = {}) {
  const classes = new Set();
  return {
    dataset: { theme, viewerBackground },
    classList: {
      add(value) {
        classes.add(value);
      },
      contains(value) {
        return classes.has(value);
      },
      remove(value) {
        classes.delete(value);
      },
    },
    classes,
  };
}

function installThemeEnvironment({
  theme = 'light',
  viewerBackground = 'grid',
  storedTheme = null,
  getFailure = null,
  setFailure = null,
  dispatchFailure = null,
  bootstrapFailure = null,
} = {}) {
  const previous = new Map();
  for (const key of [
    'document',
    'window',
    'localStorage',
    'CustomEvent',
    '__cellucidThemeBootstrapFailure',
  ]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  const root = createRoot({ theme, viewerBackground });
  const stored = new Map();
  if (storedTheme !== null) stored.set('cellucid_theme', storedTheme);
  let getCount = 0;
  let setCount = 0;
  const events = [];

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: { documentElement: root },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
    getItem(key) {
      getCount += 1;
      if (getFailure) throw getFailure;
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      setCount += 1;
      if (setFailure) throw setFailure;
      stored.set(key, value);
    },
    },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    writable: true,
    value: class {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
    dispatchEvent(event) {
      if (dispatchFailure) throw dispatchFailure;
      events.push(event);
      return true;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    },
  });
  if (bootstrapFailure === null) {
    delete globalThis.__cellucidThemeBootstrapFailure;
  } else {
    Object.defineProperty(globalThis, '__cellucidThemeBootstrapFailure', {
      configurable: true,
      writable: true,
      value: bootstrapFailure,
    });
  }

  return {
    root,
    stored,
    events,
    get getCount() {
      return getCount;
    },
    get setCount() {
      return setCount;
    },
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
    },
  };
}

async function importFreshThemeManager() {
  importSequence += 1;
  return import(`${THEME_MANAGER_URL.href}?exact-contract=${importSequence}`);
}

async function runBootstrap({
  theme = 'light',
  viewerBackground = 'grid',
  storedTheme = null,
  storedBackground = null,
  getFailure = null,
} = {}) {
  const source = await readFile(THEME_BOOTSTRAP_URL, 'utf8');
  const root = createRoot({ theme, viewerBackground });
  const body = { dataset: {} };
  let getCount = 0;
  const context = vm.createContext({
    document: { documentElement: root, body },
    globalThis: null,
    localStorage: {
      getItem(key) {
        getCount += 1;
        if (getFailure) throw getFailure;
        if (key === 'cellucid_theme') return storedTheme;
        if (key === 'cellucid_viewer_background') return storedBackground;
        throw new Error(`Unexpected storage key: ${key}`);
      },
    },
  });
  context.globalThis = context;
  let failure = null;
  try {
    new vm.Script(source, { filename: THEME_BOOTSTRAP_URL.pathname }).runInContext(context);
  } catch (error) {
    failure = error;
  }
  return {
    root,
    body,
    getCount,
    failure,
    bootstrapFailure: context.__cellucidThemeBootstrapFailure,
  };
}

test('ThemeManager rejects an unsupported theme before mutating DOM or storage', async () => {
  const fixture = installThemeEnvironment();
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    assert.throws(() => ThemeManager.setTheme('sepia'), /theme.*light.*dark/i);
    assert.equal(fixture.root.dataset.theme, 'light');
    assert.equal(fixture.setCount, 0);
  } finally {
    fixture.restore();
  }
});

test('ThemeManager rejects open and coercive options before mutation', async () => {
  const fixture = installThemeEnvironment();
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    assert.throws(
      () => ThemeManager.setTheme('dark', { persist: 'yes', withTransition: false }),
      /persist.*boolean/i,
    );
    assert.throws(
      () => ThemeManager.setTheme('dark', {
        persist: true,
        withTransition: false,
        legacyMode: true,
      }),
      /exact keys/i,
    );
    assert.equal(fixture.root.dataset.theme, 'light');
    assert.equal(fixture.setCount, 0);
  } finally {
    fixture.restore();
  }
});

test('ThemeManager propagates storage and event owner failures', async () => {
  const storageFailure = new Error('storage write failed');
  const storageFixture = installThemeEnvironment({ setFailure: storageFailure });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    assert.throws(
      () => ThemeManager.setTheme('dark', { persist: true, withTransition: false }),
      error => error === storageFailure,
    );
  } finally {
    storageFixture.restore();
  }

  const eventFailure = new Error('theme listener failed');
  const eventFixture = installThemeEnvironment({ dispatchFailure: eventFailure });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    assert.throws(
      () => ThemeManager.setTheme('dark', { persist: false, withTransition: false }),
      error => error === eventFailure,
    );
  } finally {
    eventFixture.restore();
  }
});

test('ThemeManager initialization adopts only the exact DOM-owned theme', async () => {
  const fixture = installThemeEnvironment({ theme: 'dark', storedTheme: 'light' });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    assert.equal(ThemeManager.getTheme(), 'dark');
    assert.equal(fixture.getCount, 0);
    assert.equal(fixture.setCount, 0);
  } finally {
    fixture.restore();
  }
});

test('ThemeManager requires initialization and required DOM owners', async () => {
  const fixture = installThemeEnvironment();
  try {
    const { ThemeManager } = await importFreshThemeManager();
    assert.throws(() => ThemeManager.getTheme(), /not initialized/i);
    globalThis.document.documentElement = null;
    assert.throws(() => ThemeManager.init(), /document element/i);
  } finally {
    fixture.restore();
  }
});

test('ThemeManager preserves an early bootstrap failure as the terminal owner', async () => {
  const failure = new Error('early storage failure');
  const fixture = installThemeEnvironment({ bootstrapFailure: failure });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    assert.throws(() => ThemeManager.init(), error => error === failure);
    assert.throws(() => ThemeManager.getTheme(), /not initialized/i);
  } finally {
    fixture.restore();
  }
});

test('theme bootstrap preserves declared defaults when preferences are absent', async () => {
  const result = await runBootstrap({
    theme: 'dark',
    viewerBackground: 'black',
  });
  assert.equal(result.failure, null);
  assert.equal(result.root.dataset.theme, 'dark');
  assert.equal(result.root.dataset.viewerBackground, 'black');
  assert.equal(result.body.dataset.viewerBackground, 'black');
});

test('theme bootstrap rejects invalid preferences instead of substituting defaults', async () => {
  const invalidTheme = await runBootstrap({ storedTheme: 'sepia' });
  assert.equal(invalidTheme.failure, null);
  assert.match(String(invalidTheme.bootstrapFailure), /theme.*light.*dark/i);
  assert.equal(invalidTheme.root.dataset.theme, 'light');

  const invalidBackground = await runBootstrap({ storedBackground: 'transparent' });
  assert.equal(invalidBackground.failure, null);
  assert.match(String(invalidBackground.bootstrapFailure), /background.*grid/i);
  assert.equal(invalidBackground.root.dataset.viewerBackground, 'grid');
});

test('theme bootstrap propagates storage access failure', async () => {
  const failure = new Error('storage read failed');
  const result = await runBootstrap({ getFailure: failure });
  assert.equal(result.failure, null);
  assert.equal(result.bootstrapFailure, failure);
});

test('HTML declares the exact theme and background defaults before bootstrap', async () => {
  const html = await readFile(INDEX_URL, 'utf8');
  assert.match(
    html,
    /<html\s+lang="en"\s+data-theme="light"\s+data-viewer-background="grid">/,
  );
});

test('dark theme keeps the fixed dark wordmark on a light brand card', async () => {
  const css = await readFile(SIDEBAR_CSS_URL, 'utf8');
  assert.match(
    css,
    /\[data-theme="dark"\]\s+\.sidebar-brand\s*\{\s*background:\s*var\(--white\);\s*\}/,
  );
  assert.match(
    css,
    /\[data-theme="dark"\]\s+\.sidebar-brand-link:hover\s*\{\s*background:\s*var\(--gray-100\);\s*\}/,
  );
  assert.match(
    css,
    /\[data-theme="dark"\]\s+\.sidebar-brand-link:active\s*\{\s*background:\s*var\(--gray-200\);\s*\}/,
  );
});
