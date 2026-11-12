/**
 * @fileoverview One line above the graph that says where the tracker in use
 * comes from, while it is one that came from elsewhere (History v2 §3.10,
 * §3.11), until dismissed:
 *
 * - **Loaded from a session file** (`start.kind` import): `Shared · "T cell
 *   analysis" · 3 branches   ▶ Tour  Methods  ✕`, or, for a state shared
 *   without its history, "Shared as a state, without its history".
 * - **A replay** (`start.kind` replay): `Replayed from Sample A · 2 of 16
 *   did not match   Report…  ✕` (the report dialog lists every step).
 *
 * @module ui/modules/state/workflow-banner
 */

import { formatCountOf } from '../../../../utils/format-units.js';
import { ICONS, createIconButton } from '../../components/controls.js';

/**
 * What the banner says of a tracker, or null when it says nothing.
 * @param {object} tracker - a Tracker record
 * @param {number} branches - its branches not archived
 * @returns {{kind: 'import'|'state'|'replay', text: string, tone: string, unmatched: number}|null}
 */
export function bannerOf(tracker, branches) {
  const start = tracker?.start ?? null;
  if (start === null) return null;
  if (start.kind === 'import') {
    const steps = tracker.steps instanceof Map ? [...tracker.steps.values()] : tracker.steps ?? [];
    const state = steps.length === 2 && steps[1].kind === 'squashed' && steps[1].squashed?.cause === 'share';
    const from = start.from?.tracker?.name ?? tracker.name;
    return state
      ? { kind: 'state', text: `Shared as a state, without its history · “${from}”`, tone: 'info', unmatched: 0 }
      : { kind: 'import', text: `Shared · “${from}” · ${formatCountOf(branches, 'branch', 'branches')}`, tone: 'info', unmatched: 0 };
  }
  if (start.kind === 'replay') {
    const report = start.report ?? [];
    const unmatched = report.filter(entry => entry.outcome === 'unmatched').length;
    const replayed = report.filter(entry => entry.outcome !== 'skipped').length;
    const dataset = start.from?.dataset?.name ?? 'another dataset';
    return {
      kind: 'replay',
      text: unmatched === 0 ? `Replayed from ${dataset}: every step matched` : `Replayed from ${dataset}: ${unmatched} of ${formatCountOf(replayed, 'step')} did not match`,
      tone: unmatched === 0 ? 'success' : 'warning',
      unmatched,
    };
  }
  return null;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.box - `#history-banner`
 * @param {{tour: () => void, methods: () => void, report: (opener: HTMLElement) => void}} options.ops
 */
export function createWorkflowBanner({ box, ops }) {
  const doc = box.ownerDocument;
  const dismissed = new Set();
  let trackerId = null;
  const text = doc.createElement('span');
  text.className = 'history-banner-text';
  const tour = doc.createElement('button');
  tour.type = 'button';
  tour.className = 'btn btn-compact';
  tour.textContent = '▶ Tour';
  tour.addEventListener('click', () => ops.tour());
  const methods = doc.createElement('button');
  methods.type = 'button';
  methods.className = 'btn btn-compact';
  methods.textContent = 'Methods';
  methods.title = 'Copy the methods paragraph';
  methods.addEventListener('click', () => ops.methods());
  const report = doc.createElement('button');
  report.type = 'button';
  report.className = 'btn btn-compact';
  report.textContent = 'Report…';
  report.addEventListener('click', () => ops.report(report));
  const close = createIconButton({ label: 'Dismiss', icon: ICONS.close, className: 'history-banner-close' });
  close.addEventListener('click', () => {
    if (trackerId !== null) dismissed.add(trackerId);
    box.hidden = true;
  });
  box.append(text, tour, methods, report, close);

  return {
    /** @param {import('./history-source.js').TrackerView|null} view */
    render(view) {
      trackerId = view?.id ?? null;
      const said = view === null || dismissed.has(view.id) ? null : bannerOf(view.tracker, view.branches().filter(b => !b.archived).length);
      box.hidden = said === null;
      if (said === null) return;
      box.dataset.tone = said.tone;
      text.textContent = said.text;
      tour.hidden = said.kind === 'replay';
      methods.hidden = said.kind === 'replay';
      report.hidden = said.kind !== 'replay';
    },
  };
}
