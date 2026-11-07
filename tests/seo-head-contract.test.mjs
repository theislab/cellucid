/**
 * What a search engine, a link preview or a crawler reads about
 * www.cellucid.com.
 *
 * - One canonical address. The canonical link, the Open Graph URL, the JSON-LD
 *   `url` and the sitemap's only entry are the same string, trailing slash
 *   included; a mismatch tells a crawler there are two pages competing for one.
 *   Query-string app states are not pages and are never listed. The reading
 *   pages (privacy.html, terms.html, accessibility.html, each its own
 *   canonical) are found through the footer links, the privacy link being the
 *   one Google's brand verification asks the home page for; they are not
 *   listed, because the build date would misdate them.
 * - A sitemap that cannot go stale. Its one `<lastmod>` is the date half of the
 *   build id, the day the shipped bytes last changed; the build id itself is
 *   pinned to the exact bytes by web-asset-inventory-contract, and the
 *   generator writes both. No `changefreq` or `priority`, which Google ignores.
 * - The documentation (docs.cellucid.com) has its own sitemap, advertised by
 *   its own robots.txt; www lists neither its URLs nor its sitemap.
 * - A title and description written for the searches that should find the app
 *   (interactive single-cell data visualization, UMAP, 3D, AnnData/Scanpy,
 *   Seurat), short enough to be shown whole in a result.
 * - The description, canonical, Open Graph and Twitter tags at the very start
 *   of the head. A link preview reads only a prefix of the page: Slack requests
 *   the first 32 KB with a Range header, Teams and Telegram have been seen to
 *   read less, and the import map alone is over 100 KB. Before 2026-11-07 the
 *   tags sat after it, at byte 121,167, and a 32 KB fetch of the live page held
 *   the title and nothing else.
 * - Structured data that parses, describes the app truthfully, and is the exact
 *   block the Content-Security-Policy hash allows: a WebSite node (the site name
 *   Google shows) and the WebApplication. A citation appears in it only once
 *   CITATION.cff carries the paper's DOI, and then names exactly that DOI.
 * - Crawlable text: the body is app UI, so a visually hidden <main> carries one
 *   <h1> and a description, with links to the docs, GitHub and citing that stay
 *   out of the Tab order (the plot is the first Tab stop). It, the JSON-LD and
 *   llms.txt name every format the input-format registry opens.
 * - Every crawler is let in, AI crawlers and AI assistants' fetchers included:
 *   the pages are public, and the privacy model concerns users' data, which is
 *   never on this host.
 * - A custom 404 page in the site's design, an llms.txt (llmstxt.org shape),
 *   and a /.well-known/security.txt (RFC 9116) that names SECURITY.md's contact
 *   and expires a year after the build, renewed by the generator.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderSecurityTxt } from '../scripts/generate-web-asset-inventory.mjs';
import { INPUT_FORMATS } from '../assets/js/data/input-formats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(ROOT, name), 'utf8');
const INDEX = await read('index.html');
const SITEMAP = await read('sitemap.xml');
const ROBOTS = await read('robots.txt');
const NOT_FOUND = await read('404.html');
const LLMS = await read('llms.txt');
const MANIFEST = JSON.parse(await read('site.webmanifest'));
const SECURITY_TXT = await read('.well-known/security.txt');
const READING_PAGES = ['privacy.html', 'terms.html', 'accessibility.html'];

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
const node = type => {
  const nodes = JSON_LD['@graph'].filter(entry => entry['@type'] === type);
  assert.equal(nodes.length, 1, `exactly one ${type} node`);
  return nodes[0];
};
const APP = node('WebApplication');
const WEBSITE = node('WebSite');

// The paper's DOI, once CITATION.cff's preferred-citation carries one (written
// there first, by hand, then copied everywhere by sync_citation.py).
const CITATION_CFF = await read('CITATION.cff');
const PREFERRED_CITATION = only(/# BEGIN cellucid preferred-citation\n([\s\S]*?)# END cellucid preferred-citation/g, CITATION_CFF, 'preferred-citation block');
const PAPER_DOI = /^\s+doi:\s*"?([^"\s]+)"?\s*$/m.exec(PREFERRED_CITATION)?.[1] ?? null;

// What the crawlable text calls each format the app opens: every format of the
// registry it does not refuse, so a new reader fails here until the text names it.
const FORMAT_TERMS = {
  h5ad: ['.h5ad'],
  zarr: ['Zarr', '.zarr.zip'],
  loom: ['Loom'],
  'tenx-h5': ['10x Cell Ranger', '.h5'],
  'tenx-outs': ['outs/'],
  h5mu: ['.h5mu'],
  'mudata-zarr': ['MuData Zarr'],
  rds: ['.rds', 'Seurat', 'SingleCellExperiment'],
  rda: ['.rda'],
  mtx: ['MatrixMarket'],
};

test('one canonical address everywhere', () => {
  const canonical = only(/<link rel="canonical" href="([^"]+)" \/>/g, INDEX, 'canonical link');
  assert.equal(canonical, SITE);
  assert.equal(meta('property', 'og:url'), canonical);
  assert.equal(APP.url, canonical);
  assert.equal(WEBSITE.url, canonical);
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
  // No group names a crawler, so the wildcard group is the one every crawler
  // obeys (RFC 9309 section 2.2.1): search engines, and the crawlers and
  // fetchers of AI assistants, which should read and cite the public pages.
  for (const agent of [
    'Googlebot', 'Bingbot', 'Google-Extended', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot',
    'Claude-SearchBot', 'Claude-User', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'CCBot',
    'Applebot-Extended', 'Bytespider', 'meta-externalagent', 'DuckAssistBot', 'MistralAI-User',
  ]) {
    assert.ok(!new RegExp(`^user-agent:\\s*${agent}\\s*$`, 'im').test(ROBOTS), `${agent} has no group of its own`);
  }
  assert.doesNotMatch(ROBOTS, /^Disallow:\s*\S/m);
});

test('a link preview finds the description, canonical, Open Graph and Twitter tags in the first 16 KiB', async () => {
  const tags = [...INDEX.matchAll(/<meta (?:name|property)="(?:description|og:[^"]+|twitter:[^"]+)" content="[^"]*" \/>|<link rel="canonical" href="[^"]+" \/>/g)];
  assert.ok(tags.length >= 18, `${tags.length} tags`);
  for (const match of tags) {
    const end = Buffer.byteLength(INDEX.slice(0, match.index + match[0].length), 'utf8');
    assert.ok(end <= 16 * 1024, `${match[0].slice(0, 60)}... ends at byte ${end}`);
  }
  // All of them precede the import map, whatever its size.
  assert.ok(tags.at(-1).index < INDEX.indexOf('<script type="importmap">'));
  for (const name of [...READING_PAGES, '404.html']) {
    const page = await read(name);
    const end = Buffer.byteLength(page.slice(0, page.indexOf('<meta name="description"')), 'utf8');
    assert.ok(end > 0 && end < 16 * 1024, `${name}'s description is near the top`);
  }
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

test('the structured data describes the site and the web app truthfully', () => {
  assert.equal(JSON_LD['@context'], 'https://schema.org');
  assert.deepEqual(JSON_LD['@graph'].map(entry => entry['@type']).sort(), ['WebApplication', 'WebSite']);
  // The site name Google shows beside a result comes from the home page's
  // WebSite node (developers.google.com/search/docs/appearance/site-names).
  assert.equal(WEBSITE.name, 'Cellucid');
  assert.equal(WEBSITE['@id'], `${SITE}#website`);
  assert.deepEqual(APP.isPartOf, { '@id': WEBSITE['@id'] });
  assert.equal(APP.name, 'Cellucid');
  assert.equal(APP.operatingSystem, 'Web browser');
  assert.ok(APP.applicationCategory);
  assert.deepEqual(APP.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD' });
  assert.equal(APP.isAccessibleForFree, true);
  assert.equal(APP.license, 'https://opensource.org/licenses/BSD-3-Clause');
  assert.equal(APP.softwareHelp.url, DOCS);
  for (const url of [GITHUB, DOCS, 'https://pypi.org/project/cellucid/', 'https://github.com/theislab/cellucid-r']) {
    assert.ok(APP.sameAs.includes(url), `sameAs names ${url}`);
  }
  // A sameAs must resolve: CRAN joins it once the package is on CRAN. No
  // rating or review is declared: there is none to declare.
  for (const key of ['aggregateRating', 'review']) assert.equal(key in APP, false, key);
  // The version is the release the web app shares with the Python and R
  // packages, declared once in the head.
  const version = only(/<meta name="cellucid-version" content="([^"]+)" \/> <!-- CELLUCID_VERSION -->/g, INDEX, 'version meta');
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(APP.softwareVersion, version);
});

test('a citation appears in the structured data and llms.txt only with the paper\'s DOI from CITATION.cff', () => {
  // The slot for the paper: empty while CITATION.cff has no `doi:` (no DOI may
  // be invented). Once it has one, this fails until the WebApplication carries
  // "citation": {"@type": "ScholarlyArticle", "@id": "https://doi.org/<doi>",
  // "url": "https://doi.org/<doi>", "name": "<title>"} and llms.txt links it.
  if (PAPER_DOI === null) {
    assert.equal('citation' in APP, false);
    assert.doesNotMatch(JSON_LD_TEXT + LLMS, /doi\.org/);
    return;
  }
  const doiUrl = `https://doi.org/${PAPER_DOI}`;
  assert.equal(APP.citation['@type'], 'ScholarlyArticle');
  assert.equal(APP.citation['@id'], doiUrl);
  assert.ok(LLMS.includes(doiUrl), 'llms.txt links the paper');
});

test('the Content-Security-Policy allows exactly the import map, the boot script, the JSON-LD block and the style gate', () => {
  const policy = only(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)" \/>/g, INDEX, 'CSP');
  const hashes = [...policy.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map(match => match[1]);
  const importMap = only(/^[ \t]*<script type="importmap">([\s\S]*?)<\/script>/gm, INDEX, 'import map');
  const boot = only(/^[ \t]*<script id="cellucid-page-boot">([\s\S]*?)<\/script>/gm, INDEX, 'boot script');
  const styleGate = only(/^[ \t]*<script id="cellucid-style-gate">([\s\S]*?)<\/script>/gm, INDEX, 'style gate');
  const expected = [importMap, boot, JSON_LD_TEXT, styleGate].map(text => createHash('sha256').update(text, 'utf8').digest('base64'));
  assert.deepEqual(
    hashes,
    expected,
    'regenerate the script-src hashes with `node scripts/generate-web-asset-inventory.mjs`'
  );
});

test('the Content-Security-Policy adds only Google Analytics, sign-in and its file picker to scripts, by exact path, and frames', () => {
  const policy = only(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)" \/>/g, INDEX, 'CSP');
  const directive = name => only(new RegExp(`\\b${name} ([^;]+);`, 'g'), policy, name).trim().split(/\s+/);
  // By path, never a whole host: a Google host also serves scripts anyone
  // can publish there (Tag Manager containers, JSONP endpoints).
  assert.deepEqual(
    directive('script-src').filter(source => !source.startsWith("'sha256-")),
    [
      "'self'",
      // The WebAssembly decoders compile (assets/wasm/codecs.wasm); no JavaScript is evaluated.
      "'wasm-unsafe-eval'",
      'https://www.googletagmanager.com/gtag/',
      'https://accounts.google.com/gsi/',
      'https://apis.google.com/js/api.js',
      'https://apis.google.com/_/scs/',
    ]
  );
  // Every script the app loads from Google is one those paths allow.
  const google = readFileSync(new URL('../assets/js/data/sources/auth/google.js', import.meta.url), 'utf8');
  const gaInit = readFileSync(new URL('../assets/js/app/ui/core/ga-init.js', import.meta.url), 'utf8');
  const loaded = [
    ...[...google.matchAll(/_SCRIPT_URL = '([^']+)'/g)].map(match => match[1]),
    /`(https:\/\/www\.googletagmanager\.com\/gtag\/js)\?id=/.exec(gaInit.replace(/\s+/g, ''))?.[1],
  ];
  assert.equal(loaded.length, 3);
  for (const url of loaded) {
    assert.ok(
      directive('script-src').some(source => (source.endsWith('/') ? url.startsWith(source) : url === source)),
      `${url} is allowed by the policy`
    );
  }
  assert.deepEqual(directive('form-action'), ["'none'"]);
  assert.deepEqual(directive('object-src'), ["'none'"]);
  assert.deepEqual(directive('base-uri'), ["'none'"]);
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
  const text = main.replace(/<[^>]+>/g, '');
  const features = APP.featureList.join('\n');
  for (const [id, terms] of Object.entries(FORMAT_TERMS)) {
    for (const term of terms) {
      assert.ok(text.includes(term), `the about region names ${term} (${id})`);
      assert.ok(LLMS.includes(term), `llms.txt names ${term} (${id})`);
      assert.ok(features.includes(term), `the JSON-LD feature list names ${term} (${id})`);
    }
  }
  assert.deepEqual(
    Object.keys(FORMAT_TERMS).sort(),
    INPUT_FORMATS.filter(format => !format.refusal).map(format => format.id).sort(),
    'every format the app opens, and only those, is named'
  );
  const links = [...main.matchAll(/<a href="([^"]+)"([^>]*)>/g)];
  assert.deepEqual(links.map(match => match[1]).sort(), [CITING, DOCS, GITHUB].sort());
  for (const [, href, rest] of links) assert.match(rest, /tabindex="-1"/, `${href} stays out of the Tab order`);
  // The visible app links to the documentation too: the welcome card and footer.
  assert.match(INDEX, new RegExp(`<a href="${DOCS}" target="_blank" rel="noopener noreferrer" class="welcome-btn welcome-btn-link">`));
  assert.match(INDEX, new RegExp(`<a href="${DOCS}" target="_blank" rel="noopener noreferrer">Docs</a>`));
});

test('the home page links its privacy policy, terms and accessibility statement', async () => {
  // Quiet footer links: Privacy (which Google's brand verification asks the
  // home page for) and Terms beside Docs, Cite and GitHub, Accessibility beside
  // the licence, Contact (the project's address) beside who made it; a new tab
  // keeps the app's state. Each line fits the narrowest sidebar (260px).
  const footer = only(/<div id="copyright">([\s\S]*?)<\/div>/g, INDEX, 'footer');
  assert.match(footer, /GitHub<\/a> · <a href="privacy\.html" target="_blank" rel="noopener">Privacy<\/a> · <a href="terms\.html" target="_blank" rel="noopener">Terms<\/a><\/p>/);
  assert.match(footer, /Theis Lab<\/a> · <a href="mailto:hello@cellucid\.com">Contact<\/a><\/p>/);
  assert.match(footer, /<p><a href="#" id="license-link">BSD 3-Clause license<\/a> · <a href="accessibility\.html" target="_blank" rel="noopener">Accessibility<\/a><\/p>/);
  for (const name of READING_PAGES) {
    const page = await read(name);
    assert.ok(page.includes(`<link rel="canonical" href="${SITE}${name}" />`), `${name} is its own canonical`);
    assert.doesNotMatch(page, /<meta name="robots"/, `${name} is indexable`);
    assert.ok(!SITEMAP.includes(name), `${name} is not in the sitemap`);
  }
});

test('security.txt names the security policy\'s contact and expires a year after the build', async () => {
  const contact = /`([^`@\s]+@[^`\s]+)`/.exec(await read('SECURITY.md'))?.[1];
  const fields = SECURITY_TXT.split('\n').filter(line => line && !line.startsWith('#'))
    .map(line => line.split(/: (.*)/s).slice(0, 2));
  assert.deepEqual(fields.map(([name]) => name), ['Contact', 'Expires', 'Policy', 'Preferred-Languages', 'Canonical']);
  const field = Object.fromEntries(fields);
  assert.equal(field.Contact, `mailto:${contact}`);
  assert.equal(field.Policy, 'https://github.com/theislab/cellucid/security/policy');
  assert.equal(field.Canonical, `${SITE}.well-known/security.txt`);
  // Written by the generator from the build id, as the sitemap's date is.
  const buildId = only(/<meta name="cellucid-web-build-id" content="([^"]+)" \/>/g, INDEX, 'build id');
  assert.equal(SECURITY_TXT, renderSecurityTxt(buildId).toString('utf8'), 'regenerate with `node scripts/generate-web-asset-inventory.mjs`');
  // RFC 9116: an ISO 8601 UTC time, less than a year after it was written.
  assert.match(field.Expires, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  for (const [built, expires] of [['2026-10-24', '2027-10-24'], ['2027-03-01', '2028-02-29'], ['2028-02-29', '2029-02-28']]) {
    assert.match(renderSecurityTxt(`${built}.0123abcd`).toString('utf8'), new RegExp(`^Expires: ${expires}T00:00:00Z$`, 'm'));
  }
  // GitHub Pages serves dot-directories only with Jekyll off.
  await stat(path.join(ROOT, '.nojekyll'));
});

test('no link names the retired documentation host', async () => {
  for (const [name, text] of [['index.html', INDEX], ['404.html', NOT_FOUND], ['llms.txt', LLMS]]) {
    assert.doesNotMatch(text, /readthedocs\.io/, name);
  }
  for (const name of READING_PAGES) {
    assert.doesNotMatch(await read(name), /readthedocs\.io/, name);
  }
});

test('the 404 page is the site design, links home, to the docs, GitHub and citing, and is not indexed', async () => {
  assert.match(NOT_FOUND, /<meta name="robots" content="noindex" \/>/);
  assert.match(NOT_FOUND, /<h1 id="not-found-title" class="welcome-title">Page not found<\/h1>/);
  // The standalone pages' stylesheet, the app's theme bootstrap and the brand
  // card, nothing else.
  assert.match(NOT_FOUND, /<html lang="en" data-theme="light" data-viewer-background="studio">/);
  assert.match(NOT_FOUND, /<link rel="stylesheet" href="\/assets\/css\/page\.css\?v=[0-9a-f]{12}" \/>/);
  const scripts = [...NOT_FOUND.matchAll(/<script\b([^>]*)>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^ src="\/assets\/js\/app\/ui\/core\/theme-init\.js\?v=[0-9a-f]{12}"$/);
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
    // A script's `?v=` names its bytes; the file is the path before it.
    if (url !== '/') await stat(path.join(ROOT, url.slice(1).replace(/\?v=[0-9a-f]{12}$/, '')));
  }
  // It ships with the build: inventoried, so its bytes are in the build id.
  const inventory = JSON.parse(await read('cellucid-web-assets.json'));
  assert.ok(inventory.assets.some(asset => asset.path === '404.html'));
  assert.match(await read('assets/css/page.css'), /@import 'layouts\/_page\.css\?v=[0-9a-f]{12}' layer\(layouts\);/);
});

test('llms.txt has the llmstxt.org shape, introduces the project and links to pages that exist', async t => {
  // llmstxt.org: an H1 name, a blockquote summary, prose, then H2 sections of
  // `- [name](url)` lists; a section called Optional may be skipped.
  assert.match(LLMS, /^# Cellucid\n\n> [^\n]+\n\n/);
  assert.deepEqual([...LLMS.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['Documentation', 'Source code', 'Optional']);
  for (const line of LLMS.slice(LLMS.indexOf('## Documentation')).split('\n')) {
    if (!line.trim() || line.startsWith('## ')) continue;
    assert.match(line, /^- \[[^\]]+\]\(https:\/\/[^)]+\)/, line);
  }
  assert.ok(LLMS.includes(`(${DOCS})`));
  assert.ok(LLMS.includes(`(${CITING})`));
  assert.ok(LLMS.includes(SITE));
  // Each documentation link is a page the docs build makes from a source file
  // in cellucid-python/docs (beside this checkout, or CELLUCID_PYTHON_ROOT).
  const docsRoot = path.join(process.env.CELLUCID_PYTHON_ROOT ?? path.resolve(ROOT, '..', 'cellucid-python'), 'docs');
  try {
    await stat(path.join(docsRoot, 'conf.py'));
  } catch {
    t.skip(`no cellucid-python docs at ${docsRoot}`);
    return;
  }
  const pages = [...LLMS.matchAll(/\((https:\/\/docs\.cellucid\.com\/en\/latest\/(?:[^)]*\.html)?)\)/g)].map(match => match[1]);
  assert.ok(pages.length >= 10);
  // The docs' own llms.txt and llms-full.txt are written by sphinx-llms-txt.
  for (const name of ['llms.txt', 'llms-full.txt']) {
    assert.ok(LLMS.includes(`(${DOCS}${name})`), `links the docs' ${name}`);
  }
  assert.match(await readFile(path.join(docsRoot, 'conf.py'), 'utf8'), /"sphinx_llms_txt",/, 'the docs build writes llms.txt');
  for (const url of pages) {
    const page = url.slice(DOCS.length).replace(/\.html$/, '') || 'index';
    const sources = await Promise.all(['.md', '.ipynb', '.rst'].map(suffix => stat(path.join(docsRoot, page + suffix)).then(() => true, () => false)));
    assert.ok(sources.includes(true), `${url} has a source page in cellucid-python/docs`);
  }
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
