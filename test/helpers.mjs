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
