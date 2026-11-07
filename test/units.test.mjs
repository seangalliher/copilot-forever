import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { continueMessage, resolveConfig, validate, DEFAULTS } from '../src/config.mjs';
import { activeRepoSessions, agentPs, cleanEnv, findStandaloneHost, hostArgs, maskTokenInFile } from '../src/host.mjs';
import { launchdPlists, SCHEDULE_VERSION, systemdUnits, uninstall, watchTimeLimitMinutes, windowsTaskXml } from '../src/install.mjs';
import { addSecret, redact } from '../src/log.mjs';
import { notifyCommand } from '../src/notify.mjs';
import { descendants, etimeSeconds, isDescendant, isListening, pidAlive, processTable } from '../src/proc.mjs';
import { checkSchema, parseEvents } from '../src/schema.mjs';
import { findSession, lastTurnAsked, lastTurnEvent, notIdleReason, sharedSessions, staleHostStatus, workspaceCwd } from '../src/session.mjs';
import { maybeNotifyShared, maybeNotifyStale, sharedAdvice } from '../src/watch.mjs';
import { Refusal, uriToPath, vscodeFileUri } from '../src/util.mjs';
import { BIN, fixtureEvents, fixtureText, freePort, logger, makeSession, rm, SID, tmpDir } from './helpers.mjs';

const win = process.platform === 'win32';
const REPO = win ? 'C:\\work\\repo' : '/work/repo';

const cfgFor = (over = {}) => resolveConfig({ repoFolder: REPO, ...over }, win ? 'C:\\cfg' : '/cfg', win ? 'C:\\cfg\\c.json' : '/cfg/c.json');

// ---- config ---------------------------------------------------------------------------------
test('config: defaults and path resolution', () => {
  const c = cfgFor({ stateDir: '~/.cf' });
  assert.equal(c.host.port, 47801);
  assert.deepEqual(c.host.codeCommand, ['code']);
  assert.equal(c.stateDir, path.join(os.homedir(), '.cf'));
  assert.equal(c.files.status, path.join(REPO, 'logs', 'session-log-status.json'));
  assert.equal(c.agentFile, path.join(REPO, '.github', 'agents', 'orchestrator.agent.md'));
  assert.equal(c.host.tokenFile, path.join(c.stateDir, 'token.txt'));
  assert.equal(c.trim.archiveDir, path.join(c.copilotHome, 'session-archive'));
  assert.match(continueMessage(c), /logs\/agent-handoff\.md/);
});

test('config: validation reports every problem', () => {
  const merged = { ...structuredClone(DEFAULTS), repoFolder: null, host: { ...DEFAULTS.host, port: 80, startVia: 'x' } };
  const p = validate(merged);
  assert.ok(p.some((x) => /repoFolder/.test(x)));
  assert.ok(p.some((x) => /port/.test(x)));
  assert.ok(p.some((x) => /startVia/.test(x)));
  assert.throws(() => cfgFor({ watch: { intervalMinutes: 0 } }), /intervalMinutes/);
  assert.throws(() => cfgFor({ instanceName: 'a b' }), /instanceName/);
});

// ---- schema ---------------------------------------------------------------------------------
test('schema: a known layout passes; unknown version, bad ids and malformed lines fail', () => {
  assert.deepEqual(checkSchema(fixtureEvents('basic.jsonl'), { sessionId: SID }), []);
  assert.match(checkSchema(fixtureEvents('unknown-version.jsonl'))[0], /unknown log version 2/);
  assert.match(checkSchema(fixtureEvents('basic.jsonl'), { sessionId: 'other' })[0], /names session/);
  const ev = fixtureEvents('basic.jsonl');
  ev[3] = { ...ev[3], id: ev[2].id };
  assert.ok(checkSchema(ev).some((x) => /repeats id/.test(x)));
  const ev2 = fixtureEvents('basic.jsonl');
  ev2[13] = { ...ev2[13], data: { summaryContent: 'x' } };
  assert.ok(checkSchema(ev2).some((x) => /boolean data.success/.test(x)));
  assert.match(checkSchema([{ type: 'user.message', id: 'x', parentId: null }])[0], /not session.start/);
  assert.throws(() => parseEvents('{"a":1}\nnot json\n{"b":2}\n'), /line 2/);
  assert.equal(parseEvents(fixtureText('partial-last.jsonl')).droppedPartialLast, true);
});

// ---- host -----------------------------------------------------------------------------------
test('host: clean environment drops IDE and agent variables', () => {
  const src = { PATH: '/bin', Path: 'C:\\bin', HOME: '/h', USERPROFILE: 'C:\\h', CLAUDECODE: '1', VSCODE_IPC_HOOK: 'x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', GITHUB_TOKEN: 'secret', LC_ALL: 'C', KEEP_ME: 'y' };
  const env = cleanEnv(cfgFor({ host: { passEnv: ['KEEP_ME'] } }), src);
  for (const k of ['CLAUDECODE', 'VSCODE_IPC_HOOK', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'GITHUB_TOKEN']) assert.ok(!(k in env), k);
  assert.equal(env.KEEP_ME, 'y');
  assert.ok(env.PATH || env.Path);
});

test('host: always binds localhost with a token file', () => {
  const a = hostArgs(cfgFor());
  assert.deepEqual(a.slice(0, 4), ['agent', 'host', '--host', 'localhost']);
  assert.ok(a.includes('--connection-token-file'));
  assert.ok(!a.includes('--without-connection-token'));
});

test('host: picks our standalone host from `code agent ps --json`', () => {
  const ps = [
    { host: { type: 'editor', pid: 5, address: '\\\\.\\pipe\\x' }, sessions: [] },
    { host: { type: 'standalone', pid: 7, address: 'localhost:47000' }, sessions: [] },
    { host: { type: 'standalone', pid: 9, address: 'localhost:47801' }, sessions: [{ workingDirectories: [vscodeFileUri(REPO)], resource: 'ahp-session:/s' }] },
  ];
  const h = findStandaloneHost(ps, 47801);
  assert.equal(h.host.pid, 9);
  assert.equal(activeRepoSessions(h, REPO).length, 1);
  assert.equal(activeRepoSessions(h, REPO + 'x').length, 0);
  assert.equal(findStandaloneHost(ps, 1234), null);
});

test('redaction: registered secrets and token URL parameters', () => {
  addSecret('s3cr3t-value-123');
  assert.equal(redact('x s3cr3t-value-123 y'), 'x <redacted> y');
  assert.equal(redact('ws://localhost:1/?tkn=abc123&x=1'), 'ws://localhost:1/?tkn=<redacted>&x=1');
  assert.equal(redact('--connection-token abc'), '--connection-token <redacted>');
});

test('host: the banner token is masked in place with same-length text', () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'host.log');
    const tok = 'f'.repeat(64);
    const text = `Agent host listening: http://localhost:47801/?tkn=${tok}\nready\n`;
    fs.writeFileSync(f, text);
    maskTokenInFile(f, tok);
    const out = fs.readFileSync(f, 'utf8');
    assert.equal(out.length, text.length);
    assert.ok(!out.includes(tok));
    assert.match(out, /tkn=\*{64}/);
  } finally { rm(d); }
});

// ---- util -----------------------------------------------------------------------------------
test('util: VS Code style file URIs round-trip', () => {
  if (win) {
    assert.equal(vscodeFileUri('D:\\MyRepo\\.github\\agents\\o.agent.md'), 'file:///d%3A/MyRepo/.github/agents/o.agent.md');
    assert.equal(uriToPath('file:///d%3A/MyRepo'), 'd:\\MyRepo');
  } else {
    assert.equal(vscodeFileUri('/home/u/my repo/a.md'), 'file:///home/u/my%20repo/a.md');
    assert.equal(uriToPath('file:///home/u/my%20repo'), '/home/u/my repo');
  }
});

// ---- proc -----------------------------------------------------------------------------------
test('proc: ancestry and descendants from a process table', () => {
  const t = new Map([[1, { ppid: 0 }], [10, { ppid: 1 }], [11, { ppid: 10 }], [12, { ppid: 11 }], [20, { ppid: 1 }]]);
  assert.ok(isDescendant(t, 12, 10));
  assert.ok(!isDescendant(t, 20, 10));
  assert.deepEqual(descendants(t, 10).sort(), [11, 12]);
  assert.ok(pidAlive(process.pid));
  assert.ok(!pidAlive(2147483646));
});

test('proc: isListening', async () => {
  assert.equal(await isListening(1, 300), false);
});

// ---- session --------------------------------------------------------------------------------
test('session: finds the repo session whose live lock PID runs under the host', () => {
  const d = tmpDir();
  try {
    const { stateDir, dir } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const other = makeSession(d, 'basic.jsonl', { id: 'other-session', cwd: win ? 'C:\\elsewhere' : '/elsewhere' });
    fs.writeFileSync(path.join(dir, 'inuse.300.lock'), '');
    fs.writeFileSync(path.join(other.dir, 'inuse.301.lock'), '');
    const table = new Map([[100, { ppid: 1 }], [200, { ppid: 100 }], [300, { ppid: 200 }], [301, { ppid: 200 }], [400, { ppid: 1 }]]);
    const s = findSession({ sessionStateDir: stateDir, repoFolder: REPO }, 100, table);
    assert.equal(s.id, SID);
    assert.equal(s.runtimePid, 300);
    assert.equal(findSession({ sessionStateDir: stateDir, repoFolder: REPO }, 400, table), null, 'not under this host');
    assert.equal(workspaceCwd(dir), REPO);
  } finally { rm(d); }
});

test('session: a session open in this host and in another live runtime is shared', () => {
  const d = tmpDir();
  try {
    const { stateDir, dir } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const other = makeSession(d, 'basic.jsonl', { id: 'other-session', cwd: REPO });
    const lock = (dirName, pid, ageSeconds = 0) => {
      const f = path.join(dirName, `inuse.${pid}.lock`);
      fs.writeFileSync(f, '');
      const t = Date.now() / 1000 - ageSeconds;
      fs.utimesSync(f, t, t);
    };
    const started = Date.now() - 600000; // 10 min ago
    // host 100 -> runtime 300; another host 500 -> runtime 600; 700 is an unrelated process;
    // 800 runs the runtime's executable but started after its lock was written (a reused PID);
    // 900's executable is unknown (another user's process).
    /** @type {Map<number, any>} */
    const table = new Map([[100, { ppid: 1 }], [300, { ppid: 100, exe: 'C:\\x\\copilot-runtime.exe', start: started }],
      [500, { ppid: 1 }], [600, { ppid: 500, exe: '/y/copilot-runtime.exe', start: started }], [700, { ppid: 1, exe: 'notepad.exe', start: started }],
      [800, { ppid: 1, exe: 'copilot-runtime.exe', start: Date.now() }], [900, { ppid: 1, exe: '', start: started }]]);
    const cfg = { sessionStateDir: stateDir };
    lock(dir, 300);
    assert.deepEqual(sharedSessions(cfg, 100, table), [], 'one holder');
    lock(dir, 999); // a stale lock: the process is gone
    lock(dir, 700); // a reused PID running something else
    lock(dir, 800, 3600); // a lock written an hour ago, its PID reused by a runtime started now
    lock(dir, 900);
    assert.deepEqual(sharedSessions(cfg, 100, table), [], 'stale, reused and unknown PIDs do not count');
    lock(dir, 600);
    const hosts = [{ host: { pid: 500, address: 'localhost:47811' } }, { host: { address: '\\\\.\\pipe\\x' } }];
    assert.deepEqual(sharedSessions(cfg, 100, table, hosts), [{ id: SID, dir, cwd: REPO, here: [300], elsewhere: [600], elsewhereHosts: ['localhost:47811'] }]);
    assert.deepEqual(sharedSessions(cfg, 100, table)[0].elsewhereHosts, [], 'no listing: host unknown');
    assert.deepEqual(sharedSessions(cfg, 500, table).map((s) => [s.here, s.elsewhere]), [[[600], [300]]], 'seen from the other host');
    const noExe = new Map(table);
    noExe.set(300, { ...table.get(300), exe: '' });
    assert.deepEqual(sharedSessions(cfg, 100, noExe), [], 'this host\'s holder has no known executable');
    lock(other.dir, 600);
    assert.deepEqual(sharedSessions(cfg, 400, table), [], 'nothing under this host');
    assert.deepEqual(sharedSessions({ sessionStateDir: path.join(d, 'missing') }, 100, table), []);
  } finally { rm(d); }
});

test('watch: a shared session notifies once per episode, and not in a dry run', async () => {
  const d = tmpDir();
  try {
    const cfg = cfgFor({ stateDir: path.join(d, 'state') });
    const sent = [];
    const send = async (title, body) => { sent.push({ title, body }); };
    const shared = [{ id: SID, dir: d, cwd: REPO, here: [300], elsewhere: [600], elsewhereHosts: ['localhost:47811'] }];
    assert.equal((await maybeNotifyShared(cfg, logger(), { shared: [], notify: send })).state, 'ok');
    assert.equal((await maybeNotifyShared(cfg, logger(), { shared, dryRun: true, notify: send })).state, 'would-notify');
    assert.equal(sent.length, 0);
    assert.equal((await maybeNotifyShared(cfg, logger(), { shared, notify: send })).state, 'notified');
    assert.equal(sent[0].title, 'Session open in two hosts');
    assert.match(sent[0].body, /runtime 600 under localhost:47811/);
    assert.match(sent[0].body, /trims of it are refused/);
    assert.match(sent[0].body, /Your session .* Close that copy: .*restart that host/, 'this repository\'s session: close the other copy');
    const foreign = { ...shared[0], cwd: win ? 'C:\\elsewhere' : '/elsewhere' };
    const advice = sharedAdvice(cfg, foreign, 'runtime 600 under localhost:47801');
    assert.match(advice, /The copy in this host is probably the mistake: .*copilot-forever host stop, then host start/, 'another folder\'s session: close the copy here');
    assert.doesNotMatch(sent[0].body, /copilot-forever host stop/, 'never tells you to stop this host for your own session');
    const unknown = sharedAdvice(cfg, { ...shared[0], cwd: null }, 'runtime 600');
    assert.match(unknown, /folder unknown/);
    assert.doesNotMatch(unknown, /host stop|restart that host/, 'no restart advice when the folder is unknown');
    assert.equal((await maybeNotifyShared(cfg, logger(), { shared, notify: send })).state, 'already-notified');
    const again = [{ ...shared[0], elsewhere: [601] }]; // a new runtime: a new episode
    assert.equal((await maybeNotifyShared(cfg, logger(), { shared: again, notify: send })).state, 'notified');
    assert.equal(sent.length, 2);
  } finally { rm(d); }
});

test('session: idle needs an inactive host listing, a quiet log and an ended turn', () => {
  const d = tmpDir();
  try {
    const { dir, file } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const cfg = cfgFor({ watch: { quietSeconds: 120 } });
    const session = { id: SID, dir };
    const idleHost = { host: {}, sessions: [] };
    const busyHost = { host: {}, sessions: [{ workingDirectories: [vscodeFileUri(REPO)] }] };
    const old = Date.now() / 1000 - 600;
    fs.utimesSync(file, old, old);
    assert.equal(lastTurnEvent(file), 'assistant.turn_end');
    assert.equal(notIdleReason(cfg, idleHost, session), null);
    assert.match(notIdleReason(cfg, busyHost, session), /active/);
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant.turn_start', id: 'z1', parentId: 'e017', data: {} }) + '\n');
    fs.utimesSync(file, old, old);
    assert.match(notIdleReason(cfg, idleHost, session), /not ended/);
    fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
    assert.match(notIdleReason(cfg, idleHost, session), /written/);
  } finally { rm(d); }
});

test('session: a stale host status needs a busy listing, an ended turn and a long-quiet log', () => {
  const d = tmpDir();
  try {
    const { dir, file } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const cfg = cfgFor({ watch: { staleHostMinutes: 30 } });
    const session = { id: SID, dir };
    const idleHost = { host: {}, sessions: [] };
    const busyHost = { host: {}, sessions: [{ workingDirectories: [vscodeFileUri(REPO)] }] };
    const at = (minutesAgo) => { const t = Date.now() / 1000 - minutesAgo * 60; fs.utimesSync(file, t, t); };
    at(45);
    const s = staleHostStatus(cfg, busyHost, session);
    assert.ok(s && s.quietMinutes >= 44 && s.quietMinutes <= 45, JSON.stringify(s));
    assert.equal(staleHostStatus(cfg, idleHost, session), null, 'the host agrees the session is idle');
    assert.equal(staleHostStatus(cfgFor({ watch: { staleHostMinutes: 0 } }), busyHost, session), null, '0 turns it off');
    at(10);
    assert.equal(staleHostStatus(cfg, busyHost, session), null, 'not quiet long enough');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant.turn_start', id: 'z1', parentId: 'e017', data: {} }) + '\n');
    at(45);
    assert.equal(staleHostStatus(cfg, busyHost, session), null, 'a turn still open (a long tool call) is not stale');
  } finally { rm(d); }
});

test('session: a turn that ended on an ask_user question is a pending question, not a stale status', () => {
  const d = tmpDir();
  try {
    const { dir, file } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const cfg = cfgFor({ watch: { staleHostMinutes: 30 } });
    const session = { id: SID, dir };
    const busyHost = { host: {}, sessions: [{ workingDirectories: [vscodeFileUri(REPO)] }] };
    const ev = (type, data = {}) => fs.appendFileSync(file, JSON.stringify({ type, id: `q${Math.random()}`, parentId: 'e017', data }) + '\n');
    ev('assistant.turn_start');
    ev('tool.execution_start', { toolName: 'ask_user', toolCallId: 'a1' });
    ev('tool.execution_complete', { toolCallId: 'a1' });
    ev('assistant.turn_end');
    const t = Date.now() / 1000 - 3600;
    fs.utimesSync(file, t, t);
    assert.equal(lastTurnAsked(file), true);
    assert.equal(staleHostStatus(cfg, busyHost, session), null);
    ev('assistant.turn_start'); // the next turn asks nothing
    ev('tool.execution_start', { toolName: 'task_complete', toolCallId: 'a2' });
    ev('assistant.turn_end');
    fs.utimesSync(file, t, t);
    assert.equal(lastTurnAsked(file), false);
    assert.ok(staleHostStatus(cfg, busyHost, session), 'task_complete is the stale case');
  } finally { rm(d); }
});

test('watch: a stale host status notifies once per episode, and not in a dry run', async () => {
  const d = tmpDir();
  try {
    const { dir, file } = makeSession(d, 'basic.jsonl', { cwd: REPO });
    const cfg = cfgFor({ stateDir: path.join(d, 'state') });
    const session = { id: SID, dir };
    const hostInfo = { host: {}, sessions: [{ workingDirectories: [vscodeFileUri(REPO)] }] };
    const t = Date.now() / 1000 - 3600;
    fs.utimesSync(file, t, t);
    const sent = [];
    const io = { hostInfo, session, requested: true, notify: async (title, body) => { sent.push({ title, body }); } };
    assert.equal((await maybeNotifyStale(cfg, logger(), { ...io, dryRun: true })).state, 'would-notify');
    assert.equal(sent.length, 0, 'a dry run sends nothing');
    assert.equal((await maybeNotifyStale(cfg, logger(), io)).state, 'notified');
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /trim is waiting/);
    assert.match(sent[0].body, /no question or background work pending, press Stop/);
    assert.equal((await maybeNotifyStale(cfg, logger(), io)).state, 'already-notified');
    assert.equal(sent.length, 1, 'once per episode');
    fs.utimesSync(file, t + 60, t + 60); // the log moved on, then went stale again: a new episode
    assert.equal((await maybeNotifyStale(cfg, logger(), io)).state, 'notified');
    assert.equal(sent.length, 2);
    assert.equal((await maybeNotifyStale(cfg, logger(), { ...io, hostInfo: { host: {}, sessions: [] } })).state, 'ok');
  } finally { rm(d); }
});

test('host: agent ps output with the CLI\'s own log lines ahead of the JSON still parses', async () => {
  const d = tmpDir();
  try {
    const script = path.join(d, 'fake-code.mjs');
    fs.writeFileSync(script, `console.log('[2026-11-06 22:57:42] info Updating the server');\nconsole.log(JSON.stringify([{ host: { type: 'standalone', pid: 1, address: 'localhost:47801' }, sessions: [] }]));\n`);
    const cfg = cfgFor({ host: { codeCommand: [process.execPath, script] } });
    const hosts = await agentPs(cfg);
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].host.address, 'localhost:47801');
  } finally { rm(d); }
});

// ---- install --------------------------------------------------------------------------------
test('install: Task Scheduler XML is interactive, least privilege, no overlap', () => {
  const cfg = cfgFor({ watch: { intervalMinutes: 7 } });
  const x = windowsTaskXml({ kind: 'watch', cfg, node: 'C:\\node\\node.exe', userId: 'PC\\me', startBoundary: '2026-11-04T10:00:00' });
  assert.match(x, /<Interval>PT7M<\/Interval>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(x, new RegExp(`<ExecutionTimeLimit>PT${watchTimeLimitMinutes(cfg)}M`));
  assert.match(x, /<Command>[^<]*\\System32\\conhost\.exe<\/Command>/);
  assert.match(x, /<Arguments>--headless &quot;[^<]*\\powershell\.exe&quot; -NoProfile [^<]*-WindowStyle Hidden/);
  assert.match(x, /&apos;watch&apos; &apos;--config&apos;/);
  const h = windowsTaskXml({ kind: 'host', cfg, node: 'node.exe', userId: 'PC\\me', startBoundary: '' });
  assert.match(h, /<LogonTrigger>.*<Delay>PT30S<\/Delay>/s);
  // The task is the service: through the service it would trigger itself and wait out the start timeout.
  assert.match(h, /&apos;host&apos; &apos;start&apos; &apos;--direct&apos;/);
});

test('install: systemd units run the host in the foreground and the watcher on a timer', () => {
  const cfg = cfgFor();
  const u = systemdUnits({ cfg, node: '/usr/bin/node', pathEnv: '/usr/bin:/bin' });
  const host = u['copilot-forever-host.service'];
  assert.match(host, /ExecStart="\/usr\/bin\/node" ".*copilot-forever\.mjs" "host" "start" "--foreground" "--config"/);
  assert.match(host, /Restart=no/);
  assert.match(u['copilot-forever-watch.service'], /Type=oneshot/);
  assert.match(u['copilot-forever-watch.timer'], /OnUnitActiveSec=10min/);
});

test('install: launchd agents', () => {
  const p = launchdPlists({ cfg: cfgFor({ instanceName: 'mine' }), node: '/opt/node', pathEnv: '/usr/bin' });
  assert.deepEqual(Object.keys(p), ['local.mine.host.plist', 'local.mine.watch.plist']);
  assert.match(p['local.mine.host.plist'], /<string>--foreground<\/string>/);
  assert.match(p['local.mine.host.plist'], /<key>KeepAlive<\/key><false\/>/);
  assert.match(p['local.mine.watch.plist'], /<key>StartInterval<\/key><integer>600<\/integer>/);
});

test('host start: through the installed service by default, spawned here with --direct (dry run)', async () => {
  const dir = tmpDir('cf-direct-');
  try {
    const port = await freePort();
    const cfgFile = path.join(dir, 'c.json');
    fs.mkdirSync(path.join(dir, 'repo'));
    fs.writeFileSync(cfgFile, JSON.stringify({ repoFolder: path.join(dir, 'repo'), stateDir: path.join(dir, 'state'), instanceName: 'cfx', host: { port } }));
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'state', 'installed-cfx.json'), JSON.stringify({ hostService: { kind: 'schtasks', name: 'cfx host' }, watch: { kind: 'schtasks', name: 'cfx watch' } }));
    const cli = (...args) => new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'host', 'start', '--dry-run', '--config', cfgFile, ...args], { windowsHide: true },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
    });
    const viaService = await cli();
    assert.equal(viaService.code, 0, viaService.out);
    assert.match(viaService.out, /would start the host through schtasks cfx host/);
    const direct = await cli('--direct');
    assert.equal(direct.code, 0, direct.out);
    assert.match(direct.out, /would run \(clean env/);
    assert.doesNotMatch(direct.out, /through schtasks/);
  } finally { rm(dir); }
});

test('install: the marker records the schedule version doctor checks', () => {
  assert.equal(SCHEDULE_VERSION, 2);
});

// Injected stopper, port probe and lock: no schtasks call, kill or port probe happens on any OS.
const winUninstall = (log, o) => uninstall(cfgFor({ instanceName: 'mine' }), log, { platform: 'win32', listening: async () => false, ...o });
const taskLines = (log) => log.lines.map((l) => (/mine watch/.test(l) ? 'watch' : /mine host/.test(l) ? 'host' : /STOPPED/.test(l) ? 'stop' : null)).filter(Boolean);

test('uninstall (Windows): watcher task, then the host stop, then the host task', async () => {
  const calls = [];
  const log = logger();
  const stopper = async (_c, l, o) => { calls.push(o); l.info('STOPPED'); return true; };
  await winUninstall(log, { dryRun: true, stopHost: true, stopper });
  assert.deepEqual(taskLines(log), ['watch', 'stop', 'host']);
  assert.deepEqual(calls, [{ dryRun: true }]);

  // No host listed and the port closed is not a failure.
  const log2 = logger();
  await winUninstall(log2, { dryRun: true, stopHost: true, stopper: async () => null });
  assert.deepEqual(taskLines(log2), ['watch', 'host']);
  assert.ok(log2.lines.some((l) => /uninstalled\./.test(l)));

  // Without --stop-host nothing is stopped or probed.
  await winUninstall(logger(), { dryRun: true, stopper: async () => assert.fail('stopper called'), listening: async () => assert.fail('port probed') });
});

test('uninstall (Windows): every stop failure keeps the host task and says so', async () => {
  const cases = [
    { name: 'stop returns false', o: { stopper: async () => false }, re: /did not stop/ },
    { name: 'stop throws (agent ps failed)', o: { stopper: async () => { throw new Error('agent ps --json failed (exit 3)'); } }, re: /could not stop the host: agent ps --json failed/ },
    { name: 'no host listed, port still listening', o: { stopper: async () => null, listening: async () => true }, re: /still listening, but no standalone host is listed/ },
  ];
  for (const { name, o, re } of cases) {
    const log = logger();
    await assert.rejects(winUninstall(log, { dryRun: true, stopHost: true, ...o }),
      (e) => e instanceof Refusal && re.test(e.message) && /watcher task was removed; the host task "mine host" is still installed/.test(e.message), name);
    assert.deepEqual(taskLines(log), ['watch'], `${name}: host task kept`);
    assert.ok(!log.lines.some((l) => /uninstalled/.test(l)), name);
  }
});

test('uninstall (Windows): the watcher lock is refused while held and released once otherwise', async () => {
  const log = logger();
  let locked = '';
  await assert.rejects(
    winUninstall(log, { stopHost: true, lock: (f) => { locked = f; return null; }, stopper: async () => assert.fail('stopper called') }),
    (e) => e instanceof Refusal && /watcher run is in progress/.test(e.message) && /no task was changed/.test(e.message) && /watch-mine\.lock/.test(e.message),
  );
  assert.match(locked, /watch-mine\.lock$/);
  assert.deepEqual(taskLines(log), [], 'no task deleted');

  // A real (non-dry) run releases the lock once on every outcome. Task deletes are stubbed.
  const outcomes = [
    { name: 'success', stopper: async () => true, ok: true },
    { name: 'stop failed', stopper: async () => false, ok: false },
    { name: 'host task delete failed', stopper: async () => true, failHost: true, ok: false },
  ];
  for (const { name, stopper, failHost, ok } of outcomes) {
    let released = 0;
    const deleted = [];
    const deleteTask = async (t) => { if (failHost && t === 'mine host') throw new Error('schtasks failed'); deleted.push(t); };
    const p = winUninstall(logger(), { stopHost: true, stopper, deleteTask, lock: () => () => { released++; } });
    if (ok) await p;
    else await assert.rejects(p, (e) => e instanceof Refusal && /host task "mine host" is still installed/.test(e.message), name);
    assert.equal(released, 1, `${name}: lock released once`);
    assert.deepEqual(deleted, ok ? ['mine watch', 'mine host'] : ['mine watch'], name);
  }

  // A dry run takes no lock (it changes nothing a watcher run could undo).
  await winUninstall(logger(), { dryRun: true, stopHost: true, stopper: async () => true, lock: () => assert.fail('lock taken') });
});

// ---- notify ---------------------------------------------------------------------------------
test('notify: per-OS commands escape their text', () => {
  const [ps, args] = notifyCommand('win32', `a <b> & 'c'`, 'body');
  assert.match(ps, /powershell\.exe$/);
  const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
  assert.match(script, /<text>a &lt;b&gt; &amp; &apos;c&apos;<\/text>/);  assert.deepEqual(notifyCommand('darwin', 'T "x"', 'B'), ['osascript', ['-e', 'display notification "B" with title "T \\"x\\""']]);
  assert.equal(notifyCommand('linux', 'T', 'B')[0], 'notify-send');
  assert.equal(notifyCommand('aix', 'T', 'B'), null);
});

test('proc: ps etime values and process start times', async () => {
  assert.equal(etimeSeconds('05'), NaN);
  assert.equal(etimeSeconds('01:05'), 65);
  assert.equal(etimeSeconds('2:01:05'), 7265);
  assert.equal(etimeSeconds('3-02:01:05'), 3 * 86400 + 7265);
  const me = (await processTable()).get(process.pid);
  assert.ok(me && me.start <= Date.now() + 1000 && me.start > Date.now() - 3600000, JSON.stringify(me));
});
