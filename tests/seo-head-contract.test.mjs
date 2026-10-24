/**
 * What a search engine, a link preview or a crawler reads about
 * www.cellucid.com.
 *
 * - One canonical address. The canonical link, the Open Graph URL, the JSON-LD
 *   `url` and the sitemap's only entry are the same string, trailing slash
 *   included; a mismatch tells a crawler there are two pages competing for one.
 *   Query-string app states are not pages and are never listed. The privacy
 *   policy (privacy.html, its own canonical) is found through the footer link
 *   Google's brand verification asks the home page for; it is not listed,
 *   because the build date would misdate it.
 * - A sitemap that cannot go stale. Its one `<lastmod>` is the date half of the
 *   build id, the day the shipped bytes last changed; the build id itself is
 *   pinned to the exact bytes by web-asset-inventory-contract, and the
 *   generator writes both. No `changefreq` or `priority`, which Google ignores.
 * - The documentation (docs.cellucid.com) has its own sitemap, advertised by
 *   its own robots.txt; www lists neither its URLs nor its sitemap.
 * - A title and description written for the searches that should find the app
 *   (interactive single-cell data visualization, UMAP, 3D, AnnData/Scanpy,
 *   Seurat), short enough to be shown whole in a result.
 * - Structured data that parses, describes the app truthfully, and is the exact
 *   block the Content-Security-Policy hash allows.
 * - Crawlable text: the body is app UI, so a visually hidden <main> carries one
 *   <h1> and a description, with links to the docs, GitHub and citing that stay
 *   out of the Tab order (the plot is the first Tab stop).
 * - A custom 404 page in the site's design, and an llms.txt.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(ROOT, name), 'utf8');
const INDEX = await read('index.html');
const SITEMAP = await read('sitemap.xml');
const ROBOTS = await read('robots.txt');
const NOT_FOUND = await read('404.html');
const LLMS = await read('llms.txt');
const MANIFEST = JSON.parse(await read('site.webmanifest'));

const SITE = 'https://www.cellucid.com/';
const DOCS = 'https://docs.cellucid.com/en/latest/';
const CITING = `${DOCS}citing.html`;
const GITHUB = 'https://github.com/theislab/cellucid';

function only(pattern, text, label) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `exactly one ${label}`);
  return matches[0][1];
}

const meta = (attribute, name) => only(
  new RegExp(`<meta ${attribute}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]+)" />`, 'g'),
  INDEX,
  `${attribute}=${name}`
);

const JSON_LD_TEXT = only(/^[ \t]*<script type="application\/ld\+json">([\s\S]*?)<\/script>/gm, INDEX, 'JSON-LD block');
const JSON_LD = JSON.parse(JSON_LD_TEXT);

test('one canonical address everywhere', () => {
  const canonical = only(/<link rel="canonical" href="([^"]+)" \/>/g, INDEX, 'canonical link');
  assert.equal(canonical, SITE);
  assert.equal(meta('property', 'og:url'), canonical);
  assert.equal(JSON_LD.url, canonical);
  assert.deepEqual([...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [canonical]);
});

test('the sitemap is dated by the build and carries nothing Google ignores', () => {
  const buildId = only(/<meta name="cellucid-web-build-id" content="([^"]+)" \/>/g, INDEX, 'build id');
  assert.deepEqual(
    [...SITEMAP.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(match => match[1]),
    [buildId.slice(0, 10)],
    'regenerate with `node scripts/generate-web-asset-inventory.mjs`'
  );
  assert.match(SITEMAP, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.doesNotMatch(SITEMAP, /<(changefreq|priority)>/);
});

test('robots.txt lets every crawler in and names the sitemap of this host only', () => {
  const lines = ROBOTS.split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(lines, ['User-agent: *', 'Allow: /', `Sitemap: ${SITE}sitemap.xml`]);
});

test('title and description name what the app is, and fit a search result', () => {
  const title = only(/<title>([^<]+)<\/title>/g, INDEX, 'title');
  const description = meta('name', 'description');
  assert.match(title, /^Cellucid\b/);
  assert.match(title, /interactive single-cell data visualization/i);
  assert.ok(title.length <= 70, `title is ${title.length} characters`);
  for (const term of [/single-cell data visualization/i, /UMAP/, /3D/, /AnnData/, /Scanpy/, /Seurat/]) {
    assert.match(description, term);
  }
  assert.ok(description.length <= 160, `description is ${description.length} characters`);
  assert.equal(meta('property', 'og:title'), title);
  assert.equal(meta('name', 'twitter:title'), title);
  assert.equal(meta('property', 'og:description'), description);
  assert.equal(meta('name', 'twitter:description'), description);
});

test('the link preview image exists at the size it declares and is described', async () => {
  const image = meta('property', 'og:image');
  assert.equal(meta('name', 'twitter:image'), image);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.ok(image.startsWith(SITE));
  const bytes = await readFile(path.join(ROOT, image.slice(SITE.length)));
  assert.equal(meta('property', 'og:image:type'), 'image/jpeg');
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'a JPEG');
  // Walk the JPEG markers to the start-of-frame segment that holds the size.
  let offset = 2;
  let size = null;
  while (offset < bytes.length && size === null) {
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      size = [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  assert.deepEqual(size, [Number(meta('property', 'og:image:width')), Number(meta('property', 'og:image:height'))]);
  assert.deepEqual(size, [1200, 630]);
  const alt = meta('property', 'og:image:alt');
  assert.ok(alt.length > 20);
  assert.equal(meta('name', 'twitter:image:alt'), alt);
  assert.equal(meta('property', 'og:site_name'), 'Cellucid');
});

test('the structured data describes the web app truthfully', () => {
  assert.equal(JSON_LD['@context'], 'https://schema.org');
  assert.equal(JSON_LD['@type'], 'WebApplication');
  assert.equal(JSON_LD.name, 'Cellucid');
  assert.equal(JSON_LD.operatingSystem, 'Web browser');
  assert.ok(JSON_LD.applicationCategory);
  assert.deepEqual(JSON_LD.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD' });
  assert.equal(JSON_LD.isAccessibleForFree, true);
  assert.equal(JSON_LD.license, 'https://opensource.org/licenses/BSD-3-Clause');
  assert.equal(JSON_LD.softwareHelp.url, DOCS);
  for (const url of [GITHUB, DOCS, 'https://pypi.org/project/cellucid/', 'https://github.com/theislab/cellucid-r']) {
    assert.ok(JSON_LD.sameAs.includes(url), `sameAs names ${url}`);
  }
  // The version is the release the web app shares with the Python and R
  // packages, declared once in the head; the preprint has no DOI yet, so no
  // citation may be invented.
  const version = only(/<meta name="cellucid-version" content="([^"]+)" \/> <!-- CELLUCID_VERSION -->/g, INDEX, 'version meta');
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON_LD.softwareVersion, version);
  assert.equal('citation' in JSON_LD, false);
});

test('the Content-Security-Policy allows exactly the JSON-LD block', () => {
  const policy = only(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)" \/>/g, INDEX, 'CSP');
  const hashes = [...policy.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map(match => match[1]);
  const expected = createHash('sha256').update(JSON_LD_TEXT, 'utf8').digest('base64');
  assert.deepEqual(hashes, [expected], 'regenerate the script-src hash after editing the JSON-LD');
});

test('the Content-Security-Policy adds only Google sign-in and its file picker to scripts and frames', () => {
  const policy = only(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)" \/>/g, INDEX, 'CSP');
  const directive = name => only(new RegExp(`\\b${name} ([^;]+);`, 'g'), policy, name).trim().split(/\s+/);
  assert.deepEqual(
    directive('script-src').filter(source => !source.startsWith("'sha256-")),
    ["'self'", 'https://www.googletagmanager.com', 'https://accounts.google.com', 'https://apis.google.com']
  );
  assert.deepEqual(
    directive('frame-src'),
    ["'self'", 'https://accounts.google.com', 'https://docs.google.com', 'https://drive.google.com']
  );
});

test('crawlable text says what Cellucid is and links out without taking Tab stops', () => {
  const main = only(/<main class="sr-only" aria-label="About Cellucid">([\s\S]*?)<\/main>/g, INDEX, 'about region');
  const title = only(/<title>([^<]+)<\/title>/g, INDEX, 'title');
  assert.equal(only(/<h1>([^<]+)<\/h1>/g, main, 'h1 in the about region'), title);
  for (const term of [/interactive single-cell data visualization/i, /UMAP/, /3D/, /AnnData/, /Scanpy/, /Seurat/]) {
    assert.match(main, term);
  }
  const links = [...main.matchAll(/<a href="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(links.map(match => match[1]).sort(), [CITING, DOCS, GITHUB].sort());
  for (const [, href, rest] of links) assert.match(rest, /tabindex="-1"/, `${href} stays out of the Tab order`);
  // The visible app links to the documentation too: the welcome card and footer.
  assert.match(INDEX, new RegExp(`<a href="${DOCS}" target="_blank" rel="noopener noreferrer" class="welcome-btn welcome-btn-link">`));
  assert.match(INDEX, new RegExp(`<a href="${DOCS}" target="_blank" rel="noopener noreferrer">Docs</a>`));
});

test('the home page links its privacy policy, as Google\'s brand verification requires', async () => {
  // A quiet footer link beside Docs, Cite and GitHub; a new tab keeps the app's state.
  const footer = only(/<div id="copyright">([\s\S]*?)<\/div>/g, INDEX, 'footer');
  assert.match(footer, /GitHub<\/a> · <a href="privacy\.html" target="_blank" rel="noopener">Privacy<\/a><\/p>/);
  const privacy = await read('privacy.html');
  assert.match(privacy, /<link rel="canonical" href="https:\/\/www\.cellucid\.com\/privacy\.html" \/>/);
  assert.doesNotMatch(privacy, /<meta name="robots"/, 'the privacy policy is indexable');
});

test('no link names the retired documentation host', () => {
  for (const [name, text] of [['index.html', INDEX], ['404.html', NOT_FOUND], ['llms.txt', LLMS]]) {
    assert.doesNotMatch(text, /readthedocs\.io/, name);
  }
});

test('the 404 page is the site design, links home, to the docs, GitHub and citing, and is not indexed', async () => {
  assert.match(NOT_FOUND, /<meta name="robots" content="noindex" \/>/);
  assert.match(NOT_FOUND, /<h1 id="not-found-title" class="welcome-title">Page not found<\/h1>/);
  // The standalone pages' stylesheet, the app's theme bootstrap and the brand
  // card, nothing else.
  assert.match(NOT_FOUND, /<html lang="en" data-theme="light" data-viewer-background="studio">/);
  assert.match(NOT_FOUND, /<link rel="stylesheet" href="\/assets\/css\/page\.css" \/>/);
  assert.deepEqual(
    [...NOT_FOUND.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]),
    [' src="/assets/js/app/ui/core/theme-init.js"']
  );
  assert.match(NOT_FOUND, /class="welcome-content"/);
  assert.match(NOT_FOUND, /<a href="\/" class="welcome-btn welcome-btn-primary">/);
  assert.match(NOT_FOUND, new RegExp(`<a href="${DOCS}" class="welcome-btn welcome-btn-link">`));
  assert.match(NOT_FOUND, new RegExp(`<a href="${GITHUB}">`));
  assert.match(NOT_FOUND, new RegExp(`<a href="${CITING}">`));
  assert.doesNotMatch(NOT_FOUND, /style=/);
  const policy = only(/<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/g, NOT_FOUND, '404 CSP');
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:/);
  // GitHub Pages serves it at any depth, so every local reference is
  // root-absolute, and each one exists.
  for (const [, url] of NOT_FOUND.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https:\/\//.test(url)) continue;
    assert.match(url, /^\//, `${url} is root-absolute`);
    if (url !== '/') await stat(path.join(ROOT, url.slice(1)));
  }
  // It ships with the build: inventoried, so its bytes are in the build id.
  const inventory = JSON.parse(await read('cellucid-web-assets.json'));
  assert.ok(inventory.assets.some(asset => asset.path === '404.html'));
  assert.match(await read('assets/css/page.css'), /@import 'layouts\/_page\.css' layer\(layouts\);/);
});

test('llms.txt introduces the project and links to the documentation', () => {
  assert.match(LLMS, /^# Cellucid\n\n> /);
  assert.ok(LLMS.includes(`(${DOCS})`));
  assert.ok(LLMS.includes(`(${CITING})`));
});

test('the web app manifest names the app and its icons exist at their sizes', async () => {
  assert.equal(MANIFEST.name, 'Cellucid');
  assert.equal(MANIFEST.short_name, 'Cellucid');
  assert.match(MANIFEST.description, /single-cell data visualization/i);
  assert.equal(MANIFEST.theme_color, meta('name', 'theme-color'));
  for (const icon of MANIFEST.icons) {
    const bytes = await readFile(path.join(ROOT, icon.src));
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
  assert.ok(MANIFEST.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
});
