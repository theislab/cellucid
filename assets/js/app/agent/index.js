/**
 * @fileoverview The agents' part of the page: the dock at the foot of the
 * plot with the agent presence (`presence/`: the questions an agent asks
 * first, which agent is acting) and the chat bar (`chat/`). Whether a shared
 * session carries the conversations is the Share dialog's choice
 * (`ui/modules/state/share-dialog.js`).
 *
 * What agents may be sent of each dataset (`data-scope.js`: the switch
 * "Agents see names and summaries only") is one store the presence shows
 * and the tool call enforces (`bridge/tool-call.js`).
 *
 * The presence is installed whatever else is: it is the dispatcher's
 * confirmer and the activity line of every agent, the connector's included.
 * The chat bar failing to start (its markup changed, a provider module
 * broken) takes only the chat bar away: its button is hidden, the person is
 * told in one sentence, and the presence and the connector work on.
 *
 * @module app/agent
 */

import { initAgentDock } from './dock.js';
import { initAgentPresence } from './presence/index.js';
import { initAgentChat } from './chat/index.js';
import { createSelectionSource } from './chat/selection.js';
import { agentDataStore, createShapeTracker, setShapeTracker } from './data-scope.js';

/**
 * @param {{
 *   dom: Record<string, HTMLElement>,
 *   viewer: {onPresentedLayoutChange: Function},
 *   actions: object,
 *   state?: object|null,
 *   notify: (sentence: string) => void,
 * }} options - `dom`: `dom-cache.js` `agent` (with the Agents panel's permissions line,
 *   `connectPermissionsSummary` and `connectPermissionsChange`, when the page has it);
 *   `state`: the page's data state, whose highlighted cells the chat can attach
 */
export function initAgents({ dom, viewer, actions, state = null, notify }) {
  const dock = initAgentDock({ dock: dom.dock, grip: dom.dockGrip, sidebar: dom.dock.ownerDocument.getElementById('sidebar'), viewer });
  const dataStore = agentDataStore();
  // Which groups and fields an agent shaped by naming cells, for the tool call's guard.
  const shapes = createShapeTracker({ actions, state });
  setShapeTracker(shapes);
  const presence = initAgentPresence({
    root: dom.presence,
    dialog: { dialog: dom.permissionsDialog, body: dom.permissionsBody },
    actions,
    dataStore,
    notify,
  });
  let chat = null;
  try {
    chat = initAgentChat({ dom, actions, presence, selection: createSelectionSource(state), opensAsSide: dock.opensAsSide });
  } catch (error) {
    console.error('[agents] the chat bar could not start', error);
    for (const part of [dom.toggle, dom.panel]) if (part instanceof HTMLElement) part.hidden = true;
    notify('The chat bar could not start, so it is hidden; agents connected through the Agents panel still work.');
  }
  // The same settings govern the connector's agents: their line in the Agents panel.
  const unbindConnectLine = dom.connectPermissionsSummary && dom.connectPermissionsChange
    ? presence.bindPermissionsLine({ summary: dom.connectPermissionsSummary, change: dom.connectPermissionsChange })
    : () => {};
  return Object.freeze({
    presence,
    /** The chat bar, or null when it could not start. */
    chat,
    /** What agents are sent of each dataset (`data-scope.js`). */
    dataStore,
    /** Open the agent permission settings (the Connect panel links here too). */
    openPermissions: opener => presence.openPermissions(opener),
    destroy() {
      setShapeTracker(null);
      shapes.destroy();
      unbindConnectLine();
      chat?.destroy();
      presence.destroy();
      dock.destroy();
    },
  });
}
