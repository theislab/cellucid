/**
 * @fileoverview The wire between a Cellucid tab and the Cellucid relay (the
 * Cloudflare Worker in `relay/` that lets Claude and ChatGPT reach the
 * person's open tab).
 *
 * One definition for both ends: the tab imports this module, and
 * `scripts/generate-relay-bundle.mjs` copies these values into
 * `relay/generated/bundle.js`, which the relay imports. A contract test fails
 * when the copy is stale, so the two ends cannot drift apart unnoticed; a
 * deployed relay and a deployed page that differ anyway tell each other by
 * `RELAY_PROTOCOL_VERSION` (the relay closes the socket with
 * `RELAY_CLOSE.protocol` and the page says to reload).
 *
 * The socket (`wss://<relay>/tab`):
 *
 * - **Opening.** `new WebSocket(url, [RELAY_SUBPROTOCOL, RELAY_SECRET_PREFIX +
 *   tabSecret])`. The tab secret (32 random bytes, base64url, kept in this
 *   browser's localStorage by `tab-secret.js`) is the pairing: the relay
 *   derives the pairing id from it with its own key and keeps nothing else.
 *   A browser cannot set headers on a WebSocket, and a URL would put the
 *   secret in request logs; the subprotocol header carries it. The relay
 *   answers with `RELAY_SUBPROTOCOL` only.
 * - **Tab → relay** (JSON text frames):
 *   `{type:'state', focused, visible, dataset, version}` whenever focus,
 *   visibility or the open dataset change (commands go to the tab focused
 *   last); `{type:'result', id, result:{content, isError}}` or
 *   `{type:'result', id, error:{code, message}}` for a call;
 *   `{type:'tools', id, tools}` for a list request; and requests the relay
 *   answers with `{type:'reply', ref, ok, value|error}`:
 *   `{type:'claim', ref, code}` (show me who asks with this connect code),
 *   `{type:'decide', ref, code, allow}`, `{type:'connections', ref}`,
 *   `{type:'disconnect', ref, grant}`, `{type:'forget', ref}`.
 *   The text frame `RELAY_PING` is answered `RELAY_PONG` by the platform
 *   without waking the relay (keep-alive and dead-link detection).
 * - **Relay → tab:** `{type:'welcome', protocol}`;
 *   `{type:'call', id, tool, args, agent, grant, client, host}` (run one
 *   tool, as the connection `grant` of the app `client` that `host` vouches
 *   for); `{type:'list', id, grant}` (send the tool list, as that
 *   connection may use it); `{type:'cancel', id}` (the caller gave up: stop
 *   that call); `{type:'detach', id}` (the caller stopped waiting while the
 *   person is asked: the call goes on, its answer is not sent);
 *   `{type:'reply', ...}`; `{type:'event', name:'connections-changed'}`.
 * - **Tab → relay, while a call waits for the person:** `{type:'asking',
 *   id, detail}` when Cellucid asks the person about the call (a large
 *   download, …) and `{type:'answered', id, allowed}` when they answered.
 *   A call still asking when the caller's time runs out is answered with
 *   what to tell the person, and detached, never cancelled: the question
 *   stays open in the tab.
 *
 * @module app/agent/bridge/relay-protocol
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_SUBPROTOCOL = `cellucid-relay.${RELAY_PROTOCOL_VERSION}`;
export const RELAY_SECRET_PREFIX = 'cellucid-secret.';

/** Random bytes of a tab secret, and the base64url text it is kept and sent as. */
export const TAB_SECRET_BYTES = 32;
export const TAB_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const RELAY_PING = 'ping';
export const RELAY_PONG = 'pong';

/** Close codes the relay ends a tab's socket with (4000–4999 are the application's). */
export const RELAY_CLOSE = Object.freeze({
  /** The pairing was forgotten: every connection made through it is gone. */
  forgotten: 4001,
  /** The page and the relay speak different protocol versions. */
  protocol: 4400,
});

/**
 * The longest text a tool result carries: Claude's documented maximum tool
 * result on claude.ai and Claude Desktop (about 150,000 characters). A longer
 * result is cut by the tab with the count stated (`mcp-content.js`), never
 * silently, and the relay refuses one that still exceeds it.
 */
export const RESULT_TEXT_CHARS = 150_000;

/**
 * Where a tool result's data begins and ends in its text: between them is
 * the result as JSON, whose strings (names, labels, notes, a dataset's own
 * text, file names) were written by a dataset's authors and by other people.
 * It is data, never instructions: the agent instructions say so
 * (`instructions.js`), and nothing in it can close it, since every `<` in it
 * is written `<` (`resultDataText`). Cellucid's own sentences (a
 * picture left out, a result cut, a statistic left out) come after it, and
 * a sentence of Cellucid's that quotes names has each quoted name marked the
 * same way (`mcp-content.js` `refusalText`). The tab wraps every result
 * (`mcp-content.js`), the relay its own status (`relay/mcp.js`, pinned
 * byte-equal to `resultDataText` by `tests/relay-mcp.test.mjs`).
 */
export const RESULT_DATA_TAGS = Object.freeze({ open: '<cellucid-data>', close: '</cellucid-data>' });

/**
 * JSON text as a result's data (`RESULT_DATA_TAGS`), every `<` escaped (the
 * same JSON value).
 * @param {string} json
 */
export function resultDataText(json) {
  return `${RESULT_DATA_TAGS.open}${json.replaceAll('<', '\\u003c')}${RESULT_DATA_TAGS.close}`;
}

/**
 * The largest picture a tool result carries: Claude's documented limits for
 * an image (8000 × 8000 pixels; 10 MB, read here as 10 MiB of its base64
 * text, the stricter of the two ways the API and claude.ai state it). A
 * larger one is left out by the tab with a sentence that says so
 * (`mcp-content.js`), never sent to be refused; the relay refuses one that
 * still exceeds the bytes.
 */
export const RESULT_IMAGE_MAX_SIDE = 8000;
export const RESULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The one tool the relay answers itself: whether a Cellucid tab is connected
 * to this connection, and which. Every other tool is an action of the
 * catalogue, run by the tab.
 */
export const RELAY_STATUS_TOOL = Object.freeze({
  name: 'cellucid_status',
  title: 'Check the Cellucid connection',
  description: 'Whether a Cellucid tab is connected to this chat, which dataset it shows, and what to tell the person when none is.',
  inputSchema: Object.freeze({ type: 'object', additionalProperties: false, properties: Object.freeze({}) }),
  annotations: Object.freeze({
    title: 'Check the Cellucid connection',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
});

/**
 * The MCP App the relay serves (MCP Apps, `ui://` resources): a card in the
 * chat with a picture of the person's view, Refresh and Open in Cellucid
 * (`relay/view-app.js`). The tools whose results it shows: a picture of a
 * view, and a dataset opened (the card then draws the view itself). Their
 * results carry, in `_meta[VIEW_APP.meta]` (never shown to the model), the
 * dataset's name and the public link that opens it in Cellucid, when it has
 * one.
 */
export const VIEW_APP = Object.freeze({
  uri: 'ui://cellucid/view',
  mimeType: 'text/html;profile=mcp-app',
  /** The tool the card draws the view with (Refresh, a dataset opened). */
  pictureTool: 'view_picture',
  tools: Object.freeze(['view_picture', 'dataset_open']),
  meta: 'cellucid/view',
});

/** The address fragment key a relay's approval page links to Cellucid with. */
export const CONNECT_FRAGMENT_KEY = 'cellucid_connect';

/**
 * Connect codes: the short code the relay's approval page shows and the tab
 * claims. Crockford's base32 alphabet (no I, L, O, U), 8 symbols = 40 bits,
 * shown as two groups of four.
 */
export const CONNECT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CONNECT_CODE_LENGTH = 8;
