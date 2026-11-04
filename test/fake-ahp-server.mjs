// A fake Agent Host Protocol server for tests: JSON-RPC over WebSocket, token in the `tkn` query.
// Implements initialize, subscribe (session + chat snapshots), listSessions and dispatchAction
// (chat/turnStarted), and records every turn it receives.
import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * @param {object} o
 * @param {number} [o.port]           0 = any free port
 * @param {string} o.token
 * @param {string} [o.sessionUri]
 * @param {string[]} [o.workingDirectories]
 * @param {'respond'|'reject'|'silent'} [o.behavior]
 * @param {object} [o.chat]           overrides for the chat state (turns, status, activeTurn)
 * @param {string[]} [o.supported]    protocol versions the host accepts
 * @param {(turn: any) => void} [o.onTurn]
 */
export async function startFakeAhp(o) {
  const sessionUri = o.sessionUri ?? 'ahp-session:/11111111-1111-4111-8111-111111111111';
  const chatUri = sessionUri.replace('ahp-session:', 'ahp-chat:');
  const supported = o.supported ?? ['1.1.0', '1.0.0'];
  const behavior = o.behavior ?? 'respond';
  const received = [];
  const connections = [];
  let seq = 0;

  const chatState = {
    resource: chatUri,
    title: 'chat',
    status: 1,
    turns: [
      { id: 'turn-1', message: { text: 'kickoff', origin: { kind: 'user' }, model: { id: 'model-a' }, agent: { uri: 'file:///repo/.github/agents/orchestrator.agent.md' } } },
      { id: 'turn-2', message: { text: 'auto', origin: { kind: 'system' } } },
    ],
    ...(o.chat ?? {}),
  };
  const sessionState = {
    resource: sessionUri, provider: 'copilot', title: 'Long session', status: 1, lifecycle: 'ready',
    workingDirectories: o.workingDirectories ?? ['file:///repo'], defaultChat: chatUri,
  };

  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('tkn') !== o.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    connections.push(ws);
    const send = (m) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...m }));
    const action = (channel, a, extra = {}) => send({ method: 'action', params: { channel, action: a, serverSeq: ++seq, origin: undefined, ...extra } });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      const p = m.params ?? {};
      switch (m.method) {
        case 'initialize': {
          const v = (p.protocolVersions ?? []).find((x) => supported.includes(x));
          if (!v) return send({ id: m.id, error: { code: -32005, message: 'unsupported protocol version', data: { supported } } });
          return send({ id: m.id, result: { protocolVersion: v, serverSeq: seq, serverInfo: { name: 'fake-ahp', version: '0.0.0' } } });
        }
        case 'subscribe':
          if (p.channel === sessionUri) return send({ id: m.id, result: { snapshot: { resource: sessionUri, state: sessionState, fromSeq: seq } } });
          if (p.channel === chatUri) return send({ id: m.id, result: { snapshot: { resource: chatUri, state: chatState, fromSeq: seq } } });
          return send({ id: m.id, error: { code: -32002, message: `unknown channel ${p.channel}` } });
        case 'listSessions':
          return send({ id: m.id, result: { items: [{ ...sessionState, createdAt: '2026-11-01T00:00:00Z', modifiedAt: '2026-11-02T00:00:00Z' }] } });
        case 'unsubscribe':
          return undefined;
        case 'dispatchAction': {
          const a = p.action ?? {};
          if (a.type !== 'chat/turnStarted') return undefined;
          received.push({ channel: p.channel, clientSeq: p.clientSeq, action: a });
          o.onTurn?.(a);
          if (behavior === 'reject') return action(p.channel, a, { rejectionReason: 'not allowed' });
          if (behavior === 'silent') return undefined;
          action(p.channel, a);
          setTimeout(() => action(p.channel, { type: 'chat/responsePart', turnId: a.turnId, part: { kind: 'markdown', id: 'p1', content: '' } }), 20);
          return undefined;
        }
        default:
          if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
          return undefined;
      }
    });
  });

  await new Promise((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port, sessionUri, chatUri, received,
    close: () => new Promise((r) => {
      for (const c of connections) c.terminate();
      wss.close();
      server.close(() => r(undefined));
    }),
  };
}
