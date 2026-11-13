# `app/library/`: what this browser keeps of the person's own datasets

**Owns:** My datasets (`my-datasets.js`): the datasets opened in this browser, most recently
opened first, in IndexedDB `cellucid-library` (object store `datasets`, one record per dataset
keyed by its identity, the id sessions and saved states key on), each with how it opens again;
and the handles of the files and folders of this computer among them (`local-file-handles.js`,
IndexedDB `cellucid-local-files`), which open them again with one click where the browser gives
handles (Chromium, a page not in a frame). The interface that draws them is
`ui/modules/my-datasets/` (Session › Open data › My datasets, and its All… dialog).

| Module | What it does |
| --- | --- |
| `my-datasets.js` | the record of a dataset (`LIBRARY_RECORD_VERSION`): name, where it opens from (`session/dataset-source-record.js`: a sample, a link in its public form, a Cellucid server, a file or folder by name), for a link its provider and whether what it carried to grant access was left out, its storage (format, layout, file name, host, size), cells and genes, the cells it was last open with (`openCells`), first and last opened, how often; recorded by the page (`recordDatasetOpened`), listed (`listMyDatasets`), forgotten (`forgetMyDatasets`), heard (`onMyDatasetsChange`); the request it opens again with (`reopenRequestOf`) |
| `library-file.js` | a `.cellucid-library` file: the datasets and saved states chosen, to take to another browser. The session bundle's framing (`session/bundle/`) under its own signature `CELLUCID_LIBRARY/1\n`; its manifest `{createdAt, app: {version}, datasets: [<record>], histories: [{chunk, name, kind, dataset: {id, name}, createdAt, updatedAt}], chunks: [{id, kind: 'session', codec: 'none', storedBytes}]}`; each history chunk one complete `.cellucid-session` (format 4) of a saved state read whole, every tracker and branch with results, notes, Recently deleted, conversations and exact times (`LIBRARY_SCOPE`), stored without a second gzip. `exportLibrary` (default: every dataset and its saved states this version opens), `importLibrary` (checked whole first: manifest, every record by `readRecord`, every history by `readHistoryFile`; then `library.add` and `keepAsSavedState`), `readLibraryFile` |
| `local-file-handles.js` | the browser's handle of a file or folder opened from this computer, under its dataset's id: kept, read again (asking for leave inside the person's click), forgotten; which local dataset this tab shows, for its reload's offer |

**Entry points:** `recordDatasetOpened(dataSourceManager, {counted})` (`app/main.js`: once a
dataset is published, counted unless it is the same dataset read on other cells; again, uncounted,
after the open cells grow or shrink in place); `listMyDatasets`, `forgetMyDatasets`,
`onMyDatasetsChange`, `myDatasets()` (the page's list; `add(records)` adds datasets it does not
hold); `exportLibrary`, `importLibrary`, `readLibraryFile` (`library-file.js`); `keepLocalFile`, `readKeptLocalFile`,
`listLocalFiles`, `forgetLocalFiles`.

**Invariants:**
- Nothing leaves the browser by itself: no server, no account; only a library file the person
  exports. A link is kept in its public form
  (`data/sources/link-credentials.js`); what it carried to grant access (a key, a signature, a
  token) never is, only that it did (`link.accessLeftOut`). No path of a local file is kept, only
  its name; its handle is the browser's reference, usable by this site in this browser only.
- Listed are datasets that can be opened again: a notebook's dataset (a viewer host) names no
  source and is not listed. The startup's default sample is not an opening the person chose and is
  not recorded; a sample chosen is.
- A reading of the same dataset on other cells (Cells to open, a progressive opening's growth)
  updates a dataset listed and never lists one.
- A dataset opens again with the cells it was last open with when they were chosen (a
  subsample's method, size and seed: the next opening's request, `data/cell-subset-policy.js`,
  withdrawn when its opening ends without taking it); every cell, or cells the device fit chose,
  open as the tab opens datasets now.
- Forgetting a dataset forgets its file's handle; its saved states (`app/history/autosave.js`)
  only when the person ticks them.
- A page whose browser gives it no IndexedDB (or refuses it) keeps the list for that page only
  (`lasting` false) and says so; a window that keeps nothing for a later visit keeps it until it
  closes (`keptStoragePlace`) and says so.
- Records are read back checked (`readRecord`): a record of another layout is not listed.
- A library file is untrusted input: its import checks all of it before it adds anything and
  replaces nothing kept (`library.add` never replaces a dataset); a session file given to the
  importer, and a library file given to Load, are refused saying what they are. The import's
  steps are developer doc 10, "The library file"
  (`cellucid-python/docs/user_guide/web_app/p_developer_docs/10_sessions_persistence_and_serialization.md`).
- A saved state's paused draft (changes made while recording was paused, not yet a step) cannot
  be in a session file: the export leaves it out, keeps the tracker paused, and says so.

**Who owns what is stored:** My datasets owns the datasets and how each opens again (their file
handles included): each is listed in its dialog and nowhere else. The Stored dialog
(`ui/modules/kept-stores-dialog.js`) owns what takes room for faster openings and shows My
datasets as one row (how many, Show…, Remove). State › Session › Load… owns the histories (the saved states); My
datasets shows a dataset's saved states as facts and opens the latest with Continue.

**Tests:** `tests/my-datasets.test.mjs`, `tests/library-file.test.mjs`,
`tests/local-file-handles.test.mjs`, `tests/browser/my-datasets.spec.mjs`,
`tests/browser/my-datasets-library-file.spec.mjs`, `tests/browser/local-file-reopen.spec.mjs`.
