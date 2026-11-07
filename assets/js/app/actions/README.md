# `app/actions/`: the one way state changes

**Owns:** the action catalogue (`catalog.js`: every change and read a person, an agent, a Python
or R host, a session and a replay can make, each defined once with a parameter schema, the state
domains it touches, a timeline label and a pseudocode line), the parameter schema subset
(`schema.js`), the state domain list and registry (`domains.js`), and the dispatcher
(`dispatcher.js`: checks, orders, passes every change of an agent to the person's permissions
(the confirmer, with the owner's estimate of its work), records through the history, rolls a
failed action back), and an outcome as the JSON an agent's tool result
and a host's answer carry (`outcome.js`).

**Entry points:** `defineAction`, `createActionCatalog`, `catalogDocument` (the language-neutral
catalogue Python, R, the agent tools and the docs are generated from), `upgradeParams` (parameters
recorded with an earlier `version` of an action, brought to its version now by its `upgrade`
functions, one version at a time); `createActionDispatcher`
(`dispatch`, `provide`, `recordObserved`, `subscribe` (every dispatch, reads included, as it starts and ends),
`stop` (the work of one agent turn, from its dispatch on: its estimate, a question to the person, the gate, running), `addSettler` and `settle` (a gesture recorded once it settles, a camera
drag, is ended at once when the history moves, so a move never starts before it is a step), `retire` (the application's
teardown: every dispatch under way ends as a cancellation before the state's owners go, and later ones are refused), `running` (the changes a move
waits for), `setConfirmer` (asked of every change of an agent:
`{definition, params, meta, estimate, confirm, detail, stage, asking}`; `asking()` when the person
is asked, which subscribers hear as `asking` and `answered`), `provideEstimate` (the time, bytes and
one phrase an action of a type would take, from what the page measured: `analysis.run`,
`cells.read-genes`, `cells.open`)); `createDomainRegistry` (`provide`, `owner`);
`dispatchFromControl`, `createLatestDispatch`, `reportActionFailure` (`control-dispatch.js`: a control's dispatch, its refusal said in a
notification).

**Meta** of a dispatch: `origin`, `agent`, `connection`, `host`, `turn`, and for a turn the
history's turn record keeps: `model` (an agent's), `conversation`, `message` and `turnLabel`
(what the turn was asked); `signal`. The history alone passes `rewrite` (a deleted step's
dependant applied again into its own record), `replayOf` (the step a replay applies) and
`internal` (a pass through its own gate).

**Names → current objects** (`targets/`, every action and read resolves through these, never a copy
of its own): `fields.js` (a field or gene by `{source, key}`, a category by its label, a deleted
field, a new field name), `pages.js` (a highlight page by its name, a group by its label),
`views.js`, the one owner of view names (a view is `"View N"` as the Compare views list numbers its
rows, the live view View 1 while it is shown, in params, step labels, refusals, comparison lines,
reads and the views list alike), `datasets.js` (a dataset to open: a sample by its id or name, a
dataset of My datasets by its name, else a link), `names.js` (how a refusal lists the names there
are). A name that does not resolve is refused (`ActionRefused`) with
one sentence that says what there is.

**Definitions** (`definitions/`, one pure module per area, listed in `definitions/index.js`):
`params.js` (the parameter schemas several areas name things with: a field, a category, a colour,
cells, a view, an embedding, a highlight page); `history.js` (every operation on the history: its reads, moves (the recording switch among them), edits kept in its journal (groups, squash, clear), deletes asked about with `deletes-saved`, replay and verify, a session file to share (`writes-file`) and a saved state, each as the history, the state only or the steps only, a new AnnData file of the dataset with the state shown applied (`history.anndata.save`, `writes-file`), the printable report and the guided tour, provided by the history (`app/history/history.js`), for what writes it down or reads it out by its persistence (`app/history/persistence-actions.js`, `app/history/anndata-copy-save.js`), and for the tour and the report by the State panel); `fields.js`, `coloring.js`,
`filters.js`, `mapping.js` (fields, labels, colours, filters, the data mapping, the open cells);
`highlights.js`; `views.js` (kept views, layout, selected view, linked cameras, embeddings, cell
visibility); `camera.js` (cameras, navigation mode, resets, camera path); `settings.js`; `layout.js`;
`analysis.js`; `reads.js` (what an agent reads); `datasets.js` (`datasets.list`, and `dataset.open`:
effect `dataset`, it replaces the open dataset and records no step; a whole-file download is
asked about by its implementation, `confirmAt: 'handler'`, once the link says how big it is;
`my-datasets.forget` and `dataset.share-link`); `stored.js` (what this browser keeps, listed and
removed as the Stored dialog does); `exports.js` (the figure, the highlighted cells and a field as
files); `annotation.js` (community annotation: the suggestions, a vote published).

**Acts outside the state** (effect `outside`: a file the person receives, a publication, what this
browser keeps for later visits, removed or saved) record no step and touch no domain, and the
history cannot take them back, so each but `history.save` names its `confirm`. Every one is
classified by name in `app/agent/bridge/data-guard.js` (`OUTSIDE_RESULTS`): its result is names,
sizes, counts and links, never a value of a cell. A feature that needs a gesture of the person the
browser requires (a window opened, a sign-in) takes the path an agent can take instead (Print
report: an `.html` file downloaded, or its text) or is refused with one sentence saying what the
person does first (community annotation before its repository is connected and the person signed
in). `tests/action-catalog-contract.test.mjs` lists the person's features an agent reaches this way
(`PERSON_FEATURES`) and fails on one that is not an action.

**Implementations** live with what owns the state they change (`provide`): the state's own
(`app/state/actions/field-actions.js`), a control's orchestration (`ui/modules/*.js`:
`field-selector.js`, `subsample-control.js`, `gene-read-control.js`, `view-controls.js`,
`representation-controls.js`, `camera-controls.js`, `cinematic-camera/`, `settings-actions.js`,
`layout-actions.js`, `highlight/highlight-actions.js`, `dockable-accordions.js`), the analyses
(`app/analysis/actions.js`), the reads (`app/reads/`), the history (its `history.*` actions: effect
`read`, or `history` for a move or an edit of the history, which records no step), the State panel
(`ui/modules/state/index.js`: `history.tour.start`, `history.tour.stop`, `history.report`), the Open
data controls (`ui/modules/dataset-open-action.js`: `datasets.list`, `dataset.open`), My datasets
(`ui/modules/my-datasets/index.js`: `my-datasets.forget`), Share (`ui/modules/share-dialog.js`:
`dataset.share-link`), the Stored dialog (`ui/modules/kept-stores-dialog.js`: `stored.list`,
`stored.remove`), the figure export (`ui/modules/figure-export/figure-export-ui.js`:
`figure.export`), the export buttons (`ui/modules/cell-exports-ui.js`: `cells.export`,
`field.export`) and the community annotation controls
(`ui/modules/community-annotation-controls.js`: `annotation.suggestions`, `annotation.vote`); each
calls the same function its controls call.

**Versions of parameters** (History v2 §3.8): an action whose steps are recorded (effect `state`,
`view`, `layout`) has a `version` (1 when left out) and `upgrade: {<from>: params => params}` for each
earlier version; a read or a move of the history has none (`version: null`). A step records the
version (`Step.v`); a replay upgrades a copy of its params before it dispatches (`upgradeParams`).
An earlier version whose params hold nothing the next can be made from has the upgrader
`valuesOnlyUpgrade(reason)` (`field.consensus` version 1: one code per cell, where version 2 names
each category's outcome): its steps are put back by their values on the dataset they were recorded
on and flagged with `reason` on another. A step whose params name cells by original position
(`x-cells`, `x-values`: `field.push`, a selection) is applied again only on the dataset it was
recorded on (`history/replay.js` `namesCells`): a cell count equal elsewhere says nothing of the order.
Every version keeps its shape and examples (`tests/fixtures/action-versions/<type>@<version>.json`:
`actionParamsShape` of its params schema, and `examplesOf` it: every property, every `oneOf`
branch), written once by `scripts/generate-action-versions.mjs`;
`tests/action-versions-contract.test.mjs` fails on a shape that changed without a version bump and
an upgrader (rewording does not count), on an older example that no longer upgrades to valid
parameters, and on a file whose bytes are not the pinned ones.

**Confirm kinds** (`ACTION_CONFIRMS`, each a permission kind of `app/agent/presence/permissions.js`):
`writes-file`, `deletes-saved`, `large-download`, `publishes`, and `pauses-recording`
(`history.recording.pause`: while paused, an agent's change cannot be undone on its own).

**Invariants:**
- Every state change a person can make is an action; a control calls `dispatch`, never a
  mutating state method. Settings controls and camera gestures are recorded by observation
  (`recordObserved`), synchronously from their change event. A camera gesture (a drag, a wheel,
  keys) is recorded when the viewer says it settled; an action on the cameras that starts while
  it still moves, or a move of the history, ends it first (`ui/modules/camera-controls.js`), so
  no camera motion is ever met as a change made outside an action. Page chrome is no action and
  no state: the phone sheet open or closed, scroll, focus, which panel is in front, and input
  modes (the selection tool, Select mode). A key reaching the page only through a global
  shortcut records what that shortcut's action records; a chord with Ctrl, ⌘ or Alt and a held
  key's repeats are no shortcut (`ui/onboarding/keyboard-shortcuts.js`). A change that set off more work
  (an analysis's redraw, its run after a delay) passes it as `after`: it is under way from the
  change (`history.idle` waits for it) and recorded once that work settles, one step holding
  all of it.
- Actions name their targets (fields, categories, genes, views) by name, never by position, so a
  step replays on another dataset.
- An action's implementation is provided by the module that owns the state (`provide`); the
  definition here stays pure (importable in Node).
- A domain value is plain data with immutable typed arrays; cells by original position.

**Drift guards:** `classification.js` classifies every public `DataState` method (its mixins in
`app/state/managers/`) and every key of the viewer's public API (`rendering/viewer.js`, read by
`viewerApiNames`) as `reads()`, `internal(reason)` or `mutates(domains, actions)`: the domains it
changes and the actions that own the change. `MUTATION_OWNERS` names the modules that may call
`mutates` methods (an action's implementation, a domain owner, an observation recorder, a
dataset's publication), each with its methods and why; `NAME_COLLISIONS` the same-named methods of
other objects. `tests/action-method-classification-contract.test.mjs` fails on a method not
classified (a new mixin or viewer method), a classification of a method that is gone, an owning
action the catalogue lacks or that does not touch the method's domains;
`tests/action-mutation-owners-contract.test.mjs` fails on a call of a `mutates` method outside
its owners (naming the file, the line and the action to dispatch instead), on an owner entry that
no longer holds, and on a call of an underscore member of the state outside `app/state/`.
The control walk (`tests/browser/helpers/control-walk.mjs`) walks every control the page shows
(discovered from the page's interactive roles, never from a list; what a control opens, makes or
enables is walked too, and every setting `settings.list` names that is shown must be met) on a
fixture dataset in five scenes, operates each as its role is operated and fails on a control that
changes state with no step, keeps a "Changed outside the history" step, makes more than one step
or a step without a label, or whose step undo does not put back exactly (the state fingerprint);
a control that changes nothing is recognised by that. It is a test per part (each sidebar
section, then everything outside them) spread over the spec files
`tests/browser/control-walk-<k>-of-<n>.spec.mjs`, a share each. CI runs each share in a job of its
own (the `control-walk` job of `.github/workflows/test.yml`: `CELLUCID_CONTROL_WALK=only` and
`--shard=<k>/<n>`; the browser job's shards leave the walk out with `CELLUCID_CONTROL_WALK=apart`,
`playwright.config.mjs`), and `--grep "<section id>"` runs one part; each prints where its time
went (by section and phase). The keyboard and chrome walk (`tests/browser/history-keyboard-chrome.spec.mjs`) presses
every global key shortcut, the movement keys, keys no shortcut uses and chords, and fails on a key
that changes state with more or fewer than one step or keeps an outside change; it proves a
keyboard camera gesture is one step, and that the phone sheet changes nothing in the history.
`tests/browser/action-catalogue-coverage.spec.mjs` fails
when an action of the catalogue has no implementation on a page with a dataset open
(`unprovided()`), a domain has no owner (`missing()`), or a method of the live state or viewer is
not classified. `tests/action-reference-contract.test.mjs` fails while the docs' action reference
(`scripts/generate-action-reference.mjs`) differs from the catalogue.

**Declared inputs.** Every definition declares `reads` (required, empty for none, and empty for an
action that records no step): its **result inputs**, what its result is computed from beyond its
parameters and the domains it touches (`ACTION_READ_INPUTS`: state domains, and `history` for
another branch's tip): the open cells, the data mapping, the pages a field is made from, the cells
the filters leave. It may declare `context` (none by default): its **name context**, the state its
parameters' names resolve in and its result does not follow (a field's name in `field-overlays`,
the view in focus in `views`, a gene's name in `mapping`, a step's id in `history`). Shared sets are
named once: `VISIBLE_CELLS_READS` (what decides which cells the view in focus shows, a result
input) and `SHOWN_FIELD_READS` (where a setting of the coloured field resolves, context) in
`definitions/params.js`, an analysis's result and opening inputs in `definitions/analysis.js`. A
step records the value hash of each result input (`app/history/model.js` `Step.reads`): a step of
any action whose result input differs later is stale (`app/history/provenance.js`), and a rename
or a focus change stales nothing. Result inputs and name context together decide a deleted step's
dependent re-apply. `rerun: true` (false by default) says that the same params dispatched again
bring a stale step's own result up to date (`analysis.run`; `highlight.category` and
`highlight.range`, which give a group already on the page the cells the view shows now). Only
those stale steps get Run again in the State panel (`ui/modules/state/step-details.js`). An
action that adds another of what it made, or only sets options, does not. `tests/action-reads-contract.test.mjs` checks the declarations (distinct,
known, never a touched domain, never both, empty for a stepless action, every name a parameter
gives resolved in one of them) and `tests/browser/action-reads.spec.mjs` the property they promise
on the real page: an action applied in two states that differ only in domains it neither touches,
reads nor resolves names in gives the same after-values.

**Tests:** `tests/action-history-core.test.mjs`, `tests/history-actions-contract.test.mjs`, `tests/action-catalog-contract.test.mjs` (every
action of every area), `tests/action-reads-contract.test.mjs` (declared inputs), the area tests (`action-fields-contract`, `action-highlights`,
`action-camera-path`, `actions-settings-layout-analysis`).
