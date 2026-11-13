# `app/dataset/`: the dataset shown, published and replaced

**Owns:** the one runtime the page shows (a dataset, a synthetic benchmark scene, or none): how
a dataset change stages it, publishes it in one synchronous step, puts the previous one back
when that step fails, settles the interface on it, and the catalog's starting view applied to
it. Every change of dataset passes here: startup's dataset, a sample, None, a file, a link, a
server, a session or saved state of another dataset, `dataset.open`, the benchmark, and the
same dataset read again on other cells.

| Module | What it does |
| --- | --- |
| `publication.js` | `createDatasetPublication`: the publication itself. Stages a dataset's runtime (`stageDatasetRuntime`: its generation, mapping, positions, field loaders, vector fields), commits it (`commitDatasetRuntimeStage`, `commitSyntheticRuntimeStage`, `publishEmptyDatasetRuntime`) after retiring everything of the dataset shown (kept views, the selection under way, the edges, the history unless the same dataset is read again: `keepHistory`), puts the previous runtime back (`restorePreviousRuntime`), settles the interface (`synchronizePublishedDatasetUi`), and holds what the rest reads of the dataset shown (its base URL, dimension manager, stage and publication). Makes the connectivity owner and the data mapping's runtime, and publishes the empty runtime first |
| `reload.js` | `createDatasetChanges`: one dataset change as a transaction (`reloadActiveDatasetInPlace`, shown by its opening: `reloadActiveDatasetShown`; None: `clearActiveDatasetInPlace`). The question before unkept work is replaced, staging under the change's signal, the GPU stores made before anything is replaced, the publication with its three unwinding failures, the history opened and begun, the starting view, the first coloring, My datasets, and a progressive opening's growth |
| `published-state.js` | `createPublishedDatasetState`: the catalog's starting view of the dataset published, one restore at a time, stopped and waited for by the next change; how its outcome is said |

**Entry points:** `app/main.js` makes the three, in start-up order: the publication (with its
continuation owner, made on the line before it, so a teardown during its creation retires it),
the published state once the session serializer exists, the dataset changes just before the
interface (`initUI` takes `reloadActiveDatasetShown` and `clearActiveDatasetInPlace`). The
synthetic benchmark (`ui/modules/benchmark/benchmark-controls.js`) and the open cells resized in
place (`open-cells-resize.js`) are clients of the same publication.

**Invariants:**
- The publication is one synchronous step after every fallible read: nothing awaits between the
  last check of the change's transaction and the commit, and the commit names no control of the
  interface (`dataset-reload-outcome.js`).
- Each continuation after an await checks it still belongs to the publication shown
  (`assertCurrentDatasetPublication`); a superseded one changes nothing.
- A failed publication puts back the runtime that was shown and restarts its history; a failed
  staging leaves the dataset shown untouched.
- What a module here needs of a part made later (the interface, the history, the host's results,
  the analysis module) it reads through a getter given to it; nothing here imports
  `app/ui/modules/` (the connectivity controls are passed in).
- No module runs anything when imported.
