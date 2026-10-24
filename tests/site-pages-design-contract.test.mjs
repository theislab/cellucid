/**
 * Every screen of the site follows one design (assets/css/README.md, "Site
 * Design Principles"): the standalone pages, the startup failure screen, the
 * code-load failure screen and the <noscript> screen are the brand card
 * (components/_welcome.css) placed by layouts/_page.css, styled only through
 * the shared stylesheets, in the theme the visitor chose in the app.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(ROOT, name), 'utf8');

const PAGES = ['404.html', 'privacy.html', 'terms.html', 'accessibility.html', 'assets/auth/callback.html'];
// The reading pages: the brand card widened for text, linked from the app's
// footer and from each other.
const READING_PAGES = ['privacy.html', 'terms.html', 'accessibility.html'];

test('the design system states the site design principles', async () => {
  const readme = await read('assets/css/README.md');
  for (const phrase of [
    '## Site Design Principles',
    'components/_welcome.css',
    'folded under **Details**',
    'Never a dead end',
    'Terminal only when the app cannot run',
    'assets/css/page.css',
  ]) {
    assert.ok(readme.includes(phrase), `README must state: ${phrase}`);
  }
});

test('the standalone pages are the brand card on the shared page stylesheet', async () => {
  for (const name of PAGES) {
    const html = await read(name);
    assert.match(html, /<html lang="en" data-theme="light" data-viewer-background="studio">/, name);
    assert.match(html, /<script src="\/assets\/js\/app\/ui\/core\/theme-init\.js"><\/script>/, name);
    assert.deepEqual(
      [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]),
      ['/assets/css/page.css'],
      `${name} loads only the page stylesheet`
    );
    assert.match(html, /<body class="page">/, name);
    assert.match(html, /<main class="page-screen" aria-labelledby="([^"]+)">/, name);
    assert.match(html, /class="welcome-content(?: welcome-content-wide)?"/, name);
    assert.match(html, /<img src="\/assets\/img\/cellucid-logo\.svg" alt="Cellucid" class="welcome-logo"/, name);
    assert.equal([...html.matchAll(/<h1\b[^>]*class="welcome-title"/g)].length, 1, `${name} has one calm heading`);
    assert.doesNotMatch(html, /\sstyle=|<style\b/, `${name} has no inline style`);
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(html)?.[1];
    assert.ok(policy, `${name} declares a Content-Security-Policy`);
    assert.match(policy, /style-src 'self'/, name);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, name);
  }
});

test('the reading pages are one set: dated, one contact, linked to each other', async () => {
  // The contact is the one the security policy names (SECURITY.md).
  const contact = /`([^`@\s]+@[^`\s]+)`/.exec(await read('SECURITY.md'))?.[1];
  assert.ok(contact, 'SECURITY.md names a contact address');
  for (const name of READING_PAGES) {
    const html = await read(name);
    assert.match(html, /class="welcome-content welcome-content-wide"/, `${name} is a reading page`);
    assert.match(html, /<div class="welcome-body page-prose">/, name);
    assert.match(html, /<p class="page-meta">Last updated \d{1,2} [A-Z][a-z]+ \d{4}<\/p>/, `${name} says when it last changed`);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.cellucid\\.com/${name.replace('.', '\\.')}" />`), name);
    assert.ok(html.includes(`<a href="mailto:${contact}">${contact}</a>`), `${name} names the contact ${contact}`);
    const footLinks = /<ul class="welcome-links"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    for (const sibling of READING_PAGES.filter(other => other !== name)) {
      assert.ok(footLinks.includes(`<a href="/${sibling}">`), `${name} links ${sibling} at its foot`);
    }
    assert.ok(footLinks.includes('<a href="/">Open Cellucid</a>'), `${name} links back to the app`);
  }
});

test('the page stylesheet is a subset of the app stylesheet, never a second copy', async () => {
  const page = await read('assets/css/page.css');
  const imports = [...page.matchAll(/@import '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(imports, [
    'tokens/_index.css',
    'themes/_index.css',
    'base/_index.css',
    'components/_welcome.css',
    'layouts/_page.css',
    'layouts/_responsive.css',
  ]);
  const main = await read('assets/css/main.css');
  const components = await read('assets/css/components/_index.css');
  const layouts = await read('assets/css/layouts/_index.css');
  assert.equal(
    main.match(/^@layer [^;]+;/m)?.[0],
    page.match(/^@layer [^;]+;/m)?.[0],
    'both entry points declare the same layer order'
  );
  for (const shared of ['tokens/_index.css', 'themes/_index.css', 'base/_index.css']) {
    assert.ok(main.includes(`@import '${shared}'`), `main.css imports ${shared}`);
  }
  assert.match(components, /@import '_welcome\.css';/);
  assert.match(layouts, /@import '_page\.css';/);
  assert.match(layouts, /@import '_responsive\.css';/);
  const inventory = JSON.parse(await read('cellucid-web-assets.json'));
  for (const asset of [
    'assets/css/page.css',
    'assets/css/components/_welcome.css',
    'assets/css/layouts/_page.css',
    ...PAGES,
  ]) {
    assert.ok(inventory.assets.some(entry => entry.path === asset), `${asset} ships with the build`);
  }
});

test('the screens shown when the app cannot run are the same card, with no inline style', async () => {
  const failure = await read('assets/js/app/startup-failure.js');
  const codeLoad = await read('assets/js/app/ui/core/code-load-watch.js');
  const index = await read('index.html');
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(index)?.[1] ?? '';
  for (const [name, source] of [
    ['startup-failure.js', failure],
    ['code-load-watch.js', codeLoad],
    ['index.html <noscript>', noscript],
  ]) {
    for (const part of [
      'page-screen page-screen-fixed',
      'welcome-content',
      'welcome-header',
      'welcome-logo',
      'welcome-title',
      'welcome-intro',
      'welcome-links',
    ]) {
      assert.ok(source.includes(part), `${name} builds ${part}`);
    }
    assert.doesNotMatch(source, /\.style\.|\sstyle=/, `${name} writes no inline style`);
  }
  for (const [name, source] of [['startup-failure.js', failure], ['code-load-watch.js', codeLoad]]) {
    assert.ok(source.includes("'welcome-details'"), `${name} folds the technical detail under Details`);
    assert.ok(source.includes("'Try again'"), `${name} offers to try again`);
    assert.ok(source.includes('sibling.inert = true'), `${name} takes the app it replaces out of reach`);
  }
});
