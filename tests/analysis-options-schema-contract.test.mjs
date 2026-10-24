/**
 * Every analysis declares its options once (`analysis/options/*`), and the
 * form, the session and the documentation all read that one declaration:
 *
 * - every option has a default, a sentence-case label and an (i) tip that
 *   exists in the tip registry; every "More options" group names a tip that
 *   exists too;
 * - a record holds exactly the schema's keys: an unknown or missing key is
 *   refused, never ignored, and the defaults are a valid record;
 * - every default can be stated in words for the docs (`describeDefault`),
 *   never as a raw internal value;
 * - the documentation's defaults table, between `<!-- options:<id> -->` and
 *   `<!-- /options:<id> -->` in the web app analysis pages, lists every
 *   option's label and default in form order, exactly as the schema states
 *   them (checked when the cellucid-python docs tree is present, as
 *   `info-tips-contract.test.mjs` checks the tip links).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { INFO_TIPS } from '../assets/js/app/ui/components/info-tips.js';
import { isSentenceCase } from '../assets/js/app/analysis/options/option-schema.js';
import { MARKER_OPTIONS } from '../assets/js/app/analysis/options/marker-options.js';
import { DE_OPTIONS } from '../assets/js/app/analysis/options/de-options.js';
import { SIGNATURE_OPTIONS } from '../assets/js/app/analysis/options/signature-options.js';
import { CORRELATION_OPTIONS } from '../assets/js/app/analysis/options/correlation-options.js';
import { dotplotOptions } from '../assets/js/app/analysis/options/dotplot-options.js';
import { compositionOptions } from '../assets/js/app/analysis/options/composition-options.js';

const SCHEMAS = [
  MARKER_OPTIONS,
  DE_OPTIONS,
  SIGNATURE_OPTIONS,
  CORRELATION_OPTIONS,
  dotplotOptions,
  compositionOptions,
];

/** What a dataset offers, enough for every data-dependent default. */
const CONTEXT = Object.freeze({
  categoricalFields: [{ key: 'cell_type' }, { key: 'sample' }],
  continuousFields: [{ key: 'n_counts' }],
  pages: [{ id: 'p1', name: 'Page 1' }, { id: 'p2', name: 'Page 2' }],
  geneFamilyCounts: { mito: 13, ribo: 80, hemo: 4 },
  hasHighlyVariable: false,
  groupsFor: () => [],
  minCellsFor: () => null,
  variableExists: () => true,
});

test('the schema ids are the analysis mode ids the docs tables are keyed by', () => {
  assert.deepEqual(
    SCHEMAS.map(schema => schema.id),
    ['genesPanel', 'differential', 'signature', 'correlation', 'dotplot', 'composition'],
  );
});

for (const schema of SCHEMAS) {
  test(`${schema.id}: every option has a default, a sentence-case label and a tip that exists`, () => {
    assert.ok(schema.entries.length > 0);
    for (const entry of schema.entries) {
      assert.ok(Object.hasOwn(entry, 'default'), `${schema.id}.${entry.key} has a default`);
      assert.ok(isSentenceCase(entry.label), `${schema.id}.${entry.key} label "${entry.label}" is sentence case`);
      assert.ok(Object.hasOwn(INFO_TIPS, entry.tip), `${schema.id}.${entry.key} tip "${entry.tip}" exists`);
    }
    for (const group of schema.groups) {
      assert.ok(isSentenceCase(group.title), `${schema.id} group "${group.title}" is sentence case`);
      assert.ok(group.tip === null || Object.hasOwn(INFO_TIPS, group.tip), `${schema.id} group tip "${group.tip}" exists`);
      assert.ok(schema.group(group.id).length > 0, `${schema.id} group "${group.id}" holds an option`);
    }
  });

  test(`${schema.id}: the defaults are a valid record, and an unknown or missing key is refused`, () => {
    const defaults = schema.defaults(CONTEXT);
    assert.deepEqual(Object.keys(defaults), [...schema.keys]);
    const checked = schema.validate(defaults, CONTEXT);
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(schema.normalize(defaults, CONTEXT), defaults);
    assert.deepEqual(schema.validate(defaults).errors, [], 'a record is valid without a context too');

    const unknown = schema.validate({ ...defaults, notAnOption: 1 }, CONTEXT);
    assert.equal(unknown.valid, false);
    assert.ok(unknown.errors.some(error => error.includes('"notAnOption"')));

    for (const key of schema.keys) {
      const missing = { ...defaults };
      delete missing[key];
      const result = schema.validate(missing, CONTEXT);
      assert.equal(result.valid, false, `${schema.id} refuses a record without "${key}"`);
      assert.ok(result.errors.some(error => error.includes(`"${key}"`)));
    }

    assert.throws(() => schema.normalize({ ...defaults, notAnOption: 1 }, CONTEXT), TypeError);
    assert.throws(() => schema.withDefaults({ notAnOption: 1 }, CONTEXT), RangeError);
    assert.equal(schema.validate(null).valid, false);
    assert.equal(schema.validate([]).valid, false);
  });

  test(`${schema.id}: every default is stated in words for the docs`, () => {
    for (const entry of schema.entries) {
      const text = schema.describeDefault(entry.key);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0 && text.trim() === text, `${schema.id}.${entry.key} default text`);
      // A choice whose list depends on the data cannot be looked up without
      // it: the entry states its default itself, never as the internal value.
      if (['select', 'segmented'].includes(entry.kind) && !Array.isArray(entry.choices)) {
        assert.equal(
          typeof entry.defaultText, 'string',
          `${schema.id}.${entry.key} has data-dependent choices and needs defaultText`,
        );
      }
      if (typeof entry.default === 'function') {
        assert.equal(typeof entry.defaultText, 'string', `${schema.id}.${entry.key} needs defaultText`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The documentation's defaults tables.
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS_ROOT = process.env.CELLUCID_PYTHON_DOCS
  ?? path.resolve(ROOT, '..', 'cellucid-python', 'docs');
const ANALYSIS_DOCS = path.join(DOCS_ROOT, 'user_guide', 'web_app', 'h_analysis');

/** Every `<!-- options:<id> -->` table in the analysis pages, by id. */
async function docsTables() {
  const tables = new Map();
  for (const name of readdirSync(ANALYSIS_DOCS).filter(file => file.endsWith('.md')).sort()) {
    const markdown = await readFile(path.join(ANALYSIS_DOCS, name), 'utf8');
    const pattern = /<!-- options:([A-Za-z]+) -->\n([\s\S]*?)<!-- \/options:\1 -->/g;
    for (const match of markdown.matchAll(pattern)) {
      assert.ok(!tables.has(match[1]), `the options:${match[1]} table appears once (again in ${name})`);
      const rows = match[2].split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('|'))
        // A cell's own `|` is written `\|` (Markdown), so split on the others.
        .map(line => line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|')));
      assert.deepEqual(rows[0], ['Label', 'Default'], `${name} options:${match[1]} header`);
      assert.match(rows[1].join('|'), /^-{3,}\|-{3,}$/, `${name} options:${match[1]} separator`);
      tables.set(match[1], { page: name, rows: rows.slice(2) });
    }
  }
  return tables;
}

test('every analysis page states its defaults exactly as its options schema', async t => {
  if (!existsSync(ANALYSIS_DOCS)) {
    t.skip(`documentation tree not present at ${DOCS_ROOT}`);
    return;
  }
  const tables = await docsTables();
  const missing = SCHEMAS.map(schema => schema.id).filter(id => !tables.has(id));
  assert.deepEqual(missing, [], 'every analysis has a defaults table');
  for (const schema of SCHEMAS) {
    const { page, rows } = tables.get(schema.id);
    assert.deepEqual(
      rows,
      schema.entries.map(entry => [entry.label, schema.describeDefault(entry.key)]),
      `${page} options:${schema.id} lists every option and default in form order`,
    );
  }
  const unknown = [...tables.keys()].filter(id => !SCHEMAS.some(schema => schema.id === id));
  assert.deepEqual(unknown, [], 'no table names an analysis without options');
});
