/**
 * The Cellucid relay, played by a spec: `page.routeWebSocket` on the
 * deployed relay's `/tab`, so nothing leaves the machine. It welcomes every
 * tab, answers claims with `client`, keeps the connections an approval
 * makes, records what the tab sent, and asks the tab to run tools as Claude
 * or ChatGPT does through it (`callTool`). For the Connect panel's specs and
 * the agents' acceptance matrix (a connector alone, with the chat bar, and
 * either failing).
 */
import { expect } from './test.mjs';

/** The deployed relay's tab socket (`DEFAULT_RELAY_ORIGIN` in `app/agent/bridge/relay-client.js`). */
export const RELAY_TAB = 'wss://mcp.cellucid.com/tab';
/** Where this browser keeps its pairing (`app/agent/bridge/tab-secret.js`). */
export const SECRET_KEY = 'cellucid:agent-relay:tab-secret';
export const CLAUDE = Object.freeze({
  agent: 'Claude', name: 'Claude', host: 'claude.ai', redirectHost: 'claude.ai', loopback: false, known: true, registration: 'document',
});

/** Start the page as a browser paired with the relay (a tab secret kept). */
export async function pairTab(page, secret = 'B'.repeat(43)) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [SECRET_KEY, secret]);
}

/**
 * The relay, played: welcomes every tab, answers claims with `client`,
 * keeps the connections an approval makes, and records what the tab sent.
 * `refuseFirst`: that many connections are dropped first (Infinity: the
 * relay is down).
 */
export async function playRelay(page, { client = CLAUDE, refuseFirst = 0 } = {}) {
  const relay = { sent: [], sockets: [], connections: [], client, refused: refuseFirst, opened: 0 };
  await page.routeWebSocket(RELAY_TAB, ws => {
    relay.opened += 1;
    if (relay.refused > 0) {
      relay.refused -= 1;
      ws.close({ code: 1006, reason: 'unreachable' });
      return;
    }
    relay.sockets.push(ws);
    const reply = (ref, value) => ws.send(JSON.stringify({ type: 'reply', ref, ok: true, value }));
    const changed = () => {
      for (const each of relay.sockets) each.send(JSON.stringify({ type: 'event', name: 'connections-changed' }));
    };
    ws.onMessage(text => {
      if (text === 'ping') { ws.send('pong'); return; }
      const message = JSON.parse(String(text));
      relay.sent.push(message);
      switch (message.type) {
        case 'claim':
          if (message.code === 'ZZZZZZZZ') {
            ws.send(JSON.stringify({ type: 'reply', ref: message.ref, ok: false, error: { code: 'unknown', message: 'This connect code is unknown or has expired. Start connecting again from Claude or ChatGPT.' } }));
            return;
          }
          reply(message.ref, { client: relay.client, expiresAt: Date.now() + 600_000 });
          return;
        case 'decide':
          if (message.allow) {
            relay.connections.push({
              grant: `g${relay.connections.length + 1}`, agent: relay.client.agent, client: relay.client.name,
              host: relay.client.host, createdAt: Date.now(), lastUsedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
            });
            changed();
          }
          reply(message.ref, { status: message.allow ? 'approved' : 'denied' });
          return;
        case 'connections':
          reply(message.ref, relay.connections);
          return;
        case 'disconnect':
          relay.connections = relay.connections.filter(each => each.grant !== message.grant);
          reply(message.ref, { removed: true });
          changed();
          return;
        case 'forget':
          relay.connections = [];
          reply(message.ref, { forgotten: true });
          ws.close({ code: 4001, reason: 'forgotten' });
          return;
        default:
      }
    });
    ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
  });
  return relay;
}

/** Wait for the relay to receive a message of `type` (and `match`), and return it. */
export async function received(relay, type, match = () => true) {
  await expect.poll(() => relay.sent.some(message => message.type === type && match(message))).toBe(true);
  return relay.sent.filter(message => message.type === type && match(message)).at(-1);
}

let calls = 0;

/**
 * Ask the tab, as the relay does, to run one tool for an agent's connection
 * (`grant`); resolves the tab's answer. `startTool` sends it without waiting.
 */
export function startTool(relay, tool, args, { agent = 'Claude', grant = 'g1', client = agent, host = 'claude.ai' } = {}) {
  calls += 1;
  const id = `call-${calls}-${tool}`;
  relay.sockets.at(-1).send(JSON.stringify({ type: 'call', id, tool, args, agent, grant, client, host }));
  return { id, result: () => received(relay, 'result', message => message.id === id) };
}

export async function callTool(page, relay, tool, args, who = {}) {
  return startTool(relay, tool, args, who).result();
}

/** The tool list the tab gives the connection `grant`, as the relay asks for it. */
export async function toolList(relay, grant) {
  calls += 1;
  const id = `list-${calls}`;
  relay.sockets.at(-1).send(JSON.stringify({ type: 'list', id, grant }));
  return (await received(relay, 'tools', message => message.id === id)).tools;
}
