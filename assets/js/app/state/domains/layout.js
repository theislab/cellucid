/**
 * @fileoverview The `layout` state domain: how the page is arranged around
 * the data. Floating panels and where they float, the analysis windows'
 * places and the sizes remembered per analysis, which sidebar sections are
 * open, the sidebar itself, and the theme. History settings › "Panels,
 * windows and theme" switches its recording (History v2 §3.15.5).
 *
 * Value:
 *
 *     {theme: string,                        // the app theme (#theme-select)
 *      sections: {[detailsId]: boolean},     // every accordion section, open or not
 *      panels: [{id, rect: {left, top, width, height}}, …],
 *                                            // floating sections (not analysis windows),
 *                                            // by id: their own box, not what the
 *                                            // stylesheet draws of it
 *      analysis: {windows: [{rect, open}, …],   // each analysis window's own box and
 *                                            // whether it is unfolded, in window order
 *                                            // (the `analysis` domain's windows)
 *                 sizes: {window, expandedView} | null},
 *                                            // the sizes remembered per analysis;
 *                                            // null: the analysis code never loaded
 *      sidebar: {open: boolean, width: number|null}}   // open: shown or hidden as
 *                                            // chosen (never the phone sheet); width:
 *                                            // a width the person dragged it to, null
 *                                            // for the default
 *
 * The theme is part of the dataset's history (the owner's decision,
 * 2026-11-03: layout, panels, docking and theme are steps). Page chrome is
 * not (History v2 §3.3.8): the phone sheet open or closed, the sidebar's
 * scroll and focus, which panel is in front. The sidebar's `open` is the
 * choice its owner keeps (`ui/modules/sidebar-controls.js`), which on the
 * phone layout the sheet does not change. A restore shows
 * it through its control, whose owner also keeps it in this browser
 * (`utils/theme-manager.js`) as the theme new pages open with, exactly as a
 * choice made by hand.
 *
 * Which floating panel is in front is not part of the value: raising a
 * panel is not a step, and a restore leaves the order as it is.
 *
 * Restore docks, floats and places only the panels that differ, through the
 * dockable owner (`dockable-accordions.js` `dock`/`float`/`place`); puts
 * each analysis window at its place and the remembered sizes back through
 * the window manager (`applyWindowPlaces`, `importViewSizes`; the `analysis`
 * domain, restored before this one, opened the windows), sets each section's open state
 * and the theme through the generic control path
 * (`state-serializer/ui-controls.js`), and shows, hides and sizes the sidebar
 * through its owner (`ui/modules/sidebar-controls.js` `show`, `setWidth`:
 * the paths the layout actions take, which keep its state, ARIA and the
 * plot's presented area, and leave the phone sheet as it is), never through
 * its toggle, which asks for a step.
 *
 * @module app/state/domains/layout
 */

import { StyleManager } from '../../../utils/style-manager.js';
import { createUiControlSerializer, isAnalysisWindowSection } from '../../state-serializer/ui-controls.js';
import { sameValue } from './same-value.js';

const THEME_CONTROL_ID = 'theme-select';
const SIDEBAR_WIDTH_VARIABLE = '--sidebar-user-width';

// ---------------------------------------------------------------------------
// Floating panels
// ---------------------------------------------------------------------------

function requireDetailsElement(value, context) {
  if (typeof HTMLDetailsElement === 'undefined' || !(value instanceof HTMLDetailsElement)) {
    throw new TypeError(`${context} must be an HTMLDetailsElement.`);
  }
  if (typeof value.matches !== 'function' || !value.matches('details.accordion-section')) {
    throw new TypeError(`${context} must be a current accordion section.`);
  }
  return value;
}

/** `--pos-*` is written by `StyleManager.setPosition()` as a bare pixel length. */
const PANEL_LENGTH_PATTERN = /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/;

function readPanelLength(frame, property, context) {
  const raw = StyleManager.getVariable(frame, property);
  const match = typeof raw === 'string' ? PANEL_LENGTH_PATTERN.exec(raw.trim()) : null;
  if (match === null) throw new TypeError(`${context} must be an exact pixel length.`);
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new TypeError(`${context} must be an exact pixel length.`);
  return value;
}

function requirePanelFrame(dockable, details, context) {
  const frame = dockable.panelFrame(details);
  if (frame === null || typeof frame !== 'object') throw new TypeError(`${context} must stand in its dockable panel frame.`);
  return frame;
}

/**
 * The geometry a floating panel *has*, which is not always what it shows: a
 * collapsed panel is drawn `height: auto` and a panel wider than the window
 * is capped by `max-width` (`css/components/_accordion.css`). Measuring what
 * is drawn saved the header height of a collapsed panel and narrowed a wide
 * panel on every save on a narrow window; the box is the frame's
 * `--pos-x/y/width/height`, which the dockable owner sets.
 */
function readPanelRect(frame, context) {
  const rect = {
    left: readPanelLength(frame, '--pos-x', `${context} left`),
    top: readPanelLength(frame, '--pos-y', `${context} top`),
    width: readPanelLength(frame, '--pos-width', `${context} width`),
    height: readPanelLength(frame, '--pos-height', `${context} height`),
  };
  if (rect.width <= 0 || rect.height <= 0) throw new RangeError(`${context} width and height must be positive.`);
  return rect;
}

function requireFloatingRoot(dockable) {
  const root = dockable?.floatingRoot;
  if (root === null || typeof root !== 'object' || typeof root.querySelectorAll !== 'function') {
    throw new TypeError('The floating panels need the current floating root.');
  }
  return root;
}

/** Every floating section of the layout (not analysis windows) with its frame. */
function floatingSections(dockable) {
  const sections = [];
  const ids = new Set();
  for (const candidate of requireFloatingRoot(dockable).querySelectorAll('details.accordion-section')) {
    const details = requireDetailsElement(candidate, 'Floating accordion');
    const frame = requirePanelFrame(dockable, details, 'Floating accordion');
    if (!frame.classList.contains('accordion-floating')) throw new TypeError('Every accordion in the floating root must be marked floating.');
    if (isAnalysisWindowSection(details)) continue;
    const id = details.id;
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('Every floating accordion needs a stable nonempty DOM id.');
    if (ids.has(id)) throw new TypeError(`Floating accordion id "${id}" is duplicated.`);
    ids.add(id);
    sections.push({ id, details, frame });
  }
  return sections;
}

/**
 * Every floating section (not analysis windows) and its box, by id.
 *
 * @param {object} dockable - The dockable-accordions owner
 * @returns {Array<{id: string, rect: {left: number, top: number, width: number, height: number}}>}
 */
function captureFloatingPanels(dockable) {
  return floatingSections(dockable)
    .map(({ id, frame }) => ({ id, rect: readPanelRect(frame, `Floating accordion "${id}" geometry`) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Float exactly `panels` (`captureFloatingPanels`'s shape) at their boxes:
 * every record is checked, and every panel it names found, before anything
 * moves; then a panel floating now that is not listed docks, a listed one
 * docked now floats at its box, and a floating one whose box differs is
 * placed there. A panel already where it should be is not touched, so which
 * one is in front stays as it is.
 *
 * @param {object} dockable
 * @param {Array<{id: string, rect: object}>} panels
 */
function applyFloatingPanels(dockable, panels) {
  if (!Array.isArray(panels)) throw new TypeError('The floating panels must be a list.');
  const wanted = new Map();
  panels.forEach((panel, index) => {
    const context = `Floating panel ${index}`;
    if (panel === null || typeof panel !== 'object' || typeof panel.id !== 'string' || panel.id.length === 0) {
      throw new TypeError(`${context} needs a stable nonempty DOM id.`);
    }
    const { left, top, width, height } = panel.rect ?? {};
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw new RangeError(`${context} needs a box with a positive width and height.`);
    }
    if (wanted.has(panel.id)) throw new TypeError(`Floating panel id "${panel.id}" is duplicated.`);
    const details = requireDetailsElement(document.getElementById(panel.id), `Floating panel "${panel.id}" current element`);
    if (isAnalysisWindowSection(details)) throw new TypeError(`Floating panel "${panel.id}" is not part of the saved layout.`);
    wanted.set(panel.id, { rect: panel.rect, details });
  });
  const floating = new Map(floatingSections(dockable).map(section => [section.id, section]));
  for (const [id, { details, frame }] of floating) {
    if (wanted.has(id)) continue;
    dockable.dock(details);
    if (frame.classList.contains('accordion-floating')) throw new Error(`The panel "${id}" could not be docked.`);
  }
  for (const [id, { rect, details }] of wanted) {
    const now = floating.get(id);
    if (now === undefined) {
      dockable.float(details, { left: rect.left, top: rect.top, preferredSize: { width: rect.width, height: rect.height } });
      if (!requirePanelFrame(dockable, details, `Floating panel "${id}"`).classList.contains('accordion-floating')) {
        throw new Error(`The panel "${id}" could not be floated.`);
      }
    } else if (!sameValue(readPanelRect(now.frame, `Floating accordion "${id}" geometry`), rect)) {
      dockable.place(details, rect);
    }
  }
}

// ---------------------------------------------------------------------------
// The domain
// ---------------------------------------------------------------------------

/**
 * The sidebar as the person chose it: shown or hidden (its owner's choice,
 * never the phone sheet, which is chrome) and a width dragged to.
 */
function readSidebar(sidebarLayout) {
  const raw = StyleManager.getVariable(document.documentElement, SIDEBAR_WIDTH_VARIABLE);
  const match = typeof raw === 'string' ? /^(\d+(?:\.\d+)?)px$/.exec(raw.trim()) : null;
  return {
    open: sidebarLayout.isSidebarShown(),
    width: match === null ? null : Number(match[1]),
  };
}

// ---------------------------------------------------------------------------
// The analysis windows' places and the sizes remembered per analysis
// ---------------------------------------------------------------------------

/** The value when the analysis code never loaded: no window, no size remembered. */
const NO_ANALYSIS_LAYOUT = Object.freeze({ windows: Object.freeze([]), sizes: null });

/**
 * The part of the layout the analysis windows make (`layout.analysis`):
 * `{windows: [{rect, open}, …], sizes: {window, expandedView} | null}`, read
 * and put back through the analysis window manager. Pure of the DOM.
 *
 * @param {() => Promise<{analysisWindowManager: object}|null>} analysis - The analyses once their code arrived, or null
 */
export function createAnalysisWindowLayout(analysis) {
  if (typeof analysis !== 'function') throw new TypeError('The layout domain needs the analyses (analysis()).');

  async function capture() {
    const refs = await analysis();
    if (refs === null) return { windows: [], sizes: null };
    return { windows: refs.analysisWindowManager.exportWindowPlaces(), sizes: refs.analysisWindowManager.exportViewSizes() };
  }

  /** Checked whole before anything moves. */
  function check(value) {
    if (value === null || typeof value !== 'object' || Object.keys(value).length !== 2 || !Array.isArray(value.windows)
      || !Object.hasOwn(value, 'sizes') || (value.sizes !== null && typeof value.sizes !== 'object')) {
      throw new TypeError('The analysis windows\' layout must be exactly their places and the sizes remembered per analysis.');
    }
  }

  async function restore(current, value) {
    if (sameValue(current, value)) return;
    const refs = await analysis();
    if (refs === null) {
      if (sameValue(value, NO_ANALYSIS_LAYOUT)) return;
      throw new Error('The analysis tools could not load on this page, so its analysis windows cannot be arranged.');
    }
    // Places first: placing a window remembers its size for its analysis,
    // which the remembered sizes then set exactly. Places for other windows
    // than are open (the analysis domain left as it is) are applied to those
    // both name (`applyWindowPlaces`).
    if (!sameValue(current.windows, value.windows)) refs.analysisWindowManager.applyWindowPlaces(structuredClone(value.windows));
    if (value.sizes !== null && !sameValue(current.sizes, value.sizes)) refs.analysisWindowManager.importViewSizes(structuredClone(value.sizes));
  }

  function describe(a, b) {
    const lines = [];
    if (a.windows.length !== b.windows.length) lines.push(`${b.windows.length} analysis windows placed (was ${a.windows.length})`);
    else {
      b.windows.forEach((place, index) => {
        const was = a.windows[index];
        if (was.open !== place.open) lines.push(`Analysis window ${index + 1} ${place.open ? 'unfolded' : 'folded'}`);
        if (!sameValue(was.rect, place.rect)) lines.push(`Analysis window ${index + 1} moved`);
      });
    }
    if (!sameValue(a.sizes, b.sizes)) lines.push('Analysis sizes remembered');
    return lines;
  }

  return { capture, check, restore, describe };
}

/**
 * @param {{sidebar: HTMLElement, getDockable: () => object|null,
 *   analysis: () => Promise<{analysisWindowManager: object}|null>,
 *   sidebarLayout: {isSidebarShown: () => boolean, showSidebar: (shown: boolean) => void,
 *     setSidebarWidth: (width: number|null) => void}}} options
 */
export function createLayoutDomain({ sidebar, getDockable, analysis, sidebarLayout }) {
  for (const method of ['isSidebarShown', 'showSidebar', 'setSidebarWidth']) {
    if (typeof sidebarLayout?.[method] !== 'function') {
      throw new TypeError('The layout domain needs the sidebar\'s owner (isSidebarShown, showSidebar, setSidebarWidth).');
    }
  }
  const analysisWindows = createAnalysisWindowLayout(analysis);
  const controls = createUiControlSerializer({ sidebar, domains: ['layout'] });

  async function capture() {
    const records = controls.collectUIControls();
    const sections = {};
    let theme = null;
    for (const [id, record] of Object.entries(records)) {
      if (record.type === 'details') sections[id.slice('accordion:'.length)] = record.open;
      else if (id === THEME_CONTROL_ID) theme = record.value;
    }
    const dockable = getDockable();
    return {
      theme,
      sections,
      panels: dockable === null ? [] : captureFloatingPanels(dockable),
      analysis: await analysisWindows.capture(),
      sidebar: readSidebar(sidebarLayout),
    };
  }

  async function restore(value) {
    if (value === null || typeof value !== 'object' || typeof value.sections !== 'object' || !Array.isArray(value.panels)) {
      throw new TypeError('The layout to restore must name its sections, panels, analysis windows and sidebar.');
    }
    analysisWindows.check(value.analysis);
    const current = await capture();
    if (sameValue(current, value)) return;
    const dockable = getDockable();
    if (!sameValue(current.panels, value.panels)) {
      if (dockable === null) throw new Error('Floating panels cannot be arranged on this page.');
      applyFloatingPanels(dockable, value.panels);
    }
    await analysisWindows.restore(current.analysis, value.analysis);
    const records = {};
    for (const [id, open] of Object.entries(value.sections)) records[`accordion:${id}`] = { type: 'details', open };
    if (value.theme !== null) records[THEME_CONTROL_ID] = { type: 'select', value: value.theme };
    controls.restoreUIControls(records)();
    const shown = readSidebar(sidebarLayout);
    if (shown.open !== value.sidebar.open) sidebarLayout.showSidebar(value.sidebar.open);
    if (shown.width !== value.sidebar.width) sidebarLayout.setSidebarWidth(value.sidebar.width);
  }

  return {
    capture,
    restore,
    describe(a, b) {
      const lines = [];
      if (a.theme !== b.theme) lines.push(`Theme ${b.theme}`);
      for (const [id, open] of Object.entries(b.sections)) {
        if (a.sections[id] !== open) lines.push(`Section ${id.replace(/-section$/, '').replace(/-/g, ' ')} ${open ? 'opened' : 'closed'}`);
      }
      const panelsA = new Map(a.panels.map(panel => [panel.id, panel]));
      const panelsB = new Map(b.panels.map(panel => [panel.id, panel]));
      for (const [id, panel] of panelsB) {
        const was = panelsA.get(id);
        if (was === undefined) lines.push(`Panel ${id.replace(/-section$/, '').replace(/-/g, ' ')} floated`);
        else if (!sameValue(was, panel)) lines.push(`Panel ${id.replace(/-section$/, '').replace(/-/g, ' ')} moved`);
      }
      for (const id of panelsA.keys()) if (!panelsB.has(id)) lines.push(`Panel ${id.replace(/-section$/, '').replace(/-/g, ' ')} docked`);
      lines.push(...analysisWindows.describe(a.analysis, b.analysis));
      if (a.sidebar.open !== b.sidebar.open) lines.push(b.sidebar.open ? 'Sidebar shown' : 'Sidebar hidden');
      if (a.sidebar.width !== b.sidebar.width) lines.push(b.sidebar.width === null ? 'Sidebar at its default width' : `Sidebar ${Math.round(b.sidebar.width)} px wide`);
      return lines;
    },
  };
}
