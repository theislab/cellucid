/**
 * Genes read for (`ui/modules/gene-read-control.js`), the one control that
 * changes how many of the open cells a gene is read for, and the Session
 * panel's collapsible sections it sits in (`ui/modules/session-sections.js`):
 * the steps it offers (the share read now, then 1, 5, 10, 25, 50 and 100%
 * above it, never past what the gene index fits here), its one status line
 * (the chosen step's cells and cost, priced again as the link changes, or
 * how far a read is and the time left), Read (the chosen step, priced and
 * held to the index's room at the moment it starts; the cells read kept),
 * Stop, the line that links to it from the legend and analyses, and the
 * sections' summaries and remembered open state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shareText } from '../assets/js/utils/format-units.js';

class FakeNode {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.title = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.min = '';
    this.max = '';
    this.id = '';
    this.tabIndex = 0;
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...nodes) { for (const node of nodes) if (typeof node === 'object') this.appendChild(node); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  after(node) { this.parent?.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener, options = {}) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    options?.signal?.addEventListener?.('abort', () => list.splice(list.indexOf(listener), 1), { once: true });
  }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ target: this, key: '' }); }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; this.dispatch('focus'); }
  scrollIntoView() { this.scrolled = true; }
  querySelector(selector) {
    if (selector === '.info-tip-header') return this.find('info-tip-header');
    return null;
  }
  querySelectorAll() { return []; }
  find(className) {
    if (this.className.split(' ').includes(className)) return this;
    for (const child of this.children) {
      const found = child.find?.(className);
      if (found) return found;
    }
    return null;
  }
}

function fakeDocument() {
  const byId = new Map();
  const doc = {
    activeElement: null,
    defaultView: null,
    createElement: tag => {
      const node = new FakeNode(tag, doc);
      const append = node.appendChild.bind(node);
      node.appendChild = child => { if (child && typeof child === 'object') child.parent = node; return append(child); };
      return node;
    },
    createTextNode: text => ({ textContent: text }),
    getElementById: id => byId.get(id) ?? null,
    register(id, node) { node.id = id; byId.set(id, node); return node; },
  };
  return doc;
}

const doc = fakeDocument();
globalThis.document = doc;

const {
  GENE_READ_STEPS, createGeneReadNote, geneReadStatus, geneReadSteps, initGeneReadControl, nearestGeneReadStep, revealGeneReadControl,
} = await import('../assets/js/app/ui/modules/gene-read-control.js');
const { SESSION_SECTIONS, expandSessionSection, initSessionSections, subsamplingSummary } = await import('../assets/js/app/ui/modules/session-sections.js');

// What a read says goes to the notification center: recorded here.
const { getNotificationCenter } = await import('../assets/js/app/notification-center.js');
const said = [];
Object.assign(getNotificationCenter(), {
  loading: text => { said.push(text); return 'read'; },
  complete: (_id, text) => said.push(text),
  fail: (_id, text) => said.push(text),
  hasNotification: () => true,
});

const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** A DataState with a gene sample and costs the test answers by hand. */
function createState(sample) {
  const listeners = new Set();
  const state = {
    pointCount: sample?.of ?? 0,
    sample,
    growth: null,
    asked: [],
    reads: [],
    stopped: 0,
    getGeneSample: () => state.sample,
    getGeneSampleGrowth: () => state.growth,
    geneSampleCost(cells) {
      const answer = deferred();
      state.asked.push({ cells, answer });
      return answer.promise;
    },
    // A read runs until it is stopped, which keeps what it read (an AbortError, as the state's).
    readGenesForMoreCells(target) {
      state.reads.push(target);
      return new Promise((_resolve, reject) => { state.stopRead = reject; });
    },
    stopReadingGenesForMoreCells() {
      state.stopped++;
      state.stopRead?.(Object.assign(new Error('Reading genes for more cells was stopped.'), { name: 'AbortError' }));
      state.stopRead = null;
    },
    on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    off: (_name, listener) => listeners.delete(listener),
    emit: () => { for (const listener of listeners) listener({}); },
  };
  return state;
}

function controlDom() {
  const make = (tag, id) => doc.register(id, doc.createElement(tag));
  return {
    root: make('div', 'gene-read-block'),
    slider: make('input', 'gene-read-slider'),
    percent: make('input', 'gene-read-percent'),
    status: make('p', 'gene-read-status'),
    actions: make('div', 'gene-read-actions'),
    action: make('button', 'gene-read-action'),
  };
}

test('the steps: the share read now, each fixed share above it, and the most the gene index fits as the last', () => {
  assert.deepEqual([...GENE_READ_STEPS], [1, 5, 10, 25, 50, 100]);
  // HLCA: 3,769 of 2,282,447 open cells read (0.17%).
  assert.deepEqual(geneReadSteps(3_769, 2_282_447), [3_769, 22_824, 114_122, 228_245, 570_612, 1_141_224, 2_282_447]);
  // A sample above some steps starts above them.
  assert.deepEqual(geneReadSteps(30_000, 200_000), [30_000, 50_000, 100_000, 200_000]);
  // The gene index of every open cell does not fit: the most that does is the last step.
  assert.deepEqual(geneReadSteps(3_769, 2_282_447, 400_000), [3_769, 22_824, 114_122, 228_245, 400_000]);
  // Nothing more fits: one step, the sample.
  assert.deepEqual(geneReadSteps(40_000, 455_000, 40_000), [40_000]);
  assert.deepEqual(geneReadSteps(1, 3), [1, 2, 3]);
  // A typed share snaps to the nearest step.
  const steps = geneReadSteps(3_769, 2_282_447);
  assert.equal(nearestGeneReadStep(steps, 7, 2_282_447), 2);
  assert.equal(nearestGeneReadStep(steps, 0, 2_282_447), 0);
  assert.equal(nearestGeneReadStep(steps, 100, 2_282_447), steps.length - 1);
});

test('the percent box: whole from 10 up, two figures below, never 100 short of every cell', () => {
  assert.equal(shareText(3_769, 2_282_447), '0.17');
  assert.equal(shareText(22_824, 2_282_447), '1');
  assert.equal(shareText(114_122, 2_282_447), '5');
  assert.equal(shareText(2_282_446, 2_282_447), '99');
  assert.equal(shareText(2_282_447, 2_282_447), '100');
  assert.equal(shareText(31_539, 200_000), '16');
});

test('the status line: the chosen cells and their cost, compact; a read under way and its time left', () => {
  const sample = { cells: 3_769, of: 2_282_447 };
  assert.equal(geneReadStatus(sample, { chosen: 3_769 }).text, '3.8K of 2.3M cells');
  assert.match(geneReadStatus(sample, { chosen: 3_769 }).title, /^Genes read for 3,769 of 2,282,447 cells/);
  assert.equal(geneReadStatus(sample, { chosen: 228_245 }).text, '228K of 2.3M cells', 'before it is priced');
  const priced = geneReadStatus(sample, { chosen: 228_245, cost: { bytes: 980e6, ms: 125_000 } });
  assert.equal(priced.text, '228K of 2.3M cells · 935 MB, ~2 min');
  assert.match(priced.title, /224,476 more; the 3,769 read are kept\): 935 MB, ~2 min 5 s\.$/);
  assert.equal(geneReadStatus(sample, { chosen: 3_769, noRoom: 'the index needs 9 GB' }).text, '3.8K of 2.3M cells · no more fits here');
  const reading = geneReadStatus(sample, { chosen: 228_245, growth: { cells: 12_000, target: 228_245 }, left: { bytes: 900e6, ms: 70_000 } });
  assert.equal(reading.text, 'Reading 12K of 228K cells · ~1 min left');
  // The longest line fits the narrowest panel (one line, never wrapped).
  assert.ok(geneReadStatus({ cells: 3_769, of: 99_999_999 }, { chosen: 50_000_000, cost: { bytes: 999e9, ms: 36_000_000 } }).text.length <= 42);
});

test('the control: hidden without a sample; a step chosen is priced, priced again as the link changes, and read', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dom = controlDom();
  const state = createState(null);
  let openCells = 'every cell';
  const control = initGeneReadControl({ dom, state, openCellsKey: () => openCells });
  assert.equal(control.genesAsked(), null, 'no genes asked for yet');
  assert.equal(dom.root.hidden, true, 'every open cell\'s genes are read: nothing to show');
  state.sample = { cells: 3_769, of: 2_282_447 };
  state.emit();
  assert.equal(dom.root.hidden, false);
  assert.equal(dom.status.textContent, '3.8K of 2.3M cells');
  assert.equal(dom.percent.value, '0.17');
  assert.equal(dom.slider.max, '6');
  assert.equal(dom.actions.hidden, true, 'nothing to read at the share read now');
  assert.equal(state.asked.length, 0, 'nothing is priced while the dataset opens');
  // First used: what the gene index fits here is asked, once.
  dom.slider.focus();
  dom.slider.focus();
  assert.deepEqual(state.asked.map(entry => entry.cells), [2_282_447]);
  state.asked[0].answer.resolve({ bytes: 9.8e9, ms: 4.5e6, index: { refusal: null, fits: 2_282_447 } });
  await settle();
  // The 10% step: priced, then read.
  dom.slider.value = '3';
  dom.slider.dispatch('input');
  assert.equal(dom.percent.value, '10');
  assert.equal(dom.status.textContent, '228K of 2.3M cells');
  assert.equal(dom.actions.hidden, false);
  assert.equal(state.asked.at(-1).cells, 228_245);
  state.asked.at(-1).answer.resolve({ bytes: 980e6, ms: 125_000, index: { refusal: null, fits: 228_245 } });
  await settle();
  assert.equal(dom.status.textContent, '228K of 2.3M cells · 935 MB, ~2 min');
  // The link got slower: priced again while shown, the time follows it.
  t.mock.timers.tick(5000);
  assert.equal(state.asked.at(-1).cells, 228_245);
  state.asked.at(-1).answer.resolve({ bytes: 980e6, ms: 610_000, index: { refusal: null, fits: 228_245 } });
  await settle();
  assert.equal(dom.status.textContent, '228K of 2.3M cells · 935 MB, ~10 min');
  // An answer for an earlier choice is dropped: the 25% step asked, then the 5% one.
  dom.slider.value = '4';
  dom.slider.dispatch('input');
  const stale = state.asked.at(-1);
  dom.slider.value = '2';
  dom.slider.dispatch('input');
  stale.answer.resolve({ bytes: 1, ms: 1, index: { refusal: null, fits: 570_612 } });
  await settle();
  assert.equal(dom.status.textContent, '114K of 2.3M cells');
  state.asked.at(-1).answer.resolve({ bytes: 500e6, ms: 60_000, index: { refusal: null, fits: 114_122 } });
  await settle();
  // A typed share snaps to its step.
  dom.percent.value = '24';
  dom.percent.dispatch('change');
  assert.equal(dom.percent.value, '25');
  state.asked.at(-1).answer.resolve({ bytes: 2.2e9, ms: 290_000, index: { refusal: null, fits: 570_612 } });
  await settle();
  // Read (the action cells.read-genes): priced at the moment it starts, the chosen cells read.
  dom.action.click();
  assert.equal(dom.action.disabled, true);
  await settle();
  state.asked.at(-1).answer.resolve({ bytes: 2.2e9, ms: 290_000, index: { refusal: null, fits: 570_612 } });
  await settle();
  assert.deepEqual(state.reads, [570_612]);
  assert.equal(said.at(-1), 'Reading genes for 25% of the open cells (570,612 cells) (2.0 GB, ~4 min 50 s)');
  // While it reads: Stop, the cells read so far and the time left, the slider still.
  state.growth = { cells: 22_000, target: 570_612 };
  state.emit();
  assert.equal(dom.action.textContent, 'Stop');
  assert.equal(dom.slider.disabled, true);
  assert.equal(dom.status.textContent, 'Reading 22K of 571K cells');
  state.asked.at(-1).answer.resolve({ bytes: 2.1e9, ms: 250_000, index: { refusal: null, fits: 570_612 } });
  await settle();
  assert.equal(dom.status.textContent, 'Reading 22K of 571K cells · ~4 min left');
  dom.action.click();
  assert.equal(state.stopped, 1, 'Stop keeps what is read');
  await settle();
  assert.equal(said.at(-1), 'Stopped. Genes read for 3,769 of 2,282,447 cells', 'the step ends with what was read');
  // What the step asked for is what was read, on these open cells (the `cells` state domain).
  assert.equal(control.genesAsked(), 3_769);
  openCells = 'a subsample';
  assert.equal(control.genesAsked(), null, 'a count asked on other cells says nothing of these');
  control.setGenesAsked(1_000);
  assert.equal(control.genesAsked(), 1_000);
  control.setGenesAsked(null);
  assert.equal(control.genesAsked(), null);
  assert.throws(() => control.setGenesAsked(0), /whole number of cells/);
  openCells = 'every cell';
  // Stopped: what was read is the sample, steps made afresh from it.
  state.growth = null;
  state.sample = { cells: 228_245, of: 2_282_447 };
  state.emit();
  assert.equal(dom.status.textContent, '228K of 2.3M cells');
  assert.equal(dom.percent.value, '10');
  assert.equal(dom.slider.disabled, false);
  control.destroy();
});

test('Read never asks for more cells than the gene index fits here, and no room disables the slider', async t => {
  const dom = controlDom();
  const state = createState({ cells: 40_000, of: 455_000 });
  const control = initGeneReadControl({ dom, state, openCellsKey: () => 'every cell' });
  // Chosen before the room was asked: 100%.
  dom.slider.value = '4';
  dom.slider.dispatch('input');
  state.asked.at(-1).answer.resolve({ bytes: 3e9, ms: 600_000, index: { refusal: 'the gene index of 455,000 cells needs 3 GB', fits: 120_000 } });
  await settle();
  // The last step is now the most that fits, and is chosen.
  assert.match(dom.status.textContent, /^120K of 455K cells/);
  state.asked.at(-1).answer.resolve({ bytes: 1e9, ms: 100_000, index: { refusal: null, fits: 120_000 } });
  await settle();
  dom.action.click();
  await settle();
  state.asked.at(-1).answer.resolve({ bytes: 1e9, ms: 100_000, index: { refusal: 'needs more', fits: 100_000 } });
  await settle();
  assert.deepEqual(state.reads, [100_000], 'held to the room at the moment it starts');
  // Stopped, the read ends; one control on the page reads genes at a time.
  state.stopReadingGenesForMoreCells();
  await settle();
  control.destroy();

  const none = controlDom();
  const full = createState({ cells: 40_000, of: 455_000 });
  const fullControl = initGeneReadControl({ dom: none, state: full, openCellsKey: () => 'every cell' });
  t.after(() => fullControl.destroy());
  none.percent.focus();
  full.asked[0].answer.resolve({ bytes: 1e9, ms: 1_000, index: { refusal: 'the gene index of 455,000 cells needs 3 GB', fits: 40_000 } });
  await settle();
  assert.equal(none.slider.disabled, true);
  assert.equal(none.status.textContent, '40K of 455K cells · no more fits here');
  assert.match(none.status.title, /Genes cannot be read for more cells here: the gene index of 455,000 cells needs 3 GB\./);
});

test('the line that links to it says the sample in one compact line, its exact words in the (i), and reveals the control', async () => {
  const note = createGeneReadNote({ className: 'analysis-gene-read', tip: 'gene-sample', label: 'About the gene sample' });
  note.set('Genes read for 3.8K of 2.3M cells', 'Genes are read for 3,769 of the 2,282,447 open cells.');
  assert.equal(note.link.textContent, 'Genes read for 3.8K of 2.3M cells');
  assert.match(note.link.title, /Change it in Session › Subsampling: Genes read for\.$/);
  assert.equal(note.root.find('gene-read-note-detail').textContent, 'Genes are read for 3,769 of the 2,282,447 open cells.');
  // The control, inside the collapsed Subsampling section of a closed Session panel.
  const block = doc.getElementById('gene-read-block');
  block.hidden = false;
  const panel = doc.register('session-section', doc.createElement('details'));
  panel.open = false;
  const header = doc.register(SESSION_SECTIONS.subsampling.toggle, doc.createElement('button'));
  header.setAttribute('aria-expanded', 'false');
  header.addEventListener('click', () => header.setAttribute('aria-expanded', 'true'));
  doc.register('sidebar', doc.createElement('div')).classList = { contains: () => false };
  doc.documentElement = { dataset: {} };
  note.link.ownerDocument = doc;
  note.link.click();
  // Nothing opens before the sidebar is shown (R9K-2: a section opened in the
  // moment the sidebar's action starts is kept outside the history).
  assert.equal(panel.open, false, 'the Session panel waits for the sidebar');
  // Opened, brought into view and focused once it is (`revealInSidebar`).
  await settle();
  assert.equal(panel.open, true, 'the Session panel opens');
  assert.equal(header.getAttribute('aria-expanded'), 'true', 'Subsampling opens');
  assert.equal(block.scrolled, true);
  assert.equal(doc.activeElement, doc.getElementById('gene-read-slider'), 'its slider is focused');
  block.hidden = true;
  assert.equal(revealGeneReadControl(doc), false, 'no sample: nothing to reveal');
});

test('the Session sections: collapsed by default, a one-line summary, the open state kept per viewer (never failing without storage)', () => {
  assert.equal(subsamplingSummary(null, null), '');
  assert.equal(subsamplingSummary({ nObs: 562_000, kept: null }, null), '100% cells');
  assert.equal(subsamplingSummary({ nObs: 2_282_447, kept: null }, { cells: 3_769, of: 2_282_447 }), '100% cells · genes 0.17%');
  assert.equal(subsamplingSummary({ nObs: 1_000, kept: new Uint32Array(100) }, { cells: 60, of: 100 }), '10% cells · genes 60%');
  assert.equal(subsamplingSummary({ nObs: 1_000, kept: null }, null, { cells: 2_000, target: 10_000 }), '100% cells · reading genes 2K');
  // A progressive opening growing in place says the share it grows to and the cells read so far,
  // as the Subsampling control does: the cells open so far alone ("23% cells") read as a chosen
  // subsample (Suo, R9X-18).
  assert.equal(
    subsamplingSummary({ nObs: 561_947, kept: new Uint32Array(131_072) }, null, null, { cells: 131_072, target: 561_947 }),
    '100% cells · reading 131K'
  );
  assert.equal(
    subsamplingSummary({ nObs: 1_000, kept: new Uint32Array(100) }, null, null, { cells: 100, target: 500 }),
    '50% cells · reading 100'
  );

  const page = fakeDocument();
  const values = new Map();
  page.defaultView = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
  for (const section of Object.values(SESSION_SECTIONS)) {
    const header = page.register(section.toggle, page.createElement('button'));
    header.setAttribute('aria-controls', `${section.toggle}-body`);
    page.register(`${section.toggle}-body`, page.createElement('div'));
    page.register(section.summary, page.createElement('span'));
  }
  page.register('session-section', page.createElement('details')).open = true;
  const sections = initSessionSections(page);
  const toggle = page.getElementById(SESSION_SECTIONS.subsampling.toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(page.getElementById(`${SESSION_SECTIONS.subsampling.toggle}-body`).hidden, true);
  sections.setSummary('subsampling', '100% cells · genes 6%');
  assert.equal(page.getElementById(SESSION_SECTIONS.subsampling.summary).textContent, '100% cells · genes 6%');
  assert.equal(expandSessionSection(page, 'subsampling'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(JSON.parse(values.get('cellucid_session_sections')), { subsampling: true });
  sections.destroy();
  // Opened again: as this viewer left it.
  for (const section of Object.values(SESSION_SECTIONS)) page.getElementById(section.toggle).listeners.clear();
  initSessionSections(page);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(page.getElementById(SESSION_SECTIONS.dataMapping.toggle).getAttribute('aria-expanded'), 'false');
  // A window whose storage throws: collapsed, and a toggle never fails.
  page.defaultView = { get localStorage() { throw new Error('denied'); } };
  for (const section of Object.values(SESSION_SECTIONS)) page.getElementById(section.toggle).listeners.clear();
  initSessionSections(page);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.throws(() => expandSessionSection(page, 'nothing'), /No Session section/);
});
