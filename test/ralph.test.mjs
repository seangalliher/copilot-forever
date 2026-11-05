import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { approvePlan, changes, copilotArgs, nextPhase, planApproved, promptText, ralphLoop } from '../src/ralph.mjs';
import { resolveGoalLoopConfig } from '../src/goal-loop.mjs';
import { BIN, ROOT, logger, rm, tmpDir } from './helpers.mjs';

const FAKE_COPILOT = path.join(ROOT, 'test', 'fake-copilot.mjs');
const FAKE_GH = path.join(ROOT, 'test', 'fake-gh.mjs');

/** A repo folder with .goal-loop/config.json wired to the fake copilot and gh. */
function setup({ ralph = {}, caps = {}, github = {}, state = {} } = {}) {
  const repo = tmpDir('cf-ralph-');
  const stateFile = path.join(repo, 'fake-state.json');
  fs.mkdirSync(path.join(repo, '.goal-loop'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.goal-loop', 'handoff.md'), '# Handoff\n');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: [], prs: [], ...state }));
  fs.writeFileSync(path.join(repo, '.goal-loop', 'config.json'), JSON.stringify({
    caps, github,
    ralph: {
      copilotCommand: [process.execPath, FAKE_COPILOT, '--state', stateFile],
      ghCommand: [process.execPath, FAKE_GH, '--state', stateFile],
      pauseSeconds: 0,
      iterationTimeoutMinutes: 2,
      ...ralph,
    },
  }));
  const st = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...st(), ...patch }));
  const runs = () => fs.readFileSync(path.join(repo, '.goal-loop', 'ralph', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { repo, st, setState, runs };
}

test('ralph: plan, human approval, file issues, one batch per run until the queue is empty', async () => {
  const { repo, st, runs } = setup();
  try {
    let r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.iterations, 1);
    assert.match(r.stop, /waiting for plan approval/);
    assert.ok(fs.existsSync(path.join(repo, '.goal-loop', 'PLAN.md')));
    assert.equal(st().issues.length, 0, 'nothing filed before approval');

    approvePlan(repo, logger());
    assert.ok(planApproved(repo));
    r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.exitCode, 0);
    assert.match(r.stop, /queue done: every goal-loop issue is closed/);
    assert.equal(r.iterations, 4, 'file + 3 batches');
    assert.ok(st().issues.every((i) => i.state === 'CLOSED'));

    const log = runs();
    assert.deepEqual(log.map((e) => e.phase), ['plan', 'file', 'batch', 'batch', 'batch']);
    assert.deepEqual(log[2].issuesTouched, [1]);
    assert.deepEqual(log[2].prsTouched, [101]);
    assert.ok(log.every((e) => e.exitCode === 0 && e.progress && e.startedAt && e.endedAt));
    assert.equal(log[4].openAfter, 0);

    const call = st().calls[2].args;
    const at = (f) => call[call.indexOf(f) + 1];
    assert.equal(at('--agent'), 'Goal Orchestrator');
    assert.equal(at('--model'), 'claude-sonnet-5.5');
    assert.equal(at('--reasoning-effort'), 'high');
    for (const f of ['--allow-all-tools', '--no-ask-user', '--no-auto-update', '--deny-tool=shell(gh pr merge)', '--deny-tool=shell(gh repo delete)']) assert.ok(call.includes(f), f);
    assert.match(at('-p'), /^Ralph mode: read \.goal-loop\/ralph\/run-\d{3}-batch-\S+\.prompt\.md and follow it exactly\.$/);
    assert.ok(st().calls.every((c) => !c.envHasClaudeCode));
  } finally { rm(repo); }
});

test('ralph: editing the plan after approval needs a new approval', async () => {
  const { repo } = setup();
  try {
    fs.writeFileSync(path.join(repo, '.goal-loop', 'PLAN.md'), '# Plan v1\n');
    approvePlan(repo, logger());
    fs.appendFileSync(path.join(repo, '.goal-loop', 'PLAN.md'), 'one more issue\n');
    assert.equal(planApproved(repo), false);
    const r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.iterations, 0);
    assert.match(r.stop, /waiting for plan approval/);
  } finally { rm(repo); }
});

test('ralph: the stall guard stops after N runs without progress', async () => {
  const issues = [{ number: 1, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: 't0' }];
  const { repo, runs } = setup({ state: { issues, behavior: 'stall' }, ralph: { stallLimit: 2 } });
  try {
    const r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.exitCode, 1);
    assert.match(r.stop, /stalled: 2 runs in a row/);
    assert.equal(r.iterations, 2);
    assert.ok(runs().every((e) => e.progress === false));
  } finally { rm(repo); }
});

test('ralph: a failing run counts toward the stall guard and its exit code is logged', async () => {
  const issues = [{ number: 1, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: 't0' }];
  const { repo, runs } = setup({ state: { issues, behavior: 'fail' }, ralph: { stallLimit: 1 } });
  try {
    const r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.exitCode, 1);
    assert.equal(runs()[0].exitCode, 1);
  } finally { rm(repo); }
});

test('ralph: the STOP file and the caps stop the loop', async () => {
  const issues = [1, 2, 3].map((n) => ({ number: n, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: 't0' }));
  const a = setup({ state: { issues }, caps: { maxBatchesPerRun: 1 } });
  try {
    const r = await ralphLoop({ repo: a.repo, log: logger() });
    assert.equal(r.iterations, 1);
    assert.match(r.stop, /cap: 1 batch runs/);
    fs.writeFileSync(path.join(a.repo, '.goal-loop', 'STOP'), '');
    const r2 = await ralphLoop({ repo: a.repo, log: logger() });
    assert.equal(r2.iterations, 0);
    assert.match(r2.stop, /stop file/);
  } finally { rm(a.repo); }
  const b = setup({ state: { issues } });
  try {
    const r = await ralphLoop({ repo: b.repo, log: logger(), maxIterations: 2 });
    assert.equal(r.iterations, 2);
    assert.match(r.stop, /cap: 2 runs/);
  } finally { rm(b.repo); }
});

test('ralph: parked issues end the queue instead of looping on them', () => {
  const cfg = resolveGoalLoopConfig({});
  const repo = tmpDir('cf-ralph-');
  try {
    const issues = [
      { number: 1, state: 'CLOSED', labels: [{ name: 'goal-loop' }] },
      { number: 2, state: 'OPEN', labels: [{ name: 'goal-loop' }, { name: 'goal-loop:needs-human' }] },
    ];
    const n = nextPhase(cfg, repo, { issues, prs: [] });
    assert.equal(n.phase, 'stop');
    assert.match(n.reason, /1 issue\(s\) parked/);
  } finally { rm(repo); }
});

test('ralph: --dry-run writes nothing and runs nothing', () => {
  const issues = [{ number: 1, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: 't0' }];
  const { repo, st } = setup({ state: { issues } });
  try {
    const r = spawnSync(process.execPath, [BIN, 'loop', '--mode', 'ralph', '--repo', repo, '--dry-run'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /run 1: phase batch \(1 workable issues\)/);
    assert.match(r.stdout, /would run \(in .*\): .*fake-copilot\.mjs .*-p "Ralph mode: read .*--agent "Goal Orchestrator" --model claude-sonnet-5\.5 --reasoning-effort high --allow-all-tools/);
    assert.ok(!fs.existsSync(path.join(repo, '.goal-loop', 'ralph')), 'no run folder');
    assert.equal(st().calls, undefined, 'copilot not called');
  } finally { rm(repo); }
});

test('ralph: a missing copilot executable stops with an error', async () => {
  const { repo } = setup({ ralph: { copilotCommand: ['copilot-does-not-exist-xyz'] }, state: { issues: [{ number: 1, state: 'OPEN', labels: [{ name: 'goal-loop' }], updatedAt: 't' }] } });
  try {
    const r = await ralphLoop({ repo, log: logger() });
    assert.equal(r.exitCode, 1);
    assert.match(r.stop, /cannot run copilot-does-not-exist-xyz/);
  } finally { rm(repo); }
});

test('ralph: approve-plan from the command line, and refusal without a plan', () => {
  const { repo } = setup();
  try {
    let r = spawnSync(process.execPath, [BIN, 'loop', 'approve-plan', '--repo', repo], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no plan yet/);
    fs.writeFileSync(path.join(repo, '.goal-loop', 'PLAN.md'), '# Plan\n## A\n');
    r = spawnSync(process.execPath, [BIN, 'loop', 'approve-plan', '--repo', repo], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(planApproved(repo));
  } finally { rm(repo); }
});

test('ralph: prompts, arguments and change detection', () => {
  const cfg = resolveGoalLoopConfig({ github: { mergePolicy: 'agent-after-green' }, ralph: { maxAiCreditsPerRun: 500, extraArgs: ['--reasoning-effort', 'high'] } });
  const a = copilotArgs(cfg, { promptRel: '.goal-loop/ralph/x.prompt.md', usageFile: 'u.json', shareFile: 's.md' });
  assert.ok(!a.includes('--deny-tool=shell(gh pr merge)'), 'merging allowed under agent-after-green');
  assert.deepEqual(a.slice(a.indexOf('--max-ai-credits'), a.indexOf('--max-ai-credits') + 2), ['--max-ai-credits', '500']);
  assert.deepEqual(a.slice(-2), ['--reasoning-effort', 'high']);
  assert.match(promptText(cfg, 'batch', 3), /at most one batch/);
  assert.match(promptText(cfg, 'plan', 1), /Do \*\*not\*\* file any issue/);
  assert.throws(() => resolveGoalLoopConfig({ ralph: { maxAiCreditsPerRun: 5 } }), /at least 30/);
  const before = { issues: [{ number: 1, state: 'OPEN', updatedAt: 'a', labels: [] }], prs: [] };
  const after = { issues: [{ number: 1, state: 'OPEN', updatedAt: 'a', labels: [{ name: 'x' }] }, { number: 2, state: 'OPEN', updatedAt: 'b', labels: [] }], prs: [{ number: 9, state: 'OPEN', updatedAt: 'c' }] };
  assert.deepEqual(changes(before, after), { issues: [1, 2], prs: [9] });
});

test('ralph: needs no standalone host, trim or AHP client', () => {
  const imports = (f) => [...fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of imports(f)) if (i.startsWith('./')) walk(i.slice(2));
  };
  walk('ralph.mjs');
  for (const f of ['host.mjs', 'ahp.mjs', 'trim.mjs', 'watch.mjs']) assert.ok(!seen.has(f), `ralph imports ${f}`);
  assert.ok(![...seen].some((f) => imports(f).some((i) => i.includes('agent-host-protocol'))));
});
