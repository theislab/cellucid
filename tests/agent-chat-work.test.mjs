/**
 * A turn's work as the chat shows it (`app/agent/chat/work.js`): every
 * action of the catalog named by its arguments, and the folding rules of a
 * long turn (a research answer is not buried under 30–90 rows that all say
 * the action's title).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_DEFINITIONS } from '../assets/js/app/actions/definitions/index.js';
import { createActionCatalog, toolNameOf } from '../assets/js/app/actions/catalog.js';
import { examplesOf } from '../assets/js/app/actions/schema.js';
import { HISTORY_ID_PATTERNS } from '../assets/js/app/history/model.js';
import { toolIndexOf } from '../assets/js/app/agent/bridge/mcp-tools.js';
import { UNRECORDED_NOTES } from '../assets/js/app/agent/bridge/mcp-content.js';
import { createConversation, appendMessage } from '../assets/js/app/agent/chat/conversation.js';
import { conversationMarkdown } from '../assets/js/app/agent/chat/export.js';
import {
  LIVE_ROWS, namedCall, subjectOf, toolRowText, turnFoldOf, workSummaryText,
} from '../assets/js/app/agent/chat/work.js';

const READ = { isError: false, step: null, content: [] };

/** The names an example's arguments give that a person must see in its row: fields and genes, and lists of free names. */
function givenNames(definition, args) {
  const names = [];
  for (const [key, value] of Object.entries(args)) {
    const property = definition.params.properties?.[key] ?? {};
    if (JSON.stringify(property.default) === JSON.stringify(value)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.key === 'string' && typeof value.source === 'string') names.push(value.key);
    // A list of the history's generated ids (steps to picture) is said by the row's sentence, never as ids.
    const items = property.items ?? property.oneOf?.find(branch => branch.items !== undefined)?.items;
    const historyIds = typeof items?.pattern === 'string' && Object.values(HISTORY_ID_PATTERNS).some(pattern => pattern.source === items.pattern);
    if (Array.isArray(value) && typeof value[0] === 'string' && property.items?.enum === undefined && !historyIds) names.push(value[0].trim());
  }
  return names;
}

test('every action of the catalogue gets a row name from its arguments: what it did once done, its title and subject before', () => {
  let checked = 0;
  for (const definition of ACTION_DEFINITIONS) {
    for (const args of examplesOf(definition.params)) {
      const call = namedCall({ name: toolNameOf(definition.type), args }, definition);
      const done = toolRowText(call, READ).label;
      const running = toolRowText(call, null).label;
      const refused = toolRowText(call, { isError: true, step: null, content: [{ type: 'text', text: 'There is no field "x".' }] }).label;
      for (const label of [done, running, refused]) {
        assert.equal(typeof label, 'string', definition.type);
        assert.ok(label.length > 0 && !label.includes('\n'), `${definition.type}: one line`);
        assert.doesNotMatch(label, /undefined|\[object|NaN/, `${definition.type}: ${label}`);
      }
      assert.ok(call.done !== null, `${definition.type} says what it did (describe) for ${JSON.stringify(args)}`);
      assert.ok(running.startsWith(definition.title), `${definition.type}: running says its title`);
      assert.ok(refused.startsWith(definition.title) && refused.endsWith(' · refused'), definition.type);
      for (const name of givenNames(definition, args)) {
        assert.ok(done.includes(name), `${definition.type}: "${done}" names ${name}`);
        assert.ok(running.includes(name), `${definition.type}: "${running}" names ${name}`);
      }
      checked += 1;
    }
  }
  assert.ok(checked >= ACTION_DEFINITIONS.length);
});

test('a read row says what was read, the way a scientist asks it', () => {
  const index = toolIndexOf(createActionCatalog(ACTION_DEFINITIONS));
  const label = (name, args, result = READ) => toolRowText(namedCall({ name, args }, index.get(name)), result).label;
  assert.equal(label('field_categories', { field: { source: 'obs', key: 'cell_type' } }), 'Read the categories of cell_type');
  assert.equal(label('field_summary', { field: { source: 'var', key: 'SOX9' }, by: { source: 'obs', key: 'cell_type' }, visible_only: true }), 'Summarized SOX9 by cell_type');
  const panel = Array.from({ length: 12 }, (_, at) => `G${at + 1}`);
  assert.equal(label('genes_search', { names: panel }), 'Looked up 12 gene names: G1, G2, G3 +9');
  assert.equal(label('cells_values', { cells: [0, 1, 2], fields: [{ source: 'var', key: 'Neurog3' }, { source: 'obs', key: 'clusters' }] }), 'Read 2 fields of 3 cells: Neurog3, clusters');
  // A closed word is said by the sentence in its own words, not repeated.
  assert.equal(label('analysis_result', { analysis: 'differential', top: 25 }), 'Read the differential expression result');
  // A step keeps its label; a change asked for what was so already says so, never that it was done.
  assert.equal(label('analysis_run', { analysis: 'differential' }, { ...READ, step: { label: 'Ran Differential expression' } }), 'Ran Differential expression');
  assert.equal(label('color_by', { field: { source: 'obs', key: 'cell_type' } }, { ...READ, content: [{ type: 'text', text: `{}\n${UNRECORDED_NOTES.unchanged}` }] }),
    'Color the cells by a field or gene: cell_type · already so');
  // Before it ran, and when it did not: title and subject.
  assert.equal(label('analysis_run', { analysis: 'differential' }, null), 'Run an analysis: differential…');
  assert.equal(label('color_by', { field: { source: 'var', key: 'CD3E' } }, { isError: true, step: null, content: [{ type: 'text', text: 'There is no gene "CD3E".' }] }),
    'Color the cells by a field or gene: CD3E · refused');
  // Tried again another way (a closed word added), it is the same call on the same target.
  const first = namedCall({ name: 'field_summary', args: { field: { source: 'var', key: 'Arx' }, by: { source: 'obs', key: 'clusters' } } }, index.get('field_summary'));
  const again = namedCall({ name: 'field_summary', args: { field: { source: 'var', key: 'Arx' }, by: { source: 'obs', key: 'clusters' }, visible_only: true } }, index.get('field_summary'));
  assert.equal(again.target, first.target);
  assert.equal(again.target, 'Arx, clusters');
  // A tool no action runs (a made-up name): its name, never a throw.
  assert.equal(label('no_such_tool', { x: 1 }), 'no_such_tool');
  assert.equal(label('field_categories', 'not an object'), 'Read the categories of a field');
});

test('a call\'s subject: the names its arguments hold, not how (numbers, switches, options, defaults)', () => {
  assert.equal(subjectOf({ field: { source: 'obs', key: 'organ' }, min: 0, max: 9.5, page: 'age  ≤9\npcw', visible_only: true, options: { cells: 'page:Liver' } }), 'organ, age ≤9 pcw');
  assert.equal(subjectOf({ names: ['A', 'B', 'C', 'D', 'E'] }), 'A, B, C +2');
  assert.equal(subjectOf({ a: 'x', b: 'x', c: [] }), 'x');
  assert.equal(subjectOf({ in: 'panel', analysis: 'markers' }, { properties: { in: { default: 'panel' }, analysis: { enum: ['markers'] } } }), 'markers');
  assert.equal(subjectOf(null), '');
  assert.equal(subjectOf([1, 2]), '');
});

test('a history call names steps as the State panel does, never by the ids only an agent uses (step 3, not s3)', () => {
  const index = toolIndexOf(createActionCatalog(ACTION_DEFINITIONS));
  const done = (name, args) => namedCall({ name, args }, index.get(name)).done;
  assert.equal(done('history_step_delete', { step: 's3' }), 'Deleted step 3');
  assert.equal(done('history_squash', { from: 's4', to: 's9' }), 'Merged steps 4 to 9 into one');
  assert.equal(done('history_bookmark_set', { step: 's3', name: 'Before reclustering' }), 'Bookmarked step 3 as "Before reclustering"');
  assert.equal(done('history_note_edit', { note: 'n0', text: 'checked' }), 'Edited a note: checked');
  assert.equal(done('history_journal_undo', { entry: 'j2' }), 'Restored an entry of Recently deleted');
  assert.equal(done('history_branch_cancel', {}), 'Canceled the new branch');
});

const row = (state, name = 'field_categories') => ({ state, name });

test('a short turn is shown whole: no summary row', () => {
  const items = [{ text: true, asks: 0, rows: [row('read'), row('step', 'color_by')] }, { text: true, asks: 0, rows: [row('read')] }];
  for (const running of [false, true]) {
    const fold = turnFoldOf(items, { running });
    assert.equal(fold.summary, null);
    assert.equal(fold.folded, false);
    assert.deepEqual(fold.rows, [[true, true], [true]]);
    assert.deepEqual(fold.bodies, [true, true]);
  }
  assert.equal(LIVE_ROWS, 3);
});

/** A research turn: narration and reads, a step, an analysis run, a refusal, a question, then the answer. */
const research = [
  { text: true, asks: 0, rows: [row('read'), row('read'), row('read')] },
  { text: false, asks: 0, rows: [row('read'), row('refused', 'color_by')] },
  { text: true, asks: 0, rows: [row('step', 'highlight_category'), row('step', 'analysis_run'), row('read', 'analysis_result')] },
  { text: false, asks: 1, rows: [] },
  { text: true, asks: 0, rows: [row('step', 'analysis_run'), row('stopped', 'analysis_run')] },
  { text: true, asks: 0, rows: [] },
];

test('an ended long turn folds to its answer: what went wrong and the questions stay, the rest is under the summary', () => {
  const fold = turnFoldOf(research);
  assert.equal(fold.folded, true);
  assert.deepEqual(fold.summary, { actions: 10, steps: 3, analyses: 2, refused: 1, stopped: 1, interrupted: 0 });
  assert.deepEqual(fold.bodies, [false, false, false, false, false, true], 'only the answer\'s words');
  assert.deepEqual(fold.rows, [[false, false, false], [false, true], [false, false, false], [], [false, true], []], 'only the failed calls');
  assert.deepEqual(fold.messages, [false, true, false, true, true, true], 'a message shows when something of it does');
  assert.equal(workSummaryText(fold.summary), 'Worked through 10 actions · 3 steps · 2 analyses · 1 refused · 1 stopped');
  // Opened: the turn as it was made.
  const open = turnFoldOf(research, { expanded: true });
  assert.equal(open.folded, false);
  assert.deepEqual(open.summary, fold.summary, 'the summary row stays, to fold it again');
  assert.deepEqual(open.rows, research.map(item => item.rows.map(() => true)));
  assert.deepEqual(open.bodies, research.map(item => item.text));
  assert.deepEqual(open.messages, research.map(() => true));
  // A turn that ended without words (stopped mid-call): nothing but its failures and questions.
  const silent = turnFoldOf(research.slice(0, 2).map(item => ({ ...item, text: false })));
  assert.deepEqual(silent.messages, [false, true]);
});

test('a failure the agent recovered from in the turn (the same call went through later) folds with the work; one it did not stays', () => {
  const summarise = (state, target) => ({ state, name: 'field_summary', target });
  const items = [
    { text: true, asks: 0, rows: [summarise('refused', 'Arx, clusters'), summarise('refused', 'Pax4, clusters'), row('stopped', 'analysis_open')] },
    { text: false, asks: 0, rows: [summarise('read', 'Arx, clusters'), summarise('refused', 'Gcg, clusters')] },
    { text: true, asks: 0, rows: [] },
  ];
  const fold = turnFoldOf(items);
  assert.deepEqual(fold.rows, [[false, true, true], [false, true], []], 'Arx was retried and read; Pax4, the stopped call and Gcg were not');
  assert.equal(fold.summary.refused, 3, 'the summary still counts every refusal');
  // A retry still running has not recovered anything yet.
  const pending = turnFoldOf([{ text: true, asks: 0, rows: [summarise('refused', 'Arx, clusters'), row('read'), row('read'), row('read'), summarise('running', 'Arx, clusters')] }], { running: true });
  assert.deepEqual(pending.rows, [[true, false, true, true, true]]);
});

test('a running long turn shows its latest calls (and the words that made them), not a growing wall', () => {
  const running = research.slice(0, 3);
  const fold = turnFoldOf(running, { running: true });
  assert.equal(fold.folded, true);
  assert.deepEqual(fold.rows, [[false, false, false], [false, true], [true, true, true]], 'the last LIVE_ROWS, and the refusal');
  assert.deepEqual(fold.bodies, [false, false, true]);
  assert.deepEqual(fold.messages, [false, true, true]);
  assert.equal(workSummaryText(fold.summary, { running: true }), '8 actions so far · 2 steps · 1 analysis · 1 refused');
  // The latest calls across two messages: the earlier one's words show with its call.
  const split = turnFoldOf([{ text: true, asks: 0, rows: [row('read'), row('read')] }, { text: true, asks: 0, rows: [row('read'), row('running')] }], { running: true });
  assert.deepEqual(split.rows, [[false, true], [true, true]]);
  assert.deepEqual(split.bodies, [true, true]);
  assert.deepEqual(turnFoldOf(running, { running: true, expanded: true }).rows, running.map(item => item.rows.map(() => true)));
});

test('the exported chat keeps every call, each named as its row is', () => {
  const index = toolIndexOf(createActionCatalog(ACTION_DEFINITIONS));
  const chat = createConversation({ id: 'c', now: 1 });
  appendMessage(chat, { role: 'user', text: 'What are the organs?', turn: 't', at: 1 });
  appendMessage(chat, { role: 'assistant', turn: 't', provider: 'scripted', agent: 'Claude', model: 'm', at: 2, epoch: 0, stop: 'tool-use', parts: [
    { type: 'tool-call', id: 'a', name: 'field_categories', args: { field: { source: 'obs', key: 'organ' } } },
    { type: 'tool-call', id: 'b', name: 'color_by', args: { field: { source: 'obs', key: 'organ' } } },
    { type: 'tool-call', id: 'c', name: 'genes_search', args: { names: ['CD3E'] } },
  ] });
  appendMessage(chat, { role: 'tool', turn: 't', results: [
    { id: 'a', name: 'field_categories', title: 'x', isError: false, step: null, content: [{ type: 'text', text: '{}' }] },
    { id: 'b', name: 'color_by', title: 'x', isError: false, step: { id: 's1', label: 'Colored by organ' }, content: [{ type: 'text', text: '{}' }] },
    { id: 'c', name: 'genes_search', title: 'x', isError: true, step: null, content: [{ type: 'text', text: 'Give query or names.' }] },
  ] });
  const markdown = conversationMarkdown(chat, { now: 0, toolIndex: index });
  assert.match(markdown, /- `field_categories` — read: Read the categories of organ\n- `color_by` — step "Colored by organ"\n- `genes_search` — refused: Give query or names\./);
  // Without the tools' actions a read is still listed.
  assert.match(conversationMarkdown(chat, { now: 0 }), /- `field_categories` — read\n/);
});

test('the exported chat calls only a read a read: a file written is done, a stop is a stop, a change already so is none', () => {
  // `analysis_export` and `history_note_add` are not listed as "read", the person's
  // Stop of a playing path not as "refused", a color already shown not as "read".
  const index = toolIndexOf(createActionCatalog(ACTION_DEFINITIONS));
  const chat = createConversation({ id: 'c', now: 1 });
  appendMessage(chat, { role: 'user', text: 'Export it, color by organ, play the path', turn: 't', at: 1 });
  appendMessage(chat, { role: 'assistant', turn: 't', provider: 'scripted', agent: 'Claude', model: 'm', at: 2, epoch: 0, stop: 'tool-use', parts: [
    { type: 'tool-call', id: 'a', name: 'analysis_export', args: { analysis: 'markers' } },
    { type: 'tool-call', id: 'b', name: 'color_by', args: { field: { source: 'obs', key: 'organ' } } },
    { type: 'tool-call', id: 'c', name: 'camera_path_play', args: {} },
    { type: 'tool-call', id: 'd', name: 'camera_path_stop', args: {} },
    { type: 'tool-call', id: 'e', name: 'camera_path_get', args: {} },
  ] });
  const ok = (id, name, text = '{}') => ({ id, name, title: 'x', isError: false, step: null, content: [{ type: 'text', text }] });
  appendMessage(chat, { role: 'tool', turn: 't', results: [
    ok('a', 'analysis_export', '{"analysis":"markers","file":"marker_genes.csv","bytes":10}'),
    ok('b', 'color_by', `{"step":null}\n${UNRECORDED_NOTES.unchanged}`),
    { id: 'c', name: 'camera_path_play', title: 'x', isError: true, step: null, content: [{ type: 'text', text: 'Stopped before it finished: Stopped by the person.' }] },
    ok('d', 'camera_path_stop', '{"stopped":false}'),
    ok('e', 'camera_path_get'),
  ] });
  const markdown = conversationMarkdown(chat, { now: 0, toolIndex: index });
  assert.match(markdown, /- `analysis_export` — done: Exported the marker genes result as CSV\n/);
  assert.match(markdown, /- `color_by` — no change: Color the cells by a field or gene: organ · already so\n/);
  assert.match(markdown, /- `camera_path_play` — stopped: Stopped before it finished: Stopped by the person\.\n/);
  assert.match(markdown, /- `camera_path_stop` — done: Stopped the camera path\n/);
  assert.match(markdown, /- `camera_path_get` — read: /);
  assert.doesNotMatch(markdown, /— (read|refused): (Exported|Stopped|Color)/);
});
