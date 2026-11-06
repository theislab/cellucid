/**
 * @fileoverview My datasets in Session › Open data: a dropdown like the
 * sample dataset list, for the person's own datasets. Its button names the
 * dataset open now when it is one of the list ("Choose a dataset…" else);
 * its menu offers the five most recently opened (`RECENT_DATASETS`), the one
 * open now marked and not offered again, then All…, which opens the dialog
 * of every one (`dialog.js`). A choice opens its dataset inside the click,
 * so the browser may ask for leave to read a file of this computer
 * (`index.js`). Shown while the list is empty too (its menu then offers
 * All… alone, whose Import… adds the datasets of a library file); its status
 * line says when the list is not kept beyond this page or window.
 *
 * The menu is the Open… menu's (`open-data-menu.js`: keyboard, focus,
 * closing on a press elsewhere), bound again to the items of each drawing.
 *
 * @module ui/modules/my-datasets/menu
 */

import { initOpenDataMenu } from '../open-data-menu.js';
import { RECENT_DATASETS } from '../../../library/my-datasets.js';
import { describeMenuItem } from './model.js';
import { formatCountOf } from '../../../../utils/format-units.js';

/** What the button says while the dataset open now is not one of the list. */
export const CHOOSE_LABEL = 'Choose a dataset…';

/**
 * @param {{root: HTMLElement, button: HTMLButtonElement, menu: HTMLElement, status: HTMLElement}} dom
 * @param {{onChoose: (entry: Object) => void, onAll: (opener: HTMLElement) => void}} handlers - both run
 *   inside the person's click
 * @returns {{render: (view: {entries: Object[], currentId: string|null, now: number,
 *   way: (entry: Object) => 'click'|'ask'|'choose', note: string}) => void, destroy: () => void}}
 */
export function initMyDatasetsMenu(dom, { onChoose, onAll }) {
  for (const key of ['root', 'button', 'menu', 'status']) {
    if (!dom?.[key]) throw new TypeError(`My datasets needs its ${key}.`);
  }
  const doc = dom.button.ownerDocument;
  const lifecycle = new AbortController();
  let binding = null;
  /** The entries of the items drawn, by id. */
  let shown = new Map();
  /** A drawing that waits for the menu to close (its items have the focus). */
  let pending = null;

  function item({ label, hint, title }, attributes) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'open-menu-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.title = title;
    for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
    const labelEl = doc.createElement('span');
    labelEl.className = 'open-menu-item-label';
    labelEl.textContent = label;
    const hintEl = doc.createElement('span');
    hintEl.className = 'open-menu-item-hint';
    hintEl.textContent = hint;
    button.append(labelEl, hintEl);
    return button;
  }

  function draw({ entries, currentId, now, way, note }) {
    const recent = entries.slice(0, RECENT_DATASETS);
    shown = new Map(recent.map(entry => [entry.id, entry]));
    const items = recent.map(entry => {
      const current = entry.id === currentId;
      return item(describeMenuItem(entry, { now, current, way: way(entry) }), {
        'data-dataset-id': entry.id,
        ...(current ? { 'aria-disabled': 'true', 'aria-current': 'true' } : {}),
      });
    });
    const separator = doc.createElement('div');
    separator.className = 'open-menu-separator';
    separator.setAttribute('role', 'separator');
    const all = item({ label: 'All…', hint: formatCountOf(entries.length, 'dataset'), title: 'Every dataset opened in this browser, with its details.' }, { 'data-my-datasets-all': 'true' });
    dom.menu.replaceChildren(...(items.length === 0 ? [] : [...items, separator]), all);
    const current = entries.find(entry => entry.id === currentId) ?? null;
    dom.button.textContent = current?.name ?? CHOOSE_LABEL;
    dom.button.title = current === null ? '' : `${current.name} is open. Choose another of My datasets.`;
    dom.root.hidden = false;
    dom.status.textContent = note;
    dom.status.hidden = note === '';
    binding?.abort();
    binding = new AbortController();
    initOpenDataMenu({
      button: dom.button,
      menu: dom.menu,
      items: [...items, all],
      signal: binding.signal,
      onChoose: chosen => {
        if (chosen === all) {
          onAll(dom.button);
          return;
        }
        const entry = shown.get(chosen.dataset.datasetId);
        if (entry === undefined || chosen.getAttribute('aria-disabled') === 'true') return;
        onChoose(entry);
      },
    });
  }

  // A drawing while the menu is open waits for it to close: its items hold the focus.
  const closed = new MutationObserver(() => {
    if (dom.menu.hidden && pending !== null) {
      const view = pending;
      pending = null;
      draw(view);
    }
  });
  closed.observe(dom.menu, { attributes: true, attributeFilter: ['hidden'] });

  return {
    render(view) {
      if (lifecycle.signal.aborted) return;
      if (!dom.menu.hidden) {
        pending = view;
        return;
      }
      draw(view);
    },
    destroy() {
      closed.disconnect();
      binding?.abort();
      lifecycle.abort();
    },
  };
}
