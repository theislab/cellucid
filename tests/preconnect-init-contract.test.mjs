import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = async relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

const SCRIPT_PATH = 'assets/js/app/ui/core/preconnect-init.js';
const SCRIPT = await read(SCRIPT_PATH);
const INDEX = await read('index.html');
const NOT_FOUND = await read('404.html');
const CATALOG = 'https://theislab.github.io/cellucid-datasets/exports-v3/';

/**
 * Run the bootstrap against one page: its address, its meta element, and a
 * head that records what is appended to it.
 */
function runPage({ href, meta = CATALOG }) {
  const appended = [];
  const location = new URL(href);
  const sandbox = {
    URL,
    URLSearchParams,
    window: { location: { search: location.search, href: location.href, origin: location.origin } },
    document: {
      querySelector(selector) {
        assert.equal(selector, 'meta[name="cellucid-exports-base-url"]');
        return meta === null ? null : { getAttribute: name => (name === 'content' ? meta : null) };
      },
      createElement(tag) {
        return { tag };
      },
      head: { appendChild: node => appended.push(node) },
    },
  };
  vm.runInNewContext(SCRIPT, sandbox, { filename: SCRIPT_PATH });
  return appended;
}

test('the page preconnects to the catalog origin it will fetch from', () => {
  assert.deepEqual(runPage({ href: 'https://www.cellucid.com/' }), [
    { tag: 'link', rel: 'preconnect', href: 'https://theislab.github.io', crossOrigin: 'anonymous' },
  ]);
  assert.deepEqual(runPage({ href: 'https://www.cellucid.com/?dataset=suo&github=owner/repo' }), [
    { tag: 'link', rel: 'preconnect', href: 'https://theislab.github.io', crossOrigin: 'anonymous' },
  ]);
});

test('a page told another catalog opens no connection to the default one', () => {
  // The browser tests, `cellucid serve` and Jupyter all name a catalog on
  // their own origin; the default catalog is never fetched, so a preconnect
  // to it would be the page's only Internet traffic.
  const local = 'http://127.0.0.1:4173/?exportsBaseUrl=http%3A%2F%2F127.0.0.1%3A4173%2Ftests%2Fbrowser%2Ffixtures%2Fexports%2F&dataset=current-ui-prepared';
  assert.deepEqual(runPage({ href: local }), []);
  // Two fields are a configuration error the catalog loader reports; it
  // fetches nothing, so nothing is preconnected either.
  assert.deepEqual(runPage({ href: 'https://www.cellucid.com/?exportsBaseUrl=a&exportsBaseUrl=b' }), []);
});

test('no meta element, a same-origin catalog, or an unparsable one preconnects nothing', () => {
  assert.deepEqual(runPage({ href: 'https://www.cellucid.com/', meta: null }), []);
  assert.deepEqual(runPage({ href: 'https://lab.example.org/cellucid/', meta: 'https://lab.example.org/exports/' }), []);
  assert.deepEqual(runPage({ href: 'https://lab.example.org/cellucid/', meta: '/exports/' }), []);
  assert.deepEqual(runPage({ href: 'https://www.cellucid.com/', meta: 'http://[' }), []);
});

test('index.html loads the bootstrap from the head, after the catalog meta and before the stylesheet, and ships no static preconnect', () => {
  const head = INDEX.slice(0, INDEX.indexOf('</head>'));
  const scripts = [...head.matchAll(/<script src="assets\/js\/app\/ui\/core\/preconnect-init\.js"><\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one preconnect bootstrap');
  const script = scripts[0].index;
  const meta = head.indexOf('<meta name="cellucid-exports-base-url"');
  const stylesheet = head.indexOf('<link rel="stylesheet" href="assets/css/main.css"');
  assert.ok(meta > -1 && meta < script, 'the meta element the bootstrap reads comes first');
  assert.ok(stylesheet > script, 'the connection starts before the stylesheet is requested');
  for (const [name, text] of [['index.html', INDEX], ['404.html', NOT_FOUND]]) {
    assert.doesNotMatch(text, /rel="preconnect"/, `${name} opens no connection unconditionally`);
  }
});
