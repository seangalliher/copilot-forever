// Pending continue after a trim: recorded when the trim run cannot deliver its continue, retried
// by later runs with injected send/notify/listening (no host needed). The e2e test covers the
// retry running when no session is found.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULTS, resolveConfig, validate } from '../src/config.mjs';
import { maybePendingContinue, pendingText, recordPendingContinue } from '../src/watch.mjs';
import { logger, rm, SID, tmpDir } from './helpers.mjs';

const root = tmpDir('cf-pending-');
after(() => rm(root));

function setup(name, { maxTries = 2 } = {}) {
  const dir = path.join(root, name, 'session-state', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, '{}\n');
  const t = Date.now() / 1000 - 600;
  fs.utimesSync(file, t, t);
  const cfg = resolveConfig({ repoFolder: path.join(root, name, 'repo'), stateDir: path.join(root, name, 'state'), watch: { pendingContinueMaxTries: maxTries } }, root);
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const sent = [], notes = [];
  let ok = true, up = true;
  const io = {
    listening: async () => up,
    send: async (uri, text) => {
      sent.push({ uri, text });
      if (ok) return { ok: true, detail: 'working' };
      // A failed attempt can still load the session and write to its log; that is not a hand resume.
      fs.appendFileSync(file, '{"type":"session.resume"}\n');
      fs.utimesSync(file, new Date(), new Date(Date.now() + sent.length * 1000));
      return { ok: false, detail: 'busy' };
    },
    notify: async (title) => { notes.push(title); },
  };
  return { cfg, dir, file, sent, notes, io, fail: () => { ok = false; }, succeed: () => { ok = true; }, down: () => { up = false; }, upAgain: () => { up = true; } };
}
const record = (s) => recordPendingContinue(s.cfg, logger(), { ahpSession: 'ahp-session:/x', sessionDir: s.dir, trimmedAt: '2026-11-10T07:00:00Z' });
const state = (s) => JSON.parse(fs.readFileSync(s.cfg.pendingContinueFile, 'utf8'));

test('recordPendingContinue writes the owed continue with the log mtime, no tries and not given up', () => {
  const s = setup('record');
  record(s);
  const p = state(s);
  assert.equal(p.ahp_session, 'ahp-session:/x');
  assert.equal(p.session_dir, s.dir);
  assert.equal(p.trimmed_at, '2026-11-10T07:00:00Z');
  assert.equal(p.log_mtime_ms, fs.statSync(s.file).mtimeMs);
  assert.equal(p.tries, 0);
  assert.equal(p.gave_up, false);
});

test('a retry sends the pending text and clears the file', async () => {
  const s = setup('retry');
  record(s);
  const r = await maybePendingContinue(s.cfg, logger(), s.io);
  assert.equal(r.state, 'resumed');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].uri, 'ahp-session:/x');
  assert.match(s.sent[0].text, /^Continue\. Your session log was trimmed at 2026-11-10T07:00:00Z .*check git state and any work that was running/);
  assert.ok(!fs.existsSync(s.cfg.pendingContinueFile));
  assert.deepEqual(s.notes, ['Agent resumed after its log trim']);
  assert.equal((await maybePendingContinue(s.cfg, logger(), s.io)).state, 'none');
});

test('a changed log clears the pending continue without sending', async () => {
  const s = setup('by-hand');
  record(s);
  fs.appendFileSync(s.file, '{"type":"user.message"}\n');
  const r = await maybePendingContinue(s.cfg, logger(), s.io);
  assert.equal(r.state, 'cleared');
  assert.equal(s.sent.length, 0);
  assert.ok(!fs.existsSync(s.cfg.pendingContinueFile));
});

test('host down: waits without counting a try', async () => {
  const s = setup('down');
  record(s);
  s.down();
  assert.equal((await maybePendingContinue(s.cfg, logger(), s.io)).state, 'host-down');
  assert.equal(s.sent.length, 0);
  assert.equal(state(s).tries, 0);
});

test('failed tries count up; after the limit it gives up and notifies only once', async () => {
  const s = setup('give-up', { maxTries: 2 });
  record(s);
  s.fail();
  const log = logger();
  assert.equal((await maybePendingContinue(s.cfg, log, s.io)).state, 'failed');
  assert.equal((await maybePendingContinue(s.cfg, log, s.io)).state, 'failed');
  assert.equal(state(s).tries, 2);
  assert.equal((await maybePendingContinue(s.cfg, log, s.io)).state, 'gave-up-now');
  assert.equal((await maybePendingContinue(s.cfg, log, s.io)).state, 'gave-up');
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.notes, ['Agent log trimmed: resume needed'], 'notified once');
  assert.equal(state(s).gave_up, true);
});

test('dry run changes nothing', async () => {
  const s = setup('dry');
  record(s);
  const before = fs.readFileSync(s.cfg.pendingContinueFile, 'utf8');
  assert.equal((await maybePendingContinue(s.cfg, logger(), { ...s.io, dryRun: true })).state, 'would-send');
  fs.appendFileSync(s.file, '{}\n');
  assert.equal((await maybePendingContinue(s.cfg, logger(), { ...s.io, dryRun: true })).state, 'cleared');
  assert.equal(fs.readFileSync(s.cfg.pendingContinueFile, 'utf8'), before, 'file untouched');
  assert.equal(s.sent.length, 0);
  assert.equal(s.notes.length, 0);
});

test('an unreadable pending file is removed', async () => {
  const s = setup('bad');
  fs.writeFileSync(s.cfg.pendingContinueFile, 'not json');
  assert.equal((await maybePendingContinue(s.cfg, logger(), s.io)).state, 'unreadable');
  assert.ok(!fs.existsSync(s.cfg.pendingContinueFile));
});

test('config: pendingContinueMaxTries defaults to 6 and must be at least 1', () => {
  assert.equal(DEFAULTS.watch.pendingContinueMaxTries, 6);
  const bad = { ...structuredClone(DEFAULTS), repoFolder: '/r', watch: { ...DEFAULTS.watch, pendingContinueMaxTries: 0 } };
  assert.ok(validate(bad).some((x) => x.includes('pendingContinueMaxTries')));
  assert.match(pendingText(resolveConfig({ repoFolder: '/r' }, '/cfg'), 'T'), /logs\/agent-handoff\.md/);
});
