/**
 * File-drop guard (classic script, runs before the module graph).
 *
 * A browser that receives a dropped file it has no handler for navigates to
 * that file, which unloads Cellucid and everything open in it. The module
 * graph adds a real drop target for datasets (`ui/modules/dataset-drop.js`),
 * but only once the data controls exist; before that, and anywhere the target
 * does not reach, a dropped file must still go nowhere.
 *
 * So, from the first paint, every drag that carries files is cancelled at the
 * document: the page never navigates on a drop. Until the dataset drop target
 * marks itself ready on the root element, the drag is offered as `none`, so
 * the pointer says plainly that nothing will happen. Drags that carry no files
 * (text, the app's own reordering) are left alone.
 *
 * Loaded directly from `index.html` with no dependencies, like
 * `code-load-watch.js`, so it cannot share a failure of the module graph.
 */
(() => {
  const carriesFiles = event => {
    const types = event.dataTransfer && event.dataTransfer.types;
    return types != null && Array.from(types).includes('Files');
  };
  const dropTargetReady = () =>
    document.documentElement.dataset.datasetDrop === 'ready';

  const offer = event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (!dropTargetReady()) event.dataTransfer.dropEffect = 'none';
  };
  document.addEventListener('dragenter', offer);
  document.addEventListener('dragover', offer);
  document.addEventListener('drop', event => {
    if (carriesFiles(event)) event.preventDefault();
  });
})();
