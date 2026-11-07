import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { analyze, fmtMs, gitChanges, parseShortstat, readSessionEvents, renderMarkdown, sessionFiles, summarizeChanges } from '../src/report.mjs';
import { Refusal } from '../src/util.mjs';
import { BIN, rm, tmpDir } from './helpers.mjs';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60000;
let n = 0;
/** One log event at `min` minutes after T0. */
const ev = (min, type, data = {}, agentId = undefined) => ({
  type, data, id: `e${++n}`, timestamp: new Date(T0 + min * MIN).toISOString(), parentId: null, ...(agentId ? { agentId } : {}),
});
const write = (file, events) => fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

// A 100-minute session: plan (Architect 0-20), wait for approval (25-40), Builder (45-75)
// with a sub-tool run, a Diff Reviewer (80-90), an ask_user question (92-95), stop at 100.
function sample() {
  n = 0;
  return [
    ev(0, 'session.start', { sessionId: 'S1', copilotVersion: '9.9.9' }),
    ev(0, 'user.message', { content: 'start', delivery: 'idle' }),
    ev(0, 'subagent.started', { toolCallId: 'c1', agentDisplayName: 'Architect', model: 'm-a', executionMode: 'sync' }, 'A1'),
    ev(0, 'subagent.configured', { model: 'm-a', reasoningEffort: 'max' }, 'A1'),
    ev(0, 'user.message', { content: 'Task: **intake**\nmore lines', delivery: 'immediate' }, 'A1'),
    ev(10, 'session.usage_record', { usage: { duration: 8 * MIN, outputTokens: 100, model: 'm-a' } }, 'A1'),
    ev(20, 'subagent.completed', { toolCallId: 'c1', durationMs: 20 * MIN, totalToolCalls: 5, totalTokens: 2_000_000 }, 'A1'),
    ev(22, 'session.usage_record', { usage: { duration: 2 * MIN, outputTokens: 10 } }),
    ev(25, 'session.task_complete', { summary: 'plan ready' }),
    ev(25, 'session.usage_checkpoint', { totalNanoAiu: 100e9, totalPremiumRequests: 1 }),
    ev(40, 'user.message', { content: 'APPROVE PLAN', delivery: 'idle' }),
    ev(45, 'session.usage_record', { usage: { duration: 5 * MIN, outputTokens: 0 } }), // the Orchestrator thinking 40-45
    ev(45, 'subagent.started', { toolCallId: 'c2', agentDisplayName: 'Builder', model: 'm-b', executionMode: 'sync' }, 'B1'),
    ev(45, 'subagent.configured', { model: 'm-b', reasoningEffort: 'high' }, 'B1'),
    ev(45, 'user.message', { content: 'Implement issue #1 | with a pipe' }, 'B1'),
    ev(50, 'tool.execution_start', { toolCallId: 't1', toolName: 'powershell' }, 'B1'),
    ev(54, 'tool.execution_complete', { toolCallId: 't1' }, 'B1'),
    ev(70, 'session.usage_record', { usage: { duration: 20 * MIN, outputTokens: 1000 } }, 'B1'),
    ev(75, 'subagent.completed', { toolCallId: 'c2', durationMs: 30 * MIN, totalToolCalls: 40, totalTokens: 5_000_000 }, 'B1'),
    ev(76, 'tool.execution_start', { toolCallId: 't2', toolName: 'powershell' }),
    ev(78, 'tool.execution_complete', { toolCallId: 't2' }),
    ev(80, 'subagent.started', { toolCallId: 'c3', agentDisplayName: 'Diff Reviewer', model: 'm-r', executionMode: 'sync' }, 'R1'),
    ev(80, 'subagent.configured', { model: 'm-r', reasoningEffort: 'max' }, 'R1'),
    ev(90, 'subagent.completed', { toolCallId: 'c3', durationMs: 10 * MIN, totalToolCalls: 9, totalTokens: 900_000 }, 'R1'),
    ev(92, 'tool.execution_start', { toolCallId: 't3', toolName: 'ask_user' }),
    ev(95, 'tool.execution_complete', { toolCallId: 't3' }),
    ev(96, 'assistant.turn_end', {}),
    ev(97, 'session.shutdown', { accountingSnapshot: { totalNanoAiu: 250e9, totalPremiumRequestCost: 2 } }),
    ev(99, 'session.resume', {}),
    ev(100, 'assistant.turn_end', {}),
  ];
}

test('report: buckets, per-run and per-role figures, read through the real log reader', async () => {
  const dir = tmpDir('cf-report-');
  try {
    const file = path.join(dir, 'events.jsonl');
    write(file, sample());
    const { events, unreadable } = await readSessionEvents([file]);
    assert.equal(unreadable, 0);
    const r = analyze(events);
    assert.equal(r.spanMs, 100 * MIN);
    // agents: 0-20, 45-75, 80-90 = 60; waiting: 25-40 and 92-95 = 18; stopped 97-99 = 2; the rest 20 (40-45 is a model call, so not quiet).
    assert.deepEqual(r.buckets, { agents: 60 * MIN, waiting: 18 * MIN, background: 0, quiet: 0, stopped: 2 * MIN, orchestrator: 20 * MIN });
    assert.equal(Object.values(r.buckets).reduce((a, b) => a + b), r.spanMs, 'buckets add up to the span');
    assert.equal(r.waits, 2);
    assert.equal(r.sessionId, 'S1');
    assert.equal(r.version, '9.9.9');
    assert.deepEqual(r.runs.map((x) => [x.name, x.wallMs / MIN, x.modelMs / MIN, x.toolMs / MIN, x.effort, x.model, x.task]), [
      ['Architect', 20, 8, 0, 'max', 'm-a', 'Task: **intake**'],
      ['Builder', 30, 20, 4, 'high', 'm-b', 'Implement issue #1 | with a pipe'],
      ['Diff Reviewer', 10, 0, 0, 'max', 'm-r', ''],
    ]);
    const orch = r.roles.find((x) => x.name.startsWith('Orchestrator'));
    assert.equal(orch.wallMs, 20 * MIN);
    assert.equal(orch.modelMs, 7 * MIN);
    assert.equal(orch.toolMs, 2 * MIN, 'ask_user is waiting, not tool time');
    assert.equal(r.reviewRuns, 1);
    assert.deepEqual(r.usage, { premiumRequests: 2, aiUnits: 250, modelApiMs: 35 * MIN, outputTokens: 1110 });

    const md = renderMarkdown(r, { source: [file] });
    assert.match(md, /\| Agents working \(subagents\) \| 1h00m \| 60% \|/);
    assert.match(md, /\| Waiting for a message or an answer, from you or the watcher \(2 times\) \| 18m \| 18% \|/);
    assert.match(md, /\| Session stopped \| 2m \| 2% \|/);
    assert.match(md, /\| Builder \| 1 \| 30m \| 20m \| 4m \| 0s \| 5\.0M \| high \| m-b \|/);
    assert.match(md, /Implement issue #1 \\\| with a pipe/, 'pipes in task text are escaped');
    assert.match(md, /AI units .*: 250\.0/);
  } finally { rm(dir); }
});

test('report: archives and the current log merge without double counting; bad lines are skipped', async () => {
  const dir = tmpDir('cf-report-');
  try {
    const all = sample();
    const arch = path.join(dir, 'archive.jsonl');
    const cur = path.join(dir, 'events.jsonl');
    write(arch, all.slice(0, 20)); // the archive: everything up to the trim
    // The trimmed log: overlaps the archive from event 15 on, and ends in a torn line.
    fs.writeFileSync(cur, all.slice(15).map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"assistant.turn_end","data"');
    const { events, unreadable } = await readSessionEvents([arch, cur]);
    assert.equal(unreadable, 1);
    const r = analyze(events);
    assert.equal(r.runs.length, 3);
    assert.equal(r.spanMs, 100 * MIN);
    assert.deepEqual(r.buckets, { agents: 60 * MIN, waiting: 18 * MIN, background: 0, quiet: 0, stopped: 2 * MIN, orchestrator: 20 * MIN });
  } finally { rm(dir); }
});

test('report: a subagent still running at the end of the log, and an empty log', async () => {
  const dir = tmpDir('cf-report-');
  try {
    n = 0;
    const file = path.join(dir, 'events.jsonl');
    write(file, [
      ev(0, 'session.start', { sessionId: 'S2' }),
      ev(1, 'subagent.started', { toolCallId: 'c1', agentDisplayName: 'Builder' }, 'B1'),
      ev(11, 'assistant.turn_end', {}, 'B1'),
    ]);
    const r = analyze((await readSessionEvents([file])).events);
    assert.equal(r.runs[0].status, 'running');
    assert.equal(r.runs[0].wallMs, 10 * MIN);
    assert.match(renderMarkdown(r), /Builder \(running\)/);
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    assert.throws(() => analyze([]), Refusal);
  } finally { rm(dir); }
});

test('report: silence with nothing running is quiet; runs named per task group under their agent type', async () => {
  const dir = tmpDir('cf-report-');
  try {
    n = 0;
    const file = path.join(dir, 'events.jsonl');
    write(file, [
      ev(0, 'session.start', { sessionId: 'S3' }),
      ev(0, 'subagent.started', { toolCallId: 'c1', agentType: 'Diff Reviewer', agentName: 'Diff Reviewer', agentDisplayName: 'bf1-review-r1', executionMode: 'background' }, 'R1'),
      ev(10, 'subagent.completed', { toolCallId: 'c1', durationMs: 10 * MIN }, 'R1'),
      ev(11, 'tool.execution_start', { toolCallId: 't1', toolName: 'powershell' }),
      ev(30, 'tool.execution_complete', { toolCallId: 't1' }), // a 19-minute tool run is not idle
      ev(31, 'assistant.turn_end', {}),
      ev(51, 'assistant.message', {}), // 20 silent minutes with nothing running: idle
      ev(52, 'subagent.started', { toolCallId: 'c2', agentType: 'Diff Reviewer', agentDisplayName: 'bf1-review-r2' }, 'R2'),
      ev(53, 'session.usage_record', { usage: { duration: 0 } }), // keeps the Builder's silence below from counting
      ev(60, 'subagent.completed', { toolCallId: 'c2', durationMs: 8 * MIN }, 'R2'),
      ev(61, 'assistant.turn_end', {}),
    ]);
    const r = analyze((await readSessionEvents([file])).events);
    assert.deepEqual(r.buckets, { agents: 18 * MIN, waiting: 0, background: 0, quiet: 20 * MIN, stopped: 0, orchestrator: 23 * MIN });
    assert.deepEqual(r.runs.map((x) => [x.name, x.role, x.mode]), [['bf1-review-r1', 'Diff Reviewer', 'background'], ['bf1-review-r2', 'Diff Reviewer', null]]);
    assert.deepEqual(r.roles.map((x) => [x.name, x.runs]), [['Diff Reviewer', 2], ['Orchestrator (top level)', null]]);
    assert.equal(r.reviewRuns, 2);
    assert.match(renderMarkdown(r), /\| Quiet: 5\+ min with nothing in the log explaining it \(often a stall\) \| 20m \| 33% \|/);
  } finally { rm(dir); }
});

test('report: session lookup by id, folder or file, plus trim archives', () => {
  const dir = tmpDir('cf-report-');
  try {
    const cfg = { sessionStateDir: path.join(dir, 'state'), trim: { archiveDir: path.join(dir, 'arch') }, repoFolder: path.join(dir, 'repo'), files: { status: path.join(dir, 'status.json') } };
    const sdir = path.join(cfg.sessionStateDir, 'S1');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'events.jsonl'), '');
    fs.mkdirSync(path.join(cfg.trim.archiveDir, 'S1'), { recursive: true });
    for (const a of ['events-20260102T000000Z.jsonl', 'events-20260101T000000Z.jsonl', 'notes.txt']) fs.writeFileSync(path.join(cfg.trim.archiveDir, 'S1', a), '');
    const want = [
      path.join(cfg.trim.archiveDir, 'S1', 'events-20260101T000000Z.jsonl'),
      path.join(cfg.trim.archiveDir, 'S1', 'events-20260102T000000Z.jsonl'),
      path.join(sdir, 'events.jsonl'),
    ];
    assert.deepEqual(sessionFiles(cfg, 'S1'), want, 'by id: archives oldest first, then the live log');
    assert.deepEqual(sessionFiles(cfg, sdir), want, 'by folder');
    // Without a config, archives come from <COPILOT_HOME>/session-archive.
    const home = process.env.COPILOT_HOME;
    try {
      process.env.COPILOT_HOME = path.join(dir, 'nohome');
      assert.deepEqual(sessionFiles(null, path.join(sdir, 'events.jsonl')), [path.join(sdir, 'events.jsonl')], 'by file, no config, no archives');
      fs.mkdirSync(path.join(dir, 'nohome', 'session-archive', 'S1'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nohome', 'session-archive', 'S1', 'events-1.jsonl'), '');
      assert.deepEqual(sessionFiles(null, path.join(sdir, 'events.jsonl')),
        [path.join(dir, 'nohome', 'session-archive', 'S1', 'events-1.jsonl'), path.join(sdir, 'events.jsonl')], 'by file, no config, default archives');
    } finally {
      if (home === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = home;
    }
    // No --session: the status file's session, else the newest session whose workspace is the repo.
    fs.writeFileSync(cfg.files.status, JSON.stringify({ session_id: 'S1' }));
    assert.deepEqual(sessionFiles(cfg), want);
    fs.rmSync(cfg.files.status);
    assert.throws(() => sessionFiles(cfg), /no session found/);
    fs.writeFileSync(path.join(sdir, 'workspace.yaml'), `cwd: ${JSON.stringify(cfg.repoFolder)}\n`);
    assert.deepEqual(sessionFiles(cfg), want);
    assert.throws(() => sessionFiles(cfg, 'NOPE'), /no session log/);
    assert.throws(() => sessionFiles(null, 'NOPE'), Refusal);
  } finally { rm(dir); }
});

test('report: autopilot nudges, background shells, sleeps, compaction and a tool cut off by a shutdown', async () => {
  const dir = tmpDir('cf-report-');
  try {
    n = 0;
    const file = path.join(dir, 'events.jsonl');
    write(file, [
      ev(0, 'session.start', { sessionId: 'S4' }),
      ev(1, 'assistant.turn_end', {}),
      ev(10, 'user.message', { content: '', delivery: 'idle', source: 'autopilot' }), // 1-10: not a wait; quiet
      ev(10, 'tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'Start-Sleep -Seconds 270; "wake"', mode: 'async', shellId: 'wd-1' } }),
      ev(10, 'tool.execution_complete', { toolCallId: 't1' }),
      ev(30, 'system.notification', { kind: { type: 'shell_completed', shellId: 'wd-1' } }), // 10-30: background
      ev(31, 'tool.execution_start', { toolCallId: 't2', toolName: 'powershell', arguments: { command: 'Start-Sleep -Seconds 540' } }),
      ev(40, 'tool.execution_complete', { toolCallId: 't2' }), // 31-40: a sleep, background, not tool time
      ev(41, 'session.compaction_start', {}),
      ev(60, 'session.compaction_complete', {}), // 41-60: busy (orchestrator), not quiet
      ev(61, 'tool.execution_start', { toolCallId: 't3', toolName: 'powershell', arguments: { command: 'npm test' } }),
      ev(62, 'session.shutdown', {}),
      ev(63, 'session.resume', {}), // t3 never completes; the resume clears it
      ev(64, 'assistant.turn_end', {}),
      ev(80, 'assistant.turn_end', {}), // 64-80: quiet again, despite t3
    ]);
    const r = analyze((await readSessionEvents([file])).events);
    assert.equal(r.waits, 0, 'an autopilot nudge is not a wait');
    assert.deepEqual(r.buckets, { agents: 0, waiting: 0, background: 29 * MIN, quiet: 25 * MIN, stopped: 1 * MIN, orchestrator: 25 * MIN });
    const orch = r.roles.find((x) => x.name.startsWith('Orchestrator'));
    assert.equal(orch.sleepMs, 9 * MIN);
    assert.equal(orch.toolMs, 0, 'the async start returns at once; the sleep is not tool time');
    assert.match(renderMarkdown(r), /\| Waiting on background commands or sleeps \| 29m \| 36% \|/);
  } finally { rm(dir); }
});

test('report: a shell with no completion counts only until last touched; a running subagent outranks a wait', async () => {
  const dir = tmpDir('cf-report-');
  try {
    n = 0;
    const file = path.join(dir, 'events.jsonl');
    write(file, [
      ev(0, 'session.start', { sessionId: 'S5' }),
      ev(0, 'tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'npm run build', mode: 'async', shellId: 's1' } }),
      ev(0, 'tool.execution_complete', { toolCallId: 't1' }),
      ev(3, 'tool.execution_start', { toolCallId: 't2', toolName: 'read_powershell', arguments: { shellId: 's1' } }),
      ev(3, 'tool.execution_complete', { toolCallId: 't2' }),
      ev(63, 'assistant.turn_end', {}), // s1 never reports done: background 0-3, then 60 quiet minutes
      // A background reviewer runs 70-90; the watcher's continue at 96 ends a wait from 64.
      ev(64, 'assistant.turn_end', {}),
      ev(70, 'subagent.started', { toolCallId: 'c1', agentType: 'Diff Reviewer', executionMode: 'background' }, 'R1'),
      ev(71, 'tool.execution_start', { toolCallId: 't3', toolName: 'powershell', arguments: { command: 'git diff' } }, 'R1'),
      ev(90, 'subagent.failed', { toolCallId: 'c1' }, 'R1'), // its tool never completes; the failure clears it
      ev(96, 'user.message', { content: 'Continue.', delivery: 'idle' }),
      ev(120, 'assistant.turn_end', {}), // 96-120 quiet again: t3 no longer holds it open
    ]);
    const r = analyze((await readSessionEvents([file])).events);
    assert.deepEqual(r.buckets, { agents: 20 * MIN, waiting: 12 * MIN, background: 3 * MIN, quiet: 84 * MIN, stopped: 0, orchestrator: 1 * MIN });
    assert.equal(Object.values(r.buckets).reduce((a, b) => a + b), r.spanMs);
  } finally { rm(dir); }
});

test('report: a wait outranks a background shell; an id reused by a sync command; subagents cut off by a shutdown', async () => {
  const dir = tmpDir('cf-report-');
  try {
    n = 0;
    const file = path.join(dir, 'events.jsonl');
    write(file, [
      ev(0, 'session.start', { sessionId: 'S6' }),
      ev(0, 'tool.execution_start', { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'Start-Sleep 1200', mode: 'async', shellId: 'wd' } }),
      ev(0, 'tool.execution_complete', { toolCallId: 't1' }),
      ev(1, 'assistant.turn_end', {}),
      ev(15, 'user.message', { content: 'go on', delivery: 'idle' }), // 1-15 waiting, though wd runs
      ev(20, 'system.notification', { kind: { type: 'shell_completed', shellId: 'wd' } }), // 15-20 background
      // A shell read at 21, then its id reused by a synchronous command at 300: it ended at 21.
      ev(20, 'tool.execution_start', { toolCallId: 't2', toolName: 'powershell', arguments: { command: 'npm test', mode: 'async', shellId: 'g' } }),
      ev(20, 'tool.execution_complete', { toolCallId: 't2' }),
      ev(21, 'tool.execution_start', { toolCallId: 't3', toolName: 'read_powershell', arguments: { shellId: 'g' } }),
      ev(21, 'tool.execution_complete', { toolCallId: 't3' }),
      ev(22, 'subagent.started', { toolCallId: 'c1', agentType: 'Builder', executionMode: 'background' }, 'B1'),
      ev(30, 'assistant.turn_end', {}, 'B1'),
      ev(35, 'session.shutdown', {}),
      ev(40, 'session.resume', {}), // B1 never completes: it ends at its last event, 30
      ev(41, 'tool.execution_start', { toolCallId: 't4', toolName: 'powershell', arguments: { command: 'git status', shellId: 'g' } }),
      ev(41, 'tool.execution_complete', { toolCallId: 't4' }),
      ev(60, 'assistant.turn_end', {}),
    ]);
    const r = analyze((await readSessionEvents([file])).events);
    // background: wd 0-1 (before the wait) and 15-20, g 20-21; quiet: 30-35 and 41-60; orchestrator: 21-22, 40-41.
    assert.deepEqual(r.buckets, { agents: 8 * MIN, waiting: 14 * MIN, background: 7 * MIN, quiet: 24 * MIN, stopped: 5 * MIN, orchestrator: 2 * MIN });
    assert.equal(Object.values(r.buckets).reduce((a, b) => a + b), r.spanMs);
    assert.deepEqual(r.runs.map((x) => [x.status, x.wallMs / MIN]), [['cut off', 8]]);
  } finally { rm(dir); }
});

test('report: duration format', () => {
  assert.deepEqual([fmtMs(null), fmtMs(4400), fmtMs(29.6 * MIN), fmtMs(60 * MIN), fmtMs(215 * MIN)], ['–', '4s', '30m', '1h00m', '3h35m']);
});

test('report CLI: --session with a path needs no config; --json and --out', async () => {
  const dir = tmpDir('cf-report-');
  try {
    const file = path.join(dir, 'events.jsonl');
    write(file, sample());
    const cli = (...args) => new Promise((resolve) => {
      // A home with no ~/.copilot-forever/config.json, so the no-config path really runs.
      execFile(process.execPath, [BIN, 'report', '--session', file, ...args], { cwd: dir, env: { ...process.env, COPILOT_FOREVER_CONFIG: path.join(dir, 'none.json'), HOME: dir, USERPROFILE: dir, COPILOT_HOME: path.join(dir, 'ch') }, windowsHide: true },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    const md = await cli();
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Goal-loop timing report/);
    const js = await cli('--json');
    assert.equal(js.code, 0, js.stderr);
    assert.equal(JSON.parse(js.stdout).buckets.agents, 60 * MIN);
    const out = path.join(dir, 'report.md');
    const w = await cli('--out', out);
    assert.equal(w.code, 0, w.stderr);
    assert.equal(w.stdout, '');
    assert.match(fs.readFileSync(out, 'utf8'), /## By role/);
  } finally { rm(dir); }
});

test('report: commit sizes parsed from git log --shortstat, with median and largest', () => {
  const text = ['@@aaa', '', ' 2 files changed, 10 insertions(+), 3 deletions(-)', '@@bbb', '', ' 1 file changed, 1 insertion(+)', '@@ccc', '@@ddd', '', ' 1 file changed, 4 deletions(-)'].join('\n');
  const commits = parseShortstat(text);
  assert.deepEqual(commits.map((c) => [c.sha, c.files, c.added, c.removed]), [['aaa', 2, 10, 3], ['bbb', 1, 1, 0], ['ccc', 0, 0, 0], ['ddd', 1, 0, 4]]);
  assert.deepEqual(summarizeChanges(commits), { commits: 4, files: 4, added: 11, removed: 7, medianLines: 2.5, largestLines: 13 });
  assert.deepEqual(summarizeChanges([]), { commits: 0, files: 0, added: 0, removed: 0, medianLines: null, largestLines: null });
});

test('report: changes come from the repository: the span, the committer, deleted branches, merges, a subfolder; none outside a repo', async () => {
  const dir = tmpDir('cf-report-git-');
  try {
    const at = (iso, email = 'loop@example.com') => ({ ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'x', GIT_AUTHOR_NAME: 'x' });
    const git = (env, ...a) => execFileSync('git', ['-C', dir, ...a], { env, stdio: 'pipe', windowsHide: true });
    const commit = (iso, file, lines, email) => {
      fs.writeFileSync(path.join(dir, file), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n');
      git(at(iso, email), 'add', file);
      git(at(iso, email), 'commit', '-q', '-m', file);
    };
    git(process.env, 'init', '-q', '-b', 'main');
    git(process.env, 'config', 'user.email', 'loop@example.com');
    git(process.env, 'config', 'user.name', 'x');
    commit('2026-01-01T00:00:00Z', 'before.txt', 50); // before the span
    commit('2026-01-02T01:00:00Z', 'a.txt', 3);
    commit('2026-01-02T02:00:00Z', 'b.txt', 7, 'noreply@github.com'); // another committer (a squash merge)
    commit('2026-01-02T02:30:00Z', 'e.txt', 9, 'loop@exampleXcom'); // matches only if the email were a regex
    git(process.env, 'checkout', '-q', '-b', 'feat');
    commit('2026-01-02T03:00:00Z', 'c.txt', 5);
    git(process.env, 'checkout', '-q', 'main');
    git(process.env, 'branch', '-q', '-D', 'feat'); // deleted after merging: still in the reflog
    fs.mkdirSync(path.join(dir, 'sub'));
    commit('2026-01-02T04:00:00Z', 'sub/d.txt', 4);
    git(process.env, 'checkout', '-q', '-b', 'm');
    commit('2026-01-02T05:00:00Z', 'm.txt', 2);
    git(process.env, 'checkout', '-q', 'main');
    git(at('2026-01-02T06:00:00Z'), 'merge', '-q', '--no-ff', '-m', 'merge m', 'm'); // the merge commit is left out
    const span = ['2026-01-02T00:00:00Z', '2026-01-02T23:00:00Z'];
    const c = gitChanges(dir, ...span);
    assert.equal(c.committer, 'loop@example.com');
    assert.deepEqual([c.commits, c.files, c.added, c.removed, c.medianLines, c.largestLines], [4, 4, 14, 0, 3.5, 5]);
    const sub = gitChanges(path.join(dir, 'sub'), ...span); // a folder inside the repository: its own changes only
    assert.deepEqual([sub.commits, sub.added], [1, 4]);
    const plain = tmpDir('cf-report-nogit-');
    try { assert.equal(gitChanges(plain, ...span), null); } finally { rm(plain); }

    const log = path.join(dir, 'events.jsonl');
    write(log, sample());
    const r = { ...analyze((await readSessionEvents([log])).events), changes: c };
    const md = renderMarkdown(r);
    assert.match(md, /## Changes\n\n- Commits: 4, 4 file changes, \+14 −0 lines\n- Lines changed per commit \(added plus removed\): median 3\.5, largest 5\n- Diff Reviewer runs in the session per commit counted here: 0\.3/);
    assert.match(md, /whose committer is loop@example\.com/);
    assert.match(renderMarkdown({ ...r, changes: { ...c, commits: 0 } }), /No commits by loop@example\.com in this span\./);
    assert.match(renderMarkdown({ ...r, changes: { ...c, committer: null } }), /from any committer/);
    assert.match(renderMarkdown({ ...r, changes: { repo: dir, error: 'boom' } }), /## Changes\n\nUnavailable: git failed in `[^`]+`: boom/);
    assert.doesNotMatch(renderMarkdown({ ...r, changes: null }), /## Changes/);

    // git fails in a repository: the section says why instead of disappearing.
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'broken'), 'deadbeef'.repeat(5) + '\n');
    const bad = gitChanges(dir, ...span);
    assert.match(bad.error, /bad object|broken/);
    assert.match(renderMarkdown({ ...r, changes: bad }), /Unavailable: git failed in/);
    fs.rmSync(path.join(dir, '.git', 'refs', 'heads', 'broken'));
    // git cannot run at all: an error too, not "not a repository".
    assert.ok(gitChanges(dir, ...span, { ...process.env, PATH: path.join(dir, 'no-such-bin'), Path: path.join(dir, 'no-such-bin') })?.error);
    assert.equal(gitChanges(path.join(dir, '.git'), ...span), null); // inside .git: no work tree
    assert.ok(gitChanges(path.join(dir, 'missing'), ...span)?.error); // a configured folder that is gone
  } finally { rm(dir); }
});
