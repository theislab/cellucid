/**
 * The page side of the live-history specs (`viewer-history.spec.mjs`,
 * `r-viewer-history.spec.mjs`): the viewer channel (`data/viewer-host-source.js`),
 * the command handler (`app/viewer-host/command-handler.js`), the app's own
 * action dispatcher and catalog, and a real history (`app/history/history.js`)
 * recording each step, with `app/viewer-host/history-events.js` telling the
 * host every change of it -- the modules the app wires in `app/main.js`.
 *
 * `highlight.cells` is the one data action provided (it adds a group to a
 * highlights value the history captures); a pushed session file is "loaded"
 * by reading its manifest, so the answer proves the file arrived whole: the
 * tracker it shows and that tracker's head. A second file is refused.
 */

/**
 * Open the channel to the host and start the history. Resolves once the
 * viewer said it is ready.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{url: string, viewerId: string, viewerToken: string, dataset: string, cells: number}} config
 */
export async function openHostHistoryPage(page, config) {
  await page.evaluate(async config => {
    const { ViewerHostDataSource } = await import('/assets/js/data/viewer-host-source.js');
    const { createCellIdentity } = await import('/assets/js/data/cell-identity.js');
    const { createViewerHostCommandHandlers } = await import('/assets/js/app/viewer-host/command-handler.js');
    const { createViewerHostHistoryEvents } = await import('/assets/js/app/viewer-host/history-events.js');
    const { createActionCatalog } = await import('/assets/js/app/actions/catalog.js');
    const { ACTION_DEFINITIONS } = await import('/assets/js/app/actions/definitions/index.js');
    const { createActionDispatcher } = await import('/assets/js/app/actions/dispatcher.js');
    const { createDomainRegistry } = await import('/assets/js/app/actions/domains.js');
    const { createHistory } = await import('/assets/js/app/history/history.js');

    let highlights = { active: null, pages: [] };
    const domains = createDomainRegistry();
    for (const id of domains.missing()) {
      domains.provide(id, {
        capture: () => (id === 'highlights' ? highlights : null),
        restore: value => { if (id === 'highlights') highlights = value; },
      });
    }
    const dispatcher = createActionDispatcher({ catalog: createActionCatalog(ACTION_DEFINITIONS) });
    let groups = 0;
    dispatcher.provide('highlight.cells', ({ cells, label }) => {
      const id = `highlight_${++groups}`;
      const page = highlights.pages[0] ?? { id: 'page_1', name: 'Page 1', color: '#2563eb', groups: [] };
      highlights = {
        active: 'page_1',
        pages: [{ ...page, groups: [...page.groups, { id, label: label ?? id, cells: Array.from(cells) }] }],
      };
      return { group: id, page: 'Page 1', cells: cells.length };
    });
    let clock = 1_767_225_600_000;
    let trackers = 0;
    const history = createHistory({
      dispatcher, domains, dataset: { id: config.dataset, name: config.dataset, cellOrder: null },
      newTrackerId: () => `t-00000000-0000-4000-8000-00000000000${++trackers}`, now: () => (clock += 1000),
    });

    const source = new ViewerHostDataSource({
      serverUrl: config.url,
      viewerId: config.viewerId,
      viewerToken: config.viewerToken,
    });
    const commands = [];
    let loads = 0;
    const handlers = createViewerHostCommandHandlers({
      getShownHostDataset: () => source.getShownHostDataset(),
      getHostRuntime: () => source.getHostRuntime(),
      actions: dispatcher,
      loadSession: async file => {
        if (++loads > 1) throw new Error('This page loads one session.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const signature = 'CELLUCID_SESSION/4\n';
        if (new TextDecoder().decode(bytes.subarray(0, signature.length)) !== signature) throw new Error('Not a session file.');
        const length = new DataView(bytes.buffer).getUint32(signature.length, true);
        const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(signature.length + 4, signature.length + 4 + length)));
        const shown = manifest.trackers.find(tracker => tracker.id === manifest.activeTracker);
        window.__hostHistory.loaded.push({ name: file.name, bytes: bytes.length });
        return { tracker: { id: shown.id, name: shown.name }, head: shown.headId };
      },
    });
    source.onAction(command => {
      commands.push({ action: command.action, turn: command.turn, turnLabel: command.turnLabel });
      return handlers.handleAction(command);
    });
    source.onLoadSession(handlers.handleLoadSession);
    if (!(await source.initialize())) throw new Error('the channel did not open');
    const identity = createCellIdentity({ nObs: config.cells });
    source.setCellIdentityProvider(() => identity);
    // The host's dataset is the one shown.
    source.setShownDatasetProvider(() => config.dataset);
    source.acceptCommands();
    await source.notifyReady({ dimensions: 2 });
    const errors = [];
    createViewerHostHistoryEvents({
      notify: change => source.notifyHistoryChanged(change),
      getCurrentHistory: () => history,
      subscribeCurrentHistory: () => () => {},
      onError: error => errors.push(String(error)),
    });
    await history.startTracker({ name: 'Tracker 1' });

    window.__hostHistory = {
      commands,
      errors,
      loaded: [],
      // Each highlight step the history recorded, with the turn it is in.
      steps: () => {
        const steps = history.active.steps instanceof Map ? [...history.active.steps.values()] : history.active.steps;
        return steps.filter(step => step.type === 'highlight.cells').map(step => ({
          id: step.id, turn: step.turn ?? step.by?.turn ?? null,
        }));
      },
      head: () => history.active.headId,
    };
  }, config);
}
