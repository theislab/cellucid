/**
 * @fileoverview The sections' open state and the theme as actions, and the
 * layout read (`app/actions/definitions/layout.js`).
 *
 * Opening or closing a section and choosing the theme are done with native
 * controls (a section's `<summary>`, the Theme select) whose owners apply
 * them; a person's change is recorded by observation of the event it causes,
 * so the restore paths (a session, a history jump) that set the same controls
 * need nothing here. An agent's or a replay's change is applied through the
 * same controls: a section's `open`, the select's value and its `change`, the
 * path a session restore takes. Floating, docking and placing a section are
 * the dockable panels' (`app/dockable-accordions.js`); showing and resizing
 * the sidebar are the sidebar's (`ui/modules/sidebar-controls.js`).
 *
 * @module ui/modules/layout-actions
 */

import { ActionRefused } from '../../actions/dispatcher.js';
import { ThemeManager } from '../../../utils/theme-manager.js';
import { isApplyingControls } from '../../state-serializer/ui-controls.js';

/**
 * @param {{
 *   actions: ReturnType<typeof import('../../actions/dispatcher.js').createActionDispatcher>,
 *   dockable: ReturnType<typeof import('../../dockable-accordions.js').initDockableAccordions>,
 *   describeSidebar: () => {shown: boolean, width: number},
 *   themeSelect: HTMLSelectElement,
 * }} options
 * @returns {() => void} Removes the handlers and the observation.
 */
export function installLayoutActions({ actions, dockable, describeSidebar, themeSelect }) {
  for (const method of ['provide', 'recordObserved']) {
    if (typeof actions?.[method] !== 'function') throw new TypeError(`Layout actions need the action dispatcher (${method}).`);
  }
  for (const method of ['resolveSection', 'describeSections']) {
    if (typeof dockable?.[method] !== 'function') throw new TypeError(`Layout actions need the dockable panels (${method}).`);
  }
  if (typeof describeSidebar !== 'function') throw new TypeError('Layout actions need the sidebar.');
  if (!(themeSelect instanceof HTMLSelectElement)) throw new TypeError('Layout actions need the Theme select.');
  const ownerDocument = themeSelect.ownerDocument;

  /** Whether `layout.theme.set` is dispatching the select's change (not a person's). */
  let applying = false;
  const titleOf = details => details.querySelector(':scope > summary')?.textContent?.replace(/\s+/g, ' ').trim() || details.id;

  const removers = [
    actions.provide('layout.section.open', ({ section, open }) => {
      const details = dockable.resolveSection(section);
      if (details.open === open) return null;
      details.open = open;
      return { panel: titleOf(details) };
    }),
    actions.provide('layout.theme.set', ({ theme }) => {
      if (themeSelect.value === theme && ThemeManager.getTheme() === theme) return null;
      themeSelect.value = theme;
      applying = true;
      try {
        themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      } finally {
        applying = false;
      }
      if (ThemeManager.getTheme() !== theme) {
        throw new ActionRefused(`The ${theme} theme could not be shown.`, { code: 'refused', type: 'layout.theme.set' });
      }
      return { theme };
    }),
    actions.provide('layout.get', () => ({
      panels: dockable.describeSections(),
      sidebar: describeSidebar(),
      theme: ThemeManager.getTheme(),
    })),
  ];

  function record(type, params, outcome) {
    actions.recordObserved(type, params, {}, outcome)
      .catch(error => console.error(`[Layout] ${type} could not be recorded:`, error));
  }

  /**
   * A section opened or closed. `toggle` fires for a change made by a person
   * and for one made by code alike (a restore, an undock that opens the
   * panel); the history records only what differs from what it shows, so a
   * change it already holds is no step.
   */
  function onToggle(event) {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches('details.accordion-section')) return;
    if (details.id.length === 0 || details.classList.contains('analysis-window-panel')) return;
    let section;
    try {
      section = dockable.resolveSection(details.id);
    } catch {
      return;
    }
    if (section !== details) return;
    record('layout.section.open', { section: details.id, open: details.open }, { panel: titleOf(details) });
  }

  function onThemeChange() {
    if (applying || isApplyingControls()) return;
    const theme = themeSelect.value;
    if (theme !== 'light' && theme !== 'dark') return;
    record('layout.theme.set', { theme }, { theme });
  }

  // `toggle` does not bubble: it is heard on the way down.
  ownerDocument.addEventListener('toggle', onToggle, true);
  themeSelect.addEventListener('change', onThemeChange);

  return () => {
    ownerDocument.removeEventListener('toggle', onToggle, true);
    themeSelect.removeEventListener('change', onThemeChange);
    for (const remove of removers) remove();
  };
}
