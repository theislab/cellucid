/**
 * @fileoverview A history as pseudocode: one line per step of a branch, each
 * the step's own pseudocode line as recorded (`step.code`), to paste into a
 * message, a notebook or a lab book. Pure (importable in Node). Python
 * (`cellucid.history.pseudocode_text`) and R (`cellucid_pseudocode`) write
 * the same text, pinned by the golden history's `expected.pseudocode`.
 *
 * - The lines follow the branch's path from the root to its tip (or to the
 *   step asked for).
 * - A step taken by an agent or a notebook says so in a trailing comment.
 * - A run of steps in a group opens with `# --- QC ---` and closes with
 *   `# --- end of QC ---`.
 * - A bookmarked step is followed by `# Bookmark: <name>`; a squashed step
 *   by the bookmarks of the steps it replaced too, each `(on a step merged
 *   into this one)`.
 * - A step that no longer applies, a change made outside an action and a
 *   squashed step (which has no line of its own: values only) are kept as
 *   comments, so nothing a history holds is dropped silently.
 *
 * @module app/history/exports/pseudocode
 */

import {
  bookmarksOf, branchPath, groupRuns, originOf, squashPhrase, touchedNames,
} from './step-text.js';
import { idNumber } from '../model.js';
import { formatCountOf } from '../../../utils/format-units.js';

function commentText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function stepLine(step) {
  const names = touchedNames(step).join(', ');
  if (step.kind === 'outside') return `# Changed outside the history${names ? `: ${names}` : ''}`;
  if (step.kind === 'squashed') return `# ${squashPhrase(step.squashed)}${names ? `: ${names}` : ''} (values only)`;
  if (step.status === 'unapplicable') return `# No longer applies (${commentText(step.reason ?? 'not applied')}): ${step.code}`;
  const origin = originOf(step.by);
  return origin.key === 'person' ? step.code : `${step.code}  # ${origin.name}`;
}

/**
 * @param {object} options
 * @param {object} options.tracker - A `Tracker` record (`model.js`)
 * @param {string|null} [options.branch] - The branch (id or name); the tracker's main branch when null
 * @param {string|null} [options.to] - The last step covered (on the branch's path); its tip when null
 * @param {{name?: string|null}} [options.dataset]
 * @param {string|null} [options.version] - The Cellucid version
 * @returns {string}
 */
export function historyPseudocode({ tracker, branch = null, to = null, dataset = {}, version = null }) {
  if (tracker === null || typeof tracker !== 'object') throw new TypeError('Pseudocode needs the tracker');
  const path = branchPath(tracker, { branch, to });
  const taken = path.steps.filter(step => step.kind !== 'root');
  const app = version ? `Cellucid ${version}` : 'Cellucid';
  const upTo = path.to === null ? '' : ` up to step ${idNumber(path.to)}`;
  const lines = [
    `# ${app}${dataset?.name ? ` · ${commentText(dataset.name)}` : ''}`,
    `# Tracker "${commentText(tracker.name)}", branch "${commentText(path.branch.name)}"${upTo}: ${formatCountOf(taken.length, 'step')}`,
  ];
  for (const run of groupRuns(taken, tracker)) {
    const name = run.group === null ? null : commentText(run.group.name);
    if (name !== null) lines.push(`# --- ${name} ---`);
    for (const step of run.steps) {
      lines.push(stepLine(step));
      for (const { name: bookmark, carried } of bookmarksOf(step)) {
        lines.push(`# Bookmark: ${commentText(bookmark)}${carried ? ' (on a step merged into this one)' : ''}`);
      }
    }
    if (name !== null) lines.push(`# --- end of ${name} ---`);
  }
  return `${lines.join('\n')}\n`;
}
