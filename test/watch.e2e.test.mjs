// End-to-end: the CLI against a fake setup (fake `code` CLI, fake host process tree, fake AHP
// server, synthetic session log). Covers host start, watcher dry-run, a status run and a full
// trim cycle: stop host, trim, restart host, continue over AHP.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { killTree, pidAlive } from '../src/proc.mjs';
import { vscodeFileUri } from '../src/util.mjs';
import { BIN, FAKE_CODE, freePort, makeSession, rm, SID, tmpDir } from './helpers.mjs';

let root, repo, cfgFile, stateFile, sessionDir, eventsFile, port;
const AHP = 'ahp-session:/22222222-2222-4222-8222-222222222222';

function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args, '--config', cfgFile], {
      env: { ...process.env, CF_TEST_LEAK: 'must-not-reach-the-host', CLAUDECODE: '1' },
      timeout: 240000, windowsHide: true,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const ageLog = () => { const t = Date.now() / 1000 - 600; fs.utimesSync(eventsFile, t, t); };

before(async () => {
  root = tmpDir('cf-e2e-');
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'agents', 'orchestrator.agent.md'), '# agent\nlogs/trim-request.json\n');
  const copilotHome = path.join(root, 'copilot');
  ({ dir: sessionDir, file: eventsFile } = makeSession(copilotHome, 'basic.jsonl', { cwd: repo }));
  port = await freePort();
  stateFile = path.join(root, 'fake-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ port, sessionDir, ahpSession: AHP, repoUri: vscodeFileUri(repo) }));
  cfgFile = path.join(root, 'copilot-forever.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    repoFolder: repo,
    copilotHome,
    stateDir: path.join(root, 'state'),
    host: { codeCommand: [process.execPath, FAKE_CODE, '--state', stateFile], port, startVia: 'direct', startTimeoutSeconds: 30 },
    trim: { thresholdMiB: 0.001 },
    watch: { quietSeconds: 0, idleRecheckSeconds: 0, runtimeExitTimeoutSeconds: 10, continueDelaySeconds: 0, continueTries: 2, continueRetrySeconds: 1, continueTimeoutSeconds: 10 },
    notify: false,
  }, null, 2));
});

after(async () => {
  try {
    const s = state();
    if (s.hostPid) await killTree(s.hostPid);
    if (s.runtimePid) await killTree(s.runtimePid);
  } catch { /* nothing started */ }
  rm(root);
});

test('host start: spawns the host with a clean environment and an owner-only token, banner masked', async () => {
  const r = await cli('host', 'start');
  assert.equal(r.code, 0, r.out);
  const s = state();
  assert.ok(pidAlive(s.hostPid), 'fake host running');
  const token = fs.readFileSync(path.join(root, 'state', 'token.txt'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, 'state', 'token.txt')).mode & 0o777, 0o600);
  const envKeys = JSON.parse(fs.readFileSync(path.join(root, `host-env-${s.hostPid}.json`), 'utf8'));
  assert.ok(!envKeys.includes('CF_TEST_LEAK'), 'caller variables do not reach the host');
  assert.ok(!envKeys.includes('CLAUDECODE'));
  const hostLog = fs.readFileSync(path.join(root, 'state', 'logs', 'host-copilot-forever.log'), 'utf8');
  assert.match(hostLog, /tkn=\*+/);
  assert.ok(!hostLog.includes(token), 'token masked in host.log');
  assert.ok(!r.out.includes(token));
  const again = await cli('host', 'start');
  assert.match(again.out, /already listening/);
});

test('watch --dry-run reports the trim it would do and changes nothing', async () => {
  ageLog();
  const reqFile = path.join(repo, 'logs', 'trim-request.json');
  fs.mkdirSync(path.dirname(reqFile), { recursive: true });
  fs.writeFileSync(reqFile, JSON.stringify({ requested_at: new Date().toISOString(), session_id: SID }));
  const before = fs.readFileSync(eventsFile, 'utf8');
  const hostPid = state().hostPid;
  const r = await cli('watch', '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[dry-run\] status would be: .*"trim_due":true/);
  assert.match(r.out, /would trim 00000000-0000-4000-8000-000000000001: 17 -> 9 events/);
  assert.match(r.out, new RegExp(`would stop host ${hostPid}, trim ${SID}, restart the host, send continue to ${AHP.replace(/[/]/g, '\\/')}`));
  assert.equal(fs.readFileSync(eventsFile, 'utf8'), before);
  assert.ok(fs.existsSync(reqFile), 'request left in place');
  assert.ok(!fs.existsSync(path.join(repo, 'logs', 'session-log-status.json')), 'no status written');
  assert.ok(pidAlive(hostPid), 'host untouched');
  assert.ok(!fs.existsSync(path.join(root, 'state', 'logs', 'copilot-forever.log')) ||
    !fs.readFileSync(path.join(root, 'state', 'logs', 'copilot-forever.log'), 'utf8').includes('dry-run'), 'dry-run writes no log file');
  fs.unlinkSync(reqFile);
});

test('watch without a request writes the status file only', async () => {
  const r = await cli('watch');
  assert.equal(r.code, 0, r.out);
  const st = JSON.parse(fs.readFileSync(path.join(repo, 'logs', 'session-log-status.json'), 'utf8'));
  assert.equal(st.session_id, SID);
  assert.equal(st.ahp_session, AHP, 'AHP session URI found over AHP listSessions');
  assert.equal(st.trim_due, true);
});

test('watch refuses while the session is busy, then trims at the safe point and resumes the agent', async () => {
  const reqFile = path.join(repo, 'logs', 'trim-request.json');
  fs.writeFileSync(reqFile, JSON.stringify({ requested_at: new Date().toISOString(), session_id: SID }));

  fs.writeFileSync(stateFile, JSON.stringify({ ...state(), activeSessions: [{ workingDirectories: [vscodeFileUri(repo)], resource: AHP }] }));
  let r = await cli('watch');
  assert.match(r.out, /not idle yet \(the host lists the session as active\)/);
  assert.ok(fs.existsSync(reqFile));
  fs.writeFileSync(stateFile, JSON.stringify({ ...state(), activeSessions: [] }));

  ageLog();
  const oldHost = state().hostPid;
  const oldRuntime = state().runtimePid;
  r = await cli('watch');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stopping host/);
  assert.match(r.out, /archived full log/);
  assert.match(r.out, /continue try 1: ok/);
  assert.ok(!pidAlive(oldHost) && !pidAlive(oldRuntime), 'old host tree stopped');
  const s = state();
  assert.equal(s.starts, 2, r.out);
  assert.ok(pidAlive(s.hostPid), 'host restarted');

  const kept = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((e) => e.id), ['e001', 'e002', 'e003', 'e012', 'e013', 'e014', 'e015', 'e016', 'e017']);
  const archived = fs.readdirSync(path.join(root, 'copilot', 'session-archive', SID));
  assert.equal(archived.length, 1);
  assert.ok(!fs.existsSync(reqFile), 'request moved');
  assert.equal(fs.readdirSync(path.join(repo, 'logs', 'trim-history')).filter((n) => /^trim-request-\d{8}T\d{6}Z\.json$/.test(n)).length, 1);
  const st = JSON.parse(fs.readFileSync(path.join(repo, 'logs', 'session-log-status.json'), 'utf8'));
  assert.ok(st.size_mib < 0.01);

  const turns = fs.readFileSync(path.join(root, 'received.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(turns.length, 1);
  assert.match(turns[0].message.text, /^Continue\. .*logs\/agent-handoff\.md/);
  assert.equal(turns[0].message.agent.uri, 'file:///repo/.github/agents/orchestrator.agent.md', 'agent reused from the last user message');

  const log = fs.readFileSync(path.join(root, 'state', 'logs', 'copilot-forever.log'), 'utf8');
  const token = fs.readFileSync(path.join(root, 'state', 'token.txt'), 'utf8').trim();
  assert.ok(!log.includes(token), 'token never logged');
});

test('a request with nothing safe to trim is refused without stopping the host, and the agent is resumed', async () => {
  fs.writeFileSync(eventsFile, fs.readFileSync(path.join(path.dirname(BIN), '..', 'test', 'fixtures', 'failed-only.jsonl'), 'utf8'));
  ageLog();
  const reqFile = path.join(repo, 'logs', 'trim-request.json');
  fs.writeFileSync(reqFile, '{}');
  const hostPid = state().hostPid;
  const r = await cli('watch');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /refusing to trim: no successful completed compaction/);
  assert.ok(pidAlive(hostPid), 'host not stopped');
  assert.ok(!fs.existsSync(reqFile));
  assert.ok(fs.readdirSync(path.join(repo, 'logs', 'trim-history')).some((n) => n.endsWith('-refused.json')));
  const turns = fs.readFileSync(path.join(root, 'received.jsonl'), 'utf8').trim().split('\n');
  assert.match(JSON.parse(turns[turns.length - 1]).message.text, /did NOT happen/);
});

test('host stop stops the host and its runtime', async () => {
  const s = state();
  const r = await cli('host', 'stop');
  assert.equal(r.code, 0, r.out);
  assert.ok(!pidAlive(s.hostPid));
  assert.ok(!pidAlive(s.runtimePid));
});
