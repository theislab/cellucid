#!/usr/bin/env node
/**
 * Write the action reference page of the developer docs from the action
 * catalogue (`assets/js/app/actions/definitions/`): every action an agent, a
 * Python or R viewer, a session, a replay and the person's own controls take,
 * with its parameters, what it changes, its timeline label and its
 * pseudocode, and every read with what it returns.
 *
 *   node scripts/generate-action-reference.mjs           # write it
 *   node scripts/generate-action-reference.mjs --check   # exit 1 when it is stale or missing
 *   node scripts/generate-action-reference.mjs --out <file>
 *
 * The page lives in the shared docs site (`cellucid-python/docs`, found
 * through CELLUCID_PYTHON_DOCS, else the sibling checkout):
 * `user_guide/web_app/p_developer_docs/30_action_reference.md`.
 * `tests/action-reference-contract.test.mjs` fails while it differs from what
 * this writes, so an action added, renamed or given another parameter cannot
 * leave the docs behind.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTION_CONFIRMS, ACTION_EFFECTS, createActionCatalog, isSteplessEffect, toolNameOf } from '../assets/js/app/actions/catalog.js';
import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { DOMAINS, domainName } from '../assets/js/app/actions/domains.js';
import { exampleOf } from '../assets/js/app/actions/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the page is, inside the docs tree. */
export const ACTION_REFERENCE_PAGE = path.join('user_guide', 'web_app', 'p_developer_docs', '30_action_reference.md');

/** The docs tree this checkout's page is written into. */
export function docsRoot(env = process.env) {
  return env.CELLUCID_PYTHON_DOCS ?? path.resolve(ROOT, '..', 'cellucid-python', 'docs');
}

/** The page's path for `env`. */
export function actionReferencePath(env = process.env) {
  return path.join(docsRoot(env), ACTION_REFERENCE_PAGE);
}

const EFFECT_WORDS = Object.freeze({
  state: 'it changes what the data says (fields, labels, filters, highlights, results)',
  view: 'it changes how the data is shown',
  layout: 'it changes the panels, sections or theme',
  read: 'it reads, changes nothing and records no step',
  history: 'it moves or edits the history itself and records no step of the state (an edit is kept in the history\'s journal, undone from Recently deleted)',
  dataset: 'it opens another dataset, whose history starts anew (the open one\'s stays kept in this browser), and records no step',
  outside: 'it acts outside the dataset\'s state and history (writes a file the person receives, publishes, or keeps or removes something in this browser for later visits), which the history cannot take back, and records no step',
});

const CONFIRM_WORDS = Object.freeze({
  'writes-file': 'it writes a file',
  'deletes-saved': 'it deletes something saved',
  'large-download': 'it downloads a lot',
  publishes: 'it publishes',
  'pauses-recording': 'it pauses the recording (while paused, a change cannot be undone on its own)',
});

/**
 * Words for every value of `values`: an effect or a kind the catalogue
 * gains with no words here fails the page's generation, never prints
 * "undefined".
 */
function requireWords(words, values, what) {
  const missing = values.filter(value => typeof words[value] !== 'string');
  const extra = Object.keys(words).filter(value => !values.includes(value));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`The action reference has no words for the ${what} ${missing.join(', ') || '(none)'}${extra.length > 0 ? `, and words for ${what}s the catalogue does not have: ${extra.join(', ')}` : ''}; add them to scripts/generate-action-reference.mjs`);
  }
  return words;
}
requireWords(EFFECT_WORDS, ACTION_EFFECTS, 'effect');
requireWords(CONFIRM_WORDS, ACTION_CONFIRMS, 'confirmation kind');

/** Text safe in a Markdown table cell (and in MyST): no pipes, no tags, one line. */
function cell(text) {
  return String(text).replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('\n', ' ');
}

function code(text) {
  // A backtick inside inline code would end it: use a longer fence.
  const value = String(text);
  return value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``;
}

/** A schema's type in words: "string", "list of cells (original positions)", "one of `a`, `b`". */
function typeWords(schema) {
  if (schema === undefined || schema === null) return 'any';
  if (schema['x-cells'] === true) return 'cells (original positions)';
  if (schema['x-values'] === true) return 'one number per cell';
  if (schema.const !== undefined) return code(JSON.stringify(schema.const));
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map(value => code(JSON.stringify(value))).join(', ')}`;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map(typeWords).join(' or ');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.map(type => {
    if (type === 'array') return `list of ${typeWords(schema.items)}`;
    if (type === 'object') {
      const keys = Object.keys(schema.properties ?? {});
      return keys.length === 0 ? 'object' : `object (${keys.map(code).join(', ')})`;
    }
    return type;
  }).join(' or ');
}

/** What else a schema says of its values (bounds, length), as one sentence or none. */
function limitSentence(schema) {
  const out = [];
  if (schema.minimum !== undefined) out.push(`at least ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) out.push(`more than ${schema.exclusiveMinimum}`);
  if (schema.maximum !== undefined) out.push(`at most ${schema.maximum}`);
  if (schema.minItems !== undefined) out.push(`at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
  if (schema.maxItems !== undefined) out.push(`at most ${schema.maxItems} items`);
  if (schema.uniqueItems === true) out.push('each once');
  if (schema.minLength !== undefined && schema.minLength > 0) out.push('not empty');
  if (schema.maxLength !== undefined) out.push(`at most ${schema.maxLength} characters`);
  if (out.length === 0) return null;
  const text = out.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** A description as a sentence: ends with its punctuation. */
function sentence(text) {
  const exact = text.trim();
  return /[.!?)]$/.test(exact) ? exact : `${exact}.`;
}

/** The rows of a parameter (or result) table: one per top-level property. */
function propertyRows(schema, { withRequired }) {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, sub]) => {
    const notes = [];
    if (typeof sub.description === 'string' && sub.description.trim().length > 0) notes.push(sentence(sub.description));
    const limits = limitSentence(sub);
    if (limits !== null) notes.push(limits);
    if (sub.default !== undefined) notes.push(`Default ${code(JSON.stringify(sub.default))}.`);
    const columns = [code(name), cell(typeWords(sub))];
    if (withRequired) columns.push(required.has(name) ? 'yes' : 'no');
    columns.push(cell(notes.join(' ')));
    return `| ${columns.join(' | ')} |`;
  });
}

function actionSection(definition) {
  const example = exampleOf(definition.params);
  const lines = [
    `### ${code(definition.type)}`,
    '',
    `**${cell(definition.title)}.** ${definition.summary}`,
    '',
    `- Agent tool: ${code(toolNameOf(definition.type))}`,
    `- Effect: ${code(definition.effect)}: ${EFFECT_WORDS[definition.effect]}`,
  ];
  if (definition.touches.length > 0) {
    lines.push(`- Changes: ${definition.touches.map(id => `${domainName(id)} (${code(id)})`).join(', ')}`);
  }
  if (definition.reads.length > 0) {
    const inputs = definition.reads.map(id => (id === 'history' ? `the history (${code(id)})` : `${domainName(id)} (${code(id)})`));
    lines.push(`- Depends on: ${inputs.join(', ')}`);
  }
  if (definition.confirm !== null) {
    lines.push(`- Asks the person first when an agent takes it: ${CONFIRM_WORDS[definition.confirm]} (${code(definition.confirm)})`);
  }
  if (definition.coalesce !== null) lines.push('- Repeated at once (a drag, a gesture), it is one step');
  if (definition.supersede) lines.push('- A newer one replaces one still running');
  if (definition.rerun) lines.push('- Run again on a stale step (the State panel) brings its result up to date');
  lines.push('');
  const params = propertyRows(definition.params, { withRequired: true });
  if (params.length > 0) {
    lines.push('| Parameter | Type | Required | Notes |', '|---|---|---|---|', ...params, '');
  } else {
    lines.push('It takes no parameters.', '');
  }
  lines.push(
    'Example:',
    '',
    '```json',
    JSON.stringify(example),
    '```',
    '',
  );
  if (isSteplessEffect(definition.effect) && definition.result !== null) {
    const rows = propertyRows(definition.result, { withRequired: false });
    if (rows.length > 0) lines.push('It returns:', '', '| Field | Type | Notes |', '|---|---|---|', ...rows, '');
    else lines.push(`It returns ${typeWords(definition.result)}.`, '');
  }
  if (definition.effect !== 'read') {
    lines.push(
      `Timeline label: ${cell(definition.describe(example, null))}`,
      '',
      `Pseudocode: ${code(definition.code(example))}`,
      '',
    );
  }
  return lines;
}

/** The page's text, as this checkout's catalogue makes it. */
export function renderActionReference(definitions = ACTION_DEFINITIONS) {
  const catalog = createActionCatalog(definitions);
  // Groups in the order the areas are listed (`definitions/index.js`), actions by type within one.
  const groups = [];
  for (const definition of definitions) if (!groups.includes(definition.group)) groups.push(definition.group);
  const all = catalog.list();
  const reads = all.filter(definition => definition.effect === 'read').length;
  const history = all.filter(definition => definition.effect === 'history').length;
  const outside = all.filter(definition => definition.effect === 'outside').length;
  const lines = [
    '# Action reference',
    '',
    '<!-- Generated by scripts/generate-action-reference.mjs in the cellucid repository from the action',
    '     catalogue (assets/js/app/actions/definitions/). Do not edit: run that script.',
    '     tests/action-reference-contract.test.mjs fails while this page differs from what it writes. -->',
    '',
    'This page answers: **"What can be done to an open dataset, by name, and what does each step',
    'change?"** Every change a person makes with a control, and every change or read an agent,',
    'a Python or R viewer, a session or a replay makes, is one of these actions, checked',
    'against the same parameters and recorded as one history step with the same label. The',
    'catalogue is `assets/js/app/actions/definitions/` in the `cellucid` repository',
    '(`app/actions/README.md` there); this page is generated from it. How the action layer, the',
    'state domains and the history work is {doc}`29_action_layer_domains_and_history`.',
    '',
    `The catalogue holds ${all.length} actions: ${all.length - reads - history - outside} that change the state or open a dataset, ${history} that move or edit the history, ${outside} that act outside the state (a file written, a publication, what this browser keeps), and ${reads} reads.`,
    'Parameters name things, never positions: a field as `{source, key}` (`obs` for a column of',
    'the cells, `var` for a gene), a category by its label, a gene by its name, a highlight page',
    'by its name, a view as `"live"` or `"View N"`, and cells by their original position (the',
    '0-based row of `obs`). A step therefore replays on another dataset with the same names. An',
    'agent calls an action by its tool name (the type with dots and dashes as underscores).',
    '',
    '## State domains',
    '',
    'An action names the parts of the state it changes ("Changes"). The history keeps their values',
    'before and after each step; undo puts the before-values back. It also names the parts its',
    'result depends on besides its parameters ("Depends on": the cells, mapping or pages it computes',
    'from, the state a name it is given resolves in); a step keeps their value hashes, which say',
    'when its result is stale.',
    '',
    '| Domain | Name | Holds |',
    '|---|---|---|',
    ...DOMAINS.map(([id, name, description]) => `| ${code(id)} | ${cell(name)} | ${cell(description)} |`),
    '',
  ];
  for (const group of groups) {
    lines.push(`## ${group}`, '');
    for (const definition of all.filter(entry => entry.group === group)) lines.push(...actionSection(definition));
  }
  while (lines.at(-1) === '') lines.pop();
  const text = `${lines.join('\n')}\n`;
  // A sentence or a line of pseudocode missing a value prints "undefined": the page is not
  // written so.
  const broken = text.split('\n').filter(line => /\bundefined\b|\bNaN\b|\[object Object\]/.test(line));
  if (broken.length > 0) throw new Error(`The action reference would print a missing value:\n${broken.slice(0, 10).join('\n')}`);
  return text;
}

async function main(argv) {
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const target = outIndex >= 0 ? path.resolve(argv[outIndex + 1] ?? '') : actionReferencePath();
  const text = renderActionReference();
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== text) {
      console.error(`${target} is ${current === null ? 'missing' : 'stale'}: run node scripts/generate-action-reference.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log(`${target} is current.`);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  console.log(`Wrote ${target}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
