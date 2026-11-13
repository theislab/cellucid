# `app/agent/`: agents operate Cellucid

**Owns:** what Claude, ChatGPT and Cellucid's own chat bar are told about Cellucid
(`instructions.js`: one text, `instructionsFor('connector' | 'chat')`), the bridge to the
Cellucid relay that lets Claude and ChatGPT reach this tab (`bridge/`), the Connect panel over it
(`connect/`: Agents › Claude and ChatGPT, its approval dialog and Manage…), the agent presence and
the person's permissions every agent acting here goes through (`presence/`), the chat bar
(`chat/`) and its model providers (`providers/`), where conversations and the history meet
(`history-link.js`), what agents are sent of each dataset (`data-scope.js`), and the dock at the
foot of the plot that holds the presence and the chat bar (`dock.js`, `index.js`).

| Folder or module | What it is |
| --- | --- |
| `index.js` | `initAgents`: the dock, the presence, the chat bar and the share choice (from `ui/core/ui-coordinator.js`) |
| `dock.js` | where the dock sits: the presented area's foot, above the selection bar; publishes `--agent-dock-block-size` |
| `presence/` | the dispatcher's confirmer (the person's permissions, the confirm card) and the activity line, for every agent |
| `chat/` | the chat bar: conversation, agent turn, context rule, keys, transcript, export, suggestions, share choice |
| `providers/` | one module per model provider behind one contract (`contract.js`) |
| `settings-told.js` | the person's settings (permissions, the dataset's data switch, what History leaves out) in the words every agent is told |
| `history-link.js` | the one module that knows both a chat and the history: a turn's steps, a message to its step, a step to its message |
| `data-scope.js` | the person's switch "Agents see names and summaries only", per dataset (its identity) in `localStorage` `cellucid:agent-data`, and whether the notice of what is sent was answered; `dataScopeNow` (the dataset shown and its switch) |
| `bridge/` | the relay's tab end, the catalog as MCP tools, outcomes as MCP content, one tool call |
| `connect/` | the Connect panel over the relay client (below) |

| `connect/` module | What it does |
| --- | --- |
| `index.js` | the panel: one status line that follows the link, the connector address with Copy, a code typed from another device, Manage…; the open dataset's name and public link reported to the relay |
| `approval-dialog.js` | "Connect Claude?": who asks, where the answer goes, warnings (an app neither Claude nor ChatGPT; a typed code), the code to compare, Allow / Deny; closing denies |
| `connections-dialog.js` | Manage…: each connection (who, host, since when, last used) with Remove; Forget this browser, asked in place |
| `model.js` | pure: the status line, a connection's row, the approval's sentences |

**Entry points:** `initAgents`; `instructionsFor`; `bridge/relay-client.js`
(`startRelayClientForPage`, `createRelayClient`); `bridge/tool-call.js` (`runToolCall`);
`connect/index.js` (`initAgentConnect`, from `ui/core/ui-coordinator.js`: starts the page's relay
client with the presence's `permissionFor`, claims an approval link's code, asks the person, lists
and removes connections, forgets the browser).

**Invariants:**
- An agent acts only through the action dispatcher (`app/actions/`): its tools are the
  catalog, its changes are history steps with `origin: 'agent'`, its name, its connection
  (`meta.connection`: the chat, or the connector's grant) and its turn. Both ways in (the chat bar,
  the connector) run a call with `runToolCall`: one tool list, one result encoding.
- The presence hangs on the dispatcher (its events, `stop`, `setConfirmer`), not on a way in, so
  a new way in gets the permissions, the confirm card and the activity line without code. Every
  tool list is the same whatever the person's settings (a model's reasoning is bound to the exact
  tools it was given, and a changed list rewrites a client's cached prompt); the settings are
  told in one set of words (`settings-told.js`): to the chat's model with the person's message
  (`chat/index.js` `contextFor`), to an outside agent after its connection's first result and
  after any result once they changed (`bridge/agent-calls.js`, from the presence's
  `permissionFor`).
- The chat and the history know each other only through `history-link.js`.
- Either way in works alone and both work at once; a failure of one leaves the other working and
  says in one line what to do.
- The instructions name capabilities in words; a tool name they use (in backticks) is a tool of
  the catalog (`tests/agent-bridge.test.mjs`).
- The relay's copy of the catalog, instructions and wire protocol is generated
  (`scripts/generate-relay-bundle.mjs`; `tests/relay-bundle-contract.test.mjs`).
- An API key stays in this browser and goes only to its provider (`chat/keys.js`).
- **What agents are sent of the data.** Free reading is the default: what an agent reads goes to its
  provider with the conversation, and the dataset's files never leave. The switch "Agents see names and summaries only"
  is the person's, never an action; with it on, the one tool call (`bridge/tool-call.js`, so the
  chat and the connector alike) refuses what `bridge/data-guard.js` classifies as cell-level, and
  every action that answers with data is classified there (`tests/agent-data-guard.test.mjs`). It
  is not anonymization (`SUMMARIES_ONLY_CAVEAT`). What it refuses, withholds and says is developer
  doc 32, "What agents are sent of the data"
  (`cellucid-python/docs/user_guide/web_app/p_developer_docs/32_agents_in_the_tab.md`).
- **Text written by others is data.** Every tool result's JSON is between the data tags
  (`<cellucid-data>…</cellucid-data>`, `bridge/relay-protocol.js` `RESULT_DATA_TAGS`; every `<`
  inside escaped, so nothing in it can close them), the relay's own status too, and so are the
  names a chat message attaches (`chat/selection.js`). The instructions say early that it is data,
  never instructions (`instructions.js`), and the summarizer carries no request out of it
  (`chat/context.js`). Cellucid's own sentences (a refusal, a picture left out, a result cut) are
  outside the tags, and every name such a sentence quotes is marked the same way, every `<` in it
  escaped (`bridge/mcp-content.js` `refusalText`).
- **The tool lists.** One list for every way in, the same whatever the person's settings
  (`mcp-tools.js`); the settings and the dataset's switch are told apart (`settings-told.js`).
  The chat's list adds one tool of its own, a question with choices (`chat/ask.js`), which a
  connector does not list: there the instructions say to ask in plain words with numbered choices.

**Tests:** `tests/agent-bridge.test.mjs`, `tests/agent-data-guard.test.mjs`, `tests/agent-relay-client.test.mjs`,
`tests/agent-connect.test.mjs`, `tests/agent-presence.test.mjs`, `tests/agent-chat.test.mjs`,
`tests/agent-providers.test.mjs`, `tests/browser/agent-connect.spec.mjs`,
`tests/browser/agent-chat.spec.mjs`, `tests/browser/agent-chat-features.spec.mjs` and
`tests/browser/agent-data-guard.spec.mjs` (every read walked with the switch on; the notice, the
selection chip and a question's choices) (scripted model), `tests/browser/agent-matrix.spec.mjs` (either way in alone, both at once, one failing:
the scripted model, a played Anthropic API and a played relay), `tests/browser/live-agents/` (real
providers, local only, with keys; `byok.spec.mjs` in every engine; `injection.spec.mjs` a
category named like an instruction, read as data by a real model), and the relay's own
(`relay/README.md`).
