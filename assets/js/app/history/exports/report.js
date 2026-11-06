/**
 * @fileoverview A history as a printable report: the tracker's abstract and
 * notes, the dataset and the software, the methods text, every step of one
 * branch (by group, each group under its name with its notes) with who took
 * it, when, its bookmark, its parameters, what it changed, its notes and,
 * for the steps the person picked, a picture of the views after it; then the
 * pseudocode. Pure (importable in Node): it returns one self-contained HTML
 * document that the page opens in its own window, where the person reads,
 * prints or saves it as PDF.
 *
 * No picture is stored in a history (History v2 §3.15.7): the caller draws
 * the picked steps from the live view at print time and passes them in
 * (`pictures`); `reportPictureDefaults` names the default picks (the
 * bookmarks and the last step of each group).
 *
 * The document is styled for paper as much as for the screen: system colours
 * (black on white unless the reader's browser says otherwise), page breaks
 * kept out of a step, and every text escaped (notes are shown as their text,
 * never as HTML).
 *
 * @module app/history/exports/report
 */

import {
  actorsOf, bookmarksOf, branchPath, groupRuns, originOf, parameterFacts, runHeadings, squashPhrase, touchedNames,
} from './step-text.js';
import { methodsParts } from './methods.js';
import { historyPseudocode } from './pseudocode.js';
import { idNumber } from '../model.js';
import { formatCount, formatCountOf } from '../../../utils/format-units.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** A date and time as the person's locale writes it (the report is read by people). */
export function formatWhen(ms, locale = undefined) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * The steps that get a picture unless the person picks others: each
 * bookmarked step (a squashed step keeping a replaced step's bookmark
 * included) and the last step of each group, on the path the report
 * covers, in path order.
 *
 * @param {object} tracker - A `Tracker` record
 * @param {{branch?: string|null, to?: string|null}} [options] - As `reportDocument` takes them
 * @returns {string[]} Step ids
 */
export function reportPictureDefaults(tracker, { branch = null, to = null } = {}) {
  const taken = branchPath(tracker, { branch, to }).steps.filter(step => step.kind !== 'root');
  const picked = new Set(taken.filter(step => bookmarksOf(step).length > 0).map(step => step.id));
  for (const run of groupRuns(taken, tracker)) if (run.group !== null) picked.add(run.steps[run.steps.length - 1].id);
  return taken.filter(step => picked.has(step.id)).map(step => step.id);
}

/** What the report says of a step beside its sentence: why it is not an ordinary action step, or null. */
function stepFlag(step) {
  if (step.kind === 'squashed') return `${squashPhrase(step.squashed)}. Only the state it reached is kept, not the operations.`;
  if (step.kind === 'outside') return 'Changed outside the recorded steps. Only the state it reached is kept.';
  if (step.status === 'unapplicable') return `No longer applies${step.reason ? `: ${step.reason}` : ''}`;
  return null;
}

/**
 * The steps of a branch as report entries, by runs of grouped steps (each
 * under its heading, `runHeadings`: its group's name, "Before <group>" or
 * "After <group>"; none when the path has no group): each step's number on the path, sentence, who acted (everyone, for a squashed
 * step), when, its bookmarks, the action's title and parameters as facts,
 * the parts of the state changed, its flag and its notes.
 *
 * @param {object} options
 * @param {object} options.tracker - A `Tracker` record
 * @param {string|null} [options.branch]
 * @param {string|null} [options.to]
 * @param {{has: (type: string) => boolean, get: (type: string) => object}} options.catalog
 * @returns {Array<{heading: string|null, group: {id: string, name: string, notes: object[]}|null, entries: Array<{id: string, number: number,
 *   label: string, kind: string, by: string[], at: number|null, bookmarks: Array<{name: string, carried: boolean}>,
 *   facts: Array<{label: string, value: string}>, changed: string[], flag: string|null,
 *   notes: Array<{text: string, by: string, at: number|null, carried: boolean}>}>}>} `carried`: kept by a
 *   squashed step from the steps it replaced
 */
export function reportEntries({ tracker, branch = null, to = null, catalog }) {
  if (typeof catalog?.has !== 'function' || typeof catalog?.get !== 'function') {
    throw new TypeError('A report needs the action catalogue');
  }
  const taken = branchPath(tracker, { branch, to }).steps.filter(step => step.kind !== 'root');
  const numberOf = new Map(taken.map((step, index) => [step.id, index + 1]));
  const runs = groupRuns(taken, tracker);
  const headings = runHeadings(runs);
  return runs.map((run, index) => ({
    heading: headings[index],
    group: run.group,
    entries: run.steps.map(step => {
      const facts = [];
      if (step.kind === 'action') {
        const definition = catalog.has(step.type) ? catalog.get(step.type) : null;
        facts.push({ label: 'Action', value: definition === null ? `${step.type} (not known to this version)` : definition.title });
        facts.push(...parameterFacts(step.params, definition?.params ?? null));
      }
      return {
        id: step.id,
        number: numberOf.get(step.id),
        label: step.label,
        kind: step.kind,
        by: [...new Set(actorsOf(step).map(by => originOf(by).name))],
        at: step.at,
        bookmarks: bookmarksOf(step),
        facts,
        changed: touchedNames(step),
        flag: stepFlag(step),
        notes: step.notes.map(note => ({
          text: note.text, by: originOf(note.by).name, at: note.at,
          carried: step.kind === 'squashed' && step.squashed.carried.notes.includes(note.id),
        })),
      };
    }),
  }));
}

const STYLE = `
@page { margin: 16mm 14mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 180mm; padding: 12mm 0; background: Canvas; color: CanvasText;
  font: 10.5pt/1.45 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
h1 { font-size: 16pt; font-weight: 600; margin: 0 0 2mm; }
h3 { font-size: 10.5pt; font-weight: 600; margin: 5mm 0 1mm; }
h2 { font-size: 11.5pt; font-weight: 600; margin: 8mm 0 2mm; padding-bottom: 1mm; border-bottom: 0.3mm solid GrayText; }
p { margin: 0 0 2mm; }
.meta { color: GrayText; font-size: 9pt; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.6mm 4mm; margin: 0; font-size: 9.5pt; }
dt { color: GrayText; }
dd { margin: 0; overflow-wrap: anywhere; }
ol.steps { list-style: none; margin: 0; padding: 0; }
ol.steps > li { break-inside: avoid; padding: 2.5mm 0; border-bottom: 0.2mm solid GrayText; }
.step-head { display: flex; gap: 3mm; align-items: baseline; }
.step-n { min-width: 7mm; font-variant-numeric: tabular-nums; color: GrayText; }
.step-label { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
.step-by, .step-at { font-size: 9pt; color: GrayText; white-space: nowrap; }
.step-body { margin: 1.5mm 0 0 10mm; }
.step-flag { font-size: 9pt; font-weight: 600; }
.step-bookmark { font-size: 9pt; font-weight: 600; white-space: nowrap; }
ul.notes { list-style: none; margin: 1mm 0 0; padding: 0; font-size: 9.5pt; }
ul.notes > li { margin: 0 0 1mm; overflow-wrap: anywhere; }
.step-changed { font-size: 9pt; color: GrayText; margin-top: 1mm; }
figure { margin: 2mm 0 0; }
figure img { display: block; max-width: 100%; max-height: 110mm; border: 0.2mm solid GrayText; }
figcaption { font-size: 8.5pt; color: GrayText; margin-top: 1mm; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 9pt/1.4 ui-monospace, Menlo, Consolas, monospace;
  border: 0.2mm solid GrayText; padding: 3mm; margin: 0; }
.note { font-size: 9pt; color: GrayText; }
footer { margin-top: 8mm; font-size: 8.5pt; color: GrayText; }
@media print { body { padding: 0; } .no-print { display: none; } }
`;

function factRows(rows) {
  return rows.map(row => `<dt>${esc(row.label)}</dt><dd>${esc(row.value)}</dd>`).join('');
}

function noteList(notes, locale) {
  if (notes.length === 0) return '';
  const items = notes.map(note => `<li>${esc(note.text)} <span class="meta">· ${esc(note.by)}${note.carried ? ', on a merged step' : ''}`
    + `${Number.isFinite(note.at) ? `, ${esc(formatWhen(note.at, locale))}` : ''}</span></li>`);
  return `<ul class="notes">${items.join('')}</ul>`;
}

function stepItem(entry, picture, locale) {
  return `<li>
<div class="step-head"><span class="step-n">${entry.number}</span><span class="step-label">${esc(entry.label)}</span>`
    + entry.bookmarks.map(({ name, carried }) => `<span class="step-bookmark"${carried ? ' title="On a step merged into this one"' : ''}>`
      + `★ ${esc(name)}${carried ? ' (merged)' : ''}</span>`).join('')
    + `<span class="step-by">${esc(entry.by.join(', '))}</span><span class="step-at">${esc(formatWhen(entry.at, locale))}</span></div>
<div class="step-body">${entry.flag === null ? '' : `<p class="step-flag">${esc(entry.flag)}</p>`}`
    + `${entry.facts.length > 0 ? `<dl>${factRows(entry.facts)}</dl>` : ''}`
    + `${entry.changed.length > 0 ? `<p class="step-changed">Changed: ${esc(entry.changed.join(', '))}</p>` : ''}`
    + noteList(entry.notes, locale)
    + `${picture === null ? '' : `<figure><img src="${esc(picture.src)}" alt="${esc(picture.alt)}"><figcaption>After step ${entry.number}</figcaption></figure>`}</div>
</li>`;
}

/**
 * The report of one branch of a tracker (its main branch unless named), up
 * to its tip or to `to`.
 *
 * @param {object} options
 * @param {object} options.tracker - A `Tracker` record (`model.js`)
 * @param {string|null} [options.branch] - The branch (id or name); the tracker's main branch when null
 * @param {string|null} [options.to] - The last step covered (on the branch's path); its tip when null
 * @param {{has: (type: string) => boolean, get: (type: string) => object}} options.catalog
 * @param {number} options.generatedAt
 * @param {string} [options.title]
 * @param {string|null} [options.version]
 * @param {string|null} [options.cellucidCitation]
 * @param {{name?: string|null, id?: string|null, cells?: number, genes?: number, citation?: string|null,
 *   openCells?: {open: number, of: number, method?: string|null, seed?: number|null}|null}} [options.dataset]
 * @param {Map<string, {src: string, alt: string}>} [options.pictures] - Step id → picture of the views after
 *   it, drawn by the caller from the live view for the steps picked (never read from the history)
 * @param {string|null} [options.picturesNote] - Why there are no pictures, when there are none
 * @param {string|null} [options.locale]
 * @returns {string} A whole HTML document
 */
export function reportDocument({
  tracker, branch = null, to = null, catalog, generatedAt, title = 'History report', version = null, cellucidCitation = null,
  dataset = {}, pictures = new Map(), picturesNote = null, locale = undefined,
}) {
  if (tracker === null || typeof tracker !== 'object') throw new TypeError('A report needs the tracker');
  const path = branchPath(tracker, { branch, to });
  const sections = reportEntries({ tracker, branch, to, catalog });
  const count = sections.reduce((sum, section) => sum + section.entries.length, 0);
  const methods = methodsParts({ tracker, branch, to, dataset, version, cellucidCitation });
  const pseudocode = historyPseudocode({ tracker, branch, to, dataset, version });

  const datasetRows = [];
  if (dataset?.name) datasetRows.push({ label: 'Dataset', value: dataset.name });
  if (dataset?.id && dataset.id !== dataset.name) datasetRows.push({ label: 'Identity', value: dataset.id });
  if (Number.isFinite(dataset?.cells)) datasetRows.push({ label: 'Cells', value: formatCount(dataset.cells) });
  if (Number.isFinite(dataset?.genes)) datasetRows.push({ label: 'Genes', value: formatCount(dataset.genes) });
  const open = dataset?.openCells ?? null;
  if (open !== null && Number.isFinite(open.open) && Number.isFinite(open.of) && open.open < open.of) {
    datasetRows.push({ label: 'Cells open', value: `${formatCount(open.open)} of ${formatCount(open.of)}` });
  }
  if (dataset?.citation) datasetRows.push({ label: 'Citation', value: dataset.citation });
  datasetRows.push({ label: 'Tracker', value: tracker.name });
  datasetRows.push({ label: 'Branch', value: path.to === null ? path.branch.name : `${path.branch.name}, up to step ${idNumber(path.to)}` });
  datasetRows.push({ label: 'Steps', value: formatCountOf(count, 'step') });
  datasetRows.push({ label: 'Software', value: version ? `Cellucid ${version}` : 'Cellucid' });

  const otherNotes = [
    ...tracker.notes.slice(1).map(note => ({ text: note.text, by: originOf(note.by).name, at: note.at })),
    ...path.branch.notes.map(note => ({ text: note.text, by: originOf(note.by).name, at: note.at })),
  ];
  const methodsHtml = methods.paragraphs
    .map(({ heading, text }) => `${heading === null ? '' : `<h3>${esc(heading)}</h3>`}<p>${esc(text)}</p>`).join('\n');
  const stepsHtml = sections.map(section => {
    const list = `<ol class="steps">\n${section.entries.map(entry => stepItem(entry, pictures.get(entry.id) ?? null, locale)).join('\n')}\n</ol>`;
    if (section.heading === null) return list;
    const groupNotes = section.group === null ? [] : section.group.notes.map(note => ({ text: note.text, by: originOf(note.by).name, at: note.at }));
    return `<h3>${esc(section.heading)} <span class="meta">· ${esc(formatCountOf(section.entries.length, 'step'))}</span></h3>`
      + `${noteList(groupNotes, locale)}\n${list}`;
  }).join('\n');

  const subtitle = [dataset?.name, version ? `Cellucid ${version}` : 'Cellucid', formatWhen(generatedAt, locale)]
    .filter(Boolean).map(esc).join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}${dataset?.name ? ` · ${esc(dataset.name)}` : ''}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p class="meta">${subtitle}</p></header>
${methods.abstract === null ? '' : `<section><h2>Abstract</h2><p>${esc(methods.abstract)}</p></section>\n`}`
    + `${otherNotes.length === 0 ? '' : `<section><h2>Notes</h2>${noteList(otherNotes, locale)}</section>\n`}`
    + `<section><h2>Dataset</h2><dl>${factRows(datasetRows)}</dl></section>
<section><h2>Methods</h2>${methodsHtml}</section>
<section><h2>Steps</h2>${picturesNote ? `<p class="note">${esc(picturesNote)}</p>` : ''}
${count > 0 ? stepsHtml : '<p class="note">No steps were taken.</p>'}</section>
<section><h2>Pseudocode</h2><pre>${esc(pseudocode)}</pre></section>
<footer>Made with Cellucid. The session file holds this history with every parameter and reopens it.</footer>
</body>
</html>
`;
}
