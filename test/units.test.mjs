import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { continueMessage, resolveConfig, validate, DEFAULTS } from '../src/config.mjs';
import { activeRepoSessions, cleanEnv, findStandaloneHost, hostArgs, maskTokenInFile } from '../src/host.mjs';
import { launchdPlists, systemdUnits, watchTimeLimitMinutes, windowsTaskXml } from '../src/install.mjs';
import { addSecret, redact } from '../src/log.mjs';
import { notifyCommand } from '../src/notify.mjs';
import { descendants, isDescendant, isListening, pidAlive } from '../src/proc.mjs';
import { checkSchema, parseEvents } from '../src/schema.mjs';
import { findSession, lastTurnEvent, notIdleReason, workspaceCwd } from '../src/session.mjs';
import { uriToPath, vscodeFileUri } from '../src/util.mjs';
import { fixtureEvents, fixtureText, makeSession, rm, SID, tmpDir } from './helpers.mjs';

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

// ---- install --------------------------------------------------------------------------------
test('install: Task Scheduler XML is interactive, least privilege, no overlap', () => {
  const cfg = cfgFor({ watch: { intervalMinutes: 7 } });
  const x = windowsTaskXml({ kind: 'watch', cfg, node: 'C:\\node\\node.exe', userId: 'PC\\me', startBoundary: '2026-11-04T10:00:00' });
  assert.match(x, /<Interval>PT7M<\/Interval>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(x, new RegExp(`<ExecutionTimeLimit>PT${watchTimeLimitMinutes(cfg)}M`));
  assert.match(x, /-WindowStyle Hidden/);
  assert.match(x, /&apos;watch&apos; &apos;--config&apos;/);
  const h = windowsTaskXml({ kind: 'host', cfg, node: 'node.exe', userId: 'PC\\me', startBoundary: '' });
  assert.match(h, /<LogonTrigger>.*<Delay>PT30S<\/Delay>/s);
  assert.match(h, /&apos;host&apos; &apos;start&apos;/);
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

// ---- notify ---------------------------------------------------------------------------------
test('notify: per-OS commands escape their text', () => {
  const [ps, args] = notifyCommand('win32', `a <b> & 'c'`, 'body');
  assert.match(ps, /powershell\.exe$/);
  const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
  assert.match(script, /<text>a &lt;b&gt; &amp; &apos;c&apos;<\/text>/);  assert.deepEqual(notifyCommand('darwin', 'T "x"', 'B'), ['osascript', ['-e', 'display notification "B" with title "T \\"x\\""']]);
  assert.equal(notifyCommand('linux', 'T', 'B')[0], 'notify-send');
  assert.equal(notifyCommand('aix', 'T', 'B'), null);
});
