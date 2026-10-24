import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ERROR_MESSAGES as GENES_PANEL_ERROR_MESSAGES,
  formatError
} from '../assets/js/app/analysis/genes-panel/constants.js';
import { ERROR_MESSAGES as DATA_SOURCE_ERROR_MESSAGES } from '../assets/js/data/data-source.js';
import { GenesPanelController } from '../assets/js/app/analysis/genes-panel/genes-panel-controller.js';

const ANALYSIS_ROOT = fileURLToPath(
  new URL('../assets/js/app/analysis/', import.meta.url)
);

const PLACEHOLDER = /\{(\w+)\}/;

/**
 * The message table read by direct key lookup — `DataSourceError.getUserMessage`
 * in data/data-source.js — has no substitution step at all, so a placeholder in
 * it reaches the user verbatim with no code change required.
 */
const DIRECT_LOOKUP_TABLES = Object.freeze([
  ['assets/js/data/data-source.js', DATA_SOURCE_ERROR_MESSAGES]
]);

const IMPORTED_TABLES = Object.freeze({
  './constants.js': GENES_PANEL_ERROR_MESSAGES
});

function* walkJavaScript(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkJavaScript(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield entryPath;
    }
  }
}

/**
 * Resolve which ERROR_MESSAGES table a module's `ERROR_MESSAGES.KEY` references
 * name. The scan reads the import rather than guessing from the key name, so a
 * module that imports some other table of that name is not misattributed.
 */
function resolveTable(source) {
  const importLine = source.match(
    /import\s*\{[^}]*\bERROR_MESSAGES\b[^}]*\}\s*from\s*'([^']+)'/
  );
  if (importLine === null) return null;
  return IMPORTED_TABLES[importLine[1]] ?? null;
}

test('every templated genes-panel error message reaches the user through formatError', () => {
  const templatedKeys = Object.entries(GENES_PANEL_ERROR_MESSAGES)
    .filter(([, message]) => PLACEHOLDER.test(message))
    .map(([key]) => key);
  assert.ok(
    templatedKeys.length > 0,
    'the genes panel must still carry templated messages, or this sweep asserts nothing'
  );

  let inspectedReferences = 0;
  for (const filePath of walkJavaScript(ANALYSIS_ROOT)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const table = resolveTable(source);
    if (table === null) continue;
    for (const match of source.matchAll(/ERROR_MESSAGES\.([A-Z0-9_]+)/g)) {
      const [reference, key] = match;
      const relative = path.relative(ANALYSIS_ROOT, filePath);
      assert.ok(
        Object.hasOwn(table, key),
        `${relative} names ERROR_MESSAGES.${key}, which its imported table does not define`
      );
      inspectedReferences += 1;
      if (!PLACEHOLDER.test(table[key])) continue;
      const before = source.slice(0, match.index);
      const line = source.slice(0, match.index).split('\n').length;
      assert.ok(
        before.endsWith('formatError('),
        `${relative}:${line} uses the templated ${reference} outside formatError(...); `
          + `the user would be shown the literal ${PLACEHOLDER.exec(table[key])[0]}`
      );
    }
  }

  assert.ok(
    inspectedReferences >= templatedKeys.length,
    'the analysis tree must still reference ERROR_MESSAGES, or this sweep asserts nothing'
  );
});

test('error tables read by direct key lookup carry no placeholders', () => {
  for (const [modulePath, table] of DIRECT_LOOKUP_TABLES) {
    const entries = Object.entries(table);
    assert.ok(entries.length > 0, `${modulePath} must still publish messages`);
    for (const [key, message] of entries) {
      assert.ok(
        !PLACEHOLDER.test(message),
        `${modulePath} entry ${key} carries ${PLACEHOLDER.exec(message)?.[0]}, but nothing `
          + 'substitutes it on the way to the user'
      );
    }
  }
});

test('formatError refuses to publish a message with an unfilled placeholder', () => {
  assert.throws(
    () => formatError(GENES_PANEL_ERROR_MESSAGES.TOO_FEW_GROUPS),
    /Missing error template variable: n/
  );
});

test('a dataset with no gene axis reports the empty axis rather than a gene lookup failure', async () => {
  const controller = Object.create(GenesPanelController.prototype);
  controller.dataLayer = {
    async getGeneKeys() { return this.getAvailableVariables('gene_expression').map(gene => gene.key); },
    getAvailableVariables(type) {
      assert.equal(type, 'gene_expression');
      return [];
    }
  };
  await assert.rejects(
    () => controller.genesToTest({ excludeGenes: [], excludePattern: '', onlyGenes: 'all', onlyGenesList: '' }),
    error => {
      assert.equal(error.message, GENES_PANEL_ERROR_MESSAGES.NO_GENES_AVAILABLE);
      assert.doesNotMatch(error.message, PLACEHOLDER, 'an unfilled placeholder reached the user');
      return true;
    }
  );
});
