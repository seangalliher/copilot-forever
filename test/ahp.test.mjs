import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, continueSession, findSessionUri } from '../src/ahp.mjs';
import { startFakeAhp } from './fake-ahp-server.mjs';
import { logger } from './helpers.mjs';

const TOKEN = 'a'.repeat(64);

async function withServer(opts, fn) {
  const s = await startFakeAhp({ token: TOKEN, ...opts });
  try { return await fn(s); } finally { await s.close(); }
}

test('sends a turn reusing the last user message model and agent; ok once the agent works', () =>
  withServer({}, async (s) => {
    const log = logger();
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'Continue.', log, timeoutMs: 5000, expectAgent: 'orchestrator.agent.md' });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.protocolVersion, '1.1.0');
    assert.match(r.detail, /chat\/responsePart/);
    assert.equal(s.received.length, 1);
    const a = s.received[0].action;
    assert.equal(s.received[0].channel, s.chatUri);
    assert.equal(a.type, 'chat/turnStarted');
    assert.equal(a.message.text, 'Continue.');
    assert.deepEqual(a.message.origin, { kind: 'user' });
    assert.deepEqual(a.message.model, { id: 'model-a' });
    assert.equal(a.message.agent.uri, 'file:///repo/.github/agents/orchestrator.agent.md');
    assert.ok(!log.lines.join('\n').includes(TOKEN), 'token never logged');
  }));

test('probe is read-only', () =>
  withServer({}, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, probe: true, log: logger() });
    assert.equal(r.ok, true);
    assert.equal(s.received.length, 0);
  }));

test('dry-run sends nothing', () =>
  withServer({}, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', dryRun: true, log: logger() });
    assert.equal(r.ok, true);
    assert.match(r.detail, /would send/);
    assert.equal(s.received.length, 0);
  }));

test('refuses when the chat is busy', () =>
  withServer({ chat: { status: 8 } }, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', log: logger() });
    assert.equal(r.ok, false);
    assert.match(r.detail, /busy/);
    assert.equal(s.received.length, 0);
  }));

test('refuses when the last user message is for another custom agent', () =>
  withServer({}, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', expectAgent: 'other.agent.md', log: logger() });
    assert.equal(r.ok, false);
    assert.match(r.detail, /another agent/);
    assert.equal(s.received.length, 0);
  }));

test('uses --agent-uri when the chat has no earlier user message (e.g. after a trim)', () =>
  withServer({ chat: { turns: [] } }, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', agentUri: 'file:///repo/a.agent.md', log: logger(), timeoutMs: 5000 });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(s.received[0].action.message.agent, { uri: 'file:///repo/a.agent.md' });
    assert.equal(s.received[0].action.message.model, undefined);
  }));

test('a host rejection is a failure', () =>
  withServer({ behavior: 'reject' }, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', log: logger(), timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /rejected/);
  }));

test('no agent activity within the timeout is a failure', () =>
  withServer({ behavior: 'silent' }, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, text: 'x', log: logger(), timeoutMs: 300 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not start working/);
  }));

test('a wrong token cannot connect, and the error does not contain it', () =>
  withServer({}, async (s) => {
    const bad = 'b'.repeat(64);
    await assert.rejects(continueSession({ port: s.port, token: bad, sessionUri: s.sessionUri, text: 'x', log: logger() }), (/** @type {any} */ e) => {
      assert.match(e.message, /cannot connect/);
      assert.ok(!e.message.includes(bad));
      return true;
    });
  }));

test('falls back to 1.0.0 when the host does not speak 1.1.0', () =>
  withServer({ supported: ['1.0.0'] }, async (s) => {
    const r = await continueSession({ port: s.port, token: TOKEN, sessionUri: s.sessionUri, probe: true, log: logger() });
    assert.equal(r.protocolVersion, '1.0.0');
  }));

test('rejects a session id that is not an AHP URI', async () => {
  const r = await continueSession({ port: 1, token: TOKEN, sessionUri: 'c0ffee', text: 'x', log: logger() });
  assert.equal(r.ok, false);
});

test('findSessionUri finds the session by working directory', () =>
  withServer({ workingDirectories: [process.platform === 'win32' ? 'file:///c%3A/work/repo' : 'file:///work/repo'] }, async (s) => {
    const { client } = await connect({ port: s.port, token: TOKEN });
    try {
      assert.equal(await findSessionUri(client, process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'), s.sessionUri);
      assert.equal(await findSessionUri(client, process.platform === 'win32' ? 'C:\\other' : '/other'), null);
    } finally { await client.shutdown(); }
  }));
