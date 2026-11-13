# `app/agent/chat/`: the chat bar

**Owns:** Cellucid's own chat with an agent (Claude, or OpenAI's models), with the person's API
key, in the tab: the conversation, one agent turn, the context rule, the keys, the transcript as
shown, what the empty chat offers, the chat as Markdown, and whether a saved session carries the
conversations.

| Module | What it is |
| --- | --- |
| `index.js` | `initAgentChat({dom, actions, presence})`: the bar's controls and settings, sending a message, following the history it keeps the conversation with |
| `conversation.js` | pure: a conversation (append only), what a model is sent (`modelMessages`), what the history keeps (`transcriptOf`), continuing a kept one (`conversationFrom`; one kept mid-turn has its calls answered, `closeInterrupted`), one a save or a share takes during a turn ended as saved and its turns marked received (`transcriptForSave`; a received turn offers no Try again, `offersRetry`, and its question no choices), tokens (`usageOf`, every call) and what left the browser (`sentOf`) per turn |
| `agent-loop.js` | `runAgentTurn`: model call → tool calls (`bridge/tool-call.js`) → results → … ; the effort, the token budget, Stop, waiting out a busy provider, a conversation too long |
| `context.js` | pure: the context budget (the model's own window) and the summarizing rule |
| `keys.js` | API keys: this tab (`sessionStorage`) unless Remember (`localStorage`); Forget |
| `preferences.js` | what this browser remembers (`cellucid:agent-chat`): provider, model per provider, effort per model, the person's instructions, the token budget, open |
| `transcript-view.js` | the conversation drawn: messages (Edit, Copy), Markdown replies, a compact row per tool call (Show its step; interrupted when the page closed before it finished) with the model's note before it (`progress`), a long turn's summary row (a disclosure), notes (Try again), turn footers (steps, Sent, Undo turn); a streamed piece costs the same however long the chat or the reply |
| `work.js` | pure: a turn's work as shown: each call named by what it was about (a read by its action's `describe(args)`, a running or refused call by its title and the names in its arguments, `subjectOf`), and the fold of a turn with more than `LIVE_ROWS` calls (`turnFoldOf`: ended, its answer and what went wrong; running, its latest calls) with the summary's words |
| `export.js` | pure: the chat as Markdown (Export; every call, named as its row is; raw HTML escaped and script links left as text, `markdownSafe`), a turn as a short note (what it asked, its steps, why) |
| `suggestions.js` | the first prompts the empty chat offers, from the dataset shown |
| `markdown.js` | a reply's Markdown as elements, text nodes only; a streamed reply redraws only the blocks that changed (`createMarkdownStream`) |
| `selection.js` | the selection attached to a message: a reference to the highlighted cells of the active page (its name, groups, counts), never the cells; the chip's words; what the model is told (names as data) |
| `ask.js` | the chat's own tool, a question with 2–5 choices (`ask_person`, strict for both providers): checked, answered at once, the turn ends; the question still waiting (`pendingQuestion`) |

**A turn** is one message of the person (`turn-<id>`): every step the agent takes in answer
carries the turn, the provider's agent name and the chat as its connection (`meta.connection`:
`{id: <conversation>, kind: 'chat'}`), so the timeline groups it, Undo turn takes it back, and a
permission granted "in this chat" holds for it. Tool calls run one after the other, in the model's
order. The tools are the same all chat long, and say no permission: a model's reasoning is bound to
the exact tools it was given (Anthropic refuses reasoning sent back with other tools), and the prompt cache holds only while they stay. The model is told the permissions and
the person's own instructions with the message after either changes; after a summary, the last
told before it goes with the summary.

**Above the message field** (`#agent-chat-tray`, before the field so Shift+Tab reaches it): a
question's choices as buttons while it waits (a click, or Enter, sends the choice as the person's
message; typing another answer works too; a hidden status says the choices once), and the chip
"Selection: 1,234 cells ×" while cells are highlighted: it attaches the reference to each message
(`message.attached.selection`, shown under the message, told to the model after its words), ×
leaves it out until the selection changes, and it goes when nothing is highlighted. The reference
is names and counts; the agent reads the cells through the tools, as the dataset's switch allows.

**The context rule** (`context.js`): the budget is the model's context window (Anthropic lists it;
OpenAI's refusal of a prompt too long is the other trigger). A conversation that would not fit is
summarized once, at the start of a turn, by the same model; the model is then sent the summary
and what follows it, and a new epoch starts (earlier reasoning is not sent again). The person
still sees every message; the history keeps every step. A token budget the person sets for a chat
stops it before the next model call, and before another try of a failed one, once spent, with a
note. Every call counts: a try that failed or was stopped after the provider began to answer, and
the summarizer's calls, are carried by the next message or note of the turn (`otherCalls`), so the
tokens shown and the budget count them.

**Kept with the history:** after every message, `history.setChat(tracker, id, transcript)` (no
providers' reasoning, no pictures). The chat belongs to the tab; a history to its dataset, so
another tracker, dataset or loaded session shows its latest conversation (or a new one). Messages
and steps find each other through `../history-link.js` only. What a running turn does when the
dataset changes, and how a conversation kept mid-turn is answered (`closeInterrupted`), is
developer doc 32, "Conversations and the history"
(`cellucid-python/docs/user_guide/web_app/p_developer_docs/32_agents_in_the_tab.md`).

**Invariants:**
- One tool list (`bridge/mcp-tools.js`) plus the chat's question with choices (`ask.js`), one call
  (`bridge/tool-call.js`), one instruction text (`instructionsFor('chat')`).
- The model is told the person's permissions, the dataset's switch (names and summaries only, or
  not) and their own instructions with the message after any changes; a turn's Sent line says
  when the switch kept values and pictures out.
- Messages are only appended; what was sent to a model is never edited (a model's reasoning is
  bound to its conversation; a prompt cache to an unchanged prefix).
- A key goes only to its provider, never into the DOM after it is entered, the history, a session
  file or the URL.

**Tests:** `tests/agent-chat.test.mjs`, `tests/browser/agent-chat.spec.mjs`,
`tests/browser/agent-chat-features.spec.mjs`, `tests/browser/live-agents/`.
