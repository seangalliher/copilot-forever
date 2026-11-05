import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.mjs';
import { bootstrap, modelFamily, plannedFiles, render, resolveGoalLoopConfig, TEMPLATES } from '../src/goal-loop.mjs';
import { ROOT, logger, rm, tmpDir } from './helpers.mjs';

const GATE = path.join(TEMPLATES, 'gate.mjs');

function gitRepo() {
  const d = tmpDir('cf-gl-');
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  return { d, g };
}

/** A repo with .goal-loop/config.json whose gate command is `node t.js`, and t.js exiting `code`. */
function gateRepo(script = "console.log('3 tests passed'); process.exit(0)") {
  const r = gitRepo();
  fs.mkdirSync(path.join(r.d, '.goal-loop'), { recursive: true });
  fs.writeFileSync(path.join(r.d, '.goal-loop', 'config.json'), JSON.stringify({ gate: { command: 'node t.js', timeoutMinutes: 1 } }));
  fs.writeFileSync(path.join(r.d, '.goal-loop', '.gitignore'), 'receipts/\n');
  fs.writeFileSync(path.join(r.d, 't.js'), script);
  r.g('add', '.goal-loop/config.json', '.goal-loop/.gitignore', 't.js');
  r.g('commit', '-q', '-m', 'init');
  return r;
}

const gate = (d, ...a) => spawnSync(process.execPath, [GATE, ...a], { cwd: d, encoding: 'utf8' });
const receipt = (d, label) => JSON.parse(fs.readFileSync(path.join(d, '.goal-loop', 'receipts', `${label}.json`), 'utf8'));

// ---- gate -----------------------------------------------------------------------------------
test('gate: passes on a clean committed tree and writes a receipt bound to the commit', () => {
  const { d, g } = gateRepo();
  try {
    const r = gate(d, '--label', 'batch-1');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rc = receipt(d, 'batch-1');
    assert.equal(rc.result, 'pass');
    assert.equal(rc.commit, g('rev-parse', 'HEAD').trim());
    assert.equal(rc.tree, g('rev-parse', 'HEAD^{tree}').trim());
    assert.equal(rc.command, 'node t.js');
    assert.equal(rc.tests, '3 tests passed');
    assert.match(rc.outputSha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(d, rc.log)));
    assert.equal(gate(d, '--verify', 'batch-1').status, 0);
  } finally { rm(d); }
});

test('gate: refuses a dirty index, unstaged changes and untracked files', () => {
  const { d, g } = gateRepo();
  try {
    fs.writeFileSync(path.join(d, 'new.js'), '1');
    let r = gate(d, '--label', 'x');
    assert.equal(r.status, 3);
    assert.match(r.stderr, /refusing: the tree differs from HEAD/);
    assert.equal(gate(d, '--label', 'x', '--allow-untracked').status, 0, 'untracked allowed only on request');
    g('add', 'new.js');
    r = gate(d, '--label', 'x');
    assert.equal(r.status, 3, 'staged change refused');
    g('reset', '-q');
    fs.rmSync(path.join(d, 'new.js'));
    fs.appendFileSync(path.join(d, 't.js'), '\n');
    assert.equal(gate(d, '--label', 'x').status, 3, 'unstaged change refused');
  } finally { rm(d); }
});

test('gate: a failing test command fails the gate and the receipt says so', () => {
  const { d } = gateRepo("console.error('1 failed'); process.exit(7)");
  try {
    const r = gate(d, '--label', 'red');
    assert.equal(r.status, 1);
    const rc = receipt(d, 'red');
    assert.equal(rc.result, 'fail');
    assert.equal(rc.exitCode, 7);
    assert.match(rc.tail, /1 failed/);
    assert.equal(gate(d, '--verify', 'red').status, 4);
  } finally { rm(d); }
});

test('gate: a test command that changes tracked files fails', () => {
  const { d } = gateRepo("require('fs').appendFileSync('t.js', '//x'); process.exit(0)");
  try {
    assert.equal(gate(d, '--label', 'mut').status, 1);
    assert.match(receipt(d, 'mut').notes.join(' '), /changed the tree/);
  } finally { rm(d); }
});

test('gate --verify fails after a new commit, a dirty tree or a changed command', () => {
  const { d, g } = gateRepo();
  try {
    assert.equal(gate(d, '--label', 'b').status, 0);
    fs.appendFileSync(path.join(d, 't.js'), '\n');
    let v = gate(d, '--verify', 'b');
    assert.equal(v.status, 4);
    assert.match(v.stderr, /not clean/);
    g('commit', '-q', '-am', 'more');
    v = gate(d, '--verify', 'b');
    assert.equal(v.status, 4);
    assert.match(v.stderr, /receipt is for/);
    assert.equal(gate(d, '--verify', 'missing').status, 4);
    assert.equal(gate(d, '--label', 'b').status, 0, 'rerun is allowed');
    assert.ok(fs.readdirSync(path.join(d, '.goal-loop', 'receipts')).some((n) => /^b\.prev-.*\.json$/.test(n)), 'previous receipt kept');
  } finally { rm(d); }
});

test('gate: dry-run, no commit, bad label, missing command', () => {
  const { d } = gateRepo();
  try {
    const r = gate(d, '--label', 'dry', '--dry-run');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /would run `node t.js`/);
    assert.ok(!fs.existsSync(path.join(d, '.goal-loop', 'receipts', 'dry.json')));
    assert.equal(gate(d, '--label', '../x').status, 2);
    fs.writeFileSync(path.join(d, 'other.json'), '{"gate":{}}');
    assert.equal(gate(d, '--label', 'x', '--config', 'other.json').status, 2);
  } finally { rm(d); }
  const e = gitRepo();
  try {
    fs.mkdirSync(path.join(e.d, '.goal-loop'));
    fs.writeFileSync(path.join(e.d, '.goal-loop', 'config.json'), '{"gate":{"command":"node -v"}}');
    const r = gate(e.d, '--label', 'x');
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no commit/);
  } finally { rm(e.d); }
});

// ---- config and templates -------------------------------------------------------------------
test('model families', () => {
  assert.equal(modelFamily('claude-sonnet-5.5'), 'anthropic');
  assert.equal(modelFamily('gpt-6.1-sol'), 'openai');
  assert.equal(modelFamily('o4-mini'), 'openai');
  assert.equal(modelFamily('gemini-3-pro'), 'google');
  assert.equal(modelFamily('mistral-large'), 'mistral');
});

test('config: the reviewer must be another model family than the builder', () => {
  assert.throws(() => resolveGoalLoopConfig({ models: { reviewer: 'claude-opus-5.5' } }), /same model family/);
  assert.doesNotThrow(() => resolveGoalLoopConfig({ models: { reviewer: 'claude-opus-5.5', reviewerFallback: '' } }, { allowSameFamily: true }));
  assert.throws(() => resolveGoalLoopConfig({ github: { mergePolicy: 'auto' } }), /mergePolicy/);
  assert.throws(() => resolveGoalLoopConfig({ caps: { maxBatchSize: 5 } }), /maxBatchSize/);
  assert.throws(() => resolveGoalLoopConfig({ gate: { command: '' } }), /gate.command/);
});

test('render: unknown placeholders are an error', () => {
  assert.equal(render('a {{x.y}} b', { x: { y: 1 } }), 'a 1 b');
  assert.throws(() => render('{{nope}}', {}), /no value/);
});

test('templates: every placeholder renders and frontmatter carries the configured models', () => {
  const cfg = resolveGoalLoopConfig({ models: { builder: 'builder-model-x', reviewer: 'gpt-review', orchestrator: 'orch-y', architect: 'arch-z' } });
  const files = plannedFiles(cfg, '/tmp/my-app');
  for (const f of files) assert.ok(!/\{\{/.test(f.content), `${f.rel} has an unrendered placeholder`);
  const byName = Object.fromEntries(files.map((f) => [f.rel, f.content]));
  assert.match(byName['.github/agents/orchestrator.agent.md'], /^---\nname: "Orchestrator"\n[\s\S]*model: "orch-y"/);
  assert.match(byName['.github/agents/builder.agent.md'], /model: "builder-model-x"/);
  assert.match(byName['.github/agents/diff-reviewer.agent.md'], /model: "gpt-review"/);
  assert.match(byName['.github/agents/architect.agent.md'], /model: "arch-z"/);
  const orch = byName['.github/agents/orchestrator.agent.md'];
  assert.match(orch, /APPROVE PLAN/);
  assert.match(orch, /\.goal-loop\/STOP/);
  assert.match(orch, /Never enable auto-merge/);
  assert.match(orch, /Long-running session: log trims at safe points/, 'safe-point rule embedded');
  assert.match(orch, /\.goal-loop\/trim-request\.json/);
  assert.match(orch, /never blocks after round 1/, 'wording-only findings do not use up review rounds');
  assert.match(byName['.github/agents/builder.agent.md'], /make the claim smaller or delete it/, 'repairs shrink claims');
  assert.ok(!/tools:/.test(orch.split('---')[1]), 'orchestrator keeps all tools (it delegates)');
  assert.ok(!/\bedit\b/.test(byName['.github/agents/diff-reviewer.agent.md'].split('---')[1]), 'reviewer cannot edit');
});

// ---- bootstrap ------------------------------------------------------------------------------
test('bootstrap: dry run writes nothing; a real run renders everything; a rerun skips', async () => {
  const { d } = gitRepo();
  try {
    const log = logger();
    const dry = await bootstrap({ repo: d, dryRun: true, install: false, print: false, log });
    assert.ok(dry.results.every((r) => r.action === 'create'));
    assert.deepEqual(fs.readdirSync(d).filter((n) => n !== '.git'), [], 'dry run wrote nothing');
    assert.match(dry.steps, /APPROVE PLAN/);

    const real = await bootstrap({ repo: d, install: false, print: false, log: logger() });
    for (const r of real.results) assert.ok(fs.existsSync(path.join(d, r.rel)), r.rel);
    // The generated copilot-forever config loads, and resolves to this repo.
    const kc = resolveConfig(JSON.parse(fs.readFileSync(path.join(d, '.goal-loop', 'copilot-forever.config.json'), 'utf8')), path.join(d, '.goal-loop'));
    assert.equal(kc.repoFolder, path.resolve(d));
    assert.equal(kc.files.request, path.join(d, '.goal-loop', 'trim-request.json'));
    assert.equal(kc.agentFile, path.join(d, '.github', 'agents', 'orchestrator.agent.md'));
    // The goal-loop gate works from the rendered config once committed.
    assert.match(fs.readFileSync(path.join(d, '.goal-loop', '.gitignore'), 'utf8'), /handoff\.md/);

    fs.writeFileSync(path.join(d, '.goal-loop', 'GOAL.md'), 'my goal');
    const again = await bootstrap({ repo: d, install: false, print: false, log: logger() });
    assert.ok(again.results.every((r) => r.action === 'unchanged' || r.action === 'keep'), JSON.stringify(again.results));
    fs.appendFileSync(path.join(d, '.github', 'agents', 'builder.agent.md'), 'local edit');
    assert.equal((await bootstrap({ repo: d, install: false, print: false, log: logger() })).results.find((r) => r.rel === '.github/agents/builder.agent.md').action, 'skip');
    const forced = await bootstrap({ repo: d, install: false, force: true, print: false, log: logger() });
    assert.equal(forced.results.find((r) => r.rel === '.goal-loop/GOAL.md').action, 'keep');
    assert.equal(fs.readFileSync(path.join(d, '.goal-loop', 'GOAL.md'), 'utf8'), 'my goal', 'GOAL.md never overwritten');
    assert.equal(forced.results.find((r) => r.rel === '.github/agents/builder.agent.md').action, 'overwrite');
  } finally { rm(d); }
});

test('bootstrap: an existing copilot-instructions.md is kept and the standing orders go beside it', async () => {
  const { d } = gitRepo();
  try {
    fs.mkdirSync(path.join(d, '.github'));
    fs.writeFileSync(path.join(d, '.github', 'copilot-instructions.md'), 'project rules');
    const r = await bootstrap({ repo: d, install: false, print: false, log: logger() });
    assert.equal(fs.readFileSync(path.join(d, '.github', 'copilot-instructions.md'), 'utf8'), 'project rules');
    assert.ok(r.results.some((x) => x.rel === '.goal-loop/copilot-instructions.goal-loop.md' && x.action === 'create'));
  } finally { rm(d); }
});

test('bootstrap: refuses a folder that is not a git repository, and a same-family reviewer', async () => {
  const d = tmpDir('cf-gl-');
  try {
    await assert.rejects(bootstrap({ repo: d, install: false, print: false, log: logger() }), /not a git repository/);
  } finally { rm(d); }
  const { d: g } = gitRepo();
  try {
    const cfg = path.join(g, 'gl.json');
    fs.writeFileSync(cfg, JSON.stringify({ models: { builder: 'gpt-6.1-sol', reviewer: 'gpt-6-luna' } }));
    await assert.rejects(bootstrap({ repo: g, config: cfg, install: false, print: false, log: logger() }), /same model family/);
  } finally { rm(g); }
});

test('bootstrap.mjs --dry-run from the command line', () => {
  const { d } = gitRepo();
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bootstrap.mjs'), '--repo', d, '--dry-run', '--no-install'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would create\s+\.github\/agents\/orchestrator\.agent\.md/);
    assert.match(r.stdout, /Next steps/);
    assert.deepEqual(fs.readdirSync(d).filter((n) => n !== '.git'), []);
  } finally { rm(d); }
});

// ---- vocabulary -----------------------------------------------------------------------------
test('no project-specific vocabulary in the kit, the templates or the demo', () => {
  const banned = [/probos/i, /\bcaptain\b/i, /\bcrew\b/i, /starship/i, /\bnooplex\b/i, /\b(AD|BF)-\d+/, /claude[_-]architect/i, /\bvessel\b/i, /\bwarp\b/i];
  const claudeCode = /claude code/i; // the loop runs entirely in GitHub Copilot
  const skip = new Set(['node_modules', '.git', 'package-lock.json']);
  const self = path.join('test', 'goal-loop.test.mjs');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(ROOT, p);
      if (rel === self || !/\.(md|mjs|js|json|yml|jsonl)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const b of banned) if (b.test(text)) hits.push(`${rel}: ${b}`);
      if ((rel.startsWith('templates') || rel.startsWith('demo')) && claudeCode.test(text)) hits.push(`${rel}: ${claudeCode}`);
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});

test('bootstrap --start --dry-run shows the schedule and host start, and changes nothing', async () => {
  const { d } = gitRepo();
  try {
    const log = logger();
    const r = await bootstrap({ repo: d, dryRun: true, install: false, start: true, print: false, log });
    const text = log.lines.join('\n');
    assert.match(text, /starting the keep-alive layer/);
    assert.match(text, /would (run|write)/);
    assert.match(text, /would (run \(clean env|start the host)|already listening/);
    assert.match(r.steps, /done by --start/);
    assert.match(r.steps, /loop --mode ralph/);
    assert.deepEqual(fs.readdirSync(d).filter((n) => n !== '.git'), []);
  } finally { rm(d); }
});
