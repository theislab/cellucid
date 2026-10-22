/**
 * @fileoverview The representation picker of the selected view, and the
 * keyboard's 1/2/3 gesture.
 *
 * A view shows one of the dataset's enabled representations (Session › Data
 * mapping), of any dimension; its dimension is the representation's. The
 * picker `#view-representation-select` lists every enabled representation,
 * grouped by dimension ("UMAP · 3D", "PCA (unintegrated) · 2D"), and edits the
 * view selected in Compare views -- its label says which ("View 2 shows").
 * Pressing 1, 2 or 3 shows that dimension's default representation in the
 * selected view; pressed again, it steps through that dimension's enabled
 * representations, and a short notice names what is shown and its place in
 * the cycle ("2D · t-SNE (2 of 3)").
 *
 * @module ui/modules/representation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';

const CYCLE_NOTICE_MS = 2200;

/**
 * The text of one picker option: the representation's short name and its
 * dimension.
 *
 * @param {{name: string, dimension: number}} representation
 * @returns {string}
 */
export function representationOptionText(representation) {
  return `${representation.name} · ${representation.dimension}D`;
}

/**
 * The hover text of one option: what it is read from, and whether it is the
 * dataset's default for its dimension.
 *
 * @param {{label: string, dimension: number, isDefault: boolean}} representation
 * @returns {string}
 */
export function representationOptionTitle(representation) {
  const role = representation.isDefault
    ? `The ${representation.dimension}D default`
    : `A ${representation.dimension}D embedding`;
  return `${role} of this dataset (${representation.label}).`;
}

/**
 * @param {object} options
 * @param {object} options.state
 * @param {{controls: HTMLElement, label: HTMLElement, select: HTMLSelectElement}} options.dom
 * @param {{viewLabel: (viewId: string) => string|null, onViewBadgesMaybeChanged: () => void}} options.callbacks
 *   `viewLabel` names the view the picker edits ("View 2"), or null while
 *   only one view is open.
 */
export function initRepresentationControls({ state, dom, callbacks }) {
  for (const methodName of [
    'cycleRepresentation',
    'getActiveViewId',
    'getEnabledRepresentations',
    'getViewLayoutKey',
    'on',
    'setViewRepresentation',
  ]) {
    if (typeof state?.[methodName] !== 'function') {
      throw new TypeError(`Representation controls require state.${methodName}().`);
    }
  }
  if (
    !(dom?.controls instanceof HTMLElement) ||
    !(dom.label instanceof HTMLElement) ||
    !(dom.select instanceof HTMLSelectElement)
  ) {
    throw new TypeError(
      'Representation controls require the controls block, its label and its select.'
    );
  }
  if (
    typeof callbacks?.viewLabel !== 'function' ||
    typeof callbacks.onViewBadgesMaybeChanged !== 'function'
  ) {
    throw new TypeError(
      'Representation controls require viewLabel() and onViewBadgesMaybeChanged().'
    );
  }
  const { controls, label, select } = dom;
  const ownerDocument = select.ownerDocument;
  const lifecycle = new AbortController();
  let destroyed = false;
  let busy = false;
  let cycleNoticeId = null;

  function selectedLayoutKey(viewId) {
    try {
      return state.getViewLayoutKey(viewId);
    } catch {
      return null;
    }
  }

  function render() {
    if (destroyed) return;
    const representations = state.getEnabledRepresentations();
    const viewId = state.getActiveViewId();
    const current = selectedLayoutKey(viewId);
    controls.hidden = representations.length === 0 || current === null;
    if (controls.hidden) {
      select.replaceChildren();
      return;
    }
    const viewName = callbacks.viewLabel(viewId);
    label.textContent = viewName === null ? 'Shows' : `${viewName} shows`;
    const groups = new Map();
    for (const representation of representations) {
      if (!groups.has(representation.dimension)) {
        const group = ownerDocument.createElement('optgroup');
        group.label = `${representation.dimension}D`;
        groups.set(representation.dimension, group);
      }
      const option = ownerDocument.createElement('option');
      option.value = representation.layoutKey;
      option.textContent = representationOptionText(representation);
      option.title = representationOptionTitle(representation);
      groups.get(representation.dimension).appendChild(option);
    }
    select.replaceChildren(...groups.values());
    select.value = current;
    const shown = representations.find(item => item.layoutKey === current);
    select.title = shown === undefined ? '' : representationOptionTitle(shown);
    select.disabled = busy || representations.length < 2;
    if (busy) {
      select.title = 'Switching…';
    } else if (representations.length < 2) {
      select.title = 'This dataset shows one embedding. Turn more on in Session › Data mapping.';
    }
  }

  async function show(viewId, layoutKey) {
    if (destroyed || busy) return;
    busy = true;
    render();
    const notifications = getNotificationCenter();
    try {
      await state.setViewRepresentation(viewId, layoutKey, { followsDefault: false });
      if (destroyed) return;
      callbacks.onViewBadgesMaybeChanged();
    } catch (error) {
      if (destroyed) return;
      notifications.error(
        error instanceof Error ? error.message : 'The view could not switch embedding.',
        { category: 'dimension' }
      );
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  /**
   * The keyboard gesture for one dimension, on the selected view.
   *
   * @param {number} dimension
   * @returns {Promise<void>}
   */
  async function cycle(dimension) {
    if (destroyed || busy) return;
    const representations = state.getEnabledRepresentations();
    if (!representations.some(item => item.dimension === dimension)) {
      getNotificationCenter().info(
        `No ${dimension}D embedding is on. Turn one on in Session › Data mapping.`,
        { category: 'dimension', duration: CYCLE_NOTICE_MS }
      );
      return;
    }
    busy = true;
    render();
    const notifications = getNotificationCenter();
    try {
      const result = await state.cycleRepresentation(state.getActiveViewId(), dimension);
      if (destroyed) return;
      const shown = state.getEnabledRepresentations()
        .find(item => item.layoutKey === result.layoutKey);
      const text = `${dimension}D · ${shown?.name ?? result.layoutKey}` +
        (result.count > 1 ? ` (${result.position} of ${result.count})` : '');
      if (cycleNoticeId !== null && notifications.hasNotification(cycleNoticeId)) {
        notifications.dismiss(cycleNoticeId);
      }
      cycleNoticeId = notifications.info(text, {
        category: 'dimension',
        duration: CYCLE_NOTICE_MS,
      });
      callbacks.onViewBadgesMaybeChanged();
    } catch (error) {
      if (destroyed) return;
      notifications.error(
        error instanceof Error ? error.message : 'The view could not switch embedding.',
        { category: 'dimension' }
      );
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  }

  select.addEventListener('change', () => {
    if (destroyed) return;
    void show(state.getActiveViewId(), select.value);
  }, { signal: lifecycle.signal });

  const unsubscribes = [
    state.on('view:representation-changed', () => {
      if (!busy) render();
    }),
    state.on('mapping:changed', () => {
      if (!busy) render();
    }),
  ];

  render();

  return {
    render,
    cycle,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycle.abort();
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
