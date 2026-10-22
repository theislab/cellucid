/**
 * The Cite dialog says what every other surface says.
 *
 * `CITATION.cff` is the one place the citation is written. The README
 * sections, the documentation's "Citing Cellucid" page and the R package are
 * generated from it by `cellucid-private/scripts/sync_citation.py`; the Cite
 * dialog reads it at runtime through `assets/js/app/citation.js`. This file
 * holds the JavaScript reader to the generated documentation (when the
 * cellucid-python checkout is beside this one), to the placeholder rule, and
 * to the shape a published citation takes, and holds the dialog's openers to
 * the documentation link they fall back to without JavaScript.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CITING_PAGE_URL,
  PLACEHOLDER_NOTE,
  apa,
  apaParts,
  bibtex,
  parsePreferredCitation,
} from '../assets/js/app/citation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFF = await readFile(path.join(ROOT, 'CITATION.cff'), 'utf8');
const INDEX = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const DOCS_ROOT = process.env.CELLUCID_PYTHON_DOCS
  ?? path.resolve(ROOT, '..', 'cellucid-python', 'docs');
const CITING_PAGE = path.join(DOCS_ROOT, 'citing.md');

test('the repository citation is a placeholder until it has a DOI, and says so', () => {
  const citation = parsePreferredCitation(CFF);
  assert.equal(citation.placeholder, citation.doi === null);
  if (citation.placeholder) {
    assert.match(citation.title, /placeholder/i);
    assert.equal(citation.year, null);
    assert.match(apa(citation), /\(in preparation\)\.$/);
    assert.match(bibtex(citation), /^@unpublished\{cellucid,\n/);
    assert.ok(bibtex(citation).includes(PLACEHOLDER_NOTE));
  }
});

test('the dialog renders exactly the reference and BibTeX the documentation shows', async t => {
  if (!existsSync(CITING_PAGE)) {
    t.skip(`documentation not present at ${CITING_PAGE}`);
    return;
  }
  const page = await readFile(CITING_PAGE, 'utf8');
  const citation = parsePreferredCitation(CFF);
  const bib = /```bibtex\n([\s\S]*?)```/.exec(page);
  assert.ok(bib, 'the citing page carries a BibTeX block');
  assert.equal(bibtex(citation), bib[1]);
  const { before, journal, after } = apaParts(citation);
  assert.ok(
    page.includes(`${before}*${journal}*${after}`),
    'the citing page carries the same reference, journal in italics',
  );
});

test('a published citation becomes an article with its DOI', () => {
  const published = CFF.replace(
    /preferred-citation:[\s\S]*?(?=# END cellucid preferred-citation)/,
    [
      'preferred-citation:',
      '  type: article',
      '  status: preprint',
      '  title: "Cellucid: interactive single-cell atlases in the browser"',
      '  authors:',
      '    - family-names: "Inecik"',
      '      given-names: "Kemal"',
      '    - family-names: "Doe"',
      '      given-names: "Jane Ann"',
      '  journal: "bioRxiv"',
      '  doi: "10.1101/2026.01.01.123456"',
      '  year: 2026',
      '',
    ].join('\n'),
  );
  const citation = parsePreferredCitation(published);
  assert.equal(citation.placeholder, false);
  assert.equal(
    apa(citation),
    'Inecik, K., & Doe, J. A. (2026). Cellucid: interactive single-cell atlases in the browser. '
      + 'bioRxiv. https://doi.org/10.1101/2026.01.01.123456',
  );
  assert.equal(bibtex(citation), [
    '@article{cellucid,',
    '  author  = {Inecik, Kemal and Doe, Jane Ann},',
    '  title   = {{Cellucid: interactive single-cell atlases in the browser}},',
    '  journal = {bioRxiv},',
    '  year    = {2026},',
    '  doi     = {10.1101/2026.01.01.123456},',
    '  url     = {https://doi.org/10.1101/2026.01.01.123456},',
    '}',
    '',
  ].join('\n'));
});

test('the reader refuses a citation it cannot represent exactly', () => {
  const wrap = body => `# BEGIN cellucid preferred-citation\n${body}\n# END cellucid preferred-citation\n`;
  assert.throws(() => parsePreferredCitation('cff-version: 1.2.0\n'), /no preferred-citation/);
  assert.throws(() => parsePreferredCitation(wrap('preferred-citation:\n  type: article\n  publisher: "x"')), /Unsupported/);
  assert.throws(() => parsePreferredCitation(wrap(
    'preferred-citation:\n  type: article\n  title: "T"\n  journal: "J"\n  doi: "10.1101/1"\n  authors:\n    - family-names: "A"\n      given-names: "B"',
  )), /needs a year/);
});

test('every Cite opener is a real link to the citing page, and the dialog is complete', () => {
  const openers = [...INDEX.matchAll(/<a\b[^>]*\bdata-cite-open\b[^>]*>/g)].map(match => match[0]);
  assert.equal(openers.length, 1, 'the sidebar footer');
  for (const opener of openers) {
    assert.ok(opener.includes(`href="${CITING_PAGE_URL}"`), opener);
  }
  for (const id of ['cite-dialog', 'cite-placeholder', 'cite-reference', 'cite-bibtex', 'cite-copy-reference', 'cite-copy-bibtex']) {
    assert.ok(INDEX.includes(`id="${id}"`), `index.html has #${id}`);
  }
});

test('CITATION.cff ships with every copy of the app', async () => {
  const inventory = JSON.parse(await readFile(path.join(ROOT, 'cellucid-web-assets.json'), 'utf8'));
  const entry = inventory.assets.find(asset => asset.path === 'CITATION.cff');
  assert.ok(entry, 'the runtime inventory lists CITATION.cff');
  assert.equal(entry.content_type, 'application/octet-stream');
});
