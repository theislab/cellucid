# `ui/modules/state/`: the State panel

**Owns:** the sidebar's State section (History v2 §3.10): the session's **Share…** and **Load…**,
and the history of the dataset shown as a **branch graph**, drawn from the page's current history
(`app/history/current.js`). Header `History (i)  🔍 ↶ ↷ ⚙ ⋯`; status line
`[● Recording] Main ▾ · 14 steps · ⚠ 2 stale`; everything else opens on demand.

| Module | What it draws or does |
| --- | --- |
| `index.js` | `initStateSection`: follows the current history; the header (search, undo, redo, History settings, the menu), the status line (recording switch, branch picker, steps, stale, "Next change starts …" with Cancel), the menu's "Save AnnData with this state…" (`history.anndata.save`, whose progress, outcome and refusals the action tells itself), the graph and its rows' operations (`ops`: show, branch here, compare, rename, bookmark, revert, branch without, delete a step or branch, archive, main, lock, group, ungroup, merge into one step, undo a turn, trackers, clear keeping the state, the state at a time), each asked first when it loses work, each a history action; one operation at a time (`run`: busy, failures told once); while paused, Keep / Discard / Cancel before the history moves (§3.15.1); replays with their progress and report |
| `history-source.js` | **The seam to the history core.** `trackerView` (the tracker in use as accessors and lazily derived facts: the path, branches by fork step, a branch's own steps, stale results, paused changes), `createHistoryActions` (the only way the panel acts: a `history.*` action as the person's), and the plans a confirmation is worded from (`branchDeletePlan`, `revertProblem`, `stepRun`, `groupRange`, `squashProblem`) |
| `graph-layout.js` | pure: the graph's rows (laid out whole, or from the layout before when steps were only appended; the path, fork stubs, expanded branches, turns, groups, folded runs of view and layout steps, the paused marker, search folding), their lanes and line segments, aria places; selection ranges; what to open to reveal a step |
| `graph.js` | the virtualised tree: rows in view (plus overscan, the focused row and the open details) kept by key and rewritten when they change; measured row heights (labels wrap, never truncate); click selects, Shift+click extends, double-click or a double tap shows, `›` opens details, ▸ expands; the tree keys; the hover hint; "Shown: step 12 ↑" |
| `step-details.js` | the details of a step, a branch, a turn, a group or a run, and their actions (a step's: Show this step's view, its cameras by `camera.set`) |
| `notes.js` | notes on a step, branch, group, turn or tracker: Markdown subset from text nodes only, add, edit, remove |
| `search.js` | the search box and Filter menu (who, kind, notes, bookmarks, flags, Part changed…, Day…); `stepMatcher` (pure), the history's own rule (`app/history/search.js` `stepMatches`) |
| `branch-picker.js` | the branch picker under the status line: trackers, branches with ⋯, archived, New branch |
| `branch-map-dialog.js` | the branch map: every branch as a lane graph (the graph, all expanded) and a table; archive or delete several |
| `share-dialog.js` | Share this history: History / Current state only / Steps only; branches, notes, conversations, Recently deleted, results, times, dataset; What's inside; `history.share` |
| `recently-deleted.js` | Recently deleted: every undoable edit, Restore, Empty |
| `workflow-banner.js` | the line above the graph for a loaded, shared-state or replayed tracker |
| `replay-report-dialog.js` | a replay's report, each step and what became of it; Use instead ▾ for a field, category or gene not here, and Replay again with these names |
| `memory-dialog.js` | where the history's memory goes: the status line's ⚠ while it passes what the memory budget leaves for it, the largest parts named once, every part with Show, and Recently deleted… |
| `diff-dialog.js` | Compare two steps (`history.diff`), each step once under its branch |
| `saved-states-dialog.js` | Load: saved states of this browser (open, replay here, rename, delete), save the history shown as history, state or steps (`history.save`), open or replay a session file |
| `compare.js` | two branches side by side: the views' own actions (`view.keep` with each branch, `view.layout.set`) |
| `tour.js` | the guided tour: captions with notes and group chapters, camera flights, pause, previous, next, stop; each step shown by `history.jump` |
| `share.js` | copy pseudocode or methods (`history.pseudocode`, `history.methods`), the printable report with pictures drawn on demand (none stored) |
| `keyboard.js` | Ctrl/⌘+Z and Ctrl/⌘+Shift+Z, left to text fields (only those: a slider, checkbox or select has no undo of its own), dialogs and a selection in progress |
| `model.js` | pure: how long ago, who acted (the agent's model), flags, a row's words and accessible name, the status line, the tour plan (the graph's keys are the History list group of `ui/onboarding/shortcut-table.js`, which the panel and the History tip list) |
| `dataset-facts.js` | the dataset's name, size, citation and open cells, for the exports |
| `shared.js` | glyphs, the undo keys of this platform, every question asked in the app's one confirmation dialog (`askHistory` over `components/confirm-dialog.js`), the edit toast with Undo, failures told |

**Entry points:** `initStateSection` (from `ui/core/ui-coordinator.js`), `createBranchComparison`,
`datasetFactsOf`.

**The seam to the history core** (`history-source.js`). The panel reads `history.active` (a
`Tracker` of `app/history/model.js`; collections as maps by id or the model's lists),
`history.trackers()`, `history.subscribe`, `history.catalog`, and the runtime state that is not a
record: `history.pending()` ("Branch here": `{name, from}`), `history.stale()` (`[{step, cause, inputs, causes}]`, each input with its own cause, read as a map by step),
`history.pausedChanges()` (domains differing while paused) and `history.setPausedChoice(choice,
{remember})` (the paused card's Keep and go / Discard and go), and what a delete would do before it is
asked (`history.deletePlan(id)`, `history.branchDeletePlan(ref, {withSubBranches})`), the values
a step kept and what is shown (`history.valueAt(step, domain)`, `history.shownValue(domain)`: Show this
step's view, the tour's cameras while camera moves are not recorded), and where its memory goes
(`history.pool.byteLength()`, `history.memoryParts()`). It acts only through catalog actions.

**Invariants:**
- Nothing here keeps a history of its own: every part reads the current history and redraws when it
  tells of a change, at most once a frame and only while the panel can be seen. A dataset switch
  publishes another history (or none) and the panel follows.
- Every operation is a `history.*` catalog action dispatched as the person's, the path an agent, a
  notebook and a replay take; the panel calls no history mutator (History v2 §6 test 3).
- The graph's DOM holds the rows in view, in the tree's order, never the whole history; a new step
  rewrites only the rows whose words changed, and is laid out from the layout before (only the path's
  last row and what follows it are laid out again).
- One counting rule: steps are counted without the opening (status line, picker, map, stubs, the
  pill, accessible names, Compare); a step is named by its number (`Step 12`) everywhere.
- Nothing truncates: names and labels wrap and rows grow.
- Owner rule (§3.10): click selects, double-click shows, `›` opens details, in the sidebar, the branch
  map and on a phone.
- Undo keys never take a key that something else owns: text fields, open dialogs and menus, and a
  selection in progress (its own step undo, until Confirm).
- The panel's controls are not session controls (`data-state-serializer-skip` on the section).

**Tests:** `tests/state-graph-layout.test.mjs` (rows, lanes, plans), `tests/state-panel-model.test.mjs`
(words, keys), `tests/history-exports.test.mjs` (exports), `tests/browser/history-graph.spec.mjs`
(the panel on a page), `tests/browser/history-stress.spec.mjs` (the graph at 10k steps and 100
branches), `tests/browser/history-replay-other-dataset.spec.mjs`.
