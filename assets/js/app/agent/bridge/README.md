# `app/agent/bridge/`: this tab's end of the Cellucid relay, and of local agent connections

**Owns:** the calls of agents that reach this tab from outside it (`agent-calls.js`
`createAgentCalls`: run as the agent through its connection, turns, the tool list for that
connection, the person asked and answering, a stop; one engine for the relay's `connector`
connections and the `local` connections of `cellucid mcp`, which the viewer channel carries:
`data/viewer-host-source.js` `onAgent`), what the Python and R packages' `cellucid mcp` reads
before a page answers (`local-agents.js`: the status tool, the app names, `mcpToolsDocument`,
generated into `mcp-tools.json` by `scripts/generate-action-catalog.mjs`), the WebSocket to the
relay (`relay-client.js`), the wire it speaks
(`relay-protocol.js`, bundled into the relay), this browser's pairing (`tab-secret.js`:
localStorage, Forget), connect codes (`connect-code.js`) and the head script that takes a
relay approval link's code out of the address before any module runs
(`connect-fragment.js`, a classic script in `index.html`), the catalogue as MCP tools
(`mcp-tools.js`), outcomes as MCP content (`mcp-content.js`), and one tool call run in this tab
(`tool-call.js` `runToolCall`: the relay's calls and the chat bar's go through it), and what a
result may carry of the data (`data-guard.js`).

**API for the Connect panel** (`startRelayClientForPage({actions, onApproval,
onApprovalError, onStatus, onConnectionsChanged, datasetName, datasetLink, currentStep,
permissionFor})` returns the
client; the page connects at once when this browser is paired, and claims the code of an
approval link it was opened with; `app/agent/connect/` is the panel):

| Call | What it does |
| --- | --- |
| `status()` | `{state, error, retryAt, approvals}`; `state` is `off`, `connecting`, `connected`, `retrying`, `refused` (page and relay differ: reload) or `unavailable` (the browser keeps no site data); `onStatus` hears each change |
| `claim(code, {via})` | Ask who wants to connect with a typed code (`via: 'typed'`); resolves the approval `{code, display, via, client: {agent, name, host, redirectHost, loopback, known, registration}, expiresAt}`, also given to `onApproval`; pairs the browser first when needed |
| `approve(code)` / `deny(code)` | Answer an approval |
| `connections()` | `[{grant, agent, client, host, createdAt, lastUsedAt, expiresAt}]`; `onConnectionsChanged` hears when it changes |
| `disconnect(grant)` | Remove one connection |
| `forget()` | Remove every connection at the relay, close every tab of this browser, delete the tab secret; `{revokedAtRelay}` |
| `reportState()` | Report focus, visibility and the dataset name (call it when the open dataset changes) |
| `connect()` / `start()` / `stop()` / `destroy()` | Pair and connect / connect if paired / disconnect / disconnect and stop listening |

Show the approval with its `client.agent` and `client.host` (the host that vouches for
the client), say where the answer goes (`redirectHost`; `loopback` means an app on this
computer), warn when `known` is false, and warn more for a typed code: approve only a code
the person sees on their own screen now.

**Invariants:**
- A local agent connection (`cellucid mcp`) is `{id: 'local-<12 hex>', kind: 'local', client}`
  (the app's `clientInfo.name`), its agent the app's name ("Claude Code"; `agentLabel` shows
  "Claude Code (local)"). Its calls are `createAgentCalls({kind: 'local'})`'s, wired in
  `main.js` for a host viewer; the person's question about one is told to the host with the card's
  own sentence (`presence.questionFor`) and may be answered from the app (`presence.answer`).
- Calls run through `runToolCall`, which dispatches `getActions().dispatch(type, params,
  {origin: 'agent', agent, turn, signal, connection})` (`connection`: `{id: <grant>, kind:
  'connector', client, host}`, what the person's permission settings key "allow for this
  connection" on; the chat bar's calls carry `{id: <conversation>, kind: 'chat'}`); a call the
  agent gives up on, or that is in flight when the link drops, is stopped (`closed`). Calls of
  one connection share a turn until someone else makes a step or `AGENT_TURN_IDLE_MS` passes.
- The person being asked about a call (the dispatcher's `asking` / `answered` events) is told
  to the relay; a call whose time runs out while the person is asked is answered to the agent
  as such and detached (`detach`): the question stays open and the call goes on, whatever the
  link does next.
- A tool list is made for the connection asking (`permissionFor({kind, connection})`, the
  presence layer's settings with what the person allowed for that connection): each change
  (`change`) and each question (a `confirm` kind) reads "asks", "runs without asking" or
  "refused" (`mcp-tools.js` `permissionKindOf`).
- The tab secret is sent only to the deployed relay (`DEFAULT_RELAY_ORIGIN`), or to
  `window.__CELLUCID_RELAY_ORIGIN__` on a local development host.
- A result's JSON is its data, between `RESULT_DATA_TAGS` (`<cellucid-data>…</cellucid-data>`,
  `resultDataText`: every `<` in it written `\u003c`, the same JSON value): names, labels, notes
  and a dataset's own text, written by others, which the agent never takes for instructions.
  Cellucid's own sentences follow the closing tag. `resultDataOf` reads it back.
- A tool error is Cellucid's sentence, but the names it quotes (a refusal's "there is no field
  "x"; the fields are …", a branch, a page, a group) were written by others: each quoted span
  goes out between the data tags, and every `<` in the sentence is escaped (`refusalText`).
- While the dataset shown is set to names and summaries only (`../data-scope.js`),
  `runToolCall` refuses a read `data-guard.js` classifies as `cells` (values of cells, a picture)
  or does not classify, and a value summary over groups an agent shaped by naming cells
  (`SHAPED_INPUTS`), before it runs and again once it ran; `toolResultOf` sends no picture and no
  single-cell statistic (`SINGLE_CELL_STATISTICS`: a minimum, a maximum, a median), each said
  after the data. It is not anonymisation (`SUMMARIES_ONLY_CAVEAT`).
- A result's text is cut to `RESULT_TEXT_CHARS` with both counts stated, never silently (the tags
  stay whole);
  pictures travel as image content (image `Blob`s in a result, and strings its result schema
  marks `contentEncoding: 'base64'` with an image `contentMediaType`, as `view.picture`'s
  PNG), and one larger than a chat takes (`RESULT_IMAGE_MAX_SIDE`, `RESULT_IMAGE_MAX_BYTES`)
  is left out with a sentence.
- The results of the view card's tools (`VIEW_APP.tools`) carry `_meta['cellucid/view']`:
  the dataset's name, its public link (`datasetLink`), the version; hosts keep `_meta` from
  the model.

**Tests:** `tests/agent-relay-client.test.mjs`, `tests/agent-bridge.test.mjs`,
`tests/agent-data-guard.test.mjs`, `tests/agent-calls.test.mjs`, `tests/mcp-tools-document-contract.test.mjs`,
`tests/browser/agent-data-guard.spec.mjs`, `tests/browser/mcp-local.spec.mjs`.
