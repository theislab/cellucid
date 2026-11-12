# `app/state/actions/`: the state's own action implementations

**Owns:** the implementations of the actions that need nothing but the state
(`app/actions/definitions/{fields,coloring,filters,mapping}.js`): field
renames, deletes, restores and purges, fields made from highlight pages or
pushed by a notebook, category renames, merges and deletes, category colors
and continuous color settings, every filter (categories, cells kept of a
category, ranges, outliers, turned off, removed), cells hidden one by one,
gene sets, and the data mapping (`field-actions.js`). The names their
parameters give are resolved by `app/actions/targets/` (a field by
`{source, key}`, a category by its label, a deleted field by the name it had,
a highlight page by its name), as every action's are.

The actions whose implementation is a control's orchestration live with the
control: `color.by` and `field.duplicate` (`ui/modules/field-selector.js`),
`cells.open` (`ui/modules/subsample-control.js`), `cells.read-genes`
(`ui/modules/gene-read-control.js`).

**Entry points:** `installFieldActions({state, fieldLock})` (called once by
`ui/core/ui-coordinator.js`; returns the remover).

**Invariants:**
- A handler calls the `DataState` method the control called before it
  dispatched, after resolving every name; a name that does not resolve is
  refused (`ActionRefused`) with one sentence that lists what there is.
- A handler returns a small outcome (names, counts, ids) or null when nothing
  changed; never a per-cell array.
- Nothing here touches the DOM.

**Tests:** `tests/action-fields-contract.test.mjs`,
`tests/viewer-host-command-handler-contract.test.mjs`,
`tests/browser/actions-fields.spec.mjs`.
