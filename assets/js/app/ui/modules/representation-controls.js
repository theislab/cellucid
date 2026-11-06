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
 * Both are actions implemented here (`app/actions/definitions/views.js`):
 * `view.embedding.set` names the embedding by its obsm key and columns,
 * `view.embedding.default` and `view.embedding.cycle` by its dimension. An
 * embedding without a data mapping name (the in-memory benchmark scene's) is
 * chosen by its dimension when it is that dimension's default, and otherwise
 * only through the 1, 2 and 3 keys: a step names what it shows, and such an
 * embedding has no name another dataset could have.
 *
 * @module ui/modules/representation-controls
 */

import { getNotificationCenter } from '../../notification-center.js';
import { PLACES, placePath } from '../place-names.js';
import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { resolveViewName, viewNameOf } from '../../actions/targets/views.js';
import { throwIfAborted } from '../../../utils/abort.js';

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

/** A refusal the state says in one sentence (an embedding it cannot show). */
function asRefusal(error) {
  return error instanceof RangeError ? new ActionRefused(error.marked ?? error.message) : error;
}

function noEmbeddingOfDimension(dimension) {
  return `No ${dimension}D embedding is on. Turn one on in ${placePath(PLACES.session, PLACES.dataMapping)}.`;
}

/**
 * @param {object} options
 * @param {object} options.state
 * @param {object} options.viewer names the views (`app/actions/targets/views.js`)
 * @param {{controls: HTMLElement, label: HTMLElement, select: HTMLSelectElement}} options.dom
 * @param {{viewLabel: (viewId: string) => string|null, onViewBadgesMaybeChanged: () => void}} options.callbacks
 *   `viewLabel` names the view the picker edits ("View 2"), or null while
 *   only one view is open.
 */
export function initRepresentationControls({ state, viewer, dom, callbacks }) {
  for (const methodName of [
    'cycleRepresentation',
    'getActiveViewId',
    'getEnabledRepresentations',
    'getViewLayoutKey',
    'on',
    'setViewEmbeddingRef',
    'showDefaultRepresentation',
  ]) {
    if (typeof state?.[methodName] !== 'function') {
      throw new TypeError(`Representation controls require state.${methodName}().`);
    }
  }
  for (const methodName of ['getLiveViewHidden', 'getSnapshotViews']) {
    if (typeof viewer?.[methodName] !== 'function') {
      throw new TypeError(`Representation controls require viewer.${methodName}().`);
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
  /** The dimension of a key pressed during a switch, to be done after it. */
  let waitingCycle = null;
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
      select.title = `This dataset shows one embedding. Turn more on in ${placePath(PLACES.session, PLACES.dataMapping)}.`;
    }
  }

  /** What `layoutKey` is called in a notice: "t-SNE". */
  function nameOf(layoutKey) {
    return state.getEnabledRepresentations().find(item => item.layoutKey === layoutKey)?.name ?? layoutKey;
  }

  /**
   * The action that shows `layoutKey` in `viewId`: by its embedding, or by
   * its dimension when it has no name but is its dimension's default.
   */
  function showAction(viewId, layoutKey) {
    const representation = state.getEnabledRepresentations().find(item => item.layoutKey === layoutKey);
    if (representation === undefined) {
      throw new ActionRefused(`${layoutKey} is not an embedding this dataset shows.`);
    }
    const view = viewNameOf(viewer, viewId);
    if (representation.ref !== null && representation.ref !== undefined) {
      return ['view.embedding.set', { view, embedding: { key: representation.ref.key, columns: [...representation.ref.columns] } }];
    }
    if (representation.isDefault) {
      return ['view.embedding.default', { view, dimension: representation.dimension }];
    }
    throw new ActionRefused(
      `${representation.name} has no data mapping name a step could record; the ${representation.dimension} key steps through it.`
    );
  }

  /**
   * Run one action of this picker, with the picker busy meanwhile; a failure
   * is said in one notice and the picker shows what the view shows.
   */
  async function act(build) {
    if (destroyed || busy) return null;
    busy = true;
    render();
    const notifications = getNotificationCenter();
    try {
      const [type, params] = build();
      const { outcome } = await getActions().dispatch(type, params);
      if (destroyed) return null;
      callbacks.onViewBadgesMaybeChanged();
      return outcome;
    } catch (error) {
      if (destroyed || (error instanceof ActionRefused && error.code === 'superseded')) return null;
      notifications.error(
        error instanceof Error ? error.message : 'The view could not switch embedding.',
        { category: 'dimension' }
      );
      return null;
    } finally {
      busy = false;
      if (!destroyed) {
        render();
        if (waitingCycle !== null) {
          const dimension = waitingCycle;
          waitingCycle = null;
          void cycle(dimension);
        }
      }
    }
  }

  /**
   * The keyboard gesture for one dimension, on the selected view.
   *
   * @param {number} dimension
   * @returns {Promise<void>}
   */
  async function cycle(dimension) {
    if (destroyed) return;
    const representations = state.getEnabledRepresentations();
    if (!representations.some(item => item.dimension === dimension)) {
      getNotificationCenter().info(noEmbeddingOfDimension(dimension), {
        category: 'dimension', duration: CYCLE_NOTICE_MS,
      });
      return;
    }
    // A key pressed while a switch finishes is done next, not dropped: the last one, so a held key
    // does not queue a switch per repeat.
    if (busy) {
      waitingCycle = dimension;
      return;
    }
    const outcome = await act(() => [
      'view.embedding.cycle',
      { view: viewNameOf(viewer, state.getActiveViewId()), dimension },
    ]);
    if (outcome === null || destroyed) return;
    const notifications = getNotificationCenter();
    const text = `${dimension}D · ${outcome.embedding}` +
      (outcome.count > 1 ? ` (${outcome.position} of ${outcome.count})` : '');
    if (cycleNoticeId !== null && notifications.hasNotification(cycleNoticeId)) {
      notifications.dismiss(cycleNoticeId);
    }
    cycleNoticeId = notifications.info(text, {
      category: 'dimension',
      duration: CYCLE_NOTICE_MS,
    });
  }

  // The actions this picker and the keys implement (`definitions/views.js`).
  function requireOpen() {
    if (destroyed) throw new ActionRefused('The representation controls are closed.', { code: 'unavailable' });
  }
  const actions = getActions();
  const withdrawals = [
    actions.provide('view.embedding.set', async ({ view, embedding }, { signal }) => {
      requireOpen();
      const viewId = resolveViewName(viewer, view);
      throwIfAborted(signal);
      try {
        await state.setViewEmbeddingRef(viewId, embedding);
      } catch (error) {
        throw asRefusal(error);
      }
      return { view };
    }),
    actions.provide('view.embedding.default', async ({ view, dimension }, { signal }) => {
      requireOpen();
      const viewId = resolveViewName(viewer, view);
      if (!state.getEnabledRepresentations().some(item => item.dimension === dimension)) {
        throw new ActionRefused(noEmbeddingOfDimension(dimension));
      }
      throwIfAborted(signal);
      let layoutKey;
      try {
        layoutKey = await state.showDefaultRepresentation(viewId, dimension);
      } catch (error) {
        throw asRefusal(error);
      }
      return { view, embedding: nameOf(layoutKey) };
    }),
    actions.provide('view.embedding.cycle', async ({ view, dimension }, { signal }) => {
      requireOpen();
      const viewId = resolveViewName(viewer, view);
      if (!state.getEnabledRepresentations().some(item => item.dimension === dimension)) {
        throw new ActionRefused(noEmbeddingOfDimension(dimension));
      }
      throwIfAborted(signal);
      let result;
      try {
        result = await state.cycleRepresentation(viewId, dimension);
      } catch (error) {
        throw asRefusal(error);
      }
      return { view, embedding: nameOf(result.layoutKey), position: result.position, count: result.count };
    }),
  ];

  select.addEventListener('change', () => {
    if (destroyed) return;
    const viewId = state.getActiveViewId();
    const layoutKey = select.value;
    void act(() => showAction(viewId, layoutKey));
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
      for (const withdraw of withdrawals) withdraw();
    },
  };
}
