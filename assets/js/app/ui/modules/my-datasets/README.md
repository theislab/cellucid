# `ui/modules/my-datasets/`: My datasets in Session › Open data

**Owns:** the My datasets control under the sample dataset list and its All… dialog, drawn from
the list this browser keeps (`app/library/my-datasets.js`), the saved states of histories
(`app/history/current.js`, `autosave.js`), the files whose handle is kept
(`app/library/local-file-handles.js`) and what the Stored machinery keeps
(`data/anndata/transcode/space.js`).

| Module | What it draws or does |
| --- | --- |
| `index.js` | `initMyDatasets`: follows every change (a dataset recorded or forgotten, another shown, a handle kept or forgotten; while All… is open, a saved state written or removed, the history shown and what is stored) and opens a dataset again inside the person's click |
| `menu.js` | the dropdown: its button names the dataset open now when it is listed; the five most recent (`RECENT_DATASETS`), the one open now marked and not offered again, then All… (alone while the list is empty: shown even then, for Import…); the status line when the list is not kept beyond this page or window |
| `dialog.js` | All…: every dataset as a compact row (name, kind, when; one line under it), its name opens the facts behind it; Open, Continue (its latest saved state), Forget (asked in the row, saying what goes and what stays; saved states only when ticked); the filter by name; Export… (in place of the rows: every dataset ticked with its saved states under it, saved states of datasets not listed unticked, one line of what is ticked, saying conversations go too and changes made while paused do not) and Import… of a library file (`app/library/library-file.js`), the status line saying what was added and what was already there |
| `model.js` | pure: each dataset's kind and origin, how it opens again (`click`, `ask`, `choose`), its menu item, its row's line and facts, its saved states and the one Continue opens, what is stored of it (as the Stored dialog names a dataset: its file's name and host), the filter and the status line, what an export chose and wrote and what an import added |

**Entry points:** `initMyDatasets` (from `ui/core/ui-coordinator.js`), `importLibraryFile` (a
library file dropped on the page or chosen in Open… › File…, `dataset-connections.js`: All…
opens and imports it as Import… does), `openAll` (the Stored
dialog's Show…), `openWithLastCells` (opening a listed dataset with the cells it was last open
with; an agent's `dataset.open` opens one this way too, `../dataset-open-action.js`).

**Invariants:**
- Opening runs inside the click: a file of this computer is read through its kept handle (the
  browser asks for leave to read it then), or, where no handle is kept, the click opens Open… ›
  File… (or Folder…) and says which to choose.
- Continue opens the dataset, then its latest saved state (`openSavedState`), so the history is
  back at once and never offered.
- Nothing here keeps a list of its own: every drawing reads the stores again.
- Import adds beside: nothing kept is replaced (`library.add`, saved states "<name> (imported)").
  The export's text says conversations with agents go with the saved states, since they can be
  private.
- The control is not a session control (`data-state-serializer-skip`); opening a dataset is not a
  step of a history.

**Tests:** `tests/my-datasets.test.mjs` (the model), `tests/library-file.test.mjs` (the file and
the export's and import's words), `tests/browser/my-datasets.spec.mjs`,
`tests/browser/my-datasets-library-file.spec.mjs`.
