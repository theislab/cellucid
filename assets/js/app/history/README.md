# `app/history/`: the action history

**Owns:** the history's records (`model.js`: tracker, branch, group, step of each kind, squash,
note, turn, journal entry, with their exact fields, rules, constructors, validators and the names
rule; `historyModelDocument` is what `history_model.schema.json`, Python's and R's reading model, is
generated from), and the history's core (History v2, H1):
- `tree.js`: a tracker held live (the model's records by id in Maps) with the indexes that keep
  reads and moves from growing with the history: each step's depth, so a common ancestor, "is A on
  B's path", a jump's path and redo cost the steps between, never the depth; walks are loops, never
  recursion. `valuesAt` is the plain reading (from the root) every other is checked against;
  `valuesFrom` moves values from one step to another through their common ancestor.
- `history.js`: the controller. The dispatcher's recorder (one step per action that changed
  something, on the branch the head is on, with who acted, how long, the version of its parameters,
  its pseudocode and the hashes of its result inputs; coalescing only into the step just recorded;
  a domain that follows another, `DERIVED_DOMAINS`, captured with it; an observed change read as
  its effects settle when another change of its domains followed it, else at its turn), moves
  (undo, redo, jump, switch), the recording switch and the detail switches, replays (a squashed
  step or an outside change puts its values back on its own dataset; a parameter naming a step
  names the step the replay made of it), load and import. **Every move and every journaled edit
  runs alone** (`exclusive`: actions wait at the gate, the actions and observed changes under way
  finish first, a change observed meanwhile is recorded after it against what is shown then); the
  inner operations (`jumpNow`, `journaled`, `removeSteps`, …) refuse to run outside one. The pool
  keeps only what something refers to: a capture nothing took is released once nothing shows it,
  and a gesture merged into one step keeps one value (`value-pool.js` `release`, `hold`). Verify
  and a delete compare values in their owners' canonical form (`canonical`: generated ids renamed,
  times dropped). A step of a Verify that could not run (`replaySteps` `failures`: anything but a
  refusal, a field that could not be read) gives no verdict, and whatever happens the state shown
  comes back before the scratch tracker goes; if it cannot, that tracker stays in use and says so,
  so what is shown and the tracker in use always agree. `api.active` is the live tracker,
  read-only for every reader.
- `actions.js`: the history's own catalogue actions (every `history.*` but share, save and the
  saved-states list, which persistence provides), each resolving its names and answering its
  result schema, and the estimates of the long ones; `delete-restore.js`: deleting steps (only the
  steps whose touched domains, or whose inputs but for generated ids, changed are applied again)
  and restoring from Recently deleted. Both take the history's context (`h`: its operations, and
  getters and setters of what it holds), never the page.
- `branches.js`: names (unique by key, refused like ids), where a new step goes (a new branch when
  the head is not its branch's tip, the branch is locked, or "Branch here" is pending; an agent's
  is named after it), and the structural edits as pure changes: delete a branch (its own steps
  after the last fork go; the shared ones join the oldest branch forking there), take steps out,
  squash a run (the squashed step keeps the run's last id; notes and bookmarks carried), groups.
- `journal.js`: every structural edit as the exact records it replaced and made (group edits as
  memberships); a restore puts them back exactly, as an entry of its own (tried on the records and
  checked whole, rolled back when the result would not be a valid tracker; a step added below one
  since or a move since keeps it exact), or the history restores as new objects (steps, a squash's
  run in full, applied again by name as branches, each line on its restored parent, journaled
  itself) when later edits changed what the entry made; undoing a rename whose old name was taken
  since is refused with the name to use instead; emptying drops the patches.
- `turns.js`: turn records (agent, model, conversation, message, label, branch), the branch binding
  (`moved`), and what undoing a turn would do (`turnUndoPlan`: back to before it, or only its own
  steps when others interleaved).
- `provenance.js`: what a step read (`Step.reads`: its result inputs, the catalogue's `reads`), and
  which steps of any action are stale at the head, with their cause. The state its parameters'
  names resolve in is the action's `context`, never recorded, so a rename or a focus change never
  marks a step stale.
- `search.js`: steps by words and filters (`stepMatches`, the one rule `history.search` and the
  State panel's search box apply). `describe.js`: `history.summary`, the paged
  `history.get`, `history.step`.
- `replay.js`: a saved history's plan (a branch, main by default), the name mapping
  (`mapParams`, by the parameter schema: fields, genes, categories; `mappingWith`, the names a
  report's "Use instead" chose added from the recorded ones), the report in words.

Beside the core: the content-addressed pool of domain values (`value-pool.js`: SHA-256 of the
canonical text, written in one synchronous pass after the arrays' digests; its byte count is a
counter kept as values come and go; `bytesAdded` attributes it, on demand, to the parts
`history.memoryParts()` names: "Highlights at step 31: 8 MB"), a value as a JSON skeleton plus the typed arrays it names
(`value-parts.js`: what the session file and the autosave store; `step-records.js`: which values a
step names, every step of a tracker, a step and a journal entry as stored), the dataset's history from its
opening to its replacement (`dataset-history.js`), the history kept in this browser and the saved
states (`autosave.js` over `autosave-store.js`, IndexedDB `cellucid-history`), the heavy-feature
settings (`history-settings.js`), the page's current history (`current.js`), the history in
words (`exports/`: pseudocode, methods paragraph, printable report), and "Save AnnData with this
state…" (`anndata-copy-save.js`, the action `history.anndata.save`: the state shown applied to a
new `.zarr.zip` of the dataset by the apply plan Python and R follow, `exports/anndata-copy.js`;
a new file from the save dialog, or a spool downloaded whole; aborted, never closed, and the
spool removed on a failure or a cancel).

**The History v2 model** (`model.js`; History v2 §3.2, §3.8, §3.15), what the core (H1), the
persistence (H2) and the panel (H3) build on, each record checked whole by its validator:
- **Steps of four kinds** (`Step.kind`): the `root`; an `action`, which records the version of its
  parameters (`Step.v`, the definition's `version`: a replay brings older parameters up with
  `upgradeParams`, `app/actions/catalog.js`, or puts a values-only version's step back by its values
  on its own dataset, `valuesOnlyUpgrade`; a step naming cells by position replays only there,
  `replay.js` `namesCells`); a change made `outside` an action; and a `squashed`
  step, which has no action and says what it stands for (`Step.squashed`, a `Squash`:
  `{cause, count, by, carried}`, label from `squashedLabel`). Squashing (`history.squash`), clearing
  the history keeping the state (`history.clear`, branch `FRESH_START_BRANCH_NAME`), resuming after a
  pause and sharing a state only (`scope.content: 'state'`) all make this one record.
- **Squashing steps in the middle of a branch** (cause `steps`): the squashed step takes the id of
  the range's last step, the one documented exception to ids never being reused, so a step or a
  branch after the range keeps its parent and no other branch is rewritten (a range with a fork
  anywhere but at its last step is refused, `forksInside`). It stays inside one group (and keeps
  it) or covers whole groups (which go with it, `cutsGroup`); the notes and bookmarks of the steps
  it replaces move to it (`carried`), never refused; and its `count` adds up theirs (a squashed one
  counts its own). Its journal entry is held to all of it (`checkSquashEntry`).
- **Groups** (`Group`, ids `g<n>`, counter `nextGroup`): a named run of consecutive steps of one
  branch. The step names its group (`Step.group`) and the group lists no step, so a group costs the
  same whatever it spans and a deleted step leaves it consistent; it holds whole turns and no
  group. Turns, replays and auto-folded runs stay display groups, not records.
- **The recording switch** (`Tracker.paused`: null while recording, else `{at, by, draft}`): who
  paused it and who acted meanwhile, and the draft of what differs from the head as value hashes,
  so the autosave keeps the work of a paused period across a crash (its values count as
  referenced: never pruned). Pausing records nothing; resuming (or a move, a save, a share while
  paused) adds one squashed step (`cause: 'paused'`) for what differs; a file keeps `draft: null`.
  The detail switches of History settings (camera, layout) are a preference of this browser, never
  in the model (§3.15.5).
- **No stored pictures** (§3.15.7): no step, chunk or scope holds one; the report draws them from
  the live view (`history-settings.js` `reportPictures`), an agent reads `view.picture`.
- **Scope** of a file (`Scope.content`: `history`, `state`, `steps`; `results`: `include`,
  `recompute`) and what it leaves out are checked against what the file holds (`validateSession`).
- The journal's ops are the history actions' types without `history.` (`JOURNAL_OPS`), and `load`,
  a tracker loaded beside the others from a file (no change of its own; undoing it removes the
  tracker to Recently deleted, `removeTracker`, the one way a tracker goes); a patch
  holds the exact steps, branches, groups and turns an edit replaced or made, and a group edit only
  which steps each group held (`memberships: [{group, from, to}]`), never its steps.

**Invariants:**
- The value of domain D at step S is the after-value of the nearest step on the path root → S
  that touched D, or the root's; showing a step restores only the domains whose value differs.
- A step is never dropped: one that no longer applies is kept with `status: 'unapplicable'` and
  the reason.
- A replay (`history.replay`, "run my workflow on my next sample") starts a new tracker on the state
  shown whose start names where its steps come from (`start.kind 'replay'`, a `Link`; its report
  and name mapping kept), and dispatches each step again by name (origin `replay`, the step it
  replays in `replayOf`, its parameters brought to this catalogue's version) while the person's
  actions wait at the gate. A step that does not apply here changes nothing and is kept, flagged
  with the reason; a step flagged where it was recorded is kept flagged; a step of an unknown
  action, or recorded with a newer version, is kept flagged ("Recorded with a newer Cellucid"); a
  squashed step is values only, flagged; a change made outside the steps is skipped; a stop keeps
  the steps applied before it. The source's domain values are never put back.
- Paused (`Tracker.paused`): changes apply and make no step; the draft of what differs from the
  head is kept on the tracker (`recording` events when it changes); resuming, a move (the person's
  choice: keep, the default, or discard) and Save, Share or a load (`settlePaused`) make it one
  squashed step. A domain History settings switched off is not recorded, not moved by the history
  and still captured in the steps made meanwhile.
- Deleting a step applies again only the steps below it whose action writes or reads a domain whose
  value changed there, each on its new parent's values (an outside change loses the domains the
  deleted step changed); Cancel puts everything back exactly.
- A jump holds the dispatcher's gate and waits for running actions; changes a restore causes are
  not steps. A history retired (its dataset replaced) puts nothing more back.
- A change made outside an action is kept as its own step ("Changed outside the history") and
  warned about; tests treat it as a failure. Before a dataset's first tracker starts (its
  starting view is put back with `showValues`), actions are applied and not recorded.
- A load is all or nothing: the active head is shown as soon as its values are read, the rest is
  read while it is shown, and any failure (or Cancel) puts back what was shown and keeps the
  trackers there were.
- Hashing uses `app/utils/sha256.js`, so the history works outside a secure context too.
- The autosave writes every change within a task of it, only what changed (the steps, turns,
  journal entries and messages an event names, the tracker's own record), each value once by hash,
  each sub-value once by name (parts) and each array once by digest (cell sets in the cell-set
  encoding), in one IndexedDB transaction. A history is kept once it holds anything of the person's
  (a step, a conversation, a note, a paused draft). One page writes a saved state (a Web Lock, and
  the store's writer check): a second tab continuing it opens a copy. A saved state removed while it
  is written is written whole again; a full storage pauses it and says so once, and any removal of
  saved states, in any tab, resumes it.
- The pool's typed arrays are part of the working set (`data/memory-budget.js`, part `history`).

**Tests:** `tests/history-anndata-copy.test.mjs` (the apply plan against the golden's), `tests/history-anndata-copy-save.test.mjs` (where the bytes go), `tests/history-v2-core.test.mjs`, `tests/history-tree-properties-*.test.mjs` (2,100
seeded random operation sequences in three shards, `history-tree-properties.mjs`: every invariant
after each operation, older restores, interleaved turns, two writers at once, loads beside, each
step's before-values its parent's, no loose value in the pool), the review's regressions by area
(`tests/history-v2-concurrency`, `-restore`, `-turns`, `-paused`, `-replay-steps`, `-pool`,
`-canonical`, `-derived-domains`, `-stale` `.test.mjs`, over `tests/history-fake-page.mjs`),
`tests/session-selection-tool-contract.test.mjs` (page chrome), `tests/history-catalogue-contract.test.mjs`,
`tests/history-hunt-regressions.test.mjs`, `tests/history-model-contract.test.mjs`, `tests/history-model-schema.test.mjs`,
`tests/history-golden-fixture.test.mjs`, `tests/action-versions-contract.test.mjs`, `tests/action-history-core.test.mjs`, `tests/session-history-file.test.mjs`,
`tests/history-autosave.test.mjs`, `tests/session-serializer-contract.test.mjs`,
`tests/history-exports.test.mjs`, `tests/history-replay-other-dataset.test.mjs`,
`tests/browser/history-replay-other-dataset.spec.mjs`.
