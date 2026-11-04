// Agent Host Protocol client side: send one user message to a session and confirm the agent works
// on it. Built on Microsoft's TypeScript client (@microsoft/agent-host-protocol): JSON-RPC over a
// WebSocket to the standalone host, authenticated with the connection token (query parameter).
import { randomUUID } from 'node:crypto';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { addSecret } from './log.mjs';
import { samePath, uriToPath } from './util.mjs';

// Offer the version the host was tested with first; the host picks the highest it supports.
export const PROTOCOL_VERSIONS = ['1.1.0', '1.0.0', '0.9.0'];
const IN_PROGRESS = 1 << 3; // SessionStatus.InProgress

const short = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

/**
 * Open a client to ws://localhost:<port> and run `initialize`.
 * @param {{ port: number, token: string, url?: string }} o
 */
export async function connect({ port, token, url }) {
  addSecret(token);
  const target = url ?? `ws://localhost:${port}/?tkn=${encodeURIComponent(token)}`;
  let transport;
  try {
    transport = await WebSocketTransport.connect(target);
  } catch (e) {
    throw new Error(`cannot connect to the agent host on port ${port} (is it listening, is the token right?): ${e.message}`);
  }
  const client = new AhpClient(transport, { requestTimeoutMs: 30000 });
  client.connect();
  const init = await client.initialize({ clientId: `copilot-forever-${randomUUID()}`, protocolVersions: PROTOCOL_VERSIONS });
  return { client, init };
}

/** The most recently modified session on the host whose working directory is `repoFolder`. */
export async function findSessionUri(client, repoFolder) {
  let cursor;
  const hits = [];
  for (let page = 0; page < 20; page++) {
    const r = await client.request('listSessions', { channel: 'ahp-root://', limit: 100, ...(cursor ? { cursor } : {}) });
    for (const s of r.items ?? []) {
      if ((s.workingDirectories ?? []).some((w) => samePath(uriToPath(w), repoFolder))) hits.push(s);
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  hits.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  return hits[0]?.resource ?? null;
}

/**
 * Probe a session, or start a turn with `text` and wait until the agent visibly works on it.
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.token
 * @param {string} [o.url]          override the WebSocket URL (tests)
 * @param {string} o.sessionUri     ahp-session:/<uuid>
 * @param {string} [o.text]         the message; omit with probe
 * @param {boolean} [o.probe]       read-only: print the session's and chat's shape
 * @param {boolean} [o.dryRun]      connect and check everything, but send nothing
 * @param {number} [o.timeoutMs]    how long to wait for the agent to start working
 * @param {string} [o.expectAgent]  refuse if the last user message names another custom agent
 * @param {string} [o.agentUri]     custom agent to use when the chat has no earlier user message
 * @param {{info: Function}} o.log
 * @returns {Promise<{ ok: boolean, detail: string, protocolVersion?: string }>}
 */
export async function continueSession(o) {
  const { log } = o;
  if (!String(o.sessionUri ?? '').startsWith('ahp-session:/')) return { ok: false, detail: `not an AHP session URI: ${o.sessionUri}` };
  const { client, init } = await connect(o);
  const done = async (ok, detail) => {
    try { await client.shutdown(); } catch { /* closing anyway */ }
    return { ok, detail, protocolVersion: init.protocolVersion };
  };
  try {
    log.info(`initialized: protocol ${init.protocolVersion}`);
    const { result: sres } = await client.subscribe(o.sessionUri);
    const s = /** @type {any} */ (sres?.snapshot?.state);
    if (!s) return done(false, 'no session snapshot');
    const chatUri = s.defaultChat;
    log.info(`session: lifecycle=${s.lifecycle} status=${s.summary?.status ?? s.status} defaultChat=${chatUri}`);
    if (!chatUri) return done(false, 'session has no default chat');

    const { result: cres, subscription } = await client.subscribe(chatUri);
    const c = /** @type {any} */ (cres?.snapshot?.state);
    if (!c) return done(false, 'no chat snapshot');
    const turns = c.turns ?? [];
    const lastUser = [...turns].reverse().map((t) => t.message ?? t.userMessage).find((m) => m && m.origin?.kind === 'user');
    log.info(`chat: turns=${turns.length} status=${c.status} activeTurn=${c.activeTurn ? 'yes' : 'no'}`);
    log.info(`last user message: model=${short(lastUser?.model)} agent=${short(lastUser?.agent)}`);
    if (o.probe) return done(true, 'probe ok');

    if (o.expectAgent && lastUser?.agent && !String(lastUser.agent.uri ?? '').includes(o.expectAgent)) {
      return done(false, `the chat's last user message is for another agent (${short(lastUser.agent.uri)}); not sending`);
    }
    if (c.activeTurn || (typeof c.status === 'number' && (c.status & IN_PROGRESS))) {
      return done(false, `the chat is busy (status ${c.status}); not sending`);
    }
    /** @type {any} */
    const message = { text: o.text, origin: { kind: 'user' } };
    if (lastUser?.model) message.model = lastUser.model;
    if (lastUser?.agent) message.agent = lastUser.agent;
    else if (o.agentUri) message.agent = { uri: o.agentUri };
    if (o.dryRun) return done(true, `would send a turn (model ${short(message.model)}, agent ${short(message.agent)})`);

    const turnId = randomUUID();
    const timeoutMs = o.timeoutMs ?? 120000;
    const watch = (async () => {
      for await (const ev of subscription) {
        if (ev.type !== 'action') continue;
        const env = ev.params;
        const a = /** @type {any} */ (env.action ?? {});
        if (a.turnId !== turnId) continue;
        if (env.rejectionReason) return { ok: false, detail: `the host rejected the turn: ${env.rejectionReason}` };
        if (a.type !== 'chat/turnStarted') return { ok: true, detail: `agent is working on the turn (first action: ${a.type})` };
      }
      return { ok: false, detail: 'the connection closed before the agent responded' };
    })();
    client.dispatch(chatUri, /** @type {any} */ ({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message }));
    log.info(`sent turn ${turnId}`);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ ok: false, detail: `the agent did not start working within ${timeoutMs / 1000} s` }), timeoutMs); });
    const res = await Promise.race([watch, timeout]);
    clearTimeout(timer);
    return done(res.ok, res.detail);
  } catch (e) {
    return done(false, e.message);
  }
}
