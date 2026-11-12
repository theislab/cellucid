/**
 * @fileoverview The collapsible sections of the Session panel: Subsampling
 * (Cells to open and Genes read for: `subsample-control.js`,
 * `gene-read-control.js`) and Data mapping (`data-mapping-controls.js`).
 *
 * Each is a disclosure under a section heading, collapsed by default, whose
 * header says what it holds in one line while collapsed (`setSummary`), so
 * nothing is hidden silently: "100% cells · genes 6%", "3 embeddings ·
 * UMAP 2D". Whether each is open is this viewer's preference, kept in this
 * browser (`localStorage`, every access guarded: a window that keeps nothing
 * starts collapsed) and never in a session or the address.
 *
 * What leads to a control inside one (a gene legend's or an analysis's line
 * to Genes read for, a notice to the data mapping) opens it first
 * (`expandSessionSection`), with the Session panel and the sidebar.
 *
 * @module ui/modules/session-sections
 */

import { bindDisclosure } from '../components/controls.js';
import { formatShare, formatCompactCount } from '../../../utils/format-units.js';
import { webStorage } from '../../../utils/web-storage.js';

/** The sections, by name: their header button and summary ids. */
export const SESSION_SECTIONS = Object.freeze({
  subsampling: Object.freeze({ toggle: 'reading-toggle', summary: 'reading-summary' }),
  dataMapping: Object.freeze({ toggle: 'data-mapping-toggle', summary: 'data-mapping-summary' }),
});

/** Where the sections' open state is kept in this browser. */
const STORAGE_KEY = 'cellucid_session_sections';

function readOpen(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? null;
    const parsed = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOpen(storage, name, open) {
  try {
    const next = { ...readOpen(storage), [name]: open };
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A window that keeps nothing: the section stays as it is for this visit.
  }
}

function storageOf(ownerDocument) {
  return webStorage('localStorage', ownerDocument.defaultView);
}

/**
 * The Subsampling summary: the share of the dataset's cells open, and, when
 * genes are read for a sample of them, its share of the open cells ("100%
 * cells · genes 0.17%"); "" with no dataset.
 *
 * @param {{nObs: number, kept: ArrayLike<number>|null}|null} subset - The open cells (`getCellSubset`)
 * @param {{cells: number, of: number}|null} genes - The gene sample (`DataState.getGeneSample`)
 * @param {{cells: number, target: number}|null} [growth] - Genes being read for more cells
 * @param {{cells: number, target: number}|null} [opening] - A progressive opening growing in
 *   place (`open-cells-resize.js`): the share it grows to, and how many cells are read so far
 *   ("100% cells · reading 131K"), as the Subsampling control shows it. The cells open so far
 *   alone ("23% cells") read as a subsample someone chose.
 * @returns {string}
 */
export function subsamplingSummary(subset, genes, growth = null, opening = null) {
  if (subset === null || subset === undefined) return '';
  if (opening !== null && opening !== undefined) {
    return `${formatShare(opening.target, subset.nObs)} cells · reading ${formatCompactCount(opening.cells)}`;
  }
  const open = subset.kept === null ? subset.nObs : subset.kept.length;
  const cells = `${formatShare(open, subset.nObs)} cells`;
  if (growth !== null && growth !== undefined) return `${cells} · reading genes ${formatCompactCount(growth.cells)}`;
  return genes === null || genes === undefined ? cells : `${cells} · genes ${formatShare(genes.cells, genes.of)}`;
}

/**
 * Open section `name` (`SESSION_SECTIONS`) if it is collapsed, as a click
 * on its header does (the preference is kept); the Session panel opens too.
 * True when it is there.
 *
 * @param {Document} ownerDocument
 * @param {keyof typeof SESSION_SECTIONS} name
 * @returns {boolean}
 */
export function expandSessionSection(ownerDocument, name) {
  const section = SESSION_SECTIONS[name];
  if (section === undefined) throw new RangeError(`No Session section "${String(name)}".`);
  const panel = ownerDocument.getElementById('session-section');
  if (panel !== null && 'open' in panel && !panel.open) panel.open = true;
  const header = ownerDocument.getElementById(section.toggle);
  if (header === null) return false;
  if (header.getAttribute('aria-expanded') !== 'true') header.click();
  return true;
}

/**
 * Bind the sections' headers: each opens and closes its content, starts as
 * this viewer left it (collapsed the first time), and keeps the choice.
 *
 * @param {Document} ownerDocument
 * @returns {{setSummary: (name: keyof typeof SESSION_SECTIONS, text: string) => void, destroy: () => void}}
 */
export function initSessionSections(ownerDocument) {
  const lifecycle = new AbortController();
  const storage = storageOf(ownerDocument);
  const open = readOpen(storage);
  for (const [name, section] of Object.entries(SESSION_SECTIONS)) {
    const header = ownerDocument.getElementById(section.toggle);
    if (header === null) throw new TypeError(`The Session section "${name}" needs its header #${section.toggle}.`);
    const content = ownerDocument.getElementById(header.getAttribute('aria-controls'));
    bindDisclosure({
      header,
      content,
      expanded: open[name] === true,
      onToggle: next => writeOpen(storage, name, next),
      signal: lifecycle.signal,
    });
  }
  return {
    setSummary(name, text) {
      const section = SESSION_SECTIONS[name];
      if (section === undefined) throw new RangeError(`No Session section "${String(name)}".`);
      const summary = ownerDocument.getElementById(section.summary);
      if (summary !== null && summary.textContent !== text) {
        summary.textContent = text;
        summary.title = text;
      }
    },
    destroy() {
      lifecycle.abort();
    },
  };
}
