/**
 * @fileoverview The viewer channel's side of the application, for a viewer
 * that Python or R opened: the session bundle the host asks for, the host's
 * actions and pushed session files (`command-handler.js`), what the person
 * makes published to the host (`results.js`), every change of the history
 * and of the data mapping told to it (`history-events.js`), and an agent app
 * on the host's computer driving the viewer through a local connection
 * (`app/agent/bridge/agent-calls.js`).
 *
 * It owns that wiring, made once the interface exists, and ends it by
 * accepting the commands the host sent while the dataset opened. The channel
 * is `data/viewer-host-source.js`'s; the view of the viewer (its end, its
 * pointer hooks) is `host-view.js`'s; when each piece is made is the
 * start-up's (`app/main.js`).
 *
 * @module app/viewer-host/host-channel
 */

import { SAVE_DEFAULTS } from '../session/index.js';
import { getActions } from '../actions/index.js';
import { createAgentCalls } from '../agent/bridge/agent-calls.js';
import { getCurrentHistory, subscribeCurrentHistory } from '../history/current.js';
import { createViewerHostCommandHandlers } from './command-handler.js';
import { createViewerHostHistoryEvents } from './history-events.js';
import { createViewerHostResults } from './results.js';

/**
 * Answer the host's requests for the session, as Save writes it.
 *
 * @param {{
 *   viewerHostSource: import('../../data/viewer-host-source.js').ViewerHostDataSource,
 *   sessionSerializer: Object,
 * }} options
 */
export function installViewerHostSessionBundles({ viewerHostSource, sessionSerializer }) {

  viewerHostSource.onMessage(async message => {
    if (message.type !== 'requestSessionBundle') return;
    // The notebook gets the history as Save writes it (without the conversations).
    const bundle = await sessionSerializer.createSessionBundle({ choice: SAVE_DEFAULTS });
    viewerHostSource.sendSessionBundle(message.requestId, bundle);
  });
}

/**
 * Wire the host's commands, results, history events, mapping reports and
 * local agents, then accept the commands it sent meanwhile.
 *
 * @param {{
 *   viewerHostSource: import('../../data/viewer-host-source.js').ViewerHostDataSource,
 *   state: Object,
 *   dataSourceManager: Object,
 *   sessionSerializer: Object,
 *   datasetHistories: Object,
 *   agentPresence: Object|null,
 * }} options - `agentPresence`: the interface's agents (`ui.agents.presence`), or null.
 * @returns {Readonly<{results: ReturnType<typeof createViewerHostResults>, stop: () => void}>}
 *   `results`: what the person makes, published to the host; `stop`: ends the history events.
 */
export function installViewerHostChannel({
  viewerHostSource,
  state,
  dataSourceManager,
  sessionSerializer,
  datasetHistories,
  agentPresence
}) {

  const getCellIdentity = () => state.cellIdentity;
  viewerHostSource.setCellIdentityProvider(getCellIdentity);
  // The host's dataset, while the viewer shows it: a dataset the person
  // opened instead is not the one the host's cell positions describe.
  viewerHostSource.setShownDatasetProvider(() => (
    dataSourceManager.getCurrentSourceType() === viewerHostSource.type
      ? dataSourceManager.getCurrentDatasetId()
      : null
  ));
  const viewerHostResults = createViewerHostResults({
    state,
    viewerHostSource,
    getCellIdentity
  });
  // The host's actions, dispatched as the host's, and the session files
  // it pushes, loaded as the person's Load loads one (`command-handler.js`).
  const viewerHostCommandHandlers = createViewerHostCommandHandlers({
    getShownHostDataset: () => viewerHostSource.getShownHostDataset(),
    getHostRuntime: () => viewerHostSource.getHostRuntime(),
    actions: getActions(),
    loadSession: async file => {
      await sessionSerializer.restoreFromBlob(file);
      const tree = datasetHistories.current()?.active ?? null;
      if (tree === null) throw new Error('The session was read, but no history shows it.');
      return { tracker: { id: tree.id, name: tree.name }, head: tree.headId };
    }
  });
  // Every change of the history reaches the host (`history-events.js`).
  const viewerHostHistoryEvents = createViewerHostHistoryEvents({
    notify: change => viewerHostSource.notifyHistoryChanged(change),
    getCurrentHistory,
    subscribeCurrentHistory,
    onError: error => console.error('[Main] Viewer host history report failed:', error)
  });
  // Every mapping change reaches the notebook, its own `mapping.set`
  // too (origin `notebook`): the action's answer says only that it ran.
  state.on('mapping:changed', ({ mapping, origin }) => {
    void viewerHostSource.notifyDataMapping({
      origin,
      mapping
    }).catch(error => {
      console.error('[Main] Viewer host data-mapping report failed:', error);
    });
  });
  viewerHostSource.onAction(viewerHostCommandHandlers.handleAction);
  viewerHostSource.onLoadSession(viewerHostCommandHandlers.handleLoadSession);
  // An agent app on this computer driving this viewer through the
  // host's `cellucid mcp` (`agent/bridge/agent-calls.js`): its calls run
  // as the agent through a local connection, under the person's
  // permissions, asked in the confirm card and answered back to the host.
  const localAgentCalls = createAgentCalls({
    actions: getActions(),
    kind: 'local',
    permissionFor: question => agentPresence?.permissionFor(question) ?? null,
    questionFor: signal => agentPresence?.questionFor(signal) ?? null,
    onResult: (id, result) => viewerHostSource.sendAgentResult(id, result),
    onAsking: (id, question) => viewerHostSource.sendAgentAsking(id, question),
    onAnswered: (id, allowed) => viewerHostSource.sendAgentAnswered(id, allowed),
  });
  viewerHostSource.onAgent({
    list: () => localAgentCalls.list(),
    call: call => {
      localAgentCalls.run(call).catch(error => console.error('[Main] An agent call could not be answered to the host:', error));
    },
    cancel: id => localAgentCalls.cancel(id),
    answer: (id, allowed) => {
      const signal = localAgentCalls.signalOf(id);
      if (signal !== null) agentPresence?.answer(signal, allowed);
    },
  });
  // The host stopped, or the viewer was opened elsewhere: no answer can reach its agents.
  viewerHostSource.onChannelEnd(() => localAgentCalls.failAll('The Cellucid viewer\'s link to its host ended'));
  // Every handler is in place: commands the host sent while the dataset
  // opened run now, in order.
  viewerHostSource.acceptCommands();
  return Object.freeze({
    results: viewerHostResults,
    stop: () => viewerHostHistoryEvents.stop()
  });
}
