# `app/agent/presence/`: every agent acting in this tab

**Owns:** what a person sees and decides of any agent acting here, whichever way it came in (the
chat bar, Claude or ChatGPT through the connector): the person's permissions, the confirm card,
the activity line, and the notice of what agents send with the dataset's switch.

| Module | What it is |
| --- | --- |
| `index.js` | `initAgentPresence({root, dialog, actions, permissions})`: installs the dispatcher's confirmer (`setConfirmer`), follows the dispatcher's events, draws the cards, the lines and the permission settings dialog |
| `permissions.js` | pure: the kinds, the modes, the decision for one question (`decide`), what holds for one connection, told to its agent (`permissionFor`), what an agent is told (`permissionsForAgent`), the store (`cellucid:agent-permissions`, this browser) |
| `activity.js` | pure: the agent turns (acting, done with steps, stopped, undone), fed the dispatcher's events |

**Permissions.** The dispatcher passes every change of an agent to the confirmer (reads never):
at the start with the estimate its implementation provides of its work (`provideEstimate`) and its `confirm` when that
is asked before it runs, and, for an action whose implementation asks once it knows the cost
(`confirmAt: 'handler'`, a download), again then with `detail` (what it costs). The kinds are
`change` (anything in the tab: an undoable step, another dataset opened), `heavy` (estimated at
`HEAVY_MS`, about ten seconds, or longer on this device and link) and the four `confirm` kinds
(writing a file, deleting what was saved, a large download, publishing), each Ask, Allow or Deny;
the strictest of a question's kinds decides. Modes are presets: Ask before heavy or irreversible
(the default), Allow everything undoable without asking, Read only. Deny refuses with one sentence
the agent reads (`deniedSentence`); Allow runs it; Ask shows the card.

**The confirm card.** Who asks (the agent with its way in, `activity.js` `agentLabel`: "Claude
(chat)", "Claude (Claude Desktop)"), what (the action's title; its parameters under Details) and why
(each kind asked about: the estimate for heavy work, the action's own `detail` or
`CONFIRM_REASONS`). Deny resolves the confirmer `false`, which the dispatcher turns into "The person
declined: …"; Allow **Once**, **This chat** / **This connection** (that kind, for that
`meta.connection`, until the page closes; a kind set to Deny since stays refused) or **Always**
(the kind set to Allow). Showing it calls the dispatcher's `asking` (subscribers hear `asking`,
then `answered`: the chat says it waits, the relay tells the agent). The agent giving up (the
call's signal), the person's Stop of that turn, another dataset shown, a saved state loaded over
the history shown (its `loaded` event) and the tab closing (`pagehide`) refuse it with their own
sentence. The first card waiting takes the keyboard focus (unless the person is typing in a field
outside the agent dock; its title is announced either way), Tab reaches its answers, and the focus
goes to the next card or back where it was once it is answered.

**What agents send.** The first time an agent acts on a dataset (any dispatch of `origin:
'agent'`) and its notice was not answered in this browser, one compact notice above the cards
says that what agents read there goes to their AI provider (names, counts and summaries, and when
asked values of cells and pictures of the plot; the files stay in this browser), with the switch
"Agents see names and summaries only" and Got it. Nothing waits on it (free reading is the
default); it goes when answered or another dataset is shown. The permission settings show the
same switch for the dataset shown (`../data-scope.js`; the tool call enforces it).

**The activity line.** One line per agent turn (`meta.connection` + `meta.agent` + `meta.turn`;
a turn acts from its first dispatch, and also while one of its questions waits for the person, since
the dispatcher asks before the action starts (`activity.js` `waitOnPerson`): Stop is on its line
while its card waits, and withdraws the card with the turn;
Claude in the chat and Claude Desktop through the connector at once are two lines, each named with
its way in): while it acts, what it
runs and Stop (the dispatcher's `stop` of that turn's running work, and the stop of the surface
that attached the turn); once done with steps, Undo turn (`../history-link.js` `undoAgentTurn`,
the chat's and the State panel's too: alone at the end of the branch, back to before it; when
others acted after it began, the person chooses only its steps or everything since) and dismiss. A done
turn steps aside when the person (or a notebook) takes a step. A surface that shows its own turns
(the chat bar, open) attaches them (`attach`) and the line leaves them to it.

**API:** `attach({agent, turn, connection, stop, shownElsewhere})` returns the detach;
`refresh()`; `confirm` (the confirmer itself); `permissions` (the store); `permissionFor({kind,
connection})` (what holds for a connection, told to its agent after its results; given to the Connect
panel's relay client and the local agent calls);
`bindPermissionsLine({summary, change})` (the one-line settings in the chat settings and the
Agents panel); `openPermissions(opener)`; `forgetGrants()`; `questionFor(signal)` (the card's question about the agent call whose
signal this is, in one sentence); `answer(signal, allowed)` (the person answered that question
in the agent's own app, an MCP elicitation: Allow once or Deny, as if clicked).

**Invariants:**
- It hangs on the dispatcher only (events, `stop`, `setConfirmer`); nothing here knows the chat
  or the relay. A grant keys on `meta.connection` (kind and id), never on a way in.
- A card never stays after its question is moot: answered, abandoned, stopped, dataset replaced,
  tab closed.
- The line is not a live region; one hidden status says each change of state once.
- No threshold is made up: heavy work is judged against `HEAVY_MS`.

**Tests:** `tests/agent-presence.test.mjs`, `tests/browser/agent-chat.spec.mjs`,
`tests/browser/agent-chat-features.spec.mjs`, `tests/browser/agent-matrix.spec.mjs`.
