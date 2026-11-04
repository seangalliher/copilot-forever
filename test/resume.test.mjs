// Network resume: error classification, the decision from the log, and one watcher check
// end to end with injected send/notify (no host needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { resolveConfig, validate, DEFAULTS } from '../src/config.mjs';
import { apiTarget, classifyError, maybeResume, maybeStallResume, probe, resumeCandidate, resumeText, stallCandidate, stallText, tailEvents } from '../src/resume.mjs';
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

// ---- stall resume -------------------------------------------------------------------------------
const S0 = Date.parse('2026-11-04T17:21:14.000Z');
const sev = (type, i, data = {}) => ({ type, data, id: `s${i}`, timestamp: new Date(S0 - 10000 + i * 1000).toISOString() });
const call = (i, toolName, args) => sev('tool.execution_start', i, { toolName, arguments: args });
/** A working turn with the given calls, then a closing message-only turn (the observed shape). */
const stalled = (...calls) => [
  sev('user.message', 0), sev('assistant.turn_start', 1), ...calls, sev('assistant.turn_end', 7),
  sev('assistant.turn_start', 8), sev('assistant.message', 9), sev('assistant.turn_end', 10),
];
const consult = (i = 2) => call(i, 'powershell', { command: 'python scripts/consult.py', mode: 'async', shellId: 'arch-r1', description: 'Architect consult' });
const watchdog = (s, i = 3) => call(i, 'powershell', { command: `Start-Sleep -Seconds ${s}`, mode: 'async', shellId: 'wd', description: `Watchdog ${s} s` });

test('stallCandidate: resumes a turn that ended waiting on background work, once quiet long enough', () => {
  const ev1 = stalled(consult(), watchdog(270));
  const c = stallCandidate(ev1, { now: S0 + 21 * 60000 });
  assert.equal(c.reason, null);
  assert.deepEqual(c.work, ['Architect consult', 'Watchdog 270 s']);
  assert.equal(c.quietMinutes, 20);
  assert.match(stallCandidate(ev1, { now: S0 + 9 * 60000 }).reason, /quiet for only 9 of 20 min/);
  const long = stalled(watchdog(1800));
  assert.equal(stallCandidate(long, { now: S0 + 30 * 60000 }).quietMinutes, 35, 'a long watchdog extends the wait');
  assert.match(stallCandidate(long, { now: S0 + 30 * 60000 }).reason, /of 35 min/);
  assert.equal(stallCandidate(long, { now: S0 + 36 * 60000 }).reason, null);
  const bgTask = stalled(call(2, 'task', { mode: 'background', description: 'Builder slice 2' }));
  assert.deepEqual(stallCandidate(bgTask, { now: S0 + 21 * 60000 }).work, ['Builder slice 2']);
});

test('stallCandidate: never after a deliberate stop, an error, sync-only work, or while a turn runs', () => {
  const now = S0 + 60 * 60000;
  assert.match(stallCandidate(stalled(call(2, 'powershell', { command: 'git status', mode: 'sync' })), { now }).reason, /no background work/);
  assert.match(stallCandidate(stalled(consult(), call(3, 'task_complete', {})), { now }).reason, /deliberately/);
  assert.match(stallCandidate(stalled(consult(), call(3, 'ask_user', { question: 'Which?' })), { now }).reason, /deliberately/);
  assert.match(stallCandidate([...stalled(consult()), sev('session.error', 11, { message: 'ENOTFOUND' })], { now }).reason, /network resume decides/);
  assert.match(stallCandidate([...stalled(consult()), sev('assistant.turn_start', 11)], { now }).reason, /has not ended/);
  assert.equal(stallCandidate([], { now }).key, null);
});

test('stallText fills {time} and {work}', () => {
  const cfg = resolveConfig({ repoFolder: '/r' }, '/cfg');
  const c = stallCandidate(stalled(consult(), watchdog(270)), { now: S0 + 21 * 60000 });
  assert.match(stallText(cfg, c), /^Continue\. You ended your turn at 2026-11-04 17:21Z waiting on background work \(Architect consult; Watchdog 270 s\)/);
});

test('config: stall settings are validated', () => {
  const bad = { ...structuredClone(DEFAULTS), repoFolder: '/r', stall: { ...DEFAULTS.stall, maxTries: 0, enabled: 1, text: '' } };
  const p = validate(bad);
  for (const k of ['maxTries', 'enabled', 'text']) assert.ok(p.some((x) => x.includes(`stall.${k}`)), k);
});

test('maybeStallResume: sends one continue per try, gives up after maxTries, and caps the day', async () => {
  const x = setup('stall', stalled(consult(), watchdog(270)));
  const log = logger();
  const now = S0 + 25 * 60000;
  assert.equal((await maybeStallResume(x.cfg, log, { ...x.o, now, dryRun: true })).state, 'would-resume');
  assert.equal(x.sent.length, 0, 'dry run sends nothing');
  assert.ok(!fs.existsSync(x.cfg.stallStateFile), 'dry run writes no state');
  assert.equal((await maybeStallResume(x.cfg, log, { ...x.o, now })).state, 'resumed');
  assert.match(x.sent[0], /waiting on background work \(Architect consult; Watchdog 270 s\)/);
  assert.equal((await maybeStallResume(x.cfg, log, { ...x.o, now: now + 20 * 60000 })).state, 'resumed', 'the log did not change: same stall, try 2');
  assert.equal((await maybeStallResume(x.cfg, log, { ...x.o, now: now + 40 * 60000 })).state, 'gave-up');
  assert.deepEqual(x.notes, ['Agent idle: resume needed']);
  assert.equal((await maybeStallResume(x.cfg, log, { ...x.o, now: now + 60 * 60000 })).state, 'gave-up');
  assert.equal(x.notes.length, 1, 'the give-up notification is shown once');

  const busy = setup('stall-busy', stalled(consult()));
  busy.o.hostInfo = { sessions: [{ workingDirectories: [busy.cfg.repoFolder], resource: 'ahp-session:/x' }] };
  assert.equal((await maybeStallResume(busy.cfg, logger(), { ...busy.o, now })).state, 'wait');
  assert.equal(busy.sent.length, 0);

  const daily = setup('stall-daily', stalled(consult()), { maxTries: 5 });
  daily.cfg.stall.maxPerDay = 1;
  assert.equal((await maybeStallResume(daily.cfg, logger(), { ...daily.o, now })).state, 'resumed');
  // A new stall (the log changed) still hits the daily cap.
  fs.writeFileSync(daily.file, [...stalled(consult()), sev('assistant.turn_start', 20), call(21, 'powershell', { command: 'x', mode: 'async', shellId: 'n' }), sev('assistant.turn_end', 22)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(daily.file, S0 / 1000, S0 / 1000);
  assert.equal((await maybeStallResume(daily.cfg, logger(), { ...daily.o, now })).state, 'gave-up');
  assert.equal(daily.sent.length, 1);

  const off = setup('stall-off', stalled(consult()));
  off.cfg.stall.enabled = false;
  assert.equal((await maybeStallResume(off.cfg, logger(), { ...off.o, now })).state, 'off');
});
