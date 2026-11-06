/**
 * A navigation of a page stops the loads the document it leaves still had
 * going, and WebKit reports each as an error of that document ("Cannot load
 * <url> due to access control checks.", "Importing a module script
 * failed."). The browser specs count a page's errors, and a spec that
 * navigated while the left document was still loading a worker's modules
 * failed on them (Linux WebKit, run 41307458156: the spatial-tree worker,
 * started when culling turned on 190 ms before the spec's `page.goto`).
 *
 * `tests/browser/helpers/leaving-document.mjs` prepares every page of every
 * test context (`helpers/test.mjs`): only those wordings, and only while a
 * navigation from a document runs, reach no listener of the page. These are
 * its rules, on a page and a context that stand in for Playwright's.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { setAsideLeavingReports } from './browser/helpers/leaving-document.mjs';

const STOPPED = 'Cannot load http://127.0.0.1:4173/assets/js/rendering/shader-quality.js due to access control checks.';
const STOPPED_FETCH = 'Fetch API cannot load http://127.0.0.1:4173/x.h5ad due to access control checks.';
const STOPPED_IMPORT = 'Importing a module script failed.';

const consoleMessage = (type, text) => ({ type: () => type, text: () => text });

/** A page whose navigations report what `during` says while they run. */
class FakePage extends EventEmitter {
  constructor(address = 'about:blank') {
    super();
    this.address = address;
    this.during = () => {};
    this.held = null;
  }

  url() { return this.address; }

  async navigate(address) {
    const held = this.held;
    await held;
    this.during(this);
    if (address instanceof Error) throw address;
    this.address = address;
    await Promise.resolve();
    return null;
  }

  goto(address) { return this.navigate(address); }
  reload() { return this.navigate(this.address); }
  goBack() { return this.navigate(this.address); }
  goForward() { return this.navigate(this.address); }
}

class FakeContext extends EventEmitter {
  constructor(pages = []) {
    super();
    this.open = pages;
  }

  pages() { return this.open; }

  newPage() {
    const page = new FakePage();
    this.open.push(page);
    this.emit('page', page);
    return page;
  }
}

function heard(page) {
  const errors = [];
  page.on('console', message => errors.push(`console.${message.type()}: ${message.text()}`));
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  return errors;
}

function reportStoppedLoads(page) {
  page.emit('console', consoleMessage('error', STOPPED));
  page.emit('console', consoleMessage('error', STOPPED_FETCH));
  page.emit('pageerror', new Error(STOPPED_IMPORT));
}

test('a navigation from a document sets aside only the stopped-load wordings, only while it runs', async () => {
  const context = new FakeContext();
  setAsideLeavingReports(context);
  const page = context.newPage();
  const errors = heard(page);
  await page.goto('http://127.0.0.1:4173/');
  errors.length = 0;

  for (const name of ['goto', 'reload', 'goBack', 'goForward']) {
    page.during = leaving => {
      reportStoppedLoads(leaving);
      leaving.emit('console', consoleMessage('error', 'TypeError: a real failure'));
      leaving.emit('console', consoleMessage('warning', STOPPED));
      leaving.emit('pageerror', new Error('Uncaught RangeError: a real failure'));
    };
    await page[name]('http://127.0.0.1:4173/?again');
    assert.deepEqual(errors, [
      'console.error: TypeError: a real failure',
      `console.warning: ${STOPPED}`,
      'page: Uncaught RangeError: a real failure',
    ], name);
    errors.length = 0;
  }

  // After the navigation returned, the same words are the page's errors.
  reportStoppedLoads(page);
  assert.deepEqual(errors, [
    `console.error: ${STOPPED}`,
    `console.error: ${STOPPED_FETCH}`,
    `page: ${STOPPED_IMPORT}`,
  ]);
});

test('a stopped read of a file through a blob is set aside by the sentence WebKit said, whatever Playwright made of its name', async () => {
  // Playwright's WebKit splits the sentence at its first colon, the one of
  // `blob:`: the name "Cannot load blob", the message without its first two
  // characters, the whole sentence on the stack's first line.
  const sentence = 'Cannot load blob:http://127.0.0.1:4173/342644d1-5742-4486-bd86-361276286fe0 due to access control checks.';
  const asPassed = () => {
    const error = new Error('ttp://127.0.0.1:4173/342644d1-5742-4486-bd86-361276286fe0 due to access control checks.');
    error.name = 'Cannot load blob';
    error.stack = `${sentence}\n    at lastUsedOf (http://127.0.0.1:4173/assets/js/data/anndata/transcode/space.js:384:94)`;
    return error;
  };
  // A real error whose stack begins with a sentence that is none of the wordings, or with none at all.
  const real = () => {
    const error = new Error('ttp://127.0.0.1:4173/x is not a function');
    error.stack = `TypeError: http://127.0.0.1:4173/x is not a function\n    at run (http://127.0.0.1:4173/a.js:1:1)`;
    return error;
  };
  const bare = () => {
    const error = new Error('a real failure');
    error.stack = undefined;
    return error;
  };
  const context = new FakeContext([new FakePage('http://127.0.0.1:4173/')]);
  setAsideLeavingReports(context);
  const [page] = context.pages();
  const errors = heard(page);
  page.during = leaving => {
    leaving.emit('pageerror', asPassed());
    leaving.emit('pageerror', real());
    leaving.emit('pageerror', bare());
  };
  await page.goto('http://127.0.0.1:4173/?later');
  assert.deepEqual(errors, ['page: ttp://127.0.0.1:4173/x is not a function', 'page: a real failure']);
  // After the navigation returned, the same report is the page's error.
  errors.length = 0;
  page.emit('pageerror', asPassed());
  assert.equal(errors.length, 1);
});

test('a first navigation, from about:blank, leaves nothing and sets nothing aside', async () => {
  const context = new FakeContext();
  setAsideLeavingReports(context);
  const page = context.newPage();
  const errors = heard(page);
  page.during = reportStoppedLoads;
  await page.goto('http://127.0.0.1:4173/');
  assert.equal(errors.length, 3);
});

test('a navigation that fails still ends the window', async () => {
  const context = new FakeContext([new FakePage('http://127.0.0.1:4173/')]);
  setAsideLeavingReports(context);
  const [page] = context.pages();
  const errors = heard(page);
  page.during = reportStoppedLoads;
  await assert.rejects(page.goto(new Error('net::ERR_ABORTED')), /ERR_ABORTED/);
  assert.deepEqual(errors, []);
  reportStoppedLoads(page);
  assert.equal(errors.length, 3);
});

test('overlapping navigations keep the window open until the last returns', async () => {
  const context = new FakeContext([new FakePage('http://127.0.0.1:4173/')]);
  setAsideLeavingReports(context);
  const [page] = context.pages();
  const errors = heard(page);
  let releaseFirst;
  page.held = new Promise(resolve => { releaseFirst = resolve; });
  const first = page.goto('http://127.0.0.1:4173/?one');
  page.held = null;
  await page.goto('http://127.0.0.1:4173/?two');
  // The first is still running: its document's stopped loads are set aside.
  reportStoppedLoads(page);
  assert.deepEqual(errors, []);
  releaseFirst();
  await first;
  reportStoppedLoads(page);
  assert.equal(errors.length, 3);
});

test('pages open before and after preparation are prepared once', async () => {
  const before = new FakePage('http://127.0.0.1:4173/');
  const context = new FakeContext([before]);
  setAsideLeavingReports(context);
  setAsideLeavingReports(context);
  const after = context.newPage();
  for (const page of [before, after]) {
    assert.ok(Object.hasOwn(page, 'emit'));
    for (const name of ['goto', 'reload', 'goBack', 'goForward']) assert.ok(Object.hasOwn(page, name));
  }
  const errors = heard(before);
  let reported = 0;
  before.during = leaving => { reported += 1; reportStoppedLoads(leaving); };
  await before.reload();
  assert.equal(reported, 1);
  assert.deepEqual(errors, []);
});

test('every browser context of a test is prepared, the specs\' own too', async () => {
  const fixture = await readFile(new URL('./browser/helpers/test.mjs', import.meta.url), 'utf8');
  // The test's context (ephemeral and persistent) and each `browser.newContext()`.
  assert.equal(fixture.match(/setAsideLeavingReports\((context|persistent)\);/g)?.length, 3);
  // No spec marks its navigations or filters these wordings by hand.
  const directory = new URL('./browser/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.spec.mjs')) continue;
    const spec = await readFile(new URL(name, directory), 'utf8');
    assert.equal(/from '\.\/helpers\/leaving-document\.mjs'|due to access control checks/.test(spec), false, name);
  }
});
