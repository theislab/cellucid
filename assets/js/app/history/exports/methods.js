/**
 * @fileoverview A history as a methods paragraph: the tracker's abstract, the
 * software and its version, the dataset with its size, its citation and the
 * cells opened, and the steps of one branch that changed the data or what
 * was computed, in order, with who took each when it was not the person.
 * Pure (importable in Node). Python (`cellucid.history.methods_paragraph`)
 * and R (`.history_methods_paragraph`) write the same text, pinned by the
 * golden history's `expected.methods`.
 *
 * Written the way a methods section is: past tense, factual, no step left
 * unaccounted for.
 * - The tracker's first note (its abstract) opens it, as a paragraph of its own.
 * - Steps that only presented the data (camera, panels, render settings,
 *   kept views, colors) are counted, not listed; so is a change made outside
 *   an action, or a squashed step, that touched only those.
 * - A step that no longer applies is counted and left out.
 * - A change made outside an action is listed as what it was ("filters
 *   changed outside the recorded steps").
 * - A squashed step is listed as what it stands for, with the parts of the
 *   state it changed ("changes made with recording paused (colors,
 *   filters)", "3 steps merged into one (highlights)", "a fresh start from
 *   …", "a shared state, …"), and a sentence says that only its resulting
 *   state was kept.
 * - Groups are sections. When a listed step is in a group, the first
 *   paragraph holds the software, the dataset, "The 7 steps applied are
 *   listed below, in order." and the counts; then each run of listed steps
 *   follows under its heading on a line of its own: its group's name, or
 *   "Before <group>" / "After <group>" for steps in no group
 *   (`runHeadings`). Steps are numbered through the whole text.
 *
 * @module app/history/exports/methods
 */

import {
  actorsOf, branchPath, groupRuns, inSentence, METHOD_DOMAINS, originOf, originPhrase, runHeadings, squashPhrase,
} from './step-text.js';
import { domainName } from '../../actions/domains.js';
import { countNoun, formatCount, formatCountOf } from '../../../utils/format-units.js';

const SUBSAMPLE_METHODS = Object.freeze({
  blocks: 'in blocks of neighbouring cells',
  uniform: 'uniformly at random',
  stratified: 'stratified by a field',
  spatial: 'spatially',
});

function trimEnd(text) {
  return String(text).trim().replace(/[.;,\s]+$/, '');
}

/** `[1, 2, 3, 5]` → "1–3 and 5". */
export function numberRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const parts = runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`));
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function datasetSentence(dataset) {
  const name = dataset?.name ? `“${trimEnd(dataset.name)}”` : null;
  const size = [
    Number.isFinite(dataset?.cells) ? formatCountOf(dataset.cells, 'cell') : null,
    Number.isFinite(dataset?.genes) ? formatCountOf(dataset.genes, 'gene') : null,
  ].filter(Boolean).join(' and ');
  const citation = dataset?.citation ? trimEnd(dataset.citation) : null;
  const facts = [size || null, citation].filter(Boolean).join('; ');
  const subject = name === null ? 'The dataset' : `The dataset ${name}`;
  const open = dataset?.openCells ?? null;
  let how = 'was opened in full';
  if (open !== null && Number.isFinite(open.open) && Number.isFinite(open.of) && open.open < open.of) {
    const percent = (100 * open.open) / open.of;
    const share = percent >= 1 ? `${Math.round(percent)}%` : `${Number(percent.toPrecision(2))}%`;
    const method = SUBSAMPLE_METHODS[open.method] ?? null;
    const seed = Number.isSafeInteger(open.seed) ? ` with seed ${open.seed}` : '';
    how = `was opened on ${formatCount(open.open)} of its ${formatCountOf(open.of, 'cell')} (${share})`
      + `${method ? `, chosen ${method}${seed}` : seed}`;
  }
  return `${subject}${facts ? ` (${facts})` : ''} ${how}.`;
}

function touchesMethod(step) {
  return (step.touches ?? []).some(id => METHOD_DOMAINS.has(id));
}

function lowerDomains(ids) {
  return ids.map(id => domainName(id).toLowerCase()).join(', ');
}

function stepItem(step) {
  if (step.kind === 'outside') {
    return `${lowerDomains(step.touches.filter(id => METHOD_DOMAINS.has(id)))} changed outside the recorded steps`;
  }
  if (step.kind === 'squashed') {
    return `${inSentence(squashPhrase(step.squashed))}${step.touches.length > 0 ? ` (${lowerDomains(step.touches)})` : ''}`;
  }
  return inSentence(trimEnd(step.label));
}

/** "Step 2 was taken by …, and steps 4–6 by …", or null when the person took them all. */
function originSentence(numbered) {
  const byOrigin = new Map();
  for (const { step, number } of numbered) {
    for (const by of actorsOf(step)) {
      const phrase = originOf(by).key === 'person' ? null : originPhrase(by);
      if (phrase === null) continue;
      if (!byOrigin.has(phrase)) byOrigin.set(phrase, []);
      const numbers = byOrigin.get(phrase);
      if (!numbers.includes(number)) numbers.push(number);
    }
  }
  const clauses = [...byOrigin].map(([phrase, numbers], index) => {
    const noun = countNoun(numbers.length, 'step');
    if (index > 0) return `${noun} ${numberRanges(numbers)} by ${phrase}`;
    return `${noun[0].toUpperCase()}${noun.slice(1)} ${numberRanges(numbers)} ${numbers.length === 1 ? 'was' : 'were'} taken by ${phrase}`;
  });
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return `${clauses[0]}.`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}.`;
}

function listSentences(numbered) {
  const items = numbered.map(({ step, number }) => `(${number}) ${stepItem(step)}`);
  const n = numbered.length;
  const sentences = [`The following ${formatCountOf(n, 'step')} ${n === 1 ? 'was' : 'were'} applied${n === 1 ? '' : ', in this order'}: ${items.join('; ')}.`];
  const origins = originSentence(numbered);
  if (origins !== null) sentences.push(origins);
  return sentences;
}

/**
 * The methods text of a branch, in its parts: the abstract (the tracker's
 * first note, or null) and the paragraphs after it, each with its heading
 * (a group's name) or none. `methodsParagraph` joins them; the report shows
 * the abstract on its own.
 *
 * @param {object} options
 * @param {object} options.tracker - A `Tracker` record (`model.js`)
 * @param {string|null} [options.branch] - The branch (id or name); the tracker's main branch when null
 * @param {string|null} [options.to] - The last step covered (on the branch's path); its tip when null
 * @param {{name?: string|null, cells?: number, genes?: number, citation?: string|null,
 *   openCells?: {open: number, of: number, method?: string|null, seed?: number|null}|null}} [options.dataset]
 * @param {string|null} [options.version] - The Cellucid version
 * @param {string|null} [options.cellucidCitation] - How Cellucid is cited (APA)
 * @returns {{abstract: string|null, paragraphs: Array<{heading: string|null, text: string}>}}
 */
export function methodsParts({ tracker, branch = null, to = null, dataset = {}, version = null, cellucidCitation = null }) {
  if (tracker === null || typeof tracker !== 'object' || !Array.isArray(tracker.notes)) {
    throw new TypeError('A methods paragraph needs the tracker');
  }
  const { steps } = branchPath(tracker, { branch, to });
  const taken = steps.filter(step => step.kind !== 'root');
  const flagged = taken.filter(step => step.kind === 'action' && step.status === 'unapplicable');
  const applied = taken.filter(step => !flagged.includes(step) && (step.touches ?? []).length > 0);
  const listed = applied.filter(touchesMethod);
  const presentation = applied.length - listed.length;
  const numbered = listed.map((step, index) => ({ step, number: index + 1 }));

  const opening = [];
  const software = `Cellucid${version ? ` (version ${version})` : ''}`;
  opening.push(`Single-cell data were explored interactively in ${software}${cellucidCitation ? ` [${trimEnd(cellucidCitation)}]` : ''}.`);
  opening.push(datasetSentence(dataset));
  if (listed.length === 0) opening.push('No recorded step changed the data, its annotation or what was computed.');

  const closing = [];
  const squashed = numbered.filter(({ step }) => step.kind === 'squashed').map(({ number }) => number);
  if (squashed.length > 0) {
    closing.push(squashed.length === 1
      ? `For step ${squashed[0]}, only the state it reached was kept, not the operations that led to it.`
      : `For steps ${numberRanges(squashed)}, only the states they reached were kept, not the operations that led to them.`);
  }
  if (presentation > 0) {
    closing.push(
      `${formatCountOf(presentation, 'further step')} only changed the camera, the panel layout, colors or display settings`
      + ` and ${presentation === 1 ? 'is' : 'are'} not listed.`,
    );
  }
  if (flagged.length > 0) {
    closing.push(
      `${formatCountOf(flagged.length, 'recorded step')} no longer applied after an earlier step was removed`
      + ` and ${flagged.length === 1 ? 'is' : 'are'} not included.`,
    );
  }
  closing.push('The complete history, with every parameter, can be reopened from the accompanying Cellucid session file.');

  const abstract = tracker.notes.length > 0 ? tracker.notes[0].text : null;
  const numberOf = new Map(numbered.map(({ step, number }) => [step, number]));
  const runs = groupRuns(listed, tracker);
  const headings = runHeadings(runs);
  const sentencesOf = run => listSentences(run.steps.map(step => ({ step, number: numberOf.get(step) })));
  if (headings.every(heading => heading === null)) {
    const list = runs.flatMap(sentencesOf);
    return { abstract, paragraphs: [{ heading: null, text: [...opening, ...list, ...closing].join(' ') }] };
  }
  const summary = listed.length === 1 ? 'The step applied is listed below.' : `The ${formatCountOf(listed.length, 'step')} applied are listed below, in order.`;
  return {
    abstract,
    paragraphs: [
      { heading: null, text: [...opening, summary, ...closing].join(' ') },
      ...runs.map((run, index) => ({ heading: headings[index], text: sentencesOf(run).join(' ') })),
    ],
  };
}

/**
 * The methods text of a branch, ready to paste: the abstract, then each
 * paragraph (a group's name on the line above its own), blank lines between.
 * @param {Parameters<typeof methodsParts>[0]} options
 * @returns {string}
 */
export function methodsParagraph(options) {
  const { abstract, paragraphs } = methodsParts(options);
  const blocks = paragraphs.map(({ heading, text }) => (heading === null ? text : `${heading}\n${text}`));
  return (abstract === null ? blocks : [abstract, ...blocks]).join('\n\n');
}
