# `app/agent/providers/`: the chat bar's model providers

**Owns:** one module per model provider, each behind the one contract of `contract.js` (fields,
provider-neutral messages, stream events, failures with a kind), and the list the page offers
(`index.js` `providersForPage`).

| Module | Provider |
| --- | --- |
| `anthropic.js` | Claude, Anthropic Messages API from the browser (`anthropic-dangerous-direct-browser-access`), models from `/v1/models` with their window, output limit, image support and effort levels; instructions and tools cached; a refused key (answered without CORS, so unreadable) told apart from a lost request by asking the model list without and with the key |
| `openai.js` | OpenAI's models, Responses API with `store: false`; encrypted reasoning sent back; strict tool schemas where exact (`strictSchemaOf`, `argsFromStrict`); models from `/v1/models` filtered to conversation models |
| `scripted.js` | a scripted model for the browser specs; offered only on a development host with `window.__CELLUCID_AGENT_SCRIPT__` |

**Adding or replacing a provider** (another API, a sign-in once one exists) is one module here and
its line in `index.js`; the chat, the loop and the tools do not change. A provider converts the
MCP tools (`bridge/mcp-tools.js`) and the neutral messages to its own format, maps its stream to
the contract's events, and its failures to the contract's kinds (`auth`, `permission`, `quota`,
`rate`, `busy`, `network`, `unreadable`, `model`, `too-long`, `request`); `rate`, `busy` and
`network` are waited out by the turn, and an `unreadable` answer (a tool call's arguments that are
not JSON) is asked for once more. A provider that knows a call's prompt tokens as it starts
answering says so then (a `usage` event; a later one replaces it), so a call that fails or is
stopped after is still counted.

**Invariants:**
- No model list is written in the code: each provider lists the models the key may use; a default
  id is chosen only when the list holds it.
- A key is sent only to its provider's API origin.
- A provider's reasoning comes back as `opaque` parts and is sent back unchanged to the same
  provider; another provider leaves it out.

**Tests:** `tests/agent-providers.test.mjs` (recorded API shapes, no network);
`tests/browser/live-agents/` (the real APIs, local only).
