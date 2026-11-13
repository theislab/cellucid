# `app/history/exports/`: a history in words

**Owns:** the pure text a history is shared as, made from the history's records
(`app/history/model.js`): how a step is said (`step-text.js`: who acted, the
parts of the state it changed, its parameters as facts, what a squashed step
stands for, the path an export covers and its runs of grouped steps), the
pseudocode (`pseudocode.js`: each step's stored `code` line), the methods text
(`methods.js`), and the printable report (`report.js`: one self-contained HTML
document with the abstract and notes, the dataset, the methods text, every step
by group with its bookmark, parameters, notes and the picture its caller drew,
and the pseudocode); and the apply plan of "Save AnnData with this state…"
(`anndata-copy.js`: one step of a tracker as the rows cellucid-python's
`apply_cellucid_session_to_anndata` and cellucid-r's `cellucid_apply_session()`
plan, and the changes a copy of the dataset writes for them, `CopyChanges`:
renamed obs columns and categories in place, user fields and highlights as
obs columns, gene sets in `uns['cellucid']['gene_sets']` and as boolean var
columns `cellucid_gene_set__<name>` (`geneSetColumns`; the packages write
the same, pinned by `expected.apply.sequence[].var_columns`), each written,
renamed or relabeled column's colors in `uns['<column>_colors']` as the
packages keep them (`colorChanges`: a categorical user field with the colors
it is shown in, in the view in focus, any other column written with none, a
rename carrying them, a merged category taking its first category's color,
and a dataset column recolored in the view in focus with the colors it is
shown in, a `column-colors` row each: `planColumnColors`, `openingPalette`),
`history_applied` with `package: 'web'`).

**Entry points:** `historyPseudocode`, `methodsParagraph` + `methodsParts`,
`reportDocument` + `reportEntries` + `reportPictureDefaults`, `formatWhen`,
`originOf`, `originPhrase`, `squashPhrase`, `bookmarksOf`, `parameterFacts`, `branchPath`,
`groupRuns`, `runHeadings`, `pathOf`; `chooseStep`, `planAnnDataCopy`,
`unwritableName`, `highlightColumn`, `geneSetColumns`, `historyApplied` (`anndata-copy.js`: the
dataset it plans against comes through a `CopyTarget`, the open cells as the
cells the state is known on). Each export takes `{tracker, branch, to}`:
a `Tracker` record, one of its branches (id or name; the main branch when
null) and the last step covered (its tip when null), so any branch exports
without being shown.

**Invariants:**
- Pure: no DOM, no page state; importable in Node. The State panel
  (`app/ui/modules/state/`) gathers what they need (the tracker, the branch
  and step shown, the catalog, the dataset's facts, the version, and the
  report's pictures drawn from the live view) and opens or copies the result.
- They read a step's `kind`, `by`, `squashed`, `group`, `bookmark` and
  `notes`, and the tracker's `groups` and `notes` (the first is the abstract,
  which opens the methods text and the report); never the tracker's recording
  switch.
- Nothing a history holds is dropped silently: a step that no longer applies,
  a change made outside an action and a squashed step (recording paused,
  steps merged, history cleared, a state shared: values only) are written as
  what they are.
- Groups are sections: headings in the methods text and the report
  (`runHeadings`: the group's name, or "Before"/"After" it for steps in no
  group), `# --- QC ---` … `# --- end of QC ---` in the pseudocode.
- No picture is read from a history (none is stored): the report shows only
  the pictures its caller passes, by step id.
- A step is said from its recorded label, line and parameters (names, never
  positions), so a shared history reads the same on any machine. Python
  (`cellucid.history`) and R (`R/history.R`) write the same methods text and
  pseudocode, pinned by the golden history's `expected.methods` and
  `expected.pseudocode`.

- The apply plan is the packages' (`expected.apply.sequence` of the golden
  history pins its rows, its requires and its provenance, plan after plan on
  the same dataset); a cell the viewer did not open is unknown (missing in a
  field's column, `<NA>` in a highlight's), never "not selected".

**Tests:** `tests/history-exports.test.mjs`, `tests/history-golden-fixture.test.mjs`,
`tests/history-anndata-copy.test.mjs`.
