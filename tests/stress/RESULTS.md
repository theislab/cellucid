# The history stress suite: how to run it

The suite measures what the action history costs in time, memory and bytes at scale: recording a
step, a jump, undo and redo, deleting a step, replay, the autosave, the memory accounting,
`history.get`, the session file and what a step of each kind adds. It asserts nothing about a
figure: a budget is a regression to compare with the next run, never a cap, and nothing in it
limits a history's size. The figures it produced, with the machine and the conditions of each
run, are the "Measurements that justify it" of
`cellucid-python/docs/user_guide/web_app/p_developer_docs/33_decisions_actions_domains_and_history.md`;
nothing a run writes is committed.

## What is here

| File | What it is |
| --- | --- |
| `history-stress.mjs` | The two runs: a mixed history built up to the largest size and measured at each checkpoint, and each kind of step alone on a fresh history |
| `synthetic-page.mjs` | The page under them: every state domain with a value of the shape its owner captures, on a dataset of up to millions of cells and 20,000 genes, with the real catalog, dispatcher, history, value pool, session file and autosave over it. A real owner's own capture and restore work is not in the figures |
| `memory-database.mjs` | An IndexedDB stand-in with its transaction semantics and costs, counting the bytes it holds |
| `scaled-golden.mjs` | The golden history (`tests/fixtures/history-golden.cellucid-session`) made longer, for timing the Python and R session readers |

The browser half, in a real page on a served 1,000,000-cell AnnData, is
`tests/browser/history-stress.spec.mjs`: frames during a camera gesture, a slider drag, a large
highlight and a marker run with the history recording and with the recorder bypassed
(`setRecorder(null)`, the dispatcher's own interface), the State panel's graph at 1,000 and 10,000
steps and at 10,000 steps with 100 branches, and the memory the page and the autosave hold.

## Run it

These are heavy jobs: run one at a time, alone on the machine, with no other heavy job beside it
(timings within about 20% are noise). Each Node run is one process with `--expose-gc`, and memory
is read after a collection.

```
npm run stress:history -- --quick                    # 2k steps, 100k cells: a check of the suite, in seconds
npm run stress:history -- --repeat 2 --out <dir> --guard-gib 7
npm run stress:history -- --readers --python <interpreter> --out <dir>
CELLUCID_HISTORY_STRESS=1 CELLUCID_HISTORY_STRESS_OUT=<file.json> \
  npx playwright test tests/browser/history-stress.spec.mjs --project=chromium --workers=1
```

- `--steps`, `--cells`, `--genes`, `--seed`, `--kinds-only` and `--mixed-only` are described in the
  header of `scripts/history-stress.mjs`. `--repeat N` runs the mixed history N times with
  successive seeds, each in its own process. `--guard-gib` stops a run that holds more memory than
  that: it guards the machine, it is not a limit of the history.
- `--readers` times `cellucid.read_session` and `cellucid_read_session` on the golden history made
  1,000, 10,000 and 100,000 steps longer, and on a file the web app writes (a mixed history of
  1,000 steps). The packages are found beside this checkout or where `CELLUCID_PYTHON_ROOT` and
  `CELLUCID_R_ROOT` say.
- The browser spec runs in Chromium on the machine's GPU (`scripts/lib/browser-launch.mjs`): a
  software rasterizer would make every frame time the rasterizer's. It prints its figures as one
  `HISTORY-STRESS {...}` JSON line and writes them to the file named.
- Each kind alone runs as notebook cells (origin `host`, a turn each), so a kind that coalesces
  never merges into the warm-up step; the run counts only appended steps (`steps`; `merged` must
  be 0) and reports the turn record each cell adds (`turnRecordBytesPerStep`, about 270 bytes at
  5,000 cells, included in `fileBytesPerStep`).
- `npm test` runs `tests/history-stress-harness.test.mjs`: the whole suite at a few hundred steps,
  in seconds. It asserts what the suite returns, never a timing.

## Where the results are

Section "Measurements that justify it" of
`33_decisions_actions_domains_and_history.md`: the conditions of each run, the mixed history at
each size, the recorder by step kind, the bytes per kind and where they go by domain, what breaks
first, the real page (recording on against bypassed, the timeline and the graph), the Python and
R readers, and the cost of persistence. When the suite is run again, add the new figures there in
the same change, beside the ones they are compared with.
