/**
 * @fileoverview The `active-field` state domain: what each view is colored
 * by, a field of `obs` or a gene (`var`), or nothing.
 *
 * Value: `{views: [ref|null, …]}` (live first, then kept views:
 * `view-list.js`), each `ref` a field reference (`fields.js`): `{source,
 * key}` with the key the dataset gave the field, or `{source, user}` for a
 * field the person or a notebook made. A gene is `{source: 'var', key}`,
 * its key in the gene list the data mapping shows.
 *
 * Restore reads the field first (its values or codes, as choosing it does)
 * and makes it the view's active field through the state (`setActiveField`,
 * `setActiveVarField`, `clearActiveField`), view by view.
 *
 * @module app/state/domains/active-field
 */

import { fieldName, fieldRef, loadField, requireField, whenGenesListed } from './fields.js';
import { differingViews, inEachView, requireViewsFit, viewIdsOf, viewOwner, viewReadPart } from './view-list.js';
import { viewNameInValue } from '../../actions/targets/views.js';

/** What one view (the state or a view context) is colored by. */
export function captureViewActiveField(owner) {
  const source = owner.activeFieldSource;
  if (source !== 'obs' && source !== 'var') return null;
  const index = source === 'obs' ? owner.activeFieldIndex : owner.activeVarFieldIndex;
  const field = (source === 'obs' ? owner.obsData : owner.varData)?.fields?.[index];
  if (field === undefined || field === null) return null;
  return fieldRef(field, source);
}

async function restoreFocusedActiveField(state, ref, signal) {
  if (ref === null) {
    if (state.activeFieldSource !== null) state.clearActiveField();
    return;
  }
  if (ref.source === 'var') await whenGenesListed(state, signal);
  const found = requireField(state, ref, {}, 'the field a view is colored by');
  await loadField(state, ref, found, signal);
  // Read again: loading may have published another gene list.
  const { index } = requireField(state, ref, {}, 'the field a view is colored by');
  const result = ref.source === 'var' ? state.setActiveVarField(index) : state.setActiveField(index);
  if (result === null) {
    throw new Error(`"${fieldName(state, ref)}" cannot color a view now: it is deleted.`);
  }
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createActiveFieldDomain({ state, viewer, refreshUi }) {
  return {
    // A step read the view it acted in: staleness compares that view's part alone.
    readPart: viewReadPart,
    capture() {
      return { views: viewIdsOf(viewer).map(id => captureViewActiveField(viewOwner(state, id))) };
    },
    async restore(value, { signal = null } = {}) {
      const ids = viewIdsOf(viewer);
      requireViewsFit(value, ids, 'fields the views are colored by');
      const current = ids.map(id => captureViewActiveField(viewOwner(state, id)));
      const indices = differingViews(current, value.views);
      await inEachView(state, ids, indices, (_viewId, index) => restoreFocusedActiveField(state, value.views[index], signal));
      if (indices.length > 0) refreshUi();
    },
    /** `context.liveHidden`: the live view is hidden at the later value (`views` domain), so the list numbers the kept views from 1; `context.viewLabels`: the views' names there (`viewLabelsInValue`). */
    describe(a, b, { liveHidden = false, viewLabels = null } = {}) {
      const lines = [];
      const count = Math.max(a.views.length, b.views.length);
      for (let v = 0; v < count; v++) {
        const before = a.views[v] ?? null;
        const after = b.views[v] ?? null;
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const prefix = count > 1 ? `${viewNameInValue(v, liveHidden, viewLabels)}: ` : '';
        lines.push(after === null
          ? `${prefix}not colored by a field`
          : `${prefix}colored by ${fieldName(state, after)}${before === null ? '' : ` (was ${fieldName(state, before)})`}`);
      }
      return lines;
    },
  };
}
