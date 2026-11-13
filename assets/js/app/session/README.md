# `app/session/`: session files (the history in one file)

**Owns:** the `.cellucid-session` file of the open dataset (format 4): saving its history, loading
one back into the history, and putting a dataset's published starting view back
(`session-serializer.js` holds the `SessionSerializer` class, `index.js` its factory `createSessionSerializer`); the format itself (`history-file.js`:
manifest, chunks, verification), its framing (`bundle/`) and codecs (`codecs/`: gzip, cell sets,
varints); starting views (`published-default.js`, `catalog-default-session.js`); what a session
says about its dataset (`session-context.js`: the dataset fingerprint, the fields its state uses),
where the dataset opens from (`dataset-source-record.js`), the cells and genes it was saved on
(`cell-subset-record.js`), what wrote the file (`app-stamp.js`: the Cellucid version, the catalog's
digest, each action's parameter shape), the closed-schema assertions every owner validates with
(`schema-contract.js`); the analysis results a shared file left out, run again once it is
open (`recompute-results.js`); and what a reading of the same dataset with other cells keeps
(`view-carry.js`, every state domain but the cells, through the domains' owners).

**Entry points:** `createSessionSerializer({state, dataSourceManager, getHistory, dispatcher,
onLoaded})` (`index.js`): `createSessionBundle`, `downloadSession`, `restoreFromBlob`,
`loadSessionFromFile`, `loadSavedHistory` (a saved state of the autosave),
`restorePublishedDefaultState`, `readSessionDataset`, `pickSessionFile`, `openSessionFile` (a
session file as a saved history to replay, `app/history/replay.js`); `writeHistoryFile`, `openHistoryFile`,
`readHistoryFileManifest` (`history-file.js`); `trimToPublishedDefault`,
`assertPublishedDefaultProfile`, `rebindPublishedDefaultFingerprint` (`published-default.js`,
also what `cellucid-datasets` publishes starting views with).

## The file

Only one current state document is accepted: session format 4, whose version is part of the file
signature (`CELLUCID_SESSION/4\n`, `bundle/format.js`). A session of another format version is
refused naming it (`otherSessionFormatMessage()`); a library file of My datasets
(`CELLUCID_LIBRARY/1\n`, the same framing: `app/library/library-file.js`) with
`LIBRARY_FILE_NOT_A_SESSION_MESSAGE`, which says where it is imported; any other file with
`NOT_A_SESSION_FILE_MESSAGE`. The framing is one for both kinds: `writeBundle` and `readBundle`
take the file kind's `signature` (`SESSION_SIGNATURE` by default). Sessions are **untrusted input**: exact manifests, bounds, an exact
single-member gzip envelope (trailer size checked before one paced native inflate), every array
checked against its digest and every value against its hash.

A file holds the dataset's **history**: its trackers (each a tree of steps), every value of the
history's pool the steps refer to (a state domain's value at a step, by its content hash:
`app/history/value-pool.js`; what each domain's value is: `app/state/domains/README.md`), and,
only when the person chose to include them, the conversations kept with a tracker. A session file
holds domain values as they are, with no encoder of its own per feature: a value is a JSON
skeleton plus the typed arrays it names (`app/history/value-parts.js`).

| Chunk id | Kind | Priority | Contains |
|---|---|---|---|
| `steps/<n>/<k>` | `steps` | eager | a run of the n-th tracker's steps, in id order (`Step` records, below): its kind, action, parameters (by name; cells by original position) and their version, who took it, the branch it was made on, label, pseudocode, the hash of each touched domain's value before and after and of each input it read, status, what a squashed step stands for, notes, bookmark, group |
| `parts/<priority>/<k>` | `parts` | eager for what the head's values name, else lazy | `{<name>: <skeleton>}`: sub-values stored once (below) |
| `array/<digest>` | `array` | eager for what the head's values name, else lazy | one typed array, once whatever number of values hold it: `raw`, or `cell-set` (a strictly increasing Uint32Array as a uvarint bound, then the smallest of the cell-set encodings, `codecs/cell-set.js`) |
| `values/<priority>/<k>` | `values` | eager: the values the active head shows; lazy: every other value a step or a journal patch refers to | `{<hash>: <skeleton>}` |
| `journal/<n>` | `journal` | lazy | the n-th tracker's journal (`JournalEntry` records: Recently deleted and changed), written only when included |
| `chat/<n>/<m>` | `chat` | lazy | one conversation of the n-th tracker, written only when included |

**Order.** Every eager chunk comes before any lazy one, and within each priority the kinds come in
the order of the table (`steps`, `parts`, `array`, `values`, `journal`, `chat`). A file of steps only
holds no `values` chunk; any other holds at least one eager one.

**Bounded pieces.** `steps`, `parts` and `values` chunks are JSON cut where their text passes 16 MiB
(`CHUNK_TEXT_CHARS`, `history-file.js`): one list or map in several chunks, read back as one. No
single string nears the page's longest (2^29 − 24 characters in V8: one JSON string of every lazy
value of a long history passes it; measured: 33_decisions_actions_domains_and_history.md), and a
reader inflates one piece at a time. A skeleton longer than
a piece is a chunk of its own.

**Compression, per chunk by measured gain.** Each chunk is stored gzip'd (`codec: 'gzip'`) when
that saves at least a sixteenth of its bytes, else as it is (`codec: 'none'`, `storedBytes` equal
to `uncompressedBytes`). Skeletons shrink several-fold; float arrays and cell-set bytes barely (measured:
33_decisions_actions_domains_and_history.md), and are then read without inflating.

**Skeletons** (`app/history/value-parts.js`): a value as JSON with every typed array as
`{"$array": <digest>}` (`<type>:<length>:<sha256 of its bytes>`), every number JSON cannot hold as
`{"$number": "NaN"|"Infinity"|"-Infinity"|"-0"}`, and every object or list whose skeleton text is
at least 512 characters (`PART_MIN_CHARS`) as `{"$part": <name>}`, its skeleton stored once in a
`parts` chunk under the SHA-256 of its text (bottom-up: a part names the parts inside it). Values
that share a sub-value (the gene names of every analysis result, a user field in each later
field-overlays value, a highlight group) store it once. A part is storage only: a value is checked
against its own hash once joined, a part's name is never trusted, a part that names itself
(through others) is refused, and so is a value whose text would pass 2^29 − 24 characters
(`MAX_VALUE_TEXT`) before it is expanded. A step's `params` and `outcome` are skeletons too; a
step whose parameters name an array or a part only the lazy chunks hold is read with them still a
skeleton and given joined by `readRest` (`params`).

No chunk holds a picture of a step: a picture is drawn from the live view when
someone asks for one (the printable report, an agent's `view.picture`) and never kept.

The manifest also carries the dataset fingerprint (below), where the dataset opens from
(`source`; null when the share keeps the dataset's name only), the cells and genes it was saved on
(`cells`, `genes`), `requires` (every dataset observation field and gene the shown state uses, read
from the filters, colors and active-field values and the highlight groups' fields, checked before
anything is put back), what wrote it (`app`: `{version, catalog}`, the Cellucid version and the
SHA-256 of the action catalog document), the actions its steps use (`actions`:
`[{type, version, params}]`, one stamp per action and version its steps and journal use, sorted by
type then version; `params` is the SHA-256 of that version's params shape, `actionParamsShape` as
canonical JSON, when the writer's catalog is at that version, else null), what the share chose
(`scope`, below), the page chrome it carries outside its history (`chrome`: `{pressed: {<group id>:
<button id>}}`, the pressed button of each pressed-button group, `data-state-serializer-pressed-group`,
the selection tool `highlight-mode`; written from the page at a save and kept in every
form, put back once a load has shown its head, a group the page lacks named in a note; `{pressed: {}}`
when the page keeps none), the active tracker
(`activeTracker`) and every tracker's record.

**The records are `app/history/model.js`'s** (`Tracker`, `Branch`, `Group`, `Step`, `Squash`, `By`,
`Turn`, `Note`, `JournalEntry`, `Start`, `Scope`; their fields, types and rules are `historyModelDocument()`,
mirrored to Python and R as `history_model.schema.json`). A manifest tracker is a `Tracker` whose
steps, journal and conversations are in chunks:

    {id, name, dataset, createdAt, by, start, removed, rootId, headId, activeBranch, mainBranch,
     paused, branches, groups, steps: [<steps chunk id>, …], turns, notes,
     journal: <journal chunk id> | null, chats: [<chat chunk id>], nextStep, nextBranch, nextGroup,
     nextNote, nextJournal}

(the model's field order; `steps` lists the tracker's steps chunks in order),

and each step of a `steps` chunk is

    {id, parent, children, branch, kind, type, params, v, code, label, by, at, until, merged, ms,
     touches, before, after, reads, status, reason, outcome, coalesceKey, replayOf, squashed, notes,
     bookmark, group}

- **`kind`**: `root`, `action`, `outside` (a change made outside an action) or `squashed`. A
  squashed step has no action of its own (`type`, `params`, `v`, `code` null) and says what it
  stands for (`squashed`: `{cause: 'paused'|'steps'|'clear'|'share', count, by, carried}`): what
  changed while recording was paused, consecutive steps merged into one, the history cleared
  keeping the state, or a state shared without its history. It restores exactly on the same
  dataset and replays elsewhere as values only, flagged. Steps merged into one (`steps`) give it
  the id of the last of them, the one exception to ids never being reused, so a step or a branch
  after them keeps its parent; it carries their notes and bookmarks (`carried`), and its `count`
  adds up theirs.
- **`v`**: the version of the action's parameters the step was recorded with (the catalog's
  `version`). A step is replayable here when its type is known and: its `v` is below this
  catalog's version (the action's upgraders, `upgradeParams` in `app/actions/catalog.js`, bring
  its parameters up before it is dispatched), or equal with its stamp's `params` digest equal to
  this catalog's; a `v` above it, or an equal one with another digest, is "Recorded with another
  version: shown, not replayable", its values still restored. Every version keeps examples
  (`tests/fixtures/action-versions/`).
- **Groups** (`Group`: `{id, name, createdAt, by, notes}`): a named run of consecutive steps of one
  branch, metadata only. Each step names its group (`group`); a group holds whole turns and no
  group; the journal records a group edit as which steps it held (`memberships`). **`paused`**:
  the tracker's recording switch, null while recording, else `{at, by, draft}`; a file keeps
  `draft: null`, because a save or a share squashes the changes made while paused first (this
  browser's autosave keeps the draft, as values it never prunes).

**What the share or save chose** (`scope`: `{trackers, branches, content, results, notes, chats,
journal, times, source}`) is what the file holds:
- the trackers named, each with the branches named (`branches`: `[{tracker, branches}]`) and the
  steps they hold and start from;
- notes and bookmarks only with `notes`; conversations only with `chats`; the journal only with
  `journal` (checked whole by `validateSession`);
- `content: 'history'`: the trackers and branches with every value their steps name;
- `content: 'state'` (Current state only): one squashed step "Shared state" over the dataset as
  opened, with nothing else (developer doc 10, "What a choice keeps");
- `content: 'steps'` (Steps only): no `values` chunk (`array` and `parts` chunks only for what the
  steps' parameters and outcomes still name); each step keeps its record, with `null` in
  place of every parameter that names cells by position (an `x-cells` array) or holds a value per
  cell (an `x-values` array), and replays as unmatched ("Its cells are not in this file."); the file
  opens as a replay plan (`history.replay`);
- `results: 'recompute'`: each analysis result is left out (`share-scope.js`
  `analysisWithoutResults`: beside its `settings`, the result becomes `{kind, leftOut: true,
  provenance}`, `analysis/shared/analysis-result-session.js`), so its value is stored under its own
  hash; opening the file runs again, as a step of `analysis.run`, each analysis shown at the head
  whose result was left out, and says where the result computed here differs from the shared one's
  inputs (`recompute-results.js`); later jumps never run one again (always so with
  `content: 'steps'`, whose replay runs its steps); `'include'` keeps them;
- `times: 'dates'` rounds every time down to its UTC day, `'none'` writes every time as null: the
  records' times, the times values hold (a user field's `createdAt`, an analysis result's
  `computedAt`; each such value is written under its own hash, `share-scope.js` `VALUE_TIMES`) and
  a conversation's own times;
- `chats: false` leaves out the conversations and what turns say of them (`conversation`,
  `message`); every value a step names, what it read included, is written under the same rules;
- `source: 'name'` writes `source: null`.

A file is checked whole (`validateSession`): unique branch, tracker and bookmark names; each
branch's steps one line from its fork step to its tip; every step on a branch it holds; the head on
the active branch's path; every `replayOf`, `start.from` and journal record well formed. A file
from another catalog loads: a step whose type this catalog lacks, or whose `actions` digest
differs from this catalog's, is shown ("Recorded with another version (0.9.8): shown, not
replayable") and its values restore; a domain this version lacks is refused, naming the domain and
the version that wrote it. A user field's intersection labels are keyed by the pages they
combine ("0+2", `state/domains/field-overlays.js`); no other key is read.

Every manifest chunk has exactly `id`, `kind`, `priority`, `codec`, `storedBytes`,
`uncompressedBytes` and its kind's own keys (`steps`, `journal`: `tracker`; `array`: `digest`,
`encoding`; `chat`: `tracker`, `conversation`; `parts`, `values`: none). Unknown, missing, duplicate,
unreferenced, reordered or dishonestly described chunks, a value, an array or a part no step refers to and a step referring to a value the file lacks are rejected before success.

## Loading

A file chosen with Load is **added beside** the person's trackers (`history.importTrackers`): a
tracker whose id is taken here is issued another, with what the file reads after its head (its
conversations, Recently deleted, late parameters) following it, and a name taken is suffixed
"(shared)". Each tracker added is journaled (`load`, "Loaded … from <file>"): undoing it removes the
tracker to Recently deleted, and the notice after the load offers that **Undo** for all of them
(`history.journal.undo`). A file of steps only opens as a replay (`history.replay`). A saved state
opened from this browser replaces the history (`history.load`). `planPageChrome` plans the page
chrome a file carries before anything is replaced (developer doc 10, "Loading").

A load is one awaited public operation, all or nothing: once the eager chunks are read the active
head is shown; the lazy ones are read while it is shown, before the history accepts a new step; any
later failure, and Cancel, puts back what was shown and keeps the trackers there were. The header
is read and the dataset fingerprint checked before anything else is refused, so a session opened
with no dataset says which dataset it was saved on. If the file's dataset fingerprint does not match the dataset loaded, the complete restore
rejects and rolls back; no dataset-agnostic layout subset is salvaged. Its steps can still be
replayed on that dataset (the State panel's Replay a session file here…, `openSessionFile`,
`app/history/replay.js`). A loaded session plays its
camera path when it was saved with Autoplay on (`onLoaded`).

The autosave's saved states (`app/history/autosave.js`) load the same way (`loadSavedHistory`).

**Starting views.** An official catalog dataset may advertise one SHA-256-pinned starting view
(`published-default.js`): a format-4 file of one tracker of one root, no step, no conversation, no
source and no cells, whose root holds neither `cells` (the cells open are the person's choice) nor
`layout` (the person's own panels, sidebar and theme). Cellucid puts it back without a step after
the dataset is published, before the dataset's first tracker starts, so the history starts from
it; it applies to any subsample of its dataset. Its profile is checked before any chunk is read; a
Save with steps is a starting view only once it is published (the head becomes the one root,
`trimToPublishedDefault`, which refuses content a person made). The same dataset read again on
other cells keeps its history and puts no starting view back.

## Dataset fingerprint (cell-order identity)

A session's values name cells by **original position** (the cell's row in the dataset as it was
written), not by an identifier. Positions are only meaningful against one ordering of the dataset,
so the manifest fingerprint has to pin that ordering, not just the dataset.

`datasetFingerprint` has exactly six fields. The route a dataset was opened through is not one of
them: the same dataset opened from another host restores its sessions, and `cellOrder` proves the
cells are in the same order.

| Field | Derived from | Shape |
|---|---|---|
| `datasetId` | `dataSourceManager.getCurrentIdentityId()` | string or `null` |
| `name` | `dataSourceManager.getCurrentMetadata().name` | string or `null`; used in messages, never compared |
| `cellCount` | `state.pointCount` | safe integer |
| `varCount` | source var fields in `state.varData.fields` (user-defined fields excluded) | safe integer |
| `cellOrder` | see below | `{ embedding, dimension, digest }` |
| `dataMapping` | `state.getDataMapping()` | a canonical DataMapping (`data/data-mapping.js`) |

`dataMapping` names the stored arrays the dataset is shown with: the embeddings that are on
(`embeddings.enabled`, any number of each dimension), the default of each dimension
(`embeddings.defaults`), the vector bindings, the neighbor graph, gene names, expression matrix
and latent space. It is resolved once per load by `data/dataset-mapping.js` and changed in the
Session › Data mapping panel. A dataset is shown before its gene list is read
(`state/managers/var-axis.js`), and capture and restore wait for it (`whenGenesListed`), so
`varCount` is always that of the installed gene list.

`cellOrder.embedding` names the layout the live view shows: an AnnData `obsm` key with its 0-based
columns. `cellOrder.dimension` is that layout's dimension, exactly 1, 2, or 3. `cellOrder.digest`
is 16 lowercase hex characters: the cell-order digest of `data/cell-order-digest.js` over the
stored values of that embedding's columns (rounded to float32), each open cell named by its
original position: per cell, two MurmurHash3 lanes of (original position, x, y, z words; the zero
word for an axis a 1D or 2D embedding lacks), summed over the cells, then finalized with the cell
count. `getDatasetFingerprint()` asks `dimensionManager.getCellOrderDigest(layoutKey)`, which the
reader worker answers from the sums it made as it read the embedding
(`EmbeddingPayloads.cellOrderDigest`).

Why the stored values, by original position:
- The scalars all survive a row permutation. Re-export a dataset at the same id from re-sorted
  input and every one of them is unchanged, while every stored position now denotes a different
  cell.
- Observation and variable names are also invariant under a row permutation, so they cannot
  detect the change either.
- Display coordinates depend on how the cells were opened (developer doc 10, "Cell-order digest"),
  so the digest is never taken over them: the stored values do not, and the same cells digest
  alike however they were opened.

Why the embedding travels with the digest:
- A digest is comparable only within one embedding's columns.
- A restore verifies the digest of the very embedding the session names, over the cells it names
  (opened first), whichever layout is on screen and without loading it for display, so a session
  saved in 2D opens while 3D is shown.

Cost:
- The worker sums an embedding as it reads it, in blocks of 4,096 open rows: a growth step adds the
  rows it reads, a cut keeps the whole blocks and reads under 4,096 rows when asked, the same
  cells reordered keep the total. Saving folds nothing on the page.
- A capture runs with the open cells in use (`useOpenCells`): growth and **Apply** wait for it.
  Once the digest is answered it re-checks every fingerprint field but the digest
  (`datasetFingerprintStillCurrent()`).

Restore is verify-then-apply (`verifySessionFingerprint()`): every check runs before any value is
put back, and each cause has its own message, surfaced verbatim by the session controls. The causes,
where each is detected and what the person is told are in developer doc 10, "Refusals"
(`cellucid-python/docs/user_guide/web_app/p_developer_docs/10_sessions_persistence_and_serialization.md`).

A session whose embeddings differ from the open dataset's, but which the dataset can show, is not
refused: the data mapping is put back right after the open cells (`app/actions/domains.js`
order), before every view, so every view the session names can be shown; a failure later puts the
previous mapping back with everything else.

Attributing a refusal to the wrong cause is itself an integrity failure: telling someone their
data was re-ordered when the session only named another embedding teaches them to distrust a sound
dataset. Keep the causes separate when changing this code.

The starting-view path is not exempt. `restorePublishedDefaultState()` reads the same format,
checks its profile first (`assertPublishedDefaultProfile`), and runs the same fingerprint
verification and the same `requires` check, so an advertised starting view must carry `cellOrder`
and `dataMapping`, and must have been captured in the dataset's default data mapping; on a
subsample of its dataset the cell-order digest is not compared (the catalog pins the file by
SHA-256).

## What a session does not keep

The antialiasing preference (a device capability); per-cell gene values analyses read (re-read
from the dataset); benchmarking UI state; community annotation state (votes, comments, moderation,
GitHub sync and sign-in, drafts); the dataset itself (a session assumes its dataset is loaded, and
names where it opens from); dataset selection and connection UI state; DOM, WebGL and runtime
objects; notifications; in-progress interaction state (a pointer lock, a selection not confirmed).

## Extension rule

A new persisted feature is a state domain's value (or part of one): the session file stores it as
it is, with no encoder of its own; the rule, with its coverage, is developer doc 10, "Adding or
changing persistence". A change to the file itself changes the only current format: update every
current producer, consumer, fixture, and reference together; do not add a reader for an older
shape.

**Tests:** `tests/session-history-file.test.mjs`, `tests/session-serializer-contract.test.mjs`,
`tests/session-starting-view-contract.test.mjs`, `tests/session-cell-order-identity-contract.test.mjs`,
`tests/browser/history-session-file.spec.mjs`.
