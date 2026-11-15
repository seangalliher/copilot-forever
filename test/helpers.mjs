import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLogger } from '../src/log.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const BIN = path.join(ROOT, 'bin', 'copilot-forever.mjs');
export const FAKE_CODE = path.join(ROOT, 'test', 'fake-code.mjs');
export const SID = '00000000-0000-4000-8000-000000000001';

export function tmpDir(prefix = 'cf-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function fixtureEvents(name) {
  return fixtureText(name).split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** A session-state folder with a fixture log. Returns { stateDir, dir, file }. */
export function makeSession(root, fixture, { id = SID, cwd = '/repo' } = {}) {
  const stateDir = path.join(root, 'session-state');
  const dir = path.join(stateDir, id);
  fs.mkdirSync(path.join(dir, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'checkpoints', 'index.md'), 'checkpoint\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), fixtureText(fixture));
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${cwd}\nsummary_count: 0\n`);
  return { stateDir, dir, file: path.join(dir, 'events.jsonl') };
}

export const logger = () => new MemoryLogger();

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/**
 * Log lines a continue's turn writes, in the order seen on a real host after a trim
 * (2026-11-14): session.resume, subagent.selected, session.shutdown, session.resume, hook.start,
 * hook.end, then the turn's first outcome, all within 11 s of the send and with no user.message.
 * spanMs squeezes the 11 s into less, so a test's later turns are not older than these lines.
 * kind 'auth' ends with the missing-sign-in session.error, 'working' with the model's reasoning and
 * message, 'error' with another session.error, 'unknown' with nothing after the hooks.
 * @param {'auth'|'working'|'error'|'unknown'} kind
 */
export function continueTurnLines(kind, startMs = Date.now(), spanMs = 11000) {
  const at = (s) => new Date(startMs + (s * spanMs) / 11).toISOString();
  const ev = (n, type, data, s) => JSON.stringify({ type, data, id: `turn-${kind}-${n}`, timestamp: at(s), parentId: null });
  const lines = [
    ev(1, 'session.resume', {}, 0.1),
    ev(2, 'subagent.selected', { agentName: 'orchestrator', agentDisplayName: 'Orchestrator', tools: [] }, 0.2),
    ev(3, 'session.shutdown', {}, 0.5),
    ev(4, 'session.resume', {}, 1),
    ev(5, 'hook.start', { hookType: 'sessionStart' }, 2),
    ev(6, 'hook.end', { hookType: 'sessionStart' }, 3),
  ];
  if (kind === 'auth') lines.push(ev(7, 'session.error', { errorType: 'error', message: 'Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided' }, 11));
  if (kind === 'error') lines.push(ev(7, 'session.error', { errorType: 'error', message: 'Execution failed: model overloaded' }, 11));
  if (kind === 'working') lines.push(ev(7, 'assistant.reasoning', { content: '...' }, 9), ev(8, 'assistant.message', { content: 'Resuming.' }, 10));
  return lines.map((l) => l + '\n').join('');
}
