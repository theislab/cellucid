# `app/reads/`: what an agent reads of the open dataset

**Owns:** the read actions of `app/actions/definitions/reads.js`, provided on the page's
dispatcher (`index.js` `installReadActions`): the dataset summary, the fields, a field's
categories, gene search, values of named cells, a field per category (`dataset.js`), the views
and a picture of a view (`views.js`). Names resolve as every action's do (`app/actions/targets/`:
a field by `{source, key}`, a gene by its exact name, a view `"live"` or `"View N"`).

The other reads are provided by what they read: `history.get` by the history
(`app/history/history.js`), `settings.list` and `layout.get` by `ui/modules/settings-actions.js`
and `ui/modules/layout-actions.js`, the analyses' by `analysis/actions.js`.

**Invariants:**
- A read changes nothing a person sees and records no step. A field it needs is read as
  colouring by it would read it (residency only).
- Results are compact JSON (counts, names, top-N tables with N a parameter); per-cell values
  only for the cells asked for, by original position.
- A name that does not resolve is refused with one sentence that says what there is
  (`ActionRefused`), never an internal error.
- The picture is the figure export's own renderer (`figure-export-engine.js` `renderFigure`):
  the same snapshot and drawing as a PNG download, returned instead of downloaded.

**Tests:** `tests/actions-settings-layout-analysis.test.mjs`,
`tests/browser/actions-settings-layout-analysis.spec.mjs`.
