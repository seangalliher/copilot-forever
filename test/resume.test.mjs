// Network resume: error classification, the decision from the log, and one watcher check
// end to end with injected send/notify (no host needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resolveConfig, validate, DEFAULTS } from '../src/config.mjs';
import { apiTarget, classifyError, maybeResume, probe, resumeCandidate, resumeText, tailEvents } from '../src/resume.mjs';
import { logger, rm, SID, tmpDir } from './helpers.mjs';

const DNS = 'Execution failed: Failed to get response from the AI model; retried 5 times. Last error: error sending request for url (https://api.example-copilot.test/v1/messages): client error (Connect): dns error: No such host is known. (os error 11001) [ENOTFOUND]';
const T0 = Date.parse('2026-11-04T09:33:57.000Z');
const ev = (type, i, data = {}, at = T0 - 60000 + i * 1000) => ({ type, data, id: `e${i}`, timestamp: new Date(at).toISOString() });
const errEv = (message, at = T0) => ({ type: 'session.error', data: { errorType: 'query', message }, id: 'err1', timestamp: new Date(at).toISOString() });
const turn = () => [ev('user.message', 1), ev('assistant.turn_start', 2), ev('assistant.message', 3), ev('assistant.turn_end', 4)];

test('classifyError: network errors resume; auth, quota, rate limit, policy, cancel and unknown errors do not', () => {
  for (const m of [DNS, '502 Bad Gateway', 'Service Unavailable', 'connect ECONNREFUSED 1.2.3.4:443', 'socket hang up', 'request timed out', 'getaddrinfo EAI_AGAIN api.githubcopilot.com']) {
    assert.equal(classifyError(m), 'network', m);
  }
  for (const m of ['401 Unauthorized', 'HTTP 403 Forbidden', '429 Too Many Requests', 'rate limit exceeded (503)', 'monthly quota reached', 'content filter triggered', 'request cancelled by user', 'aborted']) {
    assert.equal(classifyError(m), 'excluded', m);
  }
  assert.equal(classifyError('model returned malformed tool call'), 'unknown');
  assert.equal(classifyError(undefined), 'unknown');
});

test('resumeCandidate: resumes only on a network error that ends the log and is old enough', () => {
  const now = T0 + 20 * 60000;
  const base = [...turn(), errEv(DNS), { type: 'session.usage_checkpoint', data: {}, id: 'u', timestamp: new Date(T0).toISOString() }];
  assert.equal(resumeCandidate(base, { now }).reason, null);
  assert.equal(resumeCandidate(base, { now }).error.id, 'err1');
  assert.match(resumeCandidate(base, { now: T0 + 5 * 60000 }).reason, /only 5 min old/);
  assert.equal(resumeCandidate(base, { now: T0 + 5 * 60000 }).quiet, true);
  const worked = [...base, ev('assistant.turn_start', 9, {}, T0 + 60000)];
  assert.match(resumeCandidate(worked, { now }).reason, /worked since/);
  assert.match(resumeCandidate([...turn(), errEv('401 Unauthorized')], { now }).reason, /not a network error/);
  assert.match(resumeCandidate([...turn(), errEv('weird failure')], { now }).reason, /not a recognised/);
  assert.equal(resumeCandidate(turn(), { now }).error, null);
});

test('apiTarget and resumeText', () => {
  const cfg = resolveConfig({ repoFolder: '/r' }, '/cfg');
  assert.deepEqual(apiTarget(cfg, DNS), { host: 'api.example-copilot.test', port: 443 });
  assert.deepEqual(apiTarget(cfg, 'no url here'), { host: 'api.githubcopilot.com', port: 443 });
  const pinned = resolveConfig({ repoFolder: '/r', resume: { apiHost: '127.0.0.1', apiPort: 8443 } }, '/cfg');
  assert.deepEqual(apiTarget(pinned, DNS), { host: '127.0.0.1', port: 8443 });
  assert.match(resumeText(cfg, errEv(DNS)), /network error at 2026-11-04 09:33Z .*logs\/agent-handoff\.md/);
});

test('config: resume settings are validated', () => {
  const bad = { ...structuredClone(DEFAULTS), repoFolder: '/r', resume: { ...DEFAULTS.resume, maxTries: 0, apiPort: 0, enabled: 'yes', text: ' ' } };
  const p = validate(bad);
  for (const k of ['maxTries', 'apiPort', 'enabled', 'text']) assert.ok(p.some((x) => x.includes(`resume.${k}`)), k);
  assert.deepEqual(validate({ ...structuredClone(DEFAULTS), repoFolder: '/r' }), []);
});

// ---- one watcher check ------------------------------------------------------------------------
let root, server, apiPort, closedPort;

before(async () => {
  root = tmpDir('cf-resume-');
  server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  apiPort = /** @type {net.AddressInfo} */ (server.address()).port;
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', () => r(null)));
  closedPort = /** @type {net.AddressInfo} */ (tmp.address()).port;
  await new Promise((r) => tmp.close(r));
});
after(() => { server.close(); rm(root); });

function setup(name, events, { port = apiPort, maxTries = 2 } = {}) {
  const dir = path.join(root, name, 'session-state', SID);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const old = (T0 + 60000) / 1000;
  fs.utimesSync(file, old, old);
  const cfg = resolveConfig({
    repoFolder: path.join(root, name, 'repo'), stateDir: path.join(root, name, 'state'),
    watch: { quietSeconds: 0 }, resume: { apiHost: '127.0.0.1', apiPort: port, retryMinutes: 20, maxTries, probeTimeoutSeconds: 2 },
  }, root);
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const sent = [], notes = [];
  const o = {
    hostInfo: { sessions: [] }, session: { id: SID, dir }, ahpSession: 'ahp-session:/x',
    send: async (t) => { sent.push(t); return { ok: true, detail: 'working' }; },
    notify: async (title) => { notes.push(title); },
  };
  return { cfg, o, sent, notes, file };
}

test('maybeResume: sends one continue, waits out the retry interval, then gives up after maxTries', async () => {
  const { cfg, o, sent, notes } = setup('cycle', [...turn(), errEv(DNS)]);
  const log = logger();
  let now = T0 + 20 * 60000;
  assert.equal((await maybeResume(cfg, log, { ...o, now, dryRun: true })).state, 'would-resume');
  assert.equal(sent.length, 0, 'dry run sends nothing');
  assert.ok(!fs.existsSync(cfg.resumeStateFile), 'dry run writes no state');

  assert.equal((await maybeResume(cfg, log, { ...o, now })).state, 'resumed');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Continue\. Your last turn failed on a network error at 2026-11-04 09:33Z/);
  assert.deepEqual(notes, ['Agent resumed after a network error']);

  now += 5 * 60000;
  assert.equal((await maybeResume(cfg, log, { ...o, now })).state, 'wait', 'within the retry interval');
  now += 20 * 60000;
  assert.equal((await maybeResume(cfg, log, { ...o, now })).state, 'resumed');
  now += 21 * 60000;
  assert.equal((await maybeResume(cfg, log, { ...o, now })).state, 'gave-up');
  assert.equal(sent.length, 2);
  assert.equal(notes.at(-1), 'Agent stopped on a network error: resume needed');
  assert.equal((await maybeResume(cfg, log, { ...o, now: now + 60 * 60000 })).state, 'gave-up');
  assert.equal(notes.length, 3, 'the give-up notification is shown once');
});

test('maybeResume: waits while the API is down, and never sends after an excluded error or a busy session', async () => {
  const now = T0 + 20 * 60000;
  const down = setup('down', [...turn(), errEv(DNS)], { port: closedPort });
  assert.equal((await maybeResume(down.cfg, logger(), { ...down.o, now })).state, 'api-down');
  assert.equal(down.sent.length, 0);

  const auth = setup('auth', [...turn(), errEv('401 Unauthorized')]);
  const log = logger();
  assert.equal((await maybeResume(auth.cfg, log, { ...auth.o, now })).state, 'skip');
  assert.equal((await maybeResume(auth.cfg, log, { ...auth.o, now })).state, 'skip');
  assert.equal(auth.sent.length, 0);
  assert.equal(log.lines.filter((l) => /not resuming/.test(l)).length, 1, 'a skipped error is logged once');

  const busy = setup('busy', [...turn(), errEv(DNS)]);
  busy.o.hostInfo = { sessions: [{ workingDirectories: [busy.cfg.repoFolder], resource: 'ahp-session:/x' }] };
  assert.equal((await maybeResume(busy.cfg, logger(), { ...busy.o, now })).state, 'wait');
  assert.equal(busy.sent.length, 0);

  const off = setup('off', [...turn(), errEv(DNS)]);
  off.cfg.resume.enabled = false;
  assert.equal((await maybeResume(off.cfg, logger(), { ...off.o, now })).state, 'off');
});

test('maybeResume: the daily cap holds across different errors', async () => {
  const x = setup('daily', [...turn(), errEv(DNS)], { maxTries: 5 });
  x.cfg.resume.maxPerDay = 2;
  x.cfg.resume.retryMinutes = 0;
  const log = logger();
  let now = T0 + 20 * 60000;
  // Each continue "fails" with a new network error, as a flapping API would.
  const newError = (i) => {
    const events = [...turn(), { ...errEv(DNS, T0 + i * 60000), id: `err-${i}` }];
    fs.writeFileSync(x.file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const t = (T0 + (i + 1) * 60000) / 1000;
    fs.utimesSync(x.file, t, t);
  };
  for (let i = 0; i < 2; i++) {
    newError(i);
    assert.equal((await maybeResume(x.cfg, log, { ...x.o, now })).state, 'resumed');
    now += 60000;
  }
  newError(2);
  assert.equal((await maybeResume(x.cfg, log, { ...x.o, now })).state, 'gave-up');
  assert.equal(x.sent.length, 2);
  assert.ok(log.lines.some((l) => /2 resumes in 24 hours/.test(l)));
});

test('tailEvents drops a cut first line', () => {
  const f = path.join(root, 'tail.jsonl');
  fs.writeFileSync(f, [ev('a', 1), ev('b', 2), ev('c', 3)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual(tailEvents(f).map((e) => e.type), ['a', 'b', 'c']);
  const size = fs.statSync(f).size;
  assert.deepEqual(tailEvents(f, size - 10).map((e) => e.type), ['b', 'c']);
});

test('probe reports a closed port', async () => {
  assert.equal(await probe('127.0.0.1', apiPort, 2000), null);
  assert.match(await probe('127.0.0.1', closedPort, 2000), /not reachable|did not answer/);
});
