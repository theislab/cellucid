# History stress results: History v1 (measured 2026-11-04)

What today's action history (v1, `main` at `2367261fd`) costs in time, memory and bytes at
scale, measured by the stress suite in this directory. It is the baseline History v2
(`cellucid-private/plans/history-v2.md` §3.5, §3.6, §3.15.4, workstreams H1-H3) designs
against, and the suite is what re-measures v2. Every figure is a measurement on the machine
named below. The §3.15.4 budgets are regressions to watch, never caps, and nothing in the
suite limits a history's size.

## 1. Summary

- **Recording itself is cheap and stays flat.** The history's own share of a step
  (`history.js` capture-to-step, hashing included) has a median of 0.13-0.15 ms at every
  size from 1k to 100k steps. Its p95 is 0.4 ms at 1k and 1.5 ms at 100k. Large values are
  what cost: hashing an analysis result is 12-20 ms, and a ~1M-cell highlight is 2.4 ms.
- **What a step costs grows with the whole history, and it is not the recorder.** Two
  O(pool) walks run on the main thread after every step:
  - the memory accounting (`dataset-history.js` → `pool.byteLength()`) takes 3 ms at 1k
    steps, 47-62 ms at 10k, 333-342 ms at 50k and 0.8-0.93 s at 100k;
  - the autosave write (`autosave.js` `entryRecord` → `pool.byteLength()`, plus copying
    every stored step id) is the same again.

  Together they pass one 60 Hz frame at about 2k steps, and cost about 1.7 s a step at
  100k.
- **In the real page, the State panel's timeline is felt first** (§3b).
  - It redraws every row on every step: one step's frame takes 35 ms at 1k steps and
    300 ms at 10k.
  - Opening the panel at 10k takes 660 ms. Scrolling it runs at about 5 fps (paint, not
    script).
  - At 10k a slider drag spends 21 s of main thread per 120 inputs recording, against 2.5 s
    bypassed.
  - On a fresh history, recording on and bypassed are indistinguishable for a camera
    gesture and a slider drag.
- **Crashes, by size.**
  - **About 5,000 steps deep, two recursions overflow the stack** (`RangeError: Maximum call
    stack size exceeded`, Node's default stack):
    - `history.get` with `all_branches: true` (`describe.js` `stepsInOrder`). It fails at
      every checkpoint from 10k up, in both runs; on a bare chain it works to 4,997 steps
      and fails beyond.
    - **Deleting a step with about 4,600-6,000 steps after it** (`tree.js` `descendantsOf`;
      5,036 on a bare chain). A failed delete leaves the history unchanged.
  - **Saving a session file fails between 50k and 100k steps**: `RangeError: Invalid
    string length`, because all lazy values are one JSON string (`history-file.js`
    `jsonBytes`). That chunk was 357-375 MB at 50k; extrapolated linearly, V8's ~512 MiB
    string limit is reached near 70-75k steps.
- **The agent read passes the connector's limit almost at once.** `history.get` returns
  about 293 characters per step on the shown path, so the 150k-character limit is passed at
  about 510 steps. At 100k steps it is 27 MB.
- **Bytes go to values, and values are not shared below the domain level.**
  - At 100k steps the values hold about 0.8 GB of skeleton JSON and 1.8 GB of arrays.
  - The analysis domain (720 values) is 340-355 MB of JSON: every distinct analysis value
    repeats the 20k gene names of every result it holds.
  - `field-overlays`, `highlights` and `settings` each re-store their whole value on every
    change: 252-262, 105 and 86 MB of JSON.
- **The autosave stores cells raw.** IndexedDB holds a ~1M-cell highlight as 4.0 MB; the
  session file holds the same step in 2.7 KB, because the cell-set codec applies there. It
  is the same story for visibility masks (1.56 MB a step in IndexedDB) and user-field codes
  (1.0 MB against 0.29 MB).
- **Moves are O(depth).**
  - A jump to a random step takes 0.6 ms at 1k and 41-42 ms at 100k.
  - Undo takes 40 ms at 100k, because every move re-walks the path from the root several
    times.
  - Deleting a step re-applies each later step at O(depth): about 50 ms a step at 100k, so
    deleting a step with 1000 after it takes 42 s.
- **The session file grows with distinct values, as intended, but analysis results
  dominate it.**
  - A marker-genes result (20k genes, 12 groups) adds 7.8 MB per step, a differential
    expression 1.2 MB, a correlation 0.8 MB.
  - A camera step adds 225 B, a setting 167 B, a label edit 169 B.
  - Python reads the golden (v2) shape at about 70-80 µs a step (100k steps in 7.0-8.7 s).
    **R grows superlinearly**: 7.0-7.4 s at 10k steps and 218-262 s at 100k (two runs).

## 2. Machine and conditions

- Apple M1 Pro (10 cores), 16 GB, macOS 26.7.1, Node v26.11.1. Chromium is Playwright
  1.62.0's, launched by `scripts/lib/browser-launch.mjs` (Metal through ANGLE). The
  renderer string is recorded with the browser results.
- Each heavy run went through `.cellucid-maintenance/heavy.sh`, alone among heavy jobs.
  Other agents' light work ran on the machine at the same time. Timings within about ±20%
  are noise (see §9).
- Node runs used `--expose-gc`, and memory was read after a forced collection. Each mixed run
  is one process with `--max-old-space-size=7168` and a memory guard of 7 GiB. Neither run
  reached the guard.
- Raw results: `.cellucid-maintenance/session-09adad82/hs/` (not committed):
  - `full2/step-kinds.json`, `full2/mixed-1.json` and `full2/mixed-2.json`;
  - `readers/readers.json`;
  - `browser/browser-1.json` and `browser/browser-2.json`.

## 3. What is measured, and how

**The Node suite** (`history-stress.mjs`, `npm run stress:history`) drives the real modules:

- the catalog (`ACTION_DEFINITIONS`: real schemas, labels and pseudocode), the
  dispatcher, `createHistory`, the value pool and the tree;
- `writeHistoryFile` and `openHistoryFile`, `history.load`;
- `createAutosave` over `createHistoryStore`, `openSavedState`;
- `setWorkingSet` (`data/memory-budget.js`).

The page under them is synthetic (`synthetic-page.mjs`):

- **Dataset.** Every one of the 15 state domains has a value of the shape its owner
  captures (`app/state/domains/README.md`), on a dataset of 1,000,000 cells and 20,000
  genes.
- **Analysis results** are made by the analysis code's own encoder (`createResultEnvelope`)
  from results of real shape:
  - differential expression: 20k gene rows;
  - markers: 20k genes × 12 groups × 8 statistics;
  - correlation: 2 pages × 50k cells.
- **Capture** copies plain data and keeps typed arrays by reference, as the real owners do.
- **What the figures exclude.** A real owner's own capture and restore work (reading the
  viewer) is not in these figures. Owner time and handler time are timed apart and
  subtracted, so *recorder* below means `history.js` and the pool alone.

The wiring is `dataset-history.js`'s, with two things run when the suite says so, so that
each can be timed on its own:

- the memory accounting, which runs after every change;
- the autosave, which writes within a task of every change.

While a history is built, the autosave flushes every 500 dispatches. At a checkpoint, 20
single steps are each followed by one accounting pass and one autosave write. That per-step
cost is what the page pays at that size.

The IndexedDB stand-in (`memory-database.mjs`):

- **Semantics kept.** It has IndexedDB's transaction semantics and costs: a structured clone
  on each put, serialized transactions.
- **Counting.** It counts bytes as follows: arrays by their byte length, everything else by
  its JSON length.
- **Dropping contents.** After the last checkpoint that reads a saved state back (10k), it
  counts records without holding them, because a browser keeps them on disk and this
  process would otherwise hold the history twice.

**The mix**, as weights per 1000 actions (`MIX` in `history-stress.mjs`):

| Kind | Weight | Kind | Weight | Kind | Weight |
| --- | --- | --- | --- | --- | --- |
| camera | 250 | brush 1k cells | 50 | setting (slider, switch) | 150 |
| color by field | 70 | brush 100k cells | 5 | panel moved | 50 |
| color by gene | 40 | brush 500k (half, scattered) | 0.5 | section opened | 50 |
| color map | 20 | brush ~1M (all but 1000) | 0.5 | analysis panel switched | 10 |
| category filter | 70 | highlight group toggled | 20 | differential expression | 1 |
| range filter | 40 | cells hidden (10k) | 5 | marker genes | 0.5 |
| label edit (category rename) | 50 | all cells shown | 3 | correlation | 1 |
| user field (1M codes) | 1 | | | | |

Other things the build does:

- Past 30 highlight groups, the oldest is removed: a person clears old brushes.
- A branch is made every N/101 steps, by undoing 1-20 steps and acting.
- Nine side trackers get 1% of the steps each.
- Coalescing happens as it does in the app: about 30% of camera steps merge into the
  previous one.

At 100k there are 100,816-100,824 steps, 111 branches, 10 trackers and an active path
92,247-92,446 steps deep.

**The step kinds alone** (`runStepKinds`): each kind is measured on a fresh history, with
one result of each analysis already shown. There is one warm-up step first, so the
autosave's first whole write is not counted. Then come 10-100 steps of the kind, each in a
turn of its own so none coalesces. Every figure is per step.

**The browser spec** is `tests/browser/history-stress.spec.mjs`, run with
`CELLUCID_HISTORY_STRESS=1` in Chromium on a served 1M-cell AnnData. It runs two tests:

- **Recording on or off.** Four scenarios run with the history recording as today, then
  with the dispatcher's recorder set to none (`setRecorder(null)`). That is the
  dispatcher's own interface; no product switch was added. Each scenario runs three times
  each way, alternated.
- **Timeline and memory.** The timeline and memory are measured at 1k and 10k steps, with
  Chromium's own main-thread counters (`Performance.getMetrics`). The slider drag is then
  repeated at 10k steps, recording on and off.

**Python and R** (`--readers`):

- `cellucid.read_session` and `cellucid_read_session` time the golden history
  (`tests/fixtures/history-golden.cellucid-session`, History v2's shape) made 1k, 10k and
  100k steps longer by `scaled-golden.mjs`. Its main branch is extended with copies of its
  last step, so the file grows by step records only.
- They also try a file the web app writes today.

## 3b. In a real page (Chromium, 1M cells; two runs)

Conditions:

- `tests/browser/history-stress.spec.mjs`, run twice through heavy.sh (5.0 and 1.8 min).
- Renderer: `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)`. The frames run at 120 Hz:
  an 8.3 ms frame is a full-rate frame.
- Dataset: a 1,000,000-cell AnnData (Zarr ZIP) served over HTTP, with 30 cell types, 20
  genes (CSR) and UMAP.
- The history is the page's own (real owners, real autosave in IndexedDB).

**Recording on against bypassed, on a fresh history.** Each figure is three alternated
rounds each way; run 1 / run 2.

| Scenario | Recording on: frame p50 / p95 ms | Bypassed: frame p50 / p95 ms | Recording on: action ms | Bypassed: action ms |
| --- | --- | --- | --- | --- |
| Camera gesture (120 pointer moves) | 8.3 / 8.7-8.9 · 8.3 / 9.3 | 8.0-8.3 / 9.1-10.8 · 8.3 / 9.1-9.3 | gesture 1023-1047 · 1025-1034 | 1013-1053 · 1021-1024 |
| Slider drag (point size, 120 frames) | 8.3 / 8.7-9.2 · 8.3 / 9.3-9.4 | 8.3 / 8.6-9.1 · 8.3 / 9.3 | 1018-1029 · 1019-1021 | 1015-1022 · 1015-1017 |
| Highlight of ~1M cells (`highlight.cells`) | – | – | dispatch 33-35 · 41-48 | 25-37 · 36-41 |
| Marker genes (`analysis.run`) | – | – | 190-193 first, then 27-41 | 24-54 |

- **No long task (over 50 ms) in any camera or slider window, either way.**
- **Camera and slider: no difference beyond noise.** With a small history, recording does
  not show in the frames.
- **The highlight: about 3-5 ms slower with recording,** averaged over each run's rounds
  (run 1: 34.1 against 31.0 ms; run 2: 43.4 against 38.3 ms). That is within one run's
  spread, so it is noisy. It agrees with the Node measurement: 2.4 ms of hashing (§5) plus
  capture.
- **The marker run cannot be compared.** Its first run (recording on) computed (190 ms, one
  64 ms long task). Every later run in both modes reused the analysis's cached result for
  the same inputs.

**The timeline at 1k and 10k steps** (State panel; settings steps, two sliders alternating):

| | 1k steps, run 1 · run 2 | 10k steps, run 1 · run 2 |
| --- | --- | --- |
| Opening the panel: all rows drawn, ms | 67 · 72 (long task 64 · 69) | 663 · 659 (long tasks 708 · 705) |
| Opening, main thread (run 2): script / layout / style ms | 45 / 13 / 14 | 366 / 158 / 133 |
| One more step until its row is drawn, ms | 37 · 35 | 299 · 296 (long task 374 · 370) |
| One more step, main thread (run 2): script / layout / style ms | 9 / 10 / 14 | 64 / 112 / 127 |
| Scrolling 120 frames: frame p50 / p95 / max ms | 8.3 / 9.3 / 15.8 · 8.3 / 8.9 / 9.3 | **199 / 675 / 1108 · 200 / 667 / 1112** |
| Scrolling, main thread (run 2): task / script / layout / style ms | 263 / 3 / 0.3 / 3.5 | 31,427 / 309 / 72 / 28 |
| DOM nodes in the page | about 20,000-22,000 | about 120,000-160,000 |

- **Opening and adding a step grow linearly** with the rows, because every render rebuilds
  the whole list (`timeline.js:214`, `replaceChildren(...nodes)`, X1). A step's frame is
  35 ms at 1k and 300 ms at 10k.
- **Scrolling 10k rows runs at about 5 fps**, and less than 2% of the time is script, layout
  or style. The rest is most likely paint and compositing of the list's rows (about 100k
  more DOM nodes). That is inferred, not traced (§12).

**A slider drag at 10k steps**, with the State panel open as it opens by default. Each figure
is three rounds each way, run 2 only (run 1 predates this scenario).

| | Recording on | Bypassed |
| --- | --- | --- |
| Wall time for 120 frames, s | 35.8 · 39.2 · 37.9 | 23.1 · 27.2 · 24.9 |
| Frame p50 / p95 ms | 326-333 / 824-924 | 16.7-16.9 / 907-942 |
| Long tasks: count / total ms | 61-62 / 21,257-21,672 | 2 / 456-505 |
| Main thread: task / script / layout / style s | 23.2-23.6 / 4.5-4.7 / 6.5-6.6 / 7.4-7.5 | 2.5-2.8 / 0.66-0.69 / 0.06-0.08 / 1.27-1.32 |

- **Recording costs about 21 s of main thread over 120 inputs.** That is each recorded
  step's timeline redraw (about 300-370 ms, the row above). The drag runs at about 3 fps.
- **Bypassed, the drag still takes 23-27 s with 2.5 s of main thread.** The frames wait on
  painting a page that holds the 10k-row list. The visible history slows the page even when
  nothing is recorded.

**Memory and storage in the page** (run 1 / run 2). These are settings steps only, whose
values repeat (417 distinct values for 10k steps), so this is the floor of a history's heap,
not the mixed figure of §4:

| | Start | 1k steps | 10k steps |
| --- | --- | --- | --- |
| JS heap after GC, MB | 14.2 / 14.3 | 16.7 / 16.6 | 26.3 / 26.0 |
| `navigator.storage.estimate().usage`, MB | 20.4 / 20.4 | 21.1 / 21.1 | 24.5 / 24.6 |

That is about 1.2 KB of heap and 0.4 KB of origin storage per settings step.

**What a step costs the real page.** Building the steps with the panel closed cost 2.06-2.20
ms per settings step at 1k and 2.62-2.73 ms at 10k (`dispatch`, in the page). The same step
in the Node suite is about 0.3 ms. The difference is the real owners' capture and handler
(the settings domain captures the sidebar's whole control inventory), which the Node suite
leaves out by design.

## 3c. The branch graph (History v2, H3; Chromium, 2026-11-04)

The State panel's history is a virtualised branch graph (`ui/modules/state/graph.js`): only the
rows in view, a few above and below, the focused row and the open details exist in the page,
and a new step rewrites only the rows whose words changed. Measured with this suite's browser
spec (`the branch graph at 10 000 steps and 100 branches`, `CELLUCID_HISTORY_STRESS=1`) on a
tracker of 10 000 steps and 100 branches (100 branches of 10 steps forking from the first 100
steps, a main line to 10 000, a third of it camera moves), three runs:

| | Timeline (v1, 10k steps, §3b) | Graph (v2, 10k steps, 100 branches): run 1 · 2 · 3 |
| --- | --- | --- |
| Opening the panel until the step shown is drawn, ms | 663 · 659 | 28 · 33 · 32 |
| Rows in the page | every step (10 000) | 24 |
| One more step until its row is drawn, ms | 299 · 296 | 78 · 82 · 79, of which the panel 22-25 (the rest is the stand-in core validating the whole tracker per step; the real core's step cost is H1's) |
| One more step, the panel's script, ms | 64 | 14.4-14.5 |
| Scrolling the whole graph in 120 frames: frame p50 / p95 / max ms | 199 / 675 / 1108 | 8.4 / 17.6 / 41.7 · 8.4 / 17.6 / 33.3 · 8.4 / 16.9 / 41.5 |
| Long tasks while scrolling | 31 s of task time | none |

- **Flat in the steps.** The rows drawn are the view's, whatever the history's length; the layout of
  the rows (`graph-layout.js`) is 5 ms at 10 000 steps and 100 branches in Node.
- **Scrolling runs at the display's rate** (8.3 ms here) at the median. The p95 frame is about two
  frames: each of the 120 frames jumps about 2 100 px (the whole graph in two seconds), so every row
  in view is replaced each frame; a person's scroll replaces a few. Row elements are reused, and a
  row's position and selection are written only when they change.
- Folded runs (Camera ×6) and collapsed stubs make the rows fewer than the steps (9 100 rows for
  10 000 steps here).
- **A new step is laid out from the layout before** (review pass, same day): only the path's last row
  and what follows are laid out again, the kept rows' places and offsets patched. In Node, 40 steps
  appended at 10 000: the layout 0.17 ms per step (median) against 6.6 ms laid out whole, equal row
  for row (`tests/state-graph-layout.test.mjs`). In Chromium, the panel's frame for one more step
  (from the history's change to the end of the panel's frame, 20 steps, the stand-in core's own
  validation excluded): 10.3 ms median, 12.3 ms p90, 13.1 ms max, against 22-25 ms before; the rest is
  the browser's style and layout of the rows written and measured. Formatting times reuses one
  `Intl.DateTimeFormat` per format (a new one per row cost 4 ms a step). The 10 000-step run of this
  suite after the change: opening 31 ms, 24 rows, scrolling p50 / p95 15.7 / 17.3 ms on a machine
  shared with other runs.

## 4. The mixed history at each size (both runs: seed 1 / seed 2)

Each cell is seed 1 / seed 2.

| | 1k | 10k | 50k | 100k |
| --- | --- | --- | --- | --- |
| Recorder p50 / p95 ms (every step since the last checkpoint) | 0.13 / 0.41 · 0.11 / 0.39 | 0.13 / 0.60 · 0.13 / 0.62 | 0.14 / 0.89 · 0.14 / 0.92 | 0.15 / 1.45 · 0.15 / 1.52 |
| Recorder max ms | 3 · 17 | 20 · 32 | 36 · 34 | 91 · 87 |
| **Memory accounting per step, ms** | 3.2 · 4.0 | 46.5 · 62.3 | 342 · 333 | 796 · 927 |
| **Autosave write per step, ms (p50)** | 1.7 · 3.0 | 47 · 63 | 345 · 335 | 848 · 897 |
| Autosave in IndexedDB, MiB | 16 · 24 | 217 · 290 | 1379 · 1301 | 2880 · 2966 |
| Whole history written at once ("Save as", a resumed autosave), s | 0.06 · 0.12 | 0.82 · 1.00 | 5.6 · 5.5 | 13.3 · 13.5 |
| A saved state read back and loaded, ms | 94 · 202 | 1307 · 1574 | not measured (see §3) | not measured (see §3) |
| Jump to a random step, p50 / max ms | 0.6 / 0.7 · 6.9 / 7.8 | 10.1 / 11.0 · 9.2 / 10.9 | 22.4 / 27.8 · 21.8 / 29.6 | 41.4 / 53.0 · 42.4 / 84.6 |
| Undo / redo p50 ms | 0.18 / 0.27 · 0.17 / 0.24 | 1.6 / 1.9 · 1.4 / 1.8 | 14.1 / 20.0 · 13.7 / 18.2 | 40.2 / 56.2 · 40.3 / 57.7 |
| Delete a step with 10 / 100 / 1000 after it, ms | 5 / 33 / 265 · 36 / 157 / 563 | 87 / 290 / 1823 · 21 / 264 / 1782 | 193 / 1561 / 15090 · 177 / 1443 / 14991 | 515 / 4817 / 42909 · 502 / 5237 / 41728 |
| Replay, ms per step | 0.18 · 1.2 | 1.3 · 0.8 | 0.58 · 0.23 | 0.46 · 0.42 |
| `history.get` (shown path), characters | 291,503 · 291,803 | 2,887,596 · 2,902,814 | 13,651,519 · 13,617,050 | 27,330,523 · 27,237,749 |
| `history.get` `all_branches` | 294,651 · ok | **stack overflow** · same | **stack overflow** · same | **stack overflow** · same |
| Session file, MiB | 2.5 · 14.6 | 66.8 · 102.7 | 504 · 446 | **write fails** · same |
| Session write / load, s | 0.7 / 0.2 · 1.1 / 0.4 | 7.7 / 2.5 · 10.2 / 3.3 | 50.4 / 18.0 · 46.2 / 17.4 | — |
| JS heap / ArrayBuffers after GC, MiB | 33 / 43 · 75 / 80 | 235 / 325 · 318 / 418 | 399 / 956 · 394 / 863 | 866 / 1864 · 882 / 1907 |
| Pool: distinct values / typed-array MiB | 1,098 / 13 · 1,104 / 17 | 10,599 / 155 · 10,509 / 197 | 51,986 / 943 · 51,877 / 846 | 101,585 / 1835 · 101,411 / 1869 |

The 1k column depends on which rare kinds landed in the first thousand steps; for example,
seed 2 had a marker result early, which is in its file size and its jump times. Treat it as
noisy. At 10k, figures that depend on which large values were made (analysis results, user
fields) still differ by up to 55%: the session file size and the accounting. From 50k up the
two seeds agree within about 16%.

**`history.summary`** is in the catalog but has no provider in v1, so nothing can read a
constant-size summary today.

## 5. Recording by step kind

The recorder's p50 / p95 in ms, in the mixed history:

| Kind | 10k, seed 1 | 10k, seed 2 | 100k, seed 1 | 100k, seed 2 |
| --- | --- | --- | --- | --- |
| camera | 0.05 / 0.07 | 0.05 / 0.08 | 0.05 / 0.08 | 0.05 / 0.09 |
| color by field or gene | 0.17 / 0.23 | 0.17 / 0.21 | 0.17 / 0.24 | 0.17 / 0.53 |
| category / range filter | 0.09 / 0.12, 0.14 / 0.19 | 0.09 / 0.14, 0.14 / 0.33 | 0.09 / 0.13, 0.14 / 0.20 | 0.09 / 0.16, 0.14 / 0.40 |
| brush 1k / 100k cells | 0.22 / 0.76, 0.46 / 1.13 | 0.21 / 0.82, 0.43 / 1.10 | 0.23 / 1.32, 0.45 / 1.54 | 0.25 / 1.30, 0.47 / 1.54 |
| brush 500k / ~1M cells | 1.36 / 1.75, 2.35 / 2.37 | 1.36 / 1.62, 2.29 / 2.34 | 1.39 / 3.28, 2.37 / 2.74 | 1.41 / 2.91, 2.38 / 2.67 |
| label edit | 0.58 / 0.99 | 0.57 / 1.12 | 1.48 / 2.80 | 1.57 / 3.24 |
| user field (1M codes) | 1.09 / 1.33 | 1.09 / 2.76 | 2.09 / 3.08 | 2.13 / 3.50 |
| setting | 0.26 / 0.58 | 0.27 / 0.64 | 0.27 / 0.75 | 0.27 / 0.85 |
| panel / section | 0.07 / 0.09 | 0.07 / 0.12 | 0.07 / 0.10 | 0.07 / 0.14 |
| analysis panel switched | 11.97 / 13.65 | 12.37 / 13.58 | 13.36 / 15.06 | 13.36 / 17.20 |
| differential expression | 8.95 / 14.65 | 14.30 / 20.29 | 15.62 / 21.51 | 15.19 / 19.96 |
| marker genes | 18.54 / 20.35 | 18.68 / 32.06 | 19.82 / 38.71 | 19.90 / 36.79 |
| correlation | 13.09 / 14.33 | 13.67 / 14.89 | 14.15 / 16.71 | 14.36 / 18.49 |

What these show:

- **The recorder's time is hashing.** Hashing is over 90% of the recorder in every kind whose recorder p50 is above 0.2 ms, and 60-80% below that.
- **A kind costs what its touched values cost, and only that.**
  - The analysis kinds hash the whole `analysis` value: canonical JSON of every result,
    20k gene names included, about 1.5 MB. They hash it twice, before and after the step.
    So switching the analysis panel, which changes one string, costs 12-13 ms.
  - Label edits and user fields grow with the history because `field-overlays` holds every
    user field made so far. One label edit touches five domains (`category.rename`).
  - Brushes cost their cells' bytes: SHA-256 of a 4 MB array is 2.3 ms.
- **A step kind does not slow down as the history grows.** The camera, color, filter,
  setting and layout kinds are flat from 10k to 100k.

## 6. Bytes per step kind (each kind alone, 1M cells, 20k genes)

| Kind | Session file B/step | of which: step record | values | arrays | Autosave (IndexedDB) B/step | Recorder p50 ms | Autosave write p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| camera | 225 | 125 | 100 | 0 | 999 | 0.06 | 0.36 |
| color by field | 27 | 25 | 2 | 0 | 501 | 0.10 | 0.29 |
| color by gene | 116 | 72 | 44 | 0 | 580 | 0.11 | 0.30 |
| category filter | 138 | 79 | 57 | 0 | 1,422 | 0.07 | 0.38 |
| range filter | 182 | 108 | 74 | 0 | 1,404 | 0.12 | 0.37 |
| brush 1k cells | 2,413 | 121 | 239 | 1,746 | 18,228 | 0.33 | 0.90 |
| brush 100k cells | 65,908 | 124 | 201 | 65,268 | 407,975 | 0.46 | 0.63 |
| brush 500k cells (scattered) | 125,687 | 125 | 182 | 125,062 | 2,003,696 | 1.29 | 0.79 |
| brush ~1M cells (all but 1000) | 2,661 | 113 | 174 | 2,061 | **3,999,997** | 3.32 | 1.73 |
| cells hidden (10k more) | 979 | 105 | 83 | 175 | **1,556,493** | 1.02 | 0.56 |
| label edit | 169 | 82 | 87 | 0 | 4,025 | 0.24 | 0.54 |
| user field (1M categorical codes) | 293,496 | 156 | 275 | 292,752 | 1,009,124 | 0.93 | 0.81 |
| setting | 167 | 79 | 88 | 0 | 6,011 | 0.28 | 0.88 |
| panel moved | 139 | 83 | 55 | 0 | 1,288 | 0.07 | 0.38 |
| section opened | 90 | 56 | 33 | 0 | 789 | 0.06 | 0.32 |
| analysis panel switched | 1,605 | 23 | 1,582 | 0 | 8,299 | 12.38 | 15.29 |
| differential expression | 1,228,632 | 63 | 103,829 | 1,121,630 | 2,115,669 | 13.88 | 24.17 |
| marker genes | 7,811,814 | 64 | 103,875 | 7,678,163 | 10,115,645 | 20.36 | 27.40 |
| correlation | 825,373 | 63 | 103,810 | 718,779 | 1,315,735 | 13.52 | 23.44 |

Columns:

- *Session file* is gzip'd chunks. *Step record* is the steps chunk, the closest thing to a
  steps-only file (`values: 'none'` does not exist in v1). *Values* is the value skeletons.
  *Arrays* is the typed arrays each value names, raw or cell-set encoded, gzip'd.
- *Autosave* is what IndexedDB holds: arrays raw (`storableArray`), skeletons and step
  records uncompressed.

What these show:

- **The analysis panel row is small because the panel was switched among three values.**
  It adds 1.6 KB a step only because those three repeat, and the pool keeps each once.
- **In a real session, analysis values do not repeat.** Each new combination of results
  and settings stores the whole analysis skeleton again: about 0.5 MB uncompressed, 0.1 MB
  gzip'd, mostly gene names (§7).
- **Steps carry the cells they name.** A brush's step holds its cells in its params as well
  as in the group, as the same array, stored once. All params arrays are *eager*
  (`history-file.js` `writeHistoryFile`): at 50k steps, 65 MB of the 504 MB file must be
  read before the head is shown. Of that, the head's own value skeletons are 0.1 MB; the
  rest is every step's parameter arrays and the arrays the head's values name.

## 7. Where the bytes go: values by domain (100k steps, seed 1)

| Domain | Distinct values | Skeleton JSON | Arrays (each once) |
| --- | --- | --- | --- |
| analysis | 719 | 339 MB | 965 MB |
| field-overlays | 6,816 | 252 MB | 125 MB |
| highlights | 16,720 | 106 MB | 648 MB |
| settings | 16,275 | 86 MB | 0 |
| filters | 11,377 | 18 MB | 0 |
| layout, camera, colors | 9,711 / 22,374 / 7,233 | 6.7 / 5.2 / 5.2 MB | 0 |
| visibility | 631 | 0.1 MB | 63 MB |

Seed 2 agrees within 6%. Each figure has a reason:

- **analysis.** Each analysis value repeats every result's 20k gene names in its skeleton
  (codec `labels` and `records` columns), about 0.47 MB each. The arrays are float64 and
  float32 statistics, which gzip barely compresses.
- **field-overlays.** Each value holds every user field and every rename made so far, so a
  label edit re-stores the whole list. That is O(edits × fields).
- **highlights.** Each value lists every live group, up to 30. The arrays are shared by
  digest.
- **settings.** Each value is the whole 120-control inventory, about 5.3 KB, re-stored by
  every slider step.

In the session file, the lazy values chunk is a single JSON string. At 50k it is 375 MB
(seed 1, uncompressed), and that string is what overflows between 50k and 100k.

## 8. What breaks first, and at what size

In order of size:

0. **About 400 steps (extrapolated from 1k and 10k).** With the State panel open, as it is
   by default, a recorded step's timeline redraw passes one 60 Hz frame. It is 35-37 ms at
   1k steps and 296-299 ms at 10k (§3b). At 10k:
   - opening the panel holds the page for 660-750 ms;
   - scrolling it runs at about 5 fps;
   - a slider drag runs at about 3 fps with recording, and is slowed by paint even without.
1. **About 510 steps on the shown path.** `history.get` passes the connector's 150,000
   characters (about 293 per step, both runs). With `all_branches`, it passes them at about
   500 steps in all.
2. **About 2k steps.** The memory accounting plus the autosave write after each step pass
   one 60 Hz frame (16.7 ms). At 1k they are 4.9-7 ms, at 10k 94-125 ms, growing linearly
   with the pool. **At 10k a slider drag that records a step per frame cannot keep up.** The
   walk's cost depends on how many objects the values hold. The real page's values have their
   own shapes; the browser spec measures the real page (§3b).
3. **About 5,000 steps deep.** Two operations throw "Maximum call stack size exceeded" (§1):
   - `history.get {all_branches: true}` (`describe.js:14-23`, recursive `visit`): 4,997
     steps on a bare chain, failing at every checkpoint from 10k in both runs;
   - deleting a step with more than about 4,600-6,000 steps after it (`tree.js`
     `descendantsOf`, line 179; 5,036 on a bare chain). A failed delete changes nothing.

   Chromium's main-thread stack was not measured; it is V8's default too.
4. **About 10k-50k steps.** Undo and redo pass a frame (14-20 ms at 50k, 40-58 ms at 100k).
   Delete-a-step costs about 15-50 ms per later step.
5. **Between 50k and 100k steps (about 70-75k by extrapolation).** Saving the session file
   throws `RangeError: Invalid string length` (`history-file.js:428`, the lazy values JSON).
   The autosave keeps working because it writes values one record each.
6. **At 100k steps, nothing crashes beyond 3 and 5.**
   - Every step costs about 1.7 s of main thread (accounting plus autosave).
   - The autosave holds 2.9 GB.
   - In Node the history holds 0.87 GB of JS heap and 1.9 GB of arrays, with no
     collectable garbage left. A browser tab's JS heap limit (about 4 GB in Chromium) is not
     reached by the heap itself, but the arrays count against the tab's memory.

   **Memory growth is unbounded by design**: the pool keeps every distinct value for the
   dataset's life (X5).

## 9. Noise and repeats

- Every Node figure in §4 and §5 was measured in two independent runs (seeds 1 and 2,
  separate processes). They agree within about 16% from 50k up. At 10k, sizes that depend
  on which rare large values were made differ by up to 55% (§4).
- §6 is one run: its values are bytes (deterministic for the seed); its times are medians
  of 10-100 steps.
- **Noisy**:
  - every *max* and most *p95* figures, since GC pauses land in single steps (the recorder
    max of 87-91 ms at 100k is GC);
  - the 1k column;
  - replay ms per step, which depends on which kinds the replayed steps are;
  - the first readers run in §10, which ran beside another agent's Playwright job and was
    repeated (see there).
- **Not noisy**: byte counts, character counts, crash sizes, and how the accounting,
  autosave, jump and delete costs grow with size. The trends repeat in both runs at every
  checkpoint.

## 10. Python and R reading a session file

Two runs; each figure is three reads. Run 1 ran beside another agent's Playwright job;
run 2 ran alone through heavy.sh. The time is `read_session` / `cellucid_read_session` alone
(the R package loaded once by `pkgload::load_all`).

| File | Bytes | Python ms, run 1 | Python ms, run 2 | R ms, run 1 | R ms, run 2 |
| --- | --- | --- | --- | --- | --- |
| golden (v2 shape), as committed: 13 steps | 23,710 | 7, 6, 5 | 20, 9, 7 | 382, 381, 41 | 361, 341, 38 |
| golden + 1,000 steps | 43,232 | 63, 63, 80 | 67, 59, 70 | 738, 734, 814 | 684, 692, 763 |
| golden + 10,000 steps | 209,291 | 674, 730, 717 | 625, 670, 677 | 7,350, 7,343, 7,417 | 6,958, 7,051, 7,033 |
| golden + 100,000 steps | 1,870,373 | 7,480, 8,071, 8,697 | 6,957, 7,476, 8,004 | 259,743, 261,665, 254,863 | 217,849, 237,363, 241,057 |
| written by the web app today (v1 shape, 1,000 steps) | 168 KB | refused | refused | refused | refused |

- **Python is linear**, at about 70-80 µs a step.
- **R is superlinear.** It takes about 0.7 ms a step at 1k-10k but 2.2-2.6 ms a step at
  100k, so 10× the steps takes 31-37× the time. That is a cost in the R reader that grows
  with the steps already read (a list grown one element at a time, or a lookup by scanning,
  would do it; not profiled here).
- **The files only grow by step records.** Their values are the golden's 13 steps' values,
  so these figures are the step-parsing cost alone. A real long history adds the value bytes
  of §6 and §7.
- **Both packages refuse the file the web app writes today**, as expected until H2 changes
  the writer to the v2 shape. Python: "Session manifest must contain exactly: actions,
  activeTracker, app, …". R: "its manifest must hold exactly createdAt, app, actions, scope,
  …".

## 11. Recommendations for H1, H2 and H3, each tied to a measurement

Each recommendation cites the measurement it answers (section numbers are this file's). None
of them is a limit.

### H1 (history core)

1. **Make the pool's byte count an O(1) counter** (plan §3.5, P3): add on `put` and `adopt`,
   subtract on `prune`, count each array once by digest. **Why:** the walk
   `pool.byteLength()` costs 47-62 ms per step at 10k and 0.8-0.93 s at 100k (§4), and it
   runs after every step (`dataset-history.js:104`) and in every autosave write
   (`autosave.js:255`). Together they are the first visible lag, at about 2k steps (§8.2).
   **Budget to re-measure:** both stay flat in the steps.
2. **Iterate; never recurse over a path.** Replace the recursion in `describe.js`
   `stepsInOrder` and `tree.js` `descendantsOf`. **Why:** both overflow at about 5,000
   steps deep (§8.3). The suite reports both at every checkpoint from 10k up
   (`failures` in `mixed-*.json`).
3. **Keep the indexes plan §3.6 lists.**
   - Indexes: depth per step, the head's parent chain, `valuesAt(head)` kept current, and
     `tipOf` and `redoTarget` without `pathTo` of the active tip.
   - Re-apply after delete-a-step by moving one step at a time, not by `show(parent)` from
     the root.
   - **Why:** a jump is 41-42 ms, undo 40 ms and redo 56-58 ms at 100k, all linear in depth
     (§4). Delete-a-step costs 42-52 ms per later step at 100k, so 1000 later steps take
     42 s.
   - **Budget:** undo and redo do not grow with depth; a jump is O(the path between the two
     steps plus the restored domains).
4. **Hash big values once, not per step.**
   - Make an analysis result (and any large sub-value) a pool value of its own, kept by
     identity with its hash cached, as `typedArrayDigest` caches arrays.
   - The analysis domain's value then names result hashes.
   - **Why:** the analysis kinds cost 12-20 ms of hashing per step, before and after
     (§5). Switching the analysis panel (one string) re-hashes about 1.5 MB of canonical
     JSON.
   - Hashing big arrays in a worker (plan §3.15.4) would take the remaining 2.4 ms of a ~1M-cell
     brush off the input path (§5).
5. **Store per-entry sub-values for the domains that hold growing lists**: `field-overlays`
   (user fields, renames), `highlights` (groups) and `settings` (the control inventory).
   **Why:** at 100k they re-store 252, 106 and 86 MB of skeleton JSON (§7). A label edit's
   recorder grows from 0.6 ms at 10k to 1.5 ms at 100k with the number of user fields (§5).
6. **Page `history.get` and provide `history.summary`.** **Why:** about 293 characters per
   step, so the 150k connector limit is passed at about 510 steps (§4, §8.1). One page fits
   about 500 steps at today's step size, fewer with params added. `history.summary` has no
   provider in v1.

### H2 (persistence)

1. **Autosave O(changes).**
   - Drop the full copy of every stored step id per write (`autosave.js:211`, `nextStored`)
     and the pool walk (H1.1).
   - **Why:** an autosave write takes 47-63 ms per step at 10k and 0.85-0.90 s at 100k
     (§4); the whole history written at once takes 13.3 s at 100k.
   - **Budget:** a step's write does not grow with the history.
2. **Store cell sets in IndexedDB with the cell-set codec**, as the session file does (plan
   §3.5, "big cell sets").
   - **Why:** IndexedDB holds a ~1M-cell brush in 4.0 MB against the file's 2.7 KB (§6). A
     500k scattered brush costs 2.0 MB against 126 KB, a hidden-cells step 1.56 MB against
     1 KB, and 1M user-field codes 1.0 MB against 0.29 MB.
   - The autosave reaches 2.9 GB at 100k steps against a 446-504 MB file at 50k (§4).
3. **Write the session file's values in bounded chunks** (or one record per value, as the
   autosave does), never one JSON string. **Why:** saving fails with `Invalid string
   length` between 50k and 100k steps (§8.5); the lazy values JSON is 357-375 MB at 50k.
4. **Make step parameter arrays lazy.** **Why:** 65 MB of a 504 MB file is eager at 50k
   because every step's cell parameters are (`history-file.js:510`), while the head's
   values are 0.1 MB of skeleton (§6). The head waits for every brush ever made.
5. **Analysis results: include or recompute on open, and how to store them.**
   - **Why "recompute on open" is worth having:** results are the largest values. At 100k,
     the analysis domain is 965 MB of arrays and 339 MB of skeleton, half of all value bytes
     (§7). One marker run adds 7.8 MB to the file, a differential expression 1.2 MB (§6).
   - **Store floats as float32.** The DE statistics are float64 columns today, and gzip
     gains little on them (1.6 MB raw to 1.12 MB per run, §6).
   - **Store gene names once.** They are in every analysis value's skeleton (about
     0.47 MB per value, §7).
6. **Compression.** gzip pays for skeletons (the lazy values chunk inflates about 6.8×, §4
   breakdown in `mixed-*.json`). It pays little for the float arrays results hold (raw
   arrays 1.27×). Decide `CompressionStream` per chunk kind, not globally.
7. **The R session reader is superlinear**, and History v2's reader (H4) should fix it:
   7.0-7.4 s for 10k steps and 218-262 s for 100k, against Python's 0.6-0.7 s and 7.0-8.7 s
   (§10, two runs).

### H3 (UI)

1. **Virtualise the timeline and the graph** (plan §3.9; X1).
   - **Why:** opening the panel takes 660 ms at 10k steps and one step's redraw 300-370 ms,
     both linear in the rows. Scrolling 10k rows runs at about 5 fps, with under 2% of
     its time in script, layout or style. With only today's 10k rows in the page, a slider drag is held to
     23-27 s per 120 frames even with recording bypassed (§3b).
   - **Budget:** both stay flat in the steps; scrolling at the display's frame rate (8.3 ms
     here) at 10k and 100k.
2. **Never rebuild the list per step.** Only the rows that changed, and only those in view:
   today every step calls `replaceChildren` with every row. **Why:** 21 s of main thread per
   120 slider inputs at 10k (§3b).
3. **The diff dialog's step pickers (X2)** list every step twice. Not measured (§12). They
   would follow the timeline's row costs, and want the same virtualised list.
4. **Re-measure in the page at 100k steps once the timeline is virtualised.** This suite's
   page part stops at 10k: today's list makes a 100k page measure the list, not the
   history.

## 12. Not measured, and why

- **The forms `values: 'none'` (steps only) and state only.** Neither exists in the v1 writer.
  The steps chunk is reported as the steps-only estimate (§6). There is no state-only
  figure: the eager part of the file includes every step's parameter arrays (§6), so it is
  not one.
- **Groups, squashes and paused periods (plan §3.15.4).** They do not exist in v1; H1 adds them,
  and the suite's mix gains them then.
- **The real owners' capture and restore cost in Node.** The page is synthetic (§3), and
  the browser spec measures the real page.
- **IndexedDB's own time and on-disk size in Node.** The stand-in counts bytes and clones on
  each put; it does not model disk. The browser spec reads `navigator.storage.estimate()`.
- **Loading a 100k-step session file.** The file cannot be written at that size (§8.5).
- **A saved state read back above 10k steps.** The stand-in stops holding records past 10k,
  so that one process does not hold the history twice (§3).
- **Firefox and WebKit.** The browser spec runs in Chromium only, as asked ("Chromium
  first").
- **Python and R on a file the web app writes today.** Both refuse it, as expected until H2
  (§10).
- **Frame times in a real page at 50k and 100k steps, and with a mixed history.** Today's
  timeline already holds the page for seconds per step at 10k, so larger figures would
  measure the list. The page's history was built from settings steps; mixed values at scale
  are measured in Node (§4).
- **The analysis run, recording on against bypassed.** Only the first run computed; every
  later one reused the analysis's cached result (§3b).
- **Paint and composite time by name.** Chromium's `Performance.getMetrics` gives task,
  script, layout and style. Paint is what remains of the task time, inferred, not traced.

## 13. Running it again

```
npm run stress:history -- --quick                                  # 2k steps, 100k cells: a check of the suite (seconds)
.cellucid-maintenance/heavy.sh npm run stress:history -- --repeat 2 --out <dir> --guard-gib 7
.cellucid-maintenance/heavy.sh npm run stress:history -- --readers --python <interpreter> --out <dir>
CELLUCID_HISTORY_STRESS=1 CELLUCID_HISTORY_STRESS_OUT=<file.json> \
  .cellucid-maintenance/heavy.sh npx playwright test tests/browser/history-stress.spec.mjs --project=chromium
```

- `npm test` runs `tests/history-stress-harness.test.mjs`: the whole suite at a few hundred
  steps, in seconds. It asserts what the suite returns, never a timing.
- **Each kind alone, since 2026-11-11 (bug hunt F165):** every step is a notebook cell of its own
  (origin `host`, a turn each). Before, each step had a person's origin with a `turn` that a
  person's step does not record, so a kind that coalesces merged every change into the warm-up
  step: the camera row of §15 ("225 → 0", "one gesture's steps coalesce into one") measured
  merges, not steps, and the other coalescing kinds (range filter, setting, panel) merged whenever
  the recipe drew the same key twice. The run now counts only appended steps (`steps`; `merged`
  must be 0) and reports the turn record each cell adds (`turnRecordBytesPerStep`, about 270 B at
  5k cells, included in `fileBytesPerStep`; a person's step has none). §6 and §15 predate it.
- H1-H3 re-point the suite at History v2 and compare against this file.

## 14. History v2 core (H1), measured 2026-11-04

The same suite, re-pointed at History v2 (`history.replay {steps, from, name}`; `history.get` read a
page at a time, `history.summary` measured beside it), one run (seed 1, 1,000,000 cells, 20,000
genes, the same machine), `.cellucid-maintenance/session-09adad82/h1-stress/full1/`. Before is §4's
seed 1 (v1). Each §11 H1 item, before → after:

| §11 item | 1k | 10k | 100k |
| --- | --- | --- | --- |
| H1.1 memory accounting per step, ms (O(1) byte counter) | 3.2 → 0.0 | 46.5 → 0.0 | 796 → 0.0 |
| H1.2 `history.get` every branch (no recursion) | ok → ok | stack overflow → ok | stack overflow → ok |
| H1.2 delete a step with 1000 after it (no recursion) | 265 → 595 ms | 1823 → 41 ms | 42,909 → 491 ms |
| H1.3 undo p50, ms (no walk of the path) | 0.18 → 0.21 | 1.6 → 0.16 | 40.2 → 0.08 |
| H1.3 delete a step with 10 / 100 after it, ms (only dependants applied again) | 5 / 33 → 7 / 40 | 87 / 290 → 24 / 44 | 515 / 4817 → 179 / 213 |
| H1.3 jump to a random step, p50 / max ms (the path between the two) | 0.6 / 0.7 → 1.3 / 2.1 | 10.1 / 11.0 → 8.9 / 13.4 | 41.4 / 53.0 → 43.0 / 85.1 |
| H1.4 analysis panel switched, recorder p50 ms | — | 11.97 → 9.73 | 13.36 → 9.62 |
| H1.4 differential expression / markers / correlation, recorder p50 ms | — | 8.95 / 18.54 / 13.09 → 10.59 / 19.17 / 10.79 | 15.62 / 19.82 / 14.15 → 11.48 / 16.78 / 10.87 |
| H1.5 label edit / user field, recorder p50 ms | — | 0.58 / 1.09 → 0.70 / 1.51 | 1.48 / 2.09 → 1.19 / 1.85 |
| H1.6 `history.get`, characters (a page of 200 steps) | 291,503 → 67,308 | 2,887,596 → 67,654 | 27,330,523 → 73,009 |
| H1.6 `history.summary`, characters (no provider in v1) | — → 664 | — → 1,941 | — → 16,103 (102 branches) |
| recorder p50 / p95 ms, every step | 0.13 / 0.41 → 0.22 / 0.80 | 0.13 / 0.60 → 0.20 / 1.48 | 0.15 / 1.45 → 0.15 / 1.24 |

What these show:

- **Flat in the steps:** the accounting (a counter), undo, `history.get` (a page), and a delete's
  re-apply, which now runs only the later steps that changed or read what the deleted step
  changed (1000 after it at 100k: 69 applied again, 491 ms, against 42.9 s for all of them in v1).
  What remains of a delete at 100k is linear and cheap: reading the values at the deleted step's
  parent from the root (one walk) and the dependants' own dispatches.
- **A jump** costs the steps between the two (§3.6 budget): a random step at 100k is ~57k steps
  away, walked once each way, so a random jump is as long as v1's; a jump to a near step, an undo
  and a redo cost a few steps.
- **`history.summary` grows with branches, groups and turns, never with steps** (16 kB at 102
  branches); it takes 87 ms at 100k, most of it the stale check over the path to the head.
- **Hashing big values (H1.4) is cheaper but not gone.** Canonical text is now written in one
  synchronous pass after the arrays' digests (no wait per node): switching the analysis panel went
  from 12-13 ms to 9.6-9.7 ms. What remains is SHA-256 over the canonical text of every result
  the analysis domain holds (1.5-10 MB), which a new result needs anyway. Hashing a result once by
  its identity (a sub-value hash in the canonical text) changes the value hash rule the session
  file, the autosave and the Python and R readers verify; H2 chose (2026-11-04) to dedupe big
  sub-values on the storage side only (`$part`, gene names once), so the hash rule stays and this
  item is left at the measurement above. Hashing in a worker (§3.15.4) is the next step for the
  input path.
- **Per-entry growing lists (H1.5)**: the label edit's and user field's recorder still grows with
  the user fields held (0.70 → 1.19 ms from 10k to 100k); the storage half (each entry stored once,
  252 MB of `field-overlays` skeletons) is H2's `$part` work.
- **Not H1's:** the autosave write per step (2.2 / 24.3 / 179.6 ms) is H2's (the walk of the pool
  is gone; the copy of every stored step id per write is not), and the session file still cannot be
  written at 100k steps (`Invalid string length`, H2's chunked values).

## 15. History v2 persistence (H2), measured 2026-11-04

The same suite after H2 (format-4 writer through the share scope, `$part` sub-values, chunked
pieces, compression per chunk by measured gain, lazy parameter arrays; the autosave written per
change with cell sets in the cell-set encoding), one run (seed 1, 1,000,000 cells, 20,000 genes,
the same machine), `.cellucid-maintenance/session-09adad82/h2-stress/full/` (h2 at `59b7755b7`).
Before is §4 / §6 seed 1 (v1) and, for the autosave write, §14 (H1). Each §11 H2 item, before →
after:

| §11 item | 1k | 10k | 50k | 100k |
| --- | --- | --- | --- | --- |
| H2.1 autosave write per step, ms (p50) | 1.7 → 0.3 | 47 → 0.2 | 345 → 0.3 | 848 → 0.3 |
| H2.2 autosave in IndexedDB, MiB | 16 → 8.2 | 217 → 96 | 1379 → 674 | 2880 → 1474 |
| H2.3 session file (Save, the whole history), MiB | 2.5 → 3.3 | 66.8 → 35.5 | 504 → 343 | **write fails → 743** |
| H2.3 session write, s | 0.7 → 0.81 | 7.7 → 7.2 | 50.4 → 51.8 | — → 114.9 |
| H2.4 head shown (manifest and eager chunks read), s | — → 0.08 | — → 0.37 | — → 1.42 | — → 4.0 (second run) |
| H2.4 whole load (eager, then lazy, then applied), s | 0.2 → 0.29 | 2.5 → 2.49 | 18.0 → 19.8 | — → 75.1 (second run) |
| H2.5 Share, state only (head as one squashed step), MiB / s | — → 1.9 / 0.62 | — → 7.9 / 3.5 | — → 28.4 / 12.2 | — → 46.8 / 23.5 |
| H2.5 Share, steps only (no values), MiB / s | — → 0.20 / 0.06 | — → 1.26 / 0.32 | — → 6.0 / 1.9 | — → 12.1 / 3.5 |
| H2.5 Save, results recompute, MiB / s | — → 2.0 / 0.76 | — → 15.9 / 5.3 | — → 73.5 / 25.7 | — → 143 / 55.2 |
| A named save ("Save as" to this browser, the whole history), s | 0.06 → 0.15 → 0.12 | 0.82 → 1.55 → 1.11 | 5.6 → 15.2 → 18.2 | 13.3 → 30.2 → 19.4 |

Where the 100k file's bytes are (`mixed-1.json` `session.breakdown`): steps 12.1 MB (15 eager
pieces, 97 MB inflated), the head's values 1.8 kB with 46.6 MB of the arrays it names, and lazily
625.9 MB of raw arrays (analysis results and user-field codes), 62.9 MB of cell sets, 18.3 MB of
parts (283 MB inflated: each sub-value two values share is stored once) and 8.1 MB of value
skeletons.

Each kind alone (§6 before → after, B per step; the autosave column is what IndexedDB holds):

| Kind | Session file | Autosave | Autosave write p50 ms |
| --- | --- | --- | --- |
| camera (one gesture's steps coalesce into one) | 225 → 0 | 999 → 282 | 0.36 → 0.11 |
| color by field / gene | 27 / 116 → 32 / 124 | 501 / 580 → 960 / 1,057 | 0.29 / 0.30 → 0.09 / 0.10 |
| category / range filter | 138 / 182 → 226 / 220 | 1,422 / 1,404 → 2,033 / 1,946 | 0.38 / 0.37 → 0.14 / 0.14 |
| brush 1k / 100k cells | 2,413 / 65,908 → 2,512 / 66,009 | 18,228 / 407,975 → 16,656 / 108,475 | 0.90 / 0.63 → 0.53 / 1.68 |
| brush 500k scattered / ~1M cells | 125,687 / 2,661 → 125,745 / 2,774 | **2,003,696 / 3,999,997 → 129,551 / 7,429** | 0.79 / 1.73 → 6.65 / 8.12 |
| cells hidden (10k more) | 979 → 941 | **1,556,493 → 1,406** | 0.56 → 3.39 |
| label edit / user field | 169 / 293,496 → 260 / 293,570 | 4,025 / 1,009,124 → 4,488 / 1,003,955 | 0.54 / 0.81 → 0.47 / 0.82 |
| analysis panel switched | 1,605 → 31 | 8,299 → 1,358 | 15.29 → 0.18 |
| differential expression / markers / correlation | 1,228,632 / 7,811,814 / 825,373 → 1,133,244 / 7,712,512 / 722,146 | 2,115,669 / 10,115,645 / 1,315,735 → 1,607,066 / 9,630,817 / 808,421 | 24.17 / 27.40 / 23.44 → 8.31 / 14.96 / 7.64 |

What these show:

- **The autosave costs what changed (H2.1):** 0.2-0.3 ms a step at every size, against 0.85 s at
  100k in v1 and 180 ms after H1. A write takes the step, its parent, the tracker's own record,
  the values, parts and arrays the saved state does not hold yet, and the saved state's record.
- **Cell sets in IndexedDB (H2.2):** a ~1M-cell brush is 7.4 kB instead of 4.0 MB, a hidden-cells
  step 1.4 kB instead of 1.56 MB; the autosave is half v1's at every size. What remains is
  analysis results (float64 columns, kept as they are) and user-field codes. Encoding a cell set
  costs 6-8 ms a step for 0.5-1M cells, off the recording path (the write runs in the next task).
- **The session file is written at 100k (H2.3):** 743 MiB in 115 s; JSON is cut into pieces of
  16 MiB, so no string nears the engine's limit. At 10k-50k the file is a third smaller than v1's
  (`$part`: gene names and growing user-field lists once).
- **The head no longer waits for every brush (H2.4):** parameter arrays a step names are lazy
  unless the head's values name them, so the head is shown after 1.4 s at 50k while the rest
  (lazy values and arrays) reads behind it; the whole load stays where v1's was.
- **Share forms (H2.5):** from 10k up a state alone is 4.5-16× smaller than the whole history and
  steps only 28-61× (at 1k: 1.7× and 16×); results recompute makes the file 1.7-5× smaller,
  because analysis results are the largest values.
- **Compression per chunk by measured gain (H2.6):** gzip is kept only where it saves a sixteenth;
  skeletons inflate 6-15×, raw float arrays 1.28×, cell sets 1.37×.
- **The load at 100k** (a second run, `.cellucid-maintenance/session-09adad82/h2-stress/full2/`,
  h2 after the review fixes, `--guard-gib 12` so the process had room to hold the history twice):
  the head is shown after 4.0 s and the whole 100,813-step history is loaded in 75.1 s (50k: 1.5 s
  and 18.0 s). The first run skipped it (5.2 GB resident against half a 7 GiB guard).
- **A collect** (what removing a saved state anywhere, and the page's start, runs over every record
  this browser keeps, `autosave-store.js` `collectIn`) takes 8 ms at 1k and 55 ms at 10k in the
  suite's IndexedDB stand-in, linear in the records; from 50k the stand-in holds no records (the
  suite lets them go to fit in memory), so it is not measured there. A browser's IndexedDB adds the
  structured clone of every record it reads (the parts' 283 MB of text at 100k): a collect then
  costs seconds at that size, off the recording path; reference counts per record would make it
  O(change), measured follow-up.
- **A named save was 2-2.7× slower than v1's** (30 s at 100k in this run): it encodes every value,
  part and cell set of the whole history again before the store finds most of them already kept
  by the autosave (the named save adds 98 MB to the 1.5 GB the autosave holds). Profiled on a
  1,386-step history of 200k cells (named save 875 ms): measuring cell-set encodings was half of
  it and an `await` per node of every value most of the rest. Each array's cell-set bytes are now
  measured once (`history-file.js` `encodeArray`, cached per array as its digest is), and
  `splitValue` waits once per array and per part, not per node: the same save takes 304 ms
  (2.9× quicker), and a session file written after the autosave reuses the same encodings. In the
  second full run (beside other agents' jobs) a named save takes 0.12 / 1.11 / 18.2 / 19.4 s at
  1k / 10k / 50k / 100k: the snapshot and the stand-in's structured clone of every new record are
  what is left of it at scale.
- **Python and R read what the web app writes (H2.7)**, `npm run stress:history -- --readers`
  (`.cellucid-maintenance/session-09adad82/h2-stress/readers/`, h2 at `56a3232cc`, one run beside
  another agent's Playwright job; §10 is before). Three reads each, ms:

  | File | Bytes | Python | R |
  | --- | --- | --- | --- |
  | golden (History v2), 13 steps | 27,085 | 14, 7, 8 | 513, 528, 55 |
  | golden + 1,000 steps | 46,745 | 76, 89, 76 | 838, 851, 890 |
  | golden + 10,000 steps | 213,106 | 834, 866, 864 | 8,933, 8,507, 7,894 |
  | golden + 100,000 steps | 1,883,686 | 9,594, 10,289, 10,522 | 110,353, 102,554, 104,897 |
  | the web app's own Save, 1,000 mixed steps | 235,662 | 581, 546, 544 | 3,859, 4,200, 4,321 |

  Both read the web app's file (v1: refused by both). R is now near linear: 10× the steps takes
  12× the time (0.85 → 8.5 → 105 s), against 31-37× in v1 (218-262 s at 100k); Python stays
  linear at about 0.1 ms a step.
- **Float32 analysis results (H2.5) are not done**: storing float64 statistics as float32 changes
  the values the hash names (a lossy write), and is the analysis code's to decide; gene names are
  stored once through `$part`.

## 16. History v2 core after the review's fix pass (H1), measured 2026-11-05

The same suite and machine, seed 1, `.cellucid-maintenance/session-09adad82/h1-stress/full3/`
(after) against §14 (before this pass). What the pass changed that the suite sees: every edit
runs alone (`exclusive`), the pool releases what nothing refers to, a domain that follows another
(`DERIVED_DOMAINS`: the analyses follow the highlight pages) is captured with it, observed changes
are read as their gesture's task ends, a delete compares inputs in canonical form, and steps taken
out at once (a squash, a branch delete) have their depths computed again once.

| | 1k | 10k | 100k |
| --- | --- | --- | --- |
| recorder p50 / p95 ms, every step | 0.22 / 0.80 → 0.29 / 0.92 | 0.20 / 1.48 → 0.31 / 1.43 | 0.15 / 1.24 → 0.24 / 2.33 |
| brush (1k cells) recorder p50 / p95 ms | 0.36 / 1.46 (v2 §14) → 0.53 / 1.36 | → 1.35 / 2.99 | → 2.46 / 5.36 |
| delete a step with 1000 after it, ms | 595 → 581 | 41 → 25 | 491 → 414 |
| delete a step with 10 / 100 after it, ms | 7 / 40 → 4 / 34 | 24 / 44 → 24 / 26 | 179 / 213 → 140 / 156 |
| undo p50, ms | 0.21 → 0.13 | 0.16 → 0.34 | 0.08 → 0.08 |
| jump p50 / max ms | 1.3 / 2.1 → 0.9 / 1.4 | 8.9 / 13.4 → 10.8 / 21.5 | 43.0 / 85.1 → 58.3 / 92.1 |
| a 500-step squash near the root, 100k steps below (`s13`, fake page) | | | 6,251 → 89 ms |

What these show:

- **The analyses captured with every highlight change** first cost a hash of every result they
  held: a brush's recorder p50 went to 11.7 ms at 100k (an intermediate run, `full2`). The analysis
  domain now gives back the value it captured last while nothing about it changed, and the pool
  never hashes a value object twice (`value-pool.js`), so the follow-up costs a comparison: 2.5 ms
  p50 at 100k with the mixed history's analyses held (≈1.6 MB of results), 0.5 ms at 1k. Storing
  the person's page choice ("all pages") in the analyses instead of the derived list, so a page
  change changes nothing there, is the rest (§S7a, deferred).
- **A squash or a branch delete** takes all its steps out first and computes the depths below
  once: a 500-step squash with 100k steps below went from 6.3 s to 89 ms.
- **A delete compares its inputs in canonical form**: at 1k the 1000-later-steps delete is where
  it was (581 ms; most of its dependants change what they read); the others are flat or faster.
- Every other figure is within the run-to-run noise of §9.
