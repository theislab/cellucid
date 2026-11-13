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

test('ThemeManager keeps a theme the browser refuses to store for this page, and propagates event owner failures', async () => {
  // A full or refusing store (and a browser that keeps nothing for the site,
  // `utils/web-storage.js`): the theme is chosen all the same, kept for this page.
  const storageFailure = new Error('storage write failed');
  const storageFixture = installThemeEnvironment({ setFailure: storageFailure });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    ThemeManager.setTheme('dark', { persist: true, withTransition: false });
    assert.equal(ThemeManager.getTheme(), 'dark');
    assert.equal(storageFixture.root.dataset.theme, 'dark');
    assert.equal(storageFixture.setCount, 1);
    assert.equal(storageFixture.events.length, 1);
  } finally {
    storageFixture.restore();
  }

  const blockedFixture = installThemeEnvironment();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: access is denied for this document'); },
  });
  try {
    const { ThemeManager } = await importFreshThemeManager();
    ThemeManager.init();
    ThemeManager.setTheme('dark', { persist: true, withTransition: false });
    assert.equal(blockedFixture.root.dataset.theme, 'dark');
  } finally {
    blockedFixture.restore();
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

test('theme bootstrap starts on the declared defaults over a stored value this version does not know', async () => {
  // Another version wrote it, or it was edited: no choice of the person's, so
  // the page starts as declared instead of not starting at all.
  const invalidTheme = await runBootstrap({ storedTheme: 'sepia' });
  assert.equal(invalidTheme.failure, null);
  assert.equal(invalidTheme.bootstrapFailure, undefined);
  assert.equal(invalidTheme.root.dataset.theme, 'light');

  const invalidBackground = await runBootstrap({ storedBackground: 'transparent' });
  assert.equal(invalidBackground.failure, null);
  assert.equal(invalidBackground.bootstrapFailure, undefined);
  assert.equal(invalidBackground.root.dataset.viewerBackground, 'grid');
});

test('theme bootstrap starts on the declared defaults where the browser keeps nothing for the site', async () => {
  // Site data blocked: the read of a stored value throws. Cellucid starts
  // all the same (never "Cellucid could not start").
  const failure = new Error('SecurityError: access is denied for this document');
  const result = await runBootstrap({ theme: 'dark', viewerBackground: 'black', getFailure: failure });
  assert.equal(result.failure, null);
  assert.equal(result.bootstrapFailure, undefined);
  assert.equal(result.root.dataset.theme, 'dark');
  assert.equal(result.root.dataset.viewerBackground, 'black');
});

test('HTML declares the exact theme and background defaults before bootstrap', async () => {
  const html = await readFile(INDEX_URL, 'utf8');
  assert.match(
    html,
    /<html\s+lang="en"\s+data-theme="light"\s+data-viewer-background="studio">/,
  );
});

test('the wordmark follows the theme instead of pinning a light surface', async () => {
  // The wordmark is gray-scale ink drawn for a light surface. Its two surfaces
  // (the sidebar card and the welcome header) follow the theme, not opt into
  // the light theme, which would leave a white block in the dark sidebar; the
  // dark theme inverts the artwork itself.
  const [html, css] = await Promise.all([
    readFile(INDEX_URL, 'utf8'),
    readFile(SIDEBAR_CSS_URL, 'utf8'),
  ]);
  const logos = [...html.matchAll(/<img\b[^>]*cellucid-logo\.svg[^>]*>/g)];
  assert.ok(logos.length >= 2, 'the sidebar and the welcome dialog both show it');
  for (const logo of logos) {
    const before = html.slice(0, logo.index);
    const stack = [];
    for (const match of before.matchAll(/<(\/?)div\b([^>]*)>/g)) {
      if (match[1] === '/') stack.pop();
      else stack.push(match[2]);
    }
    assert.doesNotMatch(
      stack.join(' '),
      /\bdata-theme=/,
      `no surface holding ${logo[0]} may pin a theme`,
    );
  }
  // The sidebar card and the brand card (welcome dialog, standalone pages,
  // startup failure screen) each invert their own wordmark.
  const brandCss = await readFile(new URL('../assets/css/components/_welcome.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /:root\[data-theme="dark"\] \.sidebar-logo \{\s*filter: invert\(1\) hue-rotate\(180deg\);/,
    'the dark theme inverts the sidebar wordmark',
  );
  assert.match(
    brandCss,
    /:root\[data-theme="dark"\] \.welcome-logo \{\s*filter: invert\(1\) hue-rotate\(180deg\);/,
    'the dark theme inverts the brand card wordmark',
  );
  assert.doesNotMatch(
    css,
    /\[data-theme="dark"\]\s+\.sidebar-brand/,
    'no dark-only repaint of the brand card',
  );
});
